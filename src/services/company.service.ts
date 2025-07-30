import { Injectable, Logger } from '@nestjs/common';
import { GeminiApiService } from './gemini-api.service';
import { GeminiModelService } from './gemini-model.service';
import { GoogleAuthService } from './google-auth.service';
import { SheetsApiService } from './sheets-api.service';
import { sheets_v4 } from 'googleapis';
import axios from 'axios';
import { readFile } from 'fs/promises';
import { GeminiAiService } from './gemini-ai.service';
import { SearchService } from './search.service';
import { EmissionsReportService } from './emissions-report.service';
import { CATEGORY_SCHEMA } from '../constants';

// Add type definition for Gemini API response
interface GeminiResponse {
  response: {
    text(): string;
  };
}

interface RevenueData {
  revenue: number;
  year: string;
  source: string;
  confidence: number;
  sourceUrl?: string;
  currency?: string;
  employeeCount?: number;
}

interface CountryData {
  country: string;
  confidence: number;
  headquarters: string;
}

interface FmpSearchResult {
  symbol: string;
  name: string;
  currency: string;
  exchangeFullName: string;
  exchange: string;
}

interface FmpIncomeStatement {
  date: string;
  symbol: string;
  reportedCurrency: string;
  revenue: number;
  fiscalYear: string;
  period: string;
  // Other fields omitted for brevity
}

@Injectable()
export class CompanyService {
  private readonly logger = new Logger(CompanyService.name);
  private readonly FMP_API_BASE_URL = 'https://financialmodelingprep.com/stable';
  private readonly FMP_API_KEY = process.env.FMP_API_KEY;
  private readonly SPREADSHEET_ID = '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg';

  constructor(
    private readonly geminiApiService: GeminiApiService,
    private readonly geminiAiService: GeminiAiService,
    private readonly geminiModelService: GeminiModelService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly sheetsApiService: SheetsApiService,
    private readonly searchService: SearchService,
    private readonly emissionsReportService: EmissionsReportService,
  ) {}

  /**
   * Find the parent company of a given company
   */
  async findParentCompany(companyName: string): Promise<string | null> {
    try {
      const parentCompanyFinderModel = this.geminiModelService.getModel('parentCompanyFinder');
      
      const prompt = `
        I need you to research and determine the non-government parent company of ${companyName}, ONLY if its is a subsidiary of another private company. 
        
        Rules:
        - If ${companyName} is already the top-level parent company, return "${companyName}" as the parent
        - If the parent company is a government entity, return "${companyName}" as the parent
        - Use reliable, recent sources for your determination
        - If the parent company is an investment company or fund or private equity firm, return "${companyName}" as the parent
        
        Return your answer in the following JSON format only:
        
        {
          "parentCompany": "Example Parent Corp",
          "confidence": 8,
          "relationship": "subsidiary",
          "notes": "Acquired in 2022, maintains separate operations"
        }
        
        Example 1:
        For "Instagram", the response would be:
        {
          "parentCompany": "Meta Platforms",
          "confidence": 10,
          "relationship": "subsidiary",
          "notes": "Acquired by Facebook (now Meta) in 2012"
        }
        
        Example 2:
        For "Apple Inc", the response would be:
        {
          "parentCompany": "Apple Inc",
          "confidence": 10,
          "relationship": "parent",
          "notes": "Independent public company, not owned by another entity"
        }
      `;
      
      const result = await this.geminiApiService.handleGeminiCall(
        () => parentCompanyFinderModel.generateContent({
          contents: prompt,
        })
      );
      
      if (!result || !result) {
        throw new Error('Failed to generate content from Gemini');
      }
      
      // Parse the response
      const responseText = result.text;
      const parsedResponse = this.geminiApiService.safelyParseJson(responseText);
      
      if (!parsedResponse || !parsedResponse.parentCompany) {
        this.logger.warn(`Failed to determine parent company for ${companyName}`);
        return companyName; // Return the original company name as fallback
      }
      
      const parentCompany = parsedResponse.parentCompany.trim();
      
      // If parent is same as or very similar to the original, return the original
      if (this.isSameCompany(companyName, parentCompany)) {
        return companyName;
      }
      
      return parentCompany;
    } catch (error) {
      this.logger.error(`Error finding parent company for ${companyName}: ${error.message}`);
      return companyName; // Return the original company name as fallback
    }
  }

  async doesCompanyExist(companyName: string): Promise<boolean> {
    const existingCompanies = await this.getExistingCompaniesFromSheet();

    const doesCompanyExist = existingCompanies.some(company => this.isSameCompany(company.name, companyName));

    if (doesCompanyExist) {
      return true;
    }

    // call gemini to check if companyName is in existingCompanies
    const result = await this.geminiApiService.handleGeminiCall(
      () => this.geminiModelService.getModel('companyNameChecker').generateContent({
        contents: [{ role: 'user', parts: [{ text: `Is ${companyName} already a company in the following list? ${existingCompanies.map(company => company.name).join(', ')}` }] }],
      })
    );

    const parsedResponse = this.geminiApiService.safelyParseJson(result.text);

    return parsedResponse.exists;
  }

  /**
   * Check if two company names refer to the same company
   */
  private isSameCompany(company1: string, company2: string): boolean {
    // Normalize company names
    const normalize = (name: string): string => {
      return name.toLowerCase()
        .replace(/\s+/g, '') // Remove spaces
        .replace(/[,.'"]/g, '') // Remove punctuation
        .replace(/\b(inc|corp|co|ltd|llc|group|plc)\b/g, ''); // Remove common company suffixes
    };
    
    const normalized1 = normalize(company1);
    const normalized2 = normalize(company2);
    
    // Check if one is a substring of the other or if they're very similar
    return normalized1.includes(normalized2) || normalized2.includes(normalized1);
  }

  /**
   * Normalize company name for search by removing common suffixes and punctuation
   */
  private normalizeCompanyNameForSearch(companyName: string): string {
    return companyName
      .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|group|plc|holdings|holding|gmbh)\b\.?/gi, '')
      .replace(/[,.'"()]/g, '')
      .trim();
  }

  /**
   * Search for a company symbol by name using Financial Modeling Prep API
   */
  private async searchCompanySymbol(companyName: string): Promise<FmpSearchResult[]> {
    try {
      if (!this.FMP_API_KEY) {
        this.logger.warn('FMP API key not configured. Skipping FMP API call.');
        return [];
      }

      // Normalize the company name for better search results
      const normalizedName = this.normalizeCompanyNameForSearch(companyName);
      this.logger.debug(`Searching for symbol with normalized name: ${normalizedName} (original: ${companyName})`);

      const response = await axios.get(`${this.FMP_API_BASE_URL}/search-name`, {
        params: {
          query: normalizedName,
          apikey: this.FMP_API_KEY
        }
      });

      if (response.data && Array.isArray(response.data)) {
        return response.data;
      }
      return [];
    } catch (error) {
      this.logger.error(`Error searching company symbol for ${companyName}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get income statement data for a company using Financial Modeling Prep API
   */
  private async getIncomeStatement(symbol: string, targetYear?: string): Promise<FmpIncomeStatement[]> {
    try {
      if (!this.FMP_API_KEY) {
        this.logger.warn('FMP API key not configured. Skipping FMP API call.');
        return [];
      }

      const response = await axios.get(`${this.FMP_API_BASE_URL}/income-statement`, {
        params: {
          symbol: symbol,
          apikey: this.FMP_API_KEY
        }
      });

      if (response.data && Array.isArray(response.data)) {
        // If targetYear is specified, filter by year
        if (targetYear && targetYear !== 'recent') {
          return response.data.filter(statement => 
            statement.date.includes(targetYear) || statement.fiscalYear === targetYear
          );
        }
        return response.data;
      }
      return [];
    } catch (error) {
      this.logger.error(`Error getting income statement for ${symbol}: ${error.message}`);
      return [];
    }
  }

  async updateCompanyAudited(companyName: string, thirdPartyAssurance: any, notes: string): Promise<void> {
    const existingCompanies = await this.getExistingCompaniesFromSheet();

    // Find the row index of the company in the 'Analysed Data' sheet
    const data = await this.sheetsApiService.getValues(
      this.SPREADSHEET_ID,
      `Analysed Data!A2:E`
    );

    const rows = data.values || [];
    const companyIndex = rows.findIndex(row => row[0] === companyName);

    if (companyIndex === -1) {
      console.log(`[ERROR] Company ${companyName} not found in 'Analysed Data' sheet`);
      return  ;
    }

    await this.sheetsApiService.updateValues(
      this.SPREADSHEET_ID,
      `Analysed Data!AF:AG${companyIndex + 2}`,
      [[thirdPartyAssurance.company, notes]]
    );
  
  }

  /**
   * Get company audited data
   */
  async getCompanyAudited(companyData: any): Promise<any> {
    const { reportUrl } = companyData;

    const prompt = `
      I need you to find if the company has a third party assurance report.
      If the report contains a third party assurance statement, extract the company name that provided the assurance and the notes. If no third party assurance is found, return null for the third party assurance company and notes. If the report has undergone third party assurance but no assurance company is named, return 'Undergone, No name provided' for the third party assurance company and the notes from the report.
      The response should be in the following JSON format:
      {
        "thirdPartyAssurance": {
          "company": "The company that audited the report",
          "notes": "Additional information about the audited company"
        },
        "notes": "Additional information about the calculation of scope 1, 2 and 3 emissions (do not state the values) and the third party assurance report. Please note if any categories are not included in the report."
      }
    `;

    try {
      const result = await this.geminiApiService.handleGeminiCall(
        () => this.geminiAiService.processUrl(reportUrl, prompt, 'auditedCompanies'),
        2,
        1000,
        10 * 60 * 1000
    );
    
    const parsedResponse = this.geminiApiService.safelyParseJson(result);

      return parsedResponse;
    } catch (error) {
      console.log(`[ERROR] Failed to get company audited for ${companyData.name}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get company revenue data from Financial Modeling Prep API
   */
  private async getCompanyRevenueFromFMP(companyName: string, targetYear?: string): Promise<RevenueData | null> {
    try {
      // Step 1: Search for company symbol
      const searchResults = await this.searchCompanySymbol(companyName);
      if (!searchResults.length) {
        this.logger.debug(`No symbol found for ${companyName} in FMP`);
        return null;
      }

      // Get the most relevant result (first one)
      const symbolResult = searchResults[0];
      this.logger.debug(`Found symbol ${symbolResult.symbol} for ${companyName}`);

      // Step 2: Get income statement using the symbol
      const incomeStatements = await this.getIncomeStatement(symbolResult.symbol, targetYear);
      if (!incomeStatements.length) {
        this.logger.debug(`No income statement found for ${symbolResult.symbol}`);
        return null;
      }

      // Sort statements by date (newest first) and take the first one
      // or if targetYear is specified, take the first matching one
      const sortedStatements = incomeStatements.sort((a, b) => 
        new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      
      const statement = sortedStatements[0];
      
      // Check if revenue exists
      if (!statement.revenue) {
        this.logger.debug(`No revenue data found in income statement for ${symbolResult.symbol}`);
        return null;
      }

      // Extract year from date
      const year = statement.date.split('-')[0];
      
      return {
        revenue: statement.revenue,
        year: year,
        source: `Financial Modeling Prep API - ${symbolResult.exchangeFullName}`,
        confidence: 9, // High confidence for direct financial data
        sourceUrl: `https://financialmodelingprep.com/financial-statements/${symbolResult.symbol}`,
        currency: statement.reportedCurrency
      };
    } catch (error) {
      this.logger.error(`Error getting revenue from FMP for ${companyName}: ${error.message}`);
      return null;
    }
  }

  async searchForCompanyAnnualReport(companyName: string, year: string): Promise<string | null> {
    try {
      this.logger.log(`Searching for annual report for ${companyName} in ${year}`);
      
      // Try multiple search strategies in order of specificity
      const searchStrategies = this.buildAnnualReportSearchQueries(companyName, year);
      
      for (const searchQuery of searchStrategies) {
        this.logger.log(`Trying search query: ${searchQuery}`);
        
        const searchResults = await this.searchService.performWebSearch(searchQuery);
        
        if (!searchResults || searchResults.length === 0) {
          continue;
        }
        
        // Remove duplicates and prioritize results
        const uniqueResults = this.removeDuplicateSearchResults(searchResults);
        const prioritizedResults = this.prioritizeAnnualReportResults(uniqueResults, companyName, year);
        
        if (prioritizedResults.length === 0) {
          continue;
        }
        
        // Verify which URL contains the best annual report
        const bestReportUrl = await this.verifyBestAnnualReport(prioritizedResults, companyName, year);
        
        if (bestReportUrl) {
          this.logger.log(`Found valid annual report for ${companyName}: ${bestReportUrl}`);
          return bestReportUrl;
        }
      }
      
      this.logger.warn(`No valid annual report found for ${companyName} in ${year}`);
      return null;
      
    } catch (error) {
      this.logger.error(`Error searching for annual report for ${companyName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Build multiple search query strategies for finding annual reports
   */
  private buildAnnualReportSearchQueries(companyName: string, year: string): string[] {
    const normalizedCompanyName = this.normalizeCompanyNameForSearch(companyName);
    
    return [
      // Most specific: intext searches for exact terms
      `intext:"${normalizedCompanyName}" intext:"annual report" intext:"${year}" intext:"revenue" filetype:pdf`,
      `intext:"${normalizedCompanyName}" intext:"10-K" intext:"${year}" filetype:pdf`,
      
      // Medium specificity: structured searches
      `"${normalizedCompanyName}" "${year}" annual report revenue pdf`,
      `"${normalizedCompanyName}" "${year}" "annual report" financial results`,
      `"${normalizedCompanyName}" "${year}" 10-K SEC filing`,
      
      // Broader searches
      `${normalizedCompanyName} ${year} annual report financial statement`,
      `${normalizedCompanyName} ${year} yearly revenue earnings`,
      
      // Fallback searches
      `${normalizedCompanyName} ${year} investor relations annual`,
      `${normalizedCompanyName} ${year} financial results revenue`
    ];
  }

  /**
   * Remove duplicate search results based on URL
   */
  private removeDuplicateSearchResults(results: any[]): any[] {
    const seenUrls = new Set<string>();
    return results.filter(result => {
      const url = result.link?.toLowerCase() || '';
      if (seenUrls.has(url)) {
        return false;
      }
      seenUrls.add(url);
      return true;
    });
  }

  /**
   * Prioritize search results that are likely annual reports with revenue data
   */
  private prioritizeAnnualReportResults(results: any[], companyName: string, year: string): any[] {
    const ANNUAL_REPORT_KEYWORDS = ['annual', 'report', '10-k', 'yearly', 'financial', 'investor'];
    const REVENUE_KEYWORDS = ['revenue', 'earnings', 'income', 'financial', 'results'];
    const TRUSTED_DOMAINS = ['sec.gov', 'investor', 'ir.', 'annualreports'];
    
    const companyKeywords = companyName.toLowerCase().split(/\s+/);
    
    return results
      .map(result => {
        let score = 0;
        const title = result.title?.toLowerCase() || '';
        const snippet = result.snippet?.toLowerCase() || '';
        const link = result.link?.toLowerCase() || '';
        const displayedLink = result.displayed_link?.toLowerCase() || '';
        
        // Direct PDF files get highest priority
        if (link.endsWith('.pdf')) {
          score += 15;
        }
        
        // Check for PDF mention
        if (title.includes('pdf') || link.includes('pdf')) {
          score += 8;
        }
        
        // Annual report keywords
        ANNUAL_REPORT_KEYWORDS.forEach(keyword => {
          if (title.includes(keyword)) score += 5;
          if (snippet.includes(keyword)) score += 3;
          if (link.includes(keyword)) score += 2;
        });
        
        // Revenue/financial keywords
        REVENUE_KEYWORDS.forEach(keyword => {
          if (title.includes(keyword)) score += 4;
          if (snippet.includes(keyword)) score += 2;
          if (link.includes(keyword)) score += 1;
        });
        
        // Company name relevance
        companyKeywords.forEach(keyword => {
          if (keyword.length > 2) { // Skip very short words
            if (title.includes(keyword)) score += 3;
            if (displayedLink.includes(keyword)) score += 2;
            if (link.includes(keyword)) score += 1;
          }
        });
        
        // Year relevance
        if (title.includes(year)) score += 6;
        if (snippet.includes(year)) score += 4;
        if (link.includes(year)) score += 3;
        
        // Trusted domains
        TRUSTED_DOMAINS.forEach(domain => {
          if (link.includes(domain) || displayedLink.includes(domain)) {
            score += 7;
          }
        });
        
        // Penalize irrelevant sources
        if (link.includes('wikipedia') || link.includes('news') || link.includes('blog')) {
          score -= 5;
        }
        
        return { ...result, score };
      })
      .filter(result => result.score > 0) // Only keep results with positive scores
      .sort((a, b) => b.score - a.score) // Sort by score descending
      .slice(0, 8); // Take top 8 results
  }

  /**
   * Use Gemini AI to verify which URL contains the best annual report for revenue data
   */
  private async verifyBestAnnualReport(
    searchResults: any[], 
    companyName: string, 
    year: string
  ): Promise<string | null> {
    if (!searchResults || searchResults.length === 0) {
      return null;
    }
    
    const candidateUrls = searchResults.map(result => ({
      url: result.link,
      title: result.title || '',
      snippet: result.snippet || '',
      score: result.score || 0
    }));
    
    const prompt = this.buildAnnualReportVerificationPrompt(companyName, year, candidateUrls);
    
    try {
      const result = await this.geminiApiService.handleGeminiCall(
        () => this.geminiModelService.getModel('annualReportFinder').generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        })
      );
      
      if (!result?.candidates?.[0]?.content?.parts?.[0]?.text) {
        this.logger.warn(`No response from Gemini for annual report verification`);
        return null;
      }
      
      const parsedResponse = this.geminiApiService.safelyParseJson(
        result.candidates[0].content.parts[0].text
      );
      
      return this.validateAnnualReportResponse(parsedResponse, candidateUrls);
      
    } catch (error) {
      this.logger.error(`Error verifying annual report with Gemini: ${error.message}`);
      return null;
    }
  }

  /**
   * Build a comprehensive prompt for Gemini to verify annual reports
   */
  private buildAnnualReportVerificationPrompt(
    companyName: string, 
    year: string, 
    candidateUrls: any[]
  ): string {
    const urlsList = candidateUrls
      .map((candidate, index) => 
        `${index + 1}. URL: ${candidate.url}\n   Title: ${candidate.title}\n   Snippet: ${candidate.snippet}\n   Score: ${candidate.score}`
      )
      .join('\n\n');
    
    return `I need to find the official annual report for "${companyName}" from ${year} that contains revenue/financial data.

Please analyze these candidate URLs and determine which one is most likely to be:
1. An official annual report, 10-K filing, or financial statement from ${year}
2. Contains revenue, earnings, or comprehensive financial data
3. From the company's official website, SEC filings, or trusted investor relations sources
4. A primary source document (not a news article, summary, or third-party analysis)

Candidate URLs:
${urlsList}

Evaluation criteria (in order of importance):
- Document type: Official annual reports, 10-K filings, and investor presentations are preferred
- Revenue data presence: Must contain or reference financial/revenue information
- Source credibility: Company websites, SEC.gov, and official investor relations pages are preferred
- Year match: Document must be from ${year} reporting period
- Document format: PDF documents are strongly preferred for annual reports

Return your response in JSON format:
{
  "bestReportUrl": "URL of the most appropriate report or null if none found",
  "confidence": "score from 0-10 indicating confidence in selection",
  "reasoning": "brief explanation of selection criteria",
  "containsRevenue": "true/false indicating if the report likely contains revenue data",
  "documentType": "type of document (annual report, 10-K, etc.)",
  "year": "${year}"
}

If no URL meets the criteria for a valid annual report with revenue data, return { "bestReportUrl": null, "confidence": 0, "reasoning": "No valid annual report found", "containsRevenue": false, "documentType": null, "year": "${year}" }.`;
  }

  /**
   * Validate the Gemini response for annual report verification
   */
  private validateAnnualReportResponse(parsedResponse: any, candidateUrls: any[]): string | null {
    if (!parsedResponse) {
      return null;
    }
    
    const { bestReportUrl, confidence, containsRevenue } = parsedResponse;
    
    // Must have high confidence and indicate revenue data presence
    if (!bestReportUrl || confidence < 6 || containsRevenue !== true) {
      this.logger.warn(`Annual report validation failed: confidence=${confidence}, containsRevenue=${containsRevenue}`);
      return null;
    }
    
    // Verify the URL exists in our candidate list
    const isValidUrl = candidateUrls.some(candidate => candidate.url === bestReportUrl);
    if (!isValidUrl) {
      this.logger.warn(`Selected URL not in candidate list: ${bestReportUrl}`);
      return null;
    }
    
    return bestReportUrl;
  }

  /**
   * Extract revenue and employee count from a report URL
   */
  private async extractFinancialDataFromReport(
    companyName: string, 
    reportUrl: string, 
    targetYear: string
  ): Promise<RevenueData | null> {
    try {
      const prompt = this.buildFinancialDataExtractionPrompt(companyName, targetYear);
      
      const response = await this.geminiAiService.processUrl(
        reportUrl, 
        prompt, 
        'revenueAndEmployeeExtraction'
      );
      
      const parsedResponse = this.geminiApiService.safelyParseJson(response);

      console.log(parsedResponse);
      
      if (!parsedResponse?.revenue) {
        return null;
      }
      
      return {
        revenue: parsedResponse.revenue,
        year: parsedResponse.year || targetYear,
        source: this.determineReportSource(reportUrl),
        confidence: parsedResponse.confidence || 8,
        sourceUrl: reportUrl,
        currency: parsedResponse.currency || 'USD',
        employeeCount: parsedResponse.employeeCount || null
      };
    } catch (error) {
      this.logger.error(`Error extracting financial data from report for ${companyName}: ${error.message}`);
      return null;
    }
  }

  async updateMissingEmployees(companyName: string, employeeCount: number, company: any): Promise<any> {
         // Find the row index of the company in the 'Analysed Data' sheet
         const data = await this.sheetsApiService.getValues(
          this.SPREADSHEET_ID,
          `Analysed Data!A2:A`
        );

        const rows = data.values || [];
        const companyIndex = rows.findIndex(row => row[0] === companyName);

        if (companyIndex === -1) {
          console.log(`[ERROR] Company ${companyName} not found in 'Analysed Data' sheet`);
          return;
        }

        // Calculate the actual row number in the sheet
        const actualRowNumber = 2 + companyIndex;

        // Update the employee count in column E
        await this.sheetsApiService.updateValues(
          this.SPREADSHEET_ID,
          `Analysed Data!H${actualRowNumber}`,
          [[employeeCount]]
        );

        console.log(`[SUCCESS] Updated employee count for ${companyName} to ${employeeCount}`);
      
  }

  async checkReportUrlForMissingEmployees(companyName: string, reportUrl: string, targetYear: string): Promise<any> {
    const prompt = `
      I need you to find how many employees the company ${companyName} has in ${targetYear}.
      If the report contains a number of employees, return the number of employees.
      If the report does not contain a number of employees, return null.
      The response should be in the following JSON format:
      {
        "employeeCount": 1234567890
      }
    `;

    const response = await this.geminiAiService.processUrl(reportUrl, prompt, 'missingEmployees');
    const parsedResponse = this.geminiApiService.safelyParseJson(response);
    
    return parsedResponse;
  }

  /**
   * Build prompt for financial data extraction
   */
  private buildFinancialDataExtractionPrompt(companyName: string, targetYear: string): string {
    return `
      Extract financial information for ${companyName} from this document.
      ${targetYear !== 'recent' ? `Focus on data for the year ${targetYear}.` : 'Use the most recent data available.'}

      The name of the company in the doucment must match ${companyName}. If it is a different company, return null.
      
      IMPORTANT INSTRUCTIONS:
      1. Find the total revenue/turnover for the company
      2. Find the total number of employees (full-time equivalent if specified)
      3. Revenue must be converted to a single $ value, not thousands or millions
      4. Ensure data consistency by using the same reporting period for both metrics
      
      Return ONLY a JSON object in this exact format:
      {
        "revenue": 1234567890,
        "currency": "USD",
        "year": "2023",
        "employeeCount": 50000,
        "confidence": 9
      }
      
      If employee count is not found, set employeeCount to null.
      If revenue is not found, set revenue to null.
      Confidence should be 1-10 based on data clarity and source reliability.
    `;
  }

  /**
   * Determine the source description based on report URL
   */
  private determineReportSource(reportUrl: string): string {
    if (reportUrl.includes('annual')) {
      return 'Annual Report';
    }
    if (reportUrl.includes('sustainability') || reportUrl.includes('esg')) {
      return 'ESG/Sustainability Report';
    }
    return 'Company Report';
  }

  /**
   * Get financial data from Gemini model as fallback
   */
  private async getFinancialDataFromGemini(
    companyName: string, 
    reportingPeriod?: string,
    targetYear?: string,
    companyCategory?: string,
    country?: string
  ): Promise<RevenueData | null> {
    try {
      const revenueModel = this.geminiModelService.getModel('revenue');
      const prompt = this.buildGeminiFallbackPrompt(companyName, reportingPeriod, targetYear, companyCategory, country);
      
      const response = await this.geminiApiService.handleGeminiCall(
        () => revenueModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        })
      );

      console.log(response.text);
      
      const parsedResponse = this.geminiApiService.safelyParseJson(response.text);
      
      return {
        revenue: parsedResponse.revenue,
        year: targetYear,
        source: `${parsedResponse.source} (Gemini Model)`,
        confidence: parsedResponse.confidence,
        sourceUrl: parsedResponse.sourceUrl,
        currency: parsedResponse.currency,
        employeeCount: parsedResponse.employeeCount || null
      };
    } catch (error) {
      this.logger.error(`Error getting financial data from Gemini for ${companyName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Build prompt for Gemini fallback
   */
  private buildGeminiFallbackPrompt(
    companyName: string, 
    reportingPeriod?: string, 
    targetYear?: string,
    companyCategory?: string,
    country?: string
  ): string {
    return `
      Find accurate financial information for ${companyName}
      ${reportingPeriod ? ` for the reporting period: ${reportingPeriod}` : ''}
      ${targetYear && targetYear !== 'recent' ? ` specifically for the year ${targetYear}` : ' for the most recent period'}.
      ${companyCategory ? ` The company is a ${companyCategory}.` : ''}
      ${country ? ` The company is based in ${country}.` : ''}
      
      Please find:
      1. Total revenue/turnover (convert to single $ value, not thousands/millions)
      2. Total number of employees (full-time equivalent)

      If you cannot find the revenue, use an estimate based on rocket reach, or other sources.
      
      Return JSON format:
      {
        "revenue": 1234567890,
        "currency": "USD", 
        "year": "2023",
        "employeeCount": 50000,
        "confidence": 7,
        "source": "Rocket Reach"
      }
    `;
  }

  /**
   * Create error response for revenue data
   */
  private createErrorRevenueResponse(
    companyName: string, 
    reportingPeriod?: string, 
    annualReportUrl?: string
  ): RevenueData {
    const targetYear = reportingPeriod ? 
      (this.extractYearFromPeriod(reportingPeriod)?.toString() || 'unknown') : 
      'unknown';
    
    if (annualReportUrl) {
      return {
        revenue: null,
        year: targetYear,
        source: 'Annual Report (Error occurred during processing)',
        confidence: 1,
        sourceUrl: annualReportUrl,
        currency: 'USD',
        employeeCount: null
      };
    }
    
    return null;
  }

  /**
   * Get company revenue data
   */
  async getCompanyRevenue(companyName: string, reportingPeriod?: string, reportUrl?: string, companyCategory?: string, country?: string): Promise<RevenueData | null> {
    try {
      // Extract target year from reporting period if provided
      const targetYear = this.extractTargetYear(reportingPeriod);
      
      // First try getting revenue data from Financial Modeling Prep API
      const fmpRevenueData = await this.getCompanyRevenueFromFMP(companyName, targetYear);
      
      if (this.isValidFmpData(fmpRevenueData, targetYear)) {
        this.logger.log(`Retrieved revenue data for ${companyName} from FMP API`);
        return fmpRevenueData;
      }
      
      if (reportUrl) {
        this.logger.log(`Extracting financial data from provided report URL for ${companyName}`);
        const reportData = await this.extractFinancialDataFromReport(companyName, reportUrl, targetYear);
        
        if (reportData?.revenue) {
          return reportData;
        }
      }
      
        this.logger.log(`Searching for annual report for ${companyName}`);
        const annualReportUrl = await this.searchForCompanyAnnualReport(companyName, targetYear);
        
        if (annualReportUrl) {
          const reportData = await this.extractFinancialDataFromReport(companyName, annualReportUrl, targetYear);
          
          if (reportData?.revenue) {
            return reportData;
          }
        }
      
      
      // Fall back to Gemini model
      this.logger.log(`Using Gemini fallback for financial data for ${companyName}`);
      return await this.getFinancialDataFromGemini(companyName, reportingPeriod, targetYear, companyCategory, country);
      
    } catch (error) {
      this.logger.error(`Error getting revenue for ${companyName}: ${error.message}`);
      return this.handleRevenueError(companyName, reportingPeriod, error);
    }
  }

  /**
   * Extract target year from reporting period
   */
  private extractTargetYear(reportingPeriod?: string): string {
    if (!reportingPeriod) {
      return 'recent';
    }
    
    const year = this.extractYearFromPeriod(reportingPeriod);
    return year ? year.toString() : 'recent';
  }

  /**
   * Check if FMP data is valid for the target year
   */
  private isValidFmpData(fmpData: RevenueData | null, targetYear: string): boolean {
    return fmpData !== null && 
           (targetYear === 'recent' || fmpData.year === targetYear);
  }

  /**
   * Handle revenue retrieval errors
   */
  private async handleRevenueError(
    companyName: string, 
    reportingPeriod?: string, 
    error?: Error
  ): Promise<RevenueData> {
    try {
      const targetYear = this.extractTargetYear(reportingPeriod);
      const annualReportUrl = await this.searchForCompanyAnnualReport(companyName, targetYear);
      
      if (annualReportUrl) {
        this.logger.log(`Despite error, found annual report for ${companyName}: ${annualReportUrl}`);
      }
      
      return this.createErrorRevenueResponse(companyName, reportingPeriod, annualReportUrl);
    } catch (innerError) {
      this.logger.error(`Error in error handler: ${innerError.message}`);
      return this.createErrorRevenueResponse(companyName, reportingPeriod);
    }
  }

  /**
   * Get related companies
   */
  async getRelatedCompanies(companyName: string): Promise<string[]> {
    try {
      const relatedCompaniesModel = this.geminiModelService.getModel('relatedCompanies');

      const existingCompanies = await this.getExistingCompaniesFromSheet();
      const attempts = await this.getAttemptsFromSheet();

      const companiesToExclude = [...existingCompanies.map(company => company.name), ...attempts];

      const result = await this.geminiApiService.handleGeminiCall(
        () => relatedCompaniesModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: `I need to find related competitors of similar size and region to ${companyName}. 

INSTRUCTIONS:
1. Return a list of exactly 3 related competitors in JSON format.
2. EXCLUSION REQUIREMENT: You MUST NOT include any of the following companies in your results. Before finalizing your response, verify each company name against this exclusion list:
   ${companiesToExclude.join(', ')}
3. If you find any company on the exclusion list in your results, remove it and replace with a different suitable company.
4. Return ONLY companies that are NOT in the above exclusion list.
5. The companies must not have overlapping parent companies.

The response format should be:
{
  "relatedCompanies": ["Company1", "Company2", "Company3", "Company4", "Company5", "Company6", "Company7", "Company8", "Company9", "Company10"]
}

Again, verify your final list against the exclusion list to ensure NO overlaps.` }] }],
        })
      );
      
      if (!result || !result) {
        console.error(result);
        return [];
      }
      
      const parsedResponse = this.geminiApiService.safelyParseJson(result.text);

      console.log(parsedResponse);

      if (!parsedResponse || !parsedResponse.relatedCompanies) {
        this.logger.warn(`Failed to get related companies for ${companyName}`);
        return [];
      }

            // Check the spreadsheet to make sure the company is not already in the list
      if (existingCompanies.some(company => company.name === companyName)) {
        // Return the non duplicate companies
        const nonDuplicateCompanies = parsedResponse.relatedCompanies.filter(company => !existingCompanies.some(existingCompany => existingCompany.name === company));
        return nonDuplicateCompanies;
      }

      // Check if the company is already in the list
      if (parsedResponse.relatedCompanies.some(company => company === companyName)) {
        // Return the non duplicate companies
        const nonDuplicateCompanies = parsedResponse.relatedCompanies.filter(company => company !== companyName);
        return nonDuplicateCompanies;
      }
      
      return parsedResponse.relatedCompanies;
    } catch (error) {
      this.logger.error(`Error getting related companies for ${companyName}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get company category
   */
  async getCompanyCategory(companyName: string, country?: string, reportUrl?: string): Promise<string | null> {
    const companyCategoryModel = this.geminiModelService.getModel('companyCategory');

    const result = await this.geminiApiService.handleGeminiCall(
      () => companyCategoryModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: `I need to find the category of ${companyName} in ${country} with the sustainability report ${reportUrl}. Please return the most appropriate category possible in the JSON format. Do not provide any additional text.` }] }],
      })
    );

    console.log(result.candidates[0].content.parts[0].text);

    if (!result || !result) {
      throw new Error('Failed to generate content from Gemini');
    }

    const parsedResponse = this.geminiApiService.safelyParseJson(result.candidates[0].content.parts[0].text);

    console.log(parsedResponse);

    if (!parsedResponse || !parsedResponse.companyCategory) {
      this.logger.warn(`Failed to get company category for ${companyName}`);
      return null;
    }

    return parsedResponse.companyCategory;
  }

  /**
   * Get companies from spreadsheet
   */
  async getCompaniesFromSheet(): Promise<string[]> {
    console.log(`[STEP] Getting companies list from Google Sheet`);
    
    try {
      console.log('this.SPREADSHEET_ID', this.SPREADSHEET_ID);
      // Use the SheetsApiService with built-in exponential backoff
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        "'Companies to Request'!A2:A"
      );
      console.log('data', data);
      
      const rows = data.values || [];
      const companies = rows.map(row => row[0]).filter(Boolean);
      
      console.log(`[RESULT] Found ${companies.length} companies in spreadsheet`);
      if (companies.length > 0) {
        console.log(`[DETAIL] First 5 companies: ${companies.slice(0, 5).join(', ')}${companies.length > 5 ? '...' : ''}`);
      }
      
      return companies;
    } catch (error) {
      console.log(`[ERROR] Error getting companies from sheet: ${error.message}`);
      console.log(error);
      return [];
    }
  }

  async getExistingCompaniesFromSheet({ fromRow, toRow }: { fromRow?: number, toRow?: number } = {}): Promise<any[]> {
    try {
      console.log(`[STEP] Fetching data from 'Analysed Data' sheet`);
      
      // Use the SheetsApiService with built-in exponential backoff
      // Extended range to include third party assurance data (columns AF and AG)
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `'Analysed Data'!A${fromRow || 2}:AN${toRow || 5500}`
      );
      
      const rows = data.values || [];
      const companies = rows.map(row => ({ 
        name: row[0], 
        reportUrl: row[2],
        reportingPeriod: row[3], 
        revenueYear: row[4], 
        revenue: row[5], 
        exchangeRateCountry: row[6],
        employeeCount: row[7],
        scope1: row[9],
        scope2Location: row[10],
        scope2Market: row[11],
        scope3: row[12],
        scope3Cat1: row[13],
        scope3Cat2: row[14],
        scope3Cat3: row[15],
        scope3Cat4: row[16],
        scope3Cat5: row[17],
        scope3Cat6: row[18],
        scope3Cat7: row[19],
        scope3Cat8: row[20],
        scope3Cat9: row[21],
        scope3Cat10: row[22],
        scope3Cat11: row[23],
        scope3Cat12: row[24],
        scope3Cat13: row[25],
        scope3Cat14: row[26],
        scope3Cat15: row[27],
        country: row[29],
        category: row[30],
        revenueSource: row[33],
        revenueUrl: row[34],
        newRevenueUrl: row[38],
        newRevenueAmount: row[39],
        newRevenueCurrency: row[40],
        notes: row[32], // Column AG - general emissions notes
        scope3Mismatch: row[43],
        thirdPartyAssuranceCompany: row[31] // Column AF (0-indexed as 31)
      })).filter(Boolean);

      console.log(companies.length);

      return companies;
    } catch (error) {
      console.log(`[ERROR] Error getting companies from sheet: ${error.message}`);
      console.log(error);
      return [];
    }
  }

  /**
   * Get companies that have error messages in column AU (notes column)
   */
  async getCompaniesWithErrorMessages(): Promise<any[]> {
    try {
      console.log(`[STEP] Fetching companies with error messages from 'Analysed Data' sheet`);
      
      // Read the spreadsheet including column AU (notes column)
      // AU is column 47 (0-indexed as 46)
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `'Analysed Data'!A2:AU`
      );
      
      const rows = data.values || [];
      const allCompanies = rows.map(row => ({ 
        name: row[0], 
        reportUrl: row[2],
        reportingPeriod: row[3], 
        revenueYear: row[4], 
        revenue: row[5], 
        exchangeRateCountry: row[6],
        scope1: row[9],
        scope2Location: row[10],
        scope2Market: row[11],
        scope3: row[12],
        scope3Cat1: row[13],
        scope3Cat2: row[14],
        scope3Cat3: row[15],
        scope3Cat4: row[16],
        scope3Cat5: row[17],
        scope3Cat6: row[18],
        scope3Cat7: row[19],
        scope3Cat8: row[20],
        scope3Cat9: row[21],
        scope3Cat10: row[22],
        scope3Cat11: row[23],
        scope3Cat12: row[24],
        scope3Cat13: row[25],
        scope3Cat14: row[26],
        scope3Cat15: row[27],
        category: row[30],
        revenueSource: row[33],
        revenueUrl: row[34],
        newRevenueUrl: row[38],
        newRevenueAmount: row[39],
        newRevenueCurrency: row[40],
        notes: row[32],
        scope3Mismatch: row[43],
        errorNotes: row[46] // Column AU (0-indexed as 46)
      })).filter(Boolean);

      // Filter companies that have error messages in column AU
      const companiesWithErrors = allCompanies.filter(company => {
        const errorNotes = company.errorNotes;
        return errorNotes && 
               typeof errorNotes === 'string' && 
               errorNotes.toLowerCase().includes('error');
      });

      console.log(`[RESULT] Found ${companiesWithErrors.length} companies with error messages in column AU`);
      
      if (companiesWithErrors.length > 0) {
        console.log(`[DETAIL] Companies with errors: ${companiesWithErrors.map(c => c.name).slice(0, 5).join(', ')}${companiesWithErrors.length > 5 ? '...' : ''}`);
      }

      return companiesWithErrors;
    } catch (error) {
      console.log(`[ERROR] Error getting companies with error messages: ${error.message}`);
      console.log(error);
      return [];
    }
  }

  async checkReportUrlForMissingScopes(companyName: string, reportUrl: any): Promise<any> {
    const missingScopesModel = this.geminiModelService.getModel('missingScopes');

    const prompt = `
    For company ${companyName}
    Look for tables, charts, and text that explicitly mention greenhouse gas emissions.
        Ensure all values are converted to the same unit (preferably tons of CO2 equivalent).
        Identify the reporting period for the emissions data.

        Extract greenhouse gas emissions data from this sustainability/ESG report
        
        For scope 3 emissions, carefully analyze which categories (1-15) are reported:
        1. Purchased goods and services
        2. Capital goods
        3. Fuel- and energy-related activities
        4. Upstream transportation and distribution
        5. Waste generated in operations
        6. Business travel
        7. Employee commuting
        8. Upstream leased assets
        9. Downstream transportation and distribution
        10. Processing of sold products
        11. Use of sold products
        12. End-of-life treatment of sold products
        13. Downstream leased assets
        14. Franchises
        15. Investments
        
        For each category, determine:
        - The precise emissions value (if provided)
        - Whether the category is explicitly included in reporting (even if no value is given)

        You must convert all values to the standard unit of tons of CO2 equivalent.

      I need to check if the report url ${reportUrl} is missing any scopes.
      You must check if Scope 1 is included.
      You must check if Scope 2 is included.
      You must check if Scope 3 Category 1 is included.
      You must check if Scope 3 Category 2 is included.
      You must check if Scope 3 Category 3 is included.
      You must check if Scope 3 Category 4 is included.
      You must check if Scope 3 Category 5 is included.
      You must check if Scope 3 Category 6 is included.
      You must check if Scope 3 Category 7 is included.
      You must check if Scope 3 Category 8 is included.
      You must check if Scope 3 Category 9 is included.
      You must check if Scope 3 Category 10 is included.
      You must check if Scope 3 Category 11 is included.
      You must check if Scope 3 Category 12 is included.
      You must check if Scope 3 Category 13 is included.
      You must check if Scope 3 Category 14 is included.
      You must check if Scope 3 Category 15 is included.

      -This is because sometimes a report will mention scope 3 but not include any of the categories. So we need to confirm that none are mentioned. And if they are return their values. Or at least what scope were included in calculations.
      -This is because sometimes a report will mention Scope 1 & 2 total but not differentiate between the scope 1 and scope 2. So we need to confirm if their values are mentioned or at least what scopes were included in calculations.
      -This is because sometimes a repor twill mention Total Emissions but not mention the scope. So we need to confirm if their values are mentioned or at least what scopes were included in calculations.

      Gather all emissions values for every category and return them in the following JSON format:

      You must return the response in the following JSON format:
      
      "scope1": {
            "value": number,
            "included": boolean,
            "unit": "string",
            "confidence": number (0-10)
          },
          "scope2": {
            "locationBased": {
              "value": number,
              "unit": "string",
              "confidence": number (0-10),
              "included": boolean
            },
            "marketBased": {
              "value": number,
              "unit": "string",
              "confidence": number (0-10),
              "included": boolean
            }
          },
          "scope3": {
            "total": {
              "value": number,
              "unit": "string",
              "confidence": number (0-10)
            },
            "categories": {
              "1": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "2": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "3": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "4": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "5": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "6": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "7": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "8": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "9": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "10": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "11": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "12": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "13": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "14": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                  "15": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },            }
          },
      
    `;

    const result = await this.geminiApiService.handleGeminiCall(
      () => this.geminiAiService.processUrl(reportUrl, prompt, 'missingScopes'), 2, 5000, 60 * 1000 * 3
    );

    console.log(result);

    if (!result || !result) {
      throw new Error('Failed to generate content from Gemini');
    }

    const parsedResponse = this.geminiApiService.safelyParseJson(result);

    console.log(parsedResponse);

    return parsedResponse;
  }

  async updateMissingScopes(companyName: string, missingScopes: any, existingScopes: any): Promise<boolean> { 
     // Find the row index of the company in the 'Analysed Data' sheet
     const data = await this.sheetsApiService.getValues(
      this.SPREADSHEET_ID,
      `Analysed Data!A2:E`
    );

    const rows = data.values || [];
    const companyIndex = rows.findIndex(row => row[0] === companyName);

    if (companyIndex === -1) {
      console.log(`[ERROR] Company ${companyName} not found in 'Analysed Data' sheet`);
      return false;
    }

    if (missingScopes.scope1.included && !existingScopes.scope1) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!J${companyIndex + 2}`,
        [[missingScopes.scope1.value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope2.locationBased.included && !existingScopes.scope2Location && !existingScopes.scope2Market) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!K${companyIndex + 2}`,
        [[missingScopes.scope2.locationBased.value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope2.marketBased.included && !existingScopes.scope2Market) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!L${companyIndex + 2}`,
        [[missingScopes.scope2.marketBased.value  ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["1"].included && !existingScopes.scope3Cat1) {
      console.log('missingScopes.scope3.categories["1"].value', missingScopes.scope3.categories["1"].value);
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!N${companyIndex + 2}`,
        [[missingScopes.scope3.categories["1"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["2"].included && !existingScopes.scope3Cat2) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!O${companyIndex + 2}`,
        [[missingScopes.scope3.categories["2"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["3"].included && !existingScopes.scope3Cat3) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!P${companyIndex + 2}`,
        [[missingScopes.scope3.categories["3"].value ?? 'Not specified but included in calculation']]
      );
    }
    
    if (missingScopes.scope3.categories["4"].included && !existingScopes.scope3Cat4) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!Q${companyIndex + 2}`,
        [[missingScopes.scope3.categories["4"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["5"].included && !existingScopes.scope3Cat5) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!R${companyIndex + 2}`,
        [[missingScopes.scope3.categories["5"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["6"].included && !existingScopes.scope3Cat6) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!S${companyIndex + 2}`,
        [[missingScopes.scope3.categories["6"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["7"].included && !existingScopes.scope3Cat7) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!T${companyIndex + 2}`,
        [[missingScopes.scope3.categories["7"].value ?? 'Not specified but included in calculation']]
      );
    } 

    if (missingScopes.scope3.categories["8"].included && !existingScopes.scope3Cat8) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!U${companyIndex + 2}`,
        [[missingScopes.scope3.categories["8"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["9"].included && !existingScopes.scope3Cat9) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!V${companyIndex + 2}`,
        [[missingScopes.scope3.categories["9"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["10"].included && !existingScopes.scope3Cat10) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!W${companyIndex + 2}`,
        [[missingScopes.scope3.categories["10"].value ?? 'Not specified but included in calculation']]
      );
      }

    if (missingScopes.scope3.categories["11"].included && !existingScopes.scope3Cat11) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!X${companyIndex + 2}`,
        [[missingScopes.scope3.categories["11"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["12"].included && !existingScopes.scope3Cat12) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!Y${companyIndex + 2}`,
        [[missingScopes.scope3.categories["12"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["13"].included && !existingScopes.scope3Cat13) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!Z${companyIndex + 2}`,
        [[missingScopes.scope3.categories["13"].value ?? 'Not specified but included in calculation']]
      );
    }
    
    if (missingScopes.scope3.categories["14"].included && !existingScopes.scope3Cat14) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AA${companyIndex + 2}`,
        [[missingScopes.scope3.categories["14"].value ?? 'Not specified but included in calculation']]
      );
    }

    if (missingScopes.scope3.categories["15"].included && !existingScopes.scope3Cat15) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AB${companyIndex + 2}`,
        [[missingScopes.scope3.categories["15"].value ?? 'Not specified but included in calculation']]
      );
    }

    return true;
  }

  /**
   * Determine the country of a company
   */
  async determineCompanyCountry(companyName: string, reportUrl?: string): Promise<CountryData | null> {
    try {
      const countryFinderModel = this.geminiModelService.getModel('countryFinder');
      
      const prompt = `
        I need you to determine the primary country of headquarters or registration for the company "${companyName}".
        
        Rules:
        - Identify the primary country where the company is headquartered
        - If the company has multiple headquarters, identify the main/global HQ location
        - For multinational companies, identify where the parent company is registered
        - Use reliable, recent sources for your determination
        ${reportUrl ? `- IMPORTANT: Use the company's report provided for additional context about the company's location and headquarters` : ''}
        
        Return your answer in the following JSON format only:
        
        {
          "country": "United States",
          "confidence": 9,
          "headquarters": "Cupertino, California, USA"
        }
        
        The confidence score should be from 0 to 10, where:
        - 10 = Directly confirmed from official company sources
        - 7-9 = From reliable news or business databases
        - 4-6 = From less authoritative sources
        - 1-3 = Based on limited or potentially outdated information
        - 0 = Unable to determine with any confidence
        ${reportUrl ? `- Add +1 to confidence if information is confirmed from the provided company report` : ''}
        
        Example 1:
        For "Apple Inc", the response would be:
        {
          "country": "United States",
          "confidence": 10,
          "headquarters": "Cupertino, California, USA"
        }
        
        Example 2:
        For a less known company:
        {
          "country": "Germany",
          "confidence": 6,
          "headquarters": "Berlin, Germany"
        }
      `;
      
      let result;
      
      if (reportUrl) {
        // Use the AI service to process the report URL for additional context
        result = await this.geminiApiService.handleGeminiCall(
          () => this.geminiAiService.processUrl(reportUrl, prompt, 'countryFinder'),
          2,
          1000,
          10 * 60 * 1000
        );
        
        // Parse the response since processUrl returns a string
        const parsedResponse = this.geminiApiService.safelyParseJson(result);
        
        if (parsedResponse && parsedResponse.country) {
          return parsedResponse as CountryData;
        }
        
        // If report URL processing fails, fall back to the standard method
        this.logger.warn(`Failed to determine country from report URL for ${companyName}, falling back to standard method`);
      }
      
      // Standard method without report URL
      result = await this.geminiApiService.handleGeminiCall(
        () => countryFinderModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        })
      );
      
      if (!result || !result) {
        throw new Error('Failed to generate content from Gemini');
      }
      
      const parsedResponse = this.geminiApiService.safelyParseJson(result.text);
      
      if (!parsedResponse || !parsedResponse.country) {
        this.logger.warn(`Failed to determine country for ${companyName}`);
        return null;
      }
      
      return parsedResponse as CountryData;
    } catch (error) {
      this.logger.error(`Error determining country for ${companyName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Calculate overall confidence level based on available data
   */
  calculateOverallConfidence(emissions: any, revenueData: any = null, countryData: any = null): number {
    // Start with base weights for each category
    const weights = {
      scope1: 0.2,
      scope2: 0.2,
      scope3: 0.3,
      revenue: 0.15,
      country: 0.15
    };
    
    let totalConfidence = 0;
    let totalWeight = 0;
    
    // Add scope1 confidence if available
    if (emissions?.scope1?.confidence) {
      totalConfidence += emissions.scope1.confidence * weights.scope1;
      totalWeight += weights.scope1;
    }
    
    // Add scope2 confidence (use average if both types available)
    const scope2Confidence = emissions?.scope2?.confidence;
    if (scope2Confidence) {
      totalConfidence += scope2Confidence * weights.scope2;
      totalWeight += weights.scope2;
    }
    
    // Add scope3 confidence if available
    if (emissions?.scope3?.confidence) {
      totalConfidence += emissions.scope3.confidence * weights.scope3;
      totalWeight += weights.scope3;
    }
    
    // Add revenue confidence if available
    if (revenueData?.confidence) {
      totalConfidence += revenueData.confidence * weights.revenue;
      totalWeight += weights.revenue;
    }
    
    // Add country confidence if available
    if (countryData?.confidence) {
      totalConfidence += countryData.confidence * weights.country;
      totalWeight += weights.country;
    }
    
    // Calculate weighted average confidence
    const overallConfidence = totalWeight > 0 ? totalConfidence / totalWeight : 0;
    
    // Round to one decimal place
    return Math.round(overallConfidence * 10) / 10;
  }

  /**
   * Add company data to spreadsheet
   */
  async addCompanyToSheet(
    company: string, 
    emissions: any, 
    reportUrl: string, 
    revenueData: any = null, 
    companyCategory: any = null,
    countryData: any = null,
  ): Promise<boolean> {
    console.log(`[STEP] Adding data for ${company} to spreadsheet`);
    
    try {
      // Extract the necessary data from emissions
      console.log(`[STEP] Extracting and formatting data for ${company}`);
      const reportingPeriod = emissions.reportingPeriod || 'Unknown';
      
      // Extract the standard unit used for emissions
      const emissionsUnit = emissions.standardUnit || 'tCO2e';
      console.log(`[DETAIL] Emissions unit: ${emissionsUnit}`);

      // Extract the third party assurance data
      const thirdPartyAssurance = emissions.thirdPartyAssurance || {};
      const thirdPartyAssuranceCompany = thirdPartyAssurance.company || null;
      
      // Prepare scope 1 emissions
      const scope1 = emissions.scope1 || {};
      const scope1Value = scope1.value || (scope1.included ? 'Not specified but included in calculation' : null);
      const scope1Confidence = scope1.confidence || null;
      const scope1Unit = scope1.unit || emissionsUnit;
      console.log(`[DETAIL] Scope 1: ${scope1Value || 'Not available'} ${scope1Unit}, Confidence: ${scope1Confidence || 'N/A'}`);
      
      // Prepare scope 2 emissions
      const scope2 = emissions.scope2 || {};
      const scope2LocationBased = scope2.locationBased || {};
      const scope2MarketBased = scope2.marketBased || {};
      const scope2LocationValue = scope2LocationBased.value || (scope2LocationBased.included && !scope2MarketBased.included ? 'Not specified but included in calculation' : null);
      const scope2MarketValue = scope2MarketBased.value || (scope2MarketBased.included ? 'Not specified but included in calculation' : null);
      const scope2LocationUnit = scope2LocationBased.unit || emissionsUnit;
      const scope2MarketUnit = scope2MarketBased.unit || emissionsUnit;
      console.log(`[DETAIL] Scope 2 (Location): ${scope2LocationValue || 'Not available'} ${scope2LocationUnit}`);
      console.log(`[DETAIL] Scope 2 (Market): ${scope2MarketValue || 'Not available'} ${scope2MarketUnit}`);
      
      // Prepare scope 3 emissions
      const scope3 = emissions.scope3 || {};
      const scope3Total = scope3.total || {};
      const scope3Value = scope3Total.value || null;
      const scope3Unit = scope3Total.unit || emissionsUnit;
      console.log(`[DETAIL] Scope 3 (Total): ${scope3Value || 'Not available'} ${scope3Unit}`);
      
      // Extract scope 3 categories
      console.log(`[STEP] Processing scope 3 categories for ${company}`);
      const scope3Categories = scope3.categories || {};
      const categoryValues = {};
      const categoryIncluded = {};
      const categoryUnits = {};
      
      // Map each category (1-15) to its value, inclusion status, and notes
      for (let i = 1; i <= 15; i++) {
        const category = scope3Categories[i.toString()];
        categoryValues[`category${i}`] = category?.value || (category?.included ? 'Not specified but included in calculation' : null);
        categoryIncluded[`category${i}Included`] = category?.included || false;
        categoryUnits[`category${i}Unit`] = category?.unit || emissionsUnit;
        
        if (category?.value) {
          console.log(`[DETAIL] Category ${i}: ${category.value} ${category?.unit || emissionsUnit}, Included: ${category.included ? 'Yes' : 'No'}`);
        }
      }
      
      // Get included and missing categories
      const includedCategories = scope3.includedCategories || [];
      const missingCategories = scope3.missingCategories || [];
      const scope3Confidence = scope3.confidence || null;
      console.log(`[DETAIL] Included categories: ${includedCategories.join(', ') || 'None'}`);
      console.log(`[DETAIL] Missing categories: ${missingCategories.join(', ') || 'None'}`);
      
      // Prepare revenue data
      console.log(`[STEP] Processing revenue data for ${company}`);
      let revenue = revenueData?.revenue || null;
      const revenueYear = revenueData?.year || null;
      const revenueSource = revenueData?.source || null;
      const revenueSourceUrl = revenueData?.sourceUrl || null;
      let revenueCurrency = revenueData?.currency || 'USD';

      if (revenueCurrency !== 'USD') {
        const exchangeRate = await this.getExchangeRate(reportingPeriod, revenueCurrency);
        if (exchangeRate) {
          revenue = revenue / exchangeRate;
          revenueCurrency = 'USD';
        } else {
          const revenueData = await this.convertCurrencyUsingGemini({
            revenue: revenue,
            currency: revenueCurrency,
            year: revenueYear,
            source: 'Gemini',
            confidence: 1
          }, {
            year: revenueYear,
            source: 'Gemini',
            confidence: 1
          });
        }
      }

      console.log(`[DETAIL] Revenue: ${revenue || 'Not available'} ${revenueCurrency}, Year: ${revenueYear || 'N/A'}`);
      console.log(`[DETAIL] Revenue source: ${revenueSource || 'Not available'}, URL: ${revenueSourceUrl || 'N/A'}`);
      
      // Prepare country data
      console.log(`[STEP] Processing country data for ${company}`);
      const country = countryData?.country || null;
      const countryConfidence = countryData?.confidence || null;
      console.log(`[DETAIL] Country: ${country || 'Not available'}, Confidence: ${countryConfidence || 'N/A'}`);
      
      // Calculate overall confidence level
      const overallConfidence = this.calculateOverallConfidence(emissions, revenueData, countryData);
      console.log(`[DETAIL] Overall confidence level: ${overallConfidence}`);
      
      // Format the row data
      console.log(`[STEP] Preparing spreadsheet data for ${company}`);
      const rowData = [
        company,
        overallConfidence,
        reportUrl,
        reportingPeriod,
        revenueYear,
        revenue,
        revenueCurrency,
        revenueSourceUrl,
        revenueData?.employeeCount,
        scope1Value,
        scope2LocationValue,
        scope2MarketValue,
        scope3Value,
        ...Object.values(categoryValues),
        ,
        country,
        companyCategory,
        thirdPartyAssuranceCompany,
        emissions.notes,
        revenueSource,
        revenueSourceUrl,
      ];
      
      // Add the data to the sheet using SheetsApiService for exponential backoff
      console.log(`[STEP] Adding main data row to 'Analysed Data' sheet for ${company}`);
      await this.sheetsApiService.appendValues(
        this.SPREADSHEET_ID,
        'Analysed Data!A2',
        [rowData]
      );
    
      console.log(`[RESULT] Successfully added all data for ${company} to spreadsheets`);
      return true;
    } catch (error) {
      console.log(`[ERROR] Error adding company data to sheet for ${company}: ${error.message}`);
      return false;
    }
  }

  /**
   * Calculate percentage change between current and previous values
   */
  calculateChangePercentage(currentValue: number | null, previousValue: number | null): number | null {
    if (currentValue === null || previousValue === null || previousValue === 0) {
      return null;
    }
    
    const change = ((currentValue - previousValue) / previousValue) * 100;
    return parseFloat(change.toFixed(2)); // Round to 2 decimal places
  }

  async updateCompanyRevenue(company: string, revenueData: RevenueData): Promise<boolean> {
    try {
      console.log(`[STEP] Updating revenue for ${company} in 'Analysed Data' sheet`);
      
      // Find the row index of the company in the 'Analysed Data' sheet
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `Analysed Data!A2:E`
      );

      const rows = data.values || [];
      const companyIndex = rows.findIndex(row => row[0] === company);

      if (companyIndex === -1) {
        console.log(`[ERROR] Company ${company} not found in 'Analysed Data' sheet`);
        return false;
      }

      // Update the cell with the new revenue data and year
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!F${companyIndex + 2}`,
        [[revenueData.revenue, revenueData.currency, revenueData.employeeCount]]
      );

      // Update the source url
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AH${companyIndex + 2}`,
        [[revenueData.source, revenueData.sourceUrl ?? '']]
      );

      

      console.log(`[RESULT] Successfully updated revenue for ${company} in 'Analysed Data' sheet`);
      return true;
    } catch (error) {
      console.log(`[ERROR] Error updating revenue for ${company}: ${error.message}`);
      return false;
    }
  }
      
  

  /**
   * Extract year from reporting period string
   */
  extractYearFromPeriod(reportingPeriod: string): number | null {
    if (!reportingPeriod) return null;
    
    // Look for calendar year patterns in the reporting period e.g. 2020
    let yearMatches = reportingPeriod.match(/\b(20\d{2})\b/g);
    
    if (yearMatches && yearMatches.length > 0) {
      // If multiple years found, take the later one (likely the end of reporting period)
      const years = yearMatches.map(y => parseInt(y));
      return Math.max(...years);
    }
    
    // Look for fiscal year patterns in FY2023 format (4-digit year)
    const fyFullYearMatches = reportingPeriod.match(/\bFY(20\d{2})\b/gi);
    if (fyFullYearMatches && fyFullYearMatches.length > 0) {
      // Extract the fiscal year (e.g., "2023" from "FY2023")
      const fyYears = fyFullYearMatches.map(fy => {
        const match = fy.match(/(20\d{2})/);
        return match ? parseInt(match[0]) : null;
      }).filter(Boolean);
      
      if (fyYears.length > 0) {
        // Take the latest fiscal year if multiple are found
        return Math.max(...fyYears);
      }
    }
    
    // Look for fiscal year patterns in the reporting period e.g. FY24
    const fyMatches = reportingPeriod.match(/\bFY(\d{2})\b/gi);
    if (fyMatches && fyMatches.length > 0) {
      // Extract the fiscal year number (e.g., "24" from "FY24")
      const fyNumbers = fyMatches.map(fy => {
        const match = fy.match(/\d{2}/);
        return match ? parseInt(match[0]) : null;
      }).filter(Boolean);
      
      if (fyNumbers.length > 0) {
        // Take the latest fiscal year if multiple are found
        const latestFy = Math.max(...fyNumbers);
        
        // Convert fiscal year to calendar year
        // Assuming fiscal year 24 refers to 2024
        // This is a simplification - in reality, fiscal years can span across calendar years
        return 2000 + latestFy;
      }
    }
    
    return null;
  }

  /**
   * Add company report URL to spreadsheet
   */
  async addCompanyReportUrlToSheet(company: string, reportUrl: string): Promise<boolean> {
    console.log(`[STEP] Adding report URL for ${company} to spreadsheet`);
    
    try {
      // Format the row data
      console.log(`[STEP] Preparing report URL data for ${company}`);
      const rowData = [
        company,
        reportUrl,
        new Date().toISOString().split('T')[0] // Current date in YYYY-MM-DD format
      ];
      
      // Add the data to the sheet
      console.log(`[STEP] Adding report URL data to 'Report URLs' sheet for ${company}`);
      await this.sheetsApiService.appendValues(
        this.SPREADSHEET_ID,
        'Analysed Data!A2',
        [rowData]
      );
      
      console.log(`[RESULT] Successfully added report URL for ${company} to spreadsheet`);
      return true;
    } catch (error) {
      console.log(`[ERROR] Error adding report URL to sheet for ${company}: ${error.message}`);
      return false;
    }
  }

  async getExchangeRates(): Promise<any> {
    const rates = await readFile('src/rates.json', 'utf8');
    return JSON.parse(rates);
  }

  async getExchangeRate(reportingPeriod: string, exchangeRateCountry: string): Promise<number | null> {
    const rates = await this.getExchangeRates();
    const year = this.extractYearFromPeriod(reportingPeriod);
    if (year !== 2021 && year !== 2022 && year !== 2023 && year !== 2024) {
      return null;
    } else {
      return rates[year][exchangeRateCountry];
    }
  }

  async updateCompanyCountry(company: string, country: string): Promise<boolean> {
    try {
      console.log(`[STEP] Updating country for ${company} in 'Analysed Data' sheet`);
      
      // Find the row index of the company in the 'Analysed Data' sheet
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `Analysed Data!A2:E`
      );

      const rows = data.values || [];
      const companyIndex = rows.findIndex(row => row[0] === company);

      if (companyIndex === -1) {
        console.log(`[ERROR] Company ${company} not found in 'Analysed Data' sheet`);
        return false;
      }

      // Update the cell with the new country data
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AD${companyIndex + 2}`,
        [[country]]
      );

      console.log(`[RESULT] Successfully updated country for ${company} in 'Analysed Data' sheet`);
      return true;
    } catch (error) {
      console.log(`[ERROR] Error updating country for ${company}: ${error.message}`);
      return false;
    }
  }
  
  async updateCompanyCategory(company: string, category: string): Promise<boolean> {
    try {
      console.log(`[STEP] Updating category for ${company} in 'Analysed Data' sheet`);
      
      // Find the row index of the company in the 'Analysed Data' sheet
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `Analysed Data!A2:E`
      );

      const rows = data.values || [];
      const companyIndex = rows.findIndex(row => row[0] === company);

      if (companyIndex === -1) {
        console.log(`[ERROR] Company ${company} not found in 'Analysed Data' sheet`);
        return false;
      }

      // Update the cell with the new category data
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AE${companyIndex + 2}`,
        [[category]]
      );

      console.log(`[RESULT] Successfully updated category for ${company} in 'Analysed Data' sheet`);
      return true;
    } catch (error) {
      console.log(`[ERROR] Error updating category for ${company}: ${error.message}`);
      return false;
    }
  }

  /**
   * Add attempt to sheet
   */
  async addAttemptToSheet(company: string, processedCompanyName: string): Promise<void> {
    const sheetName = 'ESG Report Attempts';
    const value = [company, processedCompanyName, new Date().toISOString().split('T')[0]];
    
    try {
      await this.sheetsApiService.appendValues(
        this.SPREADSHEET_ID,
        `${sheetName}!A1`,
        [value]
      );
      console.log(`[DETAIL] Added attempt record for ${company}`);
    } catch (error) {
      console.log(`[ERROR] Error adding attempt to sheet for ${company}: ${error.message}`);
    }
  }

  /**
   * Get attempts from sheet
   */
  async getAttemptsFromSheet(): Promise<any[]> {
    const sheetName = 'ESG Report Attempts';
    
    try {
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `${sheetName}!A:B`
      );
      
      const attempts = data.values || [];
      
      // Combine A & B
      return [...attempts.map(attempt => attempt[0]), ...attempts.map(attempt => attempt[1])];
    } catch (error) {
      console.log(`[ERROR] Error getting attempts from sheet: ${error.message}`);
      return [];
    }
  }

  async updateNewRevenue(company: string, revenueData: any): Promise<boolean> {
    try {
      console.log(`[STEP] Updating new revenue for ${company} in 'Analysed Data' sheet`);
      
      // Find the row index of the company in the 'Analysed Data' sheet
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `Analysed Data!A2:E`
      );

      const rows = data.values || [];
      const companyIndex = rows.findIndex(row => row[0] === company);

      if (companyIndex === -1) {
        console.log(`[ERROR] Company ${company} not found in 'Analysed Data' sheet`);
        return false;
      }

      // Update the cell with the new revenue data
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!F${companyIndex + 2}`,
        [[revenueData.revenue, revenueData.currency]]
      );

      console.log(`[RESULT] Successfully updated new revenue for ${company} in 'Analysed Data' sheet`);
      return true;
    } catch (error) {
      console.log(`[ERROR] Error updating new revenue for ${company}: ${error.message}`);
      return false;
    }
  }

  async checkMismatchedScope3(company: string, reportUrl: string, scope3Values): Promise<any> {
    // Call Gemini to check if the scope3 values are correct
    const response = await this.geminiAiService.processUrl(reportUrl, 
      `
        You are a helpful assistant that checks if the scope3 values are correct.
        Look for tables, charts, and text that explicitly mention greenhouse gas emissions.
        Ensure all values are converted to the same unit (preferably tons of CO2 equivalent).
        Identify the reporting period for the emissions data.
        
        For scope 3 emissions, carefully analyze which categories (1-15) are reported:
        1. Purchased goods and services
        2. Capital goods
        3. Fuel- and energy-related activities
        4. Upstream transportation and distribution
        5. Waste generated in operations
        6. Business travel
        7. Employee commuting
        8. Upstream leased assets
        9. Downstream transportation and distribution
        10. Processing of sold products
        11. Use of sold products
        12. End-of-life treatment of sold products
        13. Downstream leased assets
        14. Franchises
        15. Investments

        The exisitng scope3 values are: ${JSON.stringify(scope3Values)}
        Make sure to gather new values from the report, and ignore the existing values when scanning the report..
        The report url is: ${reportUrl}
        If a category is part of the scope 3 total but their absolute value is not provided, set the value to Not Specified.
        If a category is not part of the scope 3 total, set the value to null.
        Please check each individual scope 3 value and the sum, since I've already determined that there's a mismatch. Make sure the total sum was not hallucinated or that the individual scope 3 categories were not extracted incorrectly.
        If the sum of the scope 3 values is not equal to the scope 3 total, set the scope 3 total to the sum of the scope 3 values.
        Your response should be a JSON object with the following fields:
        {
          "isCorrect": true,
          "reason": "The scope3 values are correct",
          "scope3Values": {
            "scope3Total": 100,
            "scope3Cat1": 100,
            "scope3Cat2": 100,
            "scope3Cat3": 100,
            "scope3Cat4": 100,
            "scope3Cat5": 100,
            "scope3Cat6": 100,
            "scope3Cat7": 100,
            "scope3Cat8": 100,
            "scope3Cat9": 100,
            "scope3Cat10": 100,
            "scope3Cat11": 100,
            "scope3Cat12": 100,
            "scope3Cat13": 100,
            "scope3Cat14": 100,
            "scope3Cat15": 100,
          }
        }
      `, 
    )

    const parsedResponse = this.geminiApiService.safelyParseJson(response);
    return parsedResponse;
  }

  async updateScope3(company: string, reason: string, scope3Values: any, isCorrect: boolean): Promise<boolean> {
    try {
      console.log(`[STEP] Updating scope3 for ${company} in 'Analysed Data' sheet`);
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `Analysed Data!A2:E`
      );

      const rows = data.values || [];
      const companyIndex = rows.findIndex(row => row[0] === company);

      if (companyIndex === -1) {
        console.log(`[ERROR] Company ${company} not found in 'Analysed Data' sheet`);
        return false;
      }

      if (!scope3Values) {
        console.log(`[ERROR] Scope3 values are not provided for ${company}`);
        return false;
      }

      console.log(scope3Values, companyIndex);
      

      if (isCorrect) {
        return await this.sheetsApiService.updateValues(
          this.SPREADSHEET_ID,
          `Analysed Data!AS${companyIndex + 2}`,
          [['Original is Correct']]
        );
      }

      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AS${companyIndex + 2}`,
        [[reason]]
      );

      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!M${companyIndex + 2}`,
        [[scope3Values.scope3Total, scope3Values.scope3Cat1, scope3Values.scope3Cat2, scope3Values.scope3Cat3, scope3Values.scope3Cat4, scope3Values.scope3Cat5, scope3Values.scope3Cat6, scope3Values.scope3Cat7, scope3Values.scope3Cat8, scope3Values.scope3Cat9, scope3Values.scope3Cat10, scope3Values.scope3Cat11, scope3Values.scope3Cat12, scope3Values.scope3Cat13, scope3Values.scope3Cat14, scope3Values.scope3Cat15]]
      );

      console.log(`[RESULT] Successfully updated scope3 for ${company} in 'Analysed Data' sheet`);
      return true;
    } catch (error) {
      console.log(`[ERROR] Error updating scope3 for ${company}: ${error.message}`);
      return false;
    }
  }

  private normalizeValueForComparison(value: any): any {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      // Handle special string cases
      if (value.toLowerCase() === 'not specified but included in calculation') return value;
      // Try to convert string numbers to actual numbers
      const num = Number(value);
      return isNaN(num) ? value : num;
    }
    return value;
  }

  async updateIncorrectEmissions(company: string, incorrectEmissions: any): Promise<any> {
    // Cross reference the report with the emission values

    const data = await this.sheetsApiService.getValues(
      this.SPREADSHEET_ID,
      `Analysed Data!A2:E`
    );
    const rows = data.values || [];
    const companyIndex = rows.findIndex(row => row[0] === company);

    if (incorrectEmissions && incorrectEmissions.length > 0) {
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AY${companyIndex + 2}:AZ${companyIndex + 2}`,
        [[incorrectEmissions.map(emission => `${emission.companyName} - ${emission.scope}: ${emission.value} -> ${emission.correctValue} ------ (${emission.reason} --- ${emission.confidence})`).join('\n'), 'Not checked or updated']]
      );
    }



    return true;
  }

  async updateCompanyType(company: string, companyType: string, companyTypeConfidence: number, companyTypeReason: string): Promise<any> {
    const data = await this.sheetsApiService.getValues(
      this.SPREADSHEET_ID,
      `Analysed Data!A2:E`
    );
    const rows = data.values || [];
    const companyIndex = rows.findIndex(row => row[0] === company);

    if (companyIndex === -1) {
      console.log(`[ERROR] Company ${company} not found in 'Analysed Data' sheet`);
      return false;
    }

    await this.sheetsApiService.updateValues(
      this.SPREADSHEET_ID,
      `Analysed Data!AV${companyIndex + 2}:AY${companyIndex + 2}`,
      [[companyType, companyTypeConfidence, companyTypeReason]]
    );

    return true;
  }

  async updateCompanyNotes(company: string, notes: string): Promise<any> {
    const data = await this.sheetsApiService.getValues(
      this.SPREADSHEET_ID,
      `Analysed Data!A2:E`
    );
    const rows = data.values || [];
    const companyIndex = rows.findIndex(row => row[0] === company);

    await this.sheetsApiService.updateValues(
      this.SPREADSHEET_ID,
      `Analysed Data!AU${companyIndex + 2}`, 
      [[`${notes}`]]
    );
  }

  /**
   * Map scope names to their corresponding spreadsheet columns
   */
  private getScopeColumnMapping(): Record<string, string> {
    return {
      'scope1': 'J',
      'scope2Location': 'K',
      'scope2Market': 'L',
      'scope3': 'M',
      'scope3Cat1': 'N',
      'scope3Cat2': 'O',
      'scope3Cat3': 'P',
      'scope3Cat4': 'Q',
      'scope3Cat5': 'R',
      'scope3Cat6': 'S',
      'scope3Cat7': 'T',
      'scope3Cat8': 'U',
      'scope3Cat9': 'V',
      'scope3Cat10': 'W',
      'scope3Cat11': 'X',
      'scope3Cat12': 'Y',
      'scope3Cat13': 'Z',
      'scope3Cat14': 'AA',
      'scope3Cat15': 'AB'
    };
  }

  /**
   * Parse notes from column AU and extract emission updates
   */
  private parseEmissionUpdatesFromNotes(notes: string): Array<{scope: string, oldValue: string, newValue: string, reason: string}> {
    if (!notes || typeof notes !== 'string') {
      return [];
    }

    const updates = [];
    const lines = notes.split('\n').filter(line => line.trim());

    for (const line of lines) {
      // Match pattern: scope3: null -> 7492 ------ (explanation)
      const match = line.match(/^(?:[^-]+-\s*)?(\w+):\s*([^-]*?)\s*->\s*([^-]*?)\s*------\s*\((.*)\)$/);
      
      if (match) {
        const [, scope, oldValue, newValue, reason] = match;
        updates.push({
          scope: scope.trim(),
          oldValue: oldValue.trim(),
          newValue: newValue.trim(),
          reason: reason.trim()
        });
      }
    }

    return updates;
  }

  /**
   * Update checked reports by parsing notes from column AU and updating corresponding cells
   */
  async updateCheckedReports(companyName: string, fromRow: number = 2): Promise<{success: boolean, updatedCount: number, errors: string[]}> {
    try {
      console.log(`[STEP] Updating checked reports for ${companyName} starting from row ${fromRow}`);
      
      // Find the company row
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `Analysed Data!A${fromRow}:AZ`
      );

      const rows = data.values || [];
      const companyIndex = rows.findIndex(row => row[0] === companyName);

      if (companyIndex === -1) {
        console.log(`[ERROR] Company ${companyName} not found in 'Analysed Data' sheet`);
        return { success: false, updatedCount: 0, errors: [`Company ${companyName} not found`] };
      }

      // Calculate the actual row number in the sheet
      const actualRowNumber = fromRow + companyIndex;

      // Get notes from column AU (index 46, 0-based)
      const notes = rows[companyIndex][48]; // Column AY
      
      if (!notes) {
        console.log(`[INFO] No notes found in column AU for ${companyName}`);
        return { success: true, updatedCount: 0, errors: [] };
      }

      console.log(`[DETAIL] Found notes for ${companyName}: ${notes}`);

      // Parse the emission updates from notes
      const updates = this.parseEmissionUpdatesFromNotes(notes);
      
      if (updates.length === 0) {
        console.log(`[INFO] No valid emission updates found in notes for ${companyName}`);
        return { success: true, updatedCount: 0, errors: [] };
      }

      console.log(`[DETAIL] Parsed ${updates.length} emission updates for ${companyName}`);

      // Get column mapping
      const columnMapping = this.getScopeColumnMapping();
      
      const errors = [];
      let updatedCount = 0;

      // Process each update
      for (const update of updates) {
        try {
          const columnLetter = columnMapping[update.scope];
          
          if (!columnLetter) {
            console.log(`[WARNING] Unknown scope '${update.scope}' for ${companyName}`);
            errors.push(`Unknown scope: ${update.scope}`);
            continue;
          }

          // Prepare value for update - Google Sheets expects strings or null
          let valueToUpdate: string | null = update.newValue;
          if (update.newValue === 'null' || update.newValue === 'undefined') {
            valueToUpdate = '';
          }

          console.log(`[DETAIL] Updating ${update.scope} (${columnLetter}${actualRowNumber}) from '${update.oldValue}' to '${valueToUpdate}' for ${companyName}`);

          // Update the cell with correct row calculation
          await this.sheetsApiService.updateValues(
            this.SPREADSHEET_ID,
            `Analysed Data!${columnLetter}${actualRowNumber}`,
            [[valueToUpdate]]
          );

          updatedCount++;
          console.log(`[SUCCESS] Updated ${update.scope} for ${companyName}`);
          
        } catch (updateError) {
          const errorMsg = `Failed to update ${update.scope}: ${updateError.message}`;
          console.log(`[ERROR] ${errorMsg}`);
          errors.push(errorMsg);
        }
      }

      // Mark as processed by updating column AV with correct row calculation
      try {
        await this.sheetsApiService.updateValues(
          this.SPREADSHEET_ID,
          `Analysed Data!AX${actualRowNumber}`,
          [['Checked and Updated']]
        );
        console.log(`[SUCCESS] Marked ${companyName} as checked and updated`);
      } catch (error) {
        console.log(`[WARNING] Failed to mark ${companyName} as processed: ${error.message}`);
        errors.push(`Failed to mark as processed: ${error.message}`);
      }

      console.log(`[RESULT] Successfully updated ${updatedCount} emission values for ${companyName}`);
      
      return {
        success: errors.length === 0 || updatedCount > 0,
        updatedCount,
        errors
      };

    } catch (error) {
      console.log(`[ERROR] Error updating checked reports for ${companyName}: ${error.message}`);
      return {
        success: false,
        updatedCount: 0,
        errors: [error.message]
      };
    }
  }

  /**
   * Get all companies that have notes in column AU but haven't been processed yet
   */
  async getCompaniesWithUncheckedReports(fromRow: number = 2): Promise<any[]> {
    try {
      console.log(`[STEP] Fetching companies with unchecked reports from 'Analysed Data' sheet starting from row ${fromRow}`);
      
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `'Analysed Data'!A${fromRow}:AZ`
      );
      
      const rows = data.values || [];
      const companiesWithUncheckedReports = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const companyName = row[0];
        const notes = row[48]; // Column AY (0-indexed as 50)
        const processedFlag = row[49]; // Column AZ (0-indexed as 51)
        
        // Check if company has notes in AU but hasn't been processed (AV is not "Checked and Updated")
        if (companyName && notes && 
            typeof notes === 'string' && 
            notes.includes('->') && processedFlag !== 'Checked and Updated') {
          
          companiesWithUncheckedReports.push({
            name: companyName,
            notes: notes,
            rowIndex: fromRow + i // Correct calculation using fromRow parameter
          });
        }
      }

      console.log(`[RESULT] Found ${companiesWithUncheckedReports.length} companies with unchecked reports`);
      
      if (companiesWithUncheckedReports.length > 0) {
        console.log(`[DETAIL] Companies with unchecked reports: ${companiesWithUncheckedReports.map(c => c.name).slice(0, 5).join(', ')}${companiesWithUncheckedReports.length > 5 ? '...' : ''}`);
      }

      return companiesWithUncheckedReports;
    } catch (error) {
      console.log(`[ERROR] Error getting companies with unchecked reports: ${error.message}`);
      console.log(error);
      return [];
    }
  }

  /**
   * Clean "Not specified" values from scope3 categories (columns N:AB) 
   * when column AP contains "no" value
   */
  async cleanNotSpecifiedValuesFromNoRows(): Promise<{
    success: boolean,
    totalRowsProcessed: number,
    totalCellsCleaned: number,
    errors: string[]
  }> {
    try {
      console.log(`[STEP] Starting cleanup of "Not specified" values from rows with "no" in column AP`);
      
      // Get data including column AP (index 41)
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `'Analysed Data'!A2:AP`
      );
      
      const rows = data.values || [];
      const errors = [];
      let totalRowsProcessed = 0;
      let totalCellsCleaned = 0;
      
      console.log(`[DETAIL] Found ${rows.length} rows to process`);
      
      // Get scope column mapping for N:AB (indices 13-27)
      const scopeColumnMapping = this.getScopeColumnMapping();
      const scope3CategoryColumns = [
        'scope3Cat1', 'scope3Cat2', 'scope3Cat3', 'scope3Cat4', 'scope3Cat5',
        'scope3Cat6', 'scope3Cat7', 'scope3Cat8', 'scope3Cat9', 'scope3Cat10',
        'scope3Cat11', 'scope3Cat12', 'scope3Cat13', 'scope3Cat14', 'scope3Cat15'
      ];
      
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        const actualRowNumber = rowIndex + 2; // Adjust for starting at row 2
        const columnAPValue = row[41]; // Column AP (0-based index 41)
        
        // Check if column AP contains "no" (case insensitive)
        if (columnAPValue && typeof columnAPValue === 'string' && 
            columnAPValue.toLowerCase().trim() === 'no') {
          
          console.log(`[DETAIL] Found "no" in column AP for row ${actualRowNumber}, company: ${row[0] || 'Unknown'}`);
          totalRowsProcessed++;
          
          // Check columns N:AB (indices 13-27) for "Not specified" values
          for (const scopeColumn of scope3CategoryColumns) {
            const columnIndex = this.getScopeColumnIndex(scopeColumn);
            const cellValue = row[columnIndex];
            
            if (cellValue && typeof cellValue === 'string' && 
                cellValue.toLowerCase().includes('not specified')) {
              
              try {
                const columnLetter = scopeColumnMapping[scopeColumn];
                console.log(`[DETAIL] Clearing "Not specified" value in ${columnLetter}${actualRowNumber}: "${cellValue}"`);
                
                // Clear the cell by setting it to empty string
                await this.sheetsApiService.updateValues(
                  this.SPREADSHEET_ID,
                  `Analysed Data!${columnLetter}${actualRowNumber}`,
                  [['']]
                );
                
                totalCellsCleaned++;
                console.log(`[SUCCESS] Cleared cell ${columnLetter}${actualRowNumber}`);
                
              } catch (updateError) {
                const errorMsg = `Failed to clear cell ${scopeColumn} in row ${actualRowNumber}: ${updateError.message}`;
                console.log(`[ERROR] ${errorMsg}`);
                errors.push(errorMsg);
              }
            }
          }
        }
      }
      
      console.log(`[RESULT] Cleanup completed. Processed ${totalRowsProcessed} rows with "no" in column AP, cleaned ${totalCellsCleaned} cells`);
      
      return {
        success: errors.length === 0,
        totalRowsProcessed,
        totalCellsCleaned,
        errors
      };
      
    } catch (error) {
      console.log(`[ERROR] Error in cleanNotSpecifiedValuesFromNoRows: ${error.message}`);
      return {
        success: false,
        totalRowsProcessed: 0,
        totalCellsCleaned: 0,
        errors: [error.message]
      };
    }
  }

  /**
   * Helper method to get column index for a scope category
   */
  private getScopeColumnIndex(scopeColumn: string): number {
    const columnMapping = {
      'scope3Cat1': 13,
      'scope3Cat2': 14,
      'scope3Cat3': 15,
      'scope3Cat4': 16,
      'scope3Cat5': 17,
      'scope3Cat6': 18,
      'scope3Cat7': 19,
      'scope3Cat8': 20,
      'scope3Cat9': 21,
      'scope3Cat10': 22,
      'scope3Cat11': 23,
      'scope3Cat12': 24,
      'scope3Cat13': 25,
      'scope3Cat14': 26,
      'scope3Cat15': 27
    };
    return columnMapping[scopeColumn] || -1;
  }

  /**
   * Calculate average emissions per benchmark unit for every GHG emission category by industry
   * Uses revenue benchmarking (kg CO2e/USD) for most categories and employee benchmarking (kg CO2e/employee) 
   * for Categories 1 (office-based), 5, 6, and 7. Processes each category individually and removes outliers 
   * specific to each category. Results are in kg CO2e per USD or kg CO2e per employee 
   * (emissions converted from tons to kg)
   */
  async calculateAverageEmissionsByIndustry(): Promise<any> {
    try {
      this.logger.log('Fetching all companies from spreadsheet');
      const allCompanies = await this.getExistingCompaniesFromSheet({ fromRow: 2, toRow: 10710 });
      
      this.logger.log(`Processing ${allCompanies.length} total companies`);
      
      // Filter companies with basic required data (name, category, revenue)
      const companiesWithBasicData = this.filterCompaniesWithBasicData(allCompanies);
      this.logger.log(`Found ${companiesWithBasicData.length} companies with basic data`);
      
      // Group companies by industry category and revenue range using CATEGORY_SCHEMA
      const companiesByIndustryAndRevenue = this.groupCompaniesByIndustryFromSchema(companiesWithBasicData);
      
      // Calculate averages for each industry, revenue range, and category individually with outlier removal
      // This now also tracks summary data during processing to avoid duplicate calculations
      const { results: industryAverages, summary: companiesUsedSummary } = this.calculateIndustryAveragesByCategory(companiesByIndustryAndRevenue);
      
      return {
        success: true,
        totalCompaniesProcessed: allCompanies.length,
        companiesWithBasicData: companiesWithBasicData.length,
        industriesAnalyzed: Object.keys(industryAverages).length,
        companiesUsedSummary: companiesUsedSummary,
        industries: industryAverages,
        metadata: {
          ghgCategories: this.getGhgCategoryDefinitions(),
          industryCategories: this.getValidIndustryCategories(),
          revenueRanges: this.getRevenueRanges(),
          calculationMethod: 'Average emissions per benchmark unit with category-specific outlier removal, segmented by revenue ranges, using only audited companies. Requires minimum 3 companies per calculation. Benchmarks: revenue (kg CO2e/USD) for most categories, employee count (kg CO2e/employee) for Categories 1 (office-based), 5, 6, and 7',
          dataCompleteness: 'Only audited companies (with third party assurance) included per category based on data availability for that specific category, segmented by revenue to avoid skewing',
          outlierRemovalMethod: 'Interquartile Range (IQR) with 1.0x multiplier (stricter bounds) applied individually to each category within each revenue segment',
          emissionsUnit: 'kg CO2e per USD (revenue-based) or kg CO2e per employee (employee-based), converted from tons CO2e to kg CO2e',
          calculationFlow: [
            '1. Filter companies with basic data (name, industry category from CATEGORY_SCHEMA, revenue, employee count for applicable categories) AND third party assurance (audited companies only)',
            '2. Group companies by industry category AND revenue range (0-50M, 50M-250M, 250M-1B, 1B+)',
            '3. For each industry, revenue range, and each GHG category:',
            '   a. Determine benchmark type: employee count for Categories 1 (office-based industries), 5, 6, 7; revenue for all others',
            '   b. Calculate emissions per benchmark unit (USD or employee) for companies with valid data for that category',
            '   c. Remove outliers specific to that category using stricter IQR method (1.0x instead of 1.5x)',
            '   d. Calculate averages using non-outlier companies for that category within the revenue segment (minimum 3 companies required)',
            '4. Companies can be included in some categories but excluded from others based on outlier status',
            '5. Revenue segmentation prevents large companies from skewing averages for smaller companies',
            '6. Employee-based benchmarking for employee-related categories (waste, travel, commuting) and office-based purchased goods/services',
            '7. Only audited companies (with third party assurance) are included for data quality assurance'
          ]
        }
      };
    } catch (error) {
      this.logger.error(`Error calculating average emissions by industry: ${error.message}`);
      throw error;
    }
  }

  /**
   * Filter companies that have basic required data (name, industry category, revenue)
   * and have been audited (third party assurance)
   */
  private filterCompaniesWithBasicData(companies: any[]): any[] {
    return companies.filter(company => {
      // Must have basic required data
      const hasBasicData = company.name && company.category && company.revenue;
      if (!hasBasicData) return false;
      
      // Must have valid revenue for calculations
      const hasValidRevenue = this.isValidValue(company.revenue) && company.revenueSource !== 'Could not find annual report' && !company.revenueSource.includes('Gemini');
      if (!hasValidRevenue) return false;
      
      // Must have a valid industry category from CATEGORY_SCHEMA
      const hasValidIndustryCategory = this.isValidIndustryCategory(company.category);
      if (!hasValidIndustryCategory) return false;
      
      // Must have been audited (third party assurance)
      const hasThirdPartyAssurance = this.hasValidThirdPartyAssurance(company.thirdPartyAssuranceCompany);
      if (!hasThirdPartyAssurance) return false;
      
      return true;
    });
  }

  /**
   * Check if a company has valid third party assurance (has been audited)
   */
  private hasValidThirdPartyAssurance(thirdPartyAssuranceCompany: any): boolean {
    return thirdPartyAssuranceCompany && 
           typeof thirdPartyAssuranceCompany === 'string' && 
           thirdPartyAssuranceCompany.trim() !== '' &&
           thirdPartyAssuranceCompany.toLowerCase() !== 'null' &&
           thirdPartyAssuranceCompany.toLowerCase() !== 'undefined';
  }

  /**
   * Check if the industry category is valid according to CATEGORY_SCHEMA
   */
  private isValidIndustryCategory(category: string): boolean {
    return CATEGORY_SCHEMA.includes(category);
  }

  /**
   * Define revenue ranges for segmentation to avoid skewing
   */
  private getRevenueRanges(): Array<{name: string, min: number, max: number}> {
    return [
      { name: '0-50M', min: 0, max: 50000000 },
      { name: '50M-250M', min: 50000000, max: 250000000 },
      { name: '250M-1B', min: 250000000, max: 1000000000 },
      { name: '1B+', min: 1000000000, max: 10000000000 }
    ];
  }

  /**
   * Determine which revenue range a company belongs to
   */
  private getRevenueRangeForCompany(revenue: number): string {
    const ranges = this.getRevenueRanges();
    const range = ranges.find(r => revenue >= r.min && revenue < r.max);
    return range ? range.name : 'Unknown';
  }

  /**
   * Group companies by their industry category and revenue range using only valid CATEGORY_SCHEMA categories
   */
  private groupCompaniesByIndustryFromSchema(companies: any[]): Record<string, Record<string, any[]>> {
    const grouped: Record<string, Record<string, any[]>> = {};
    
    companies.forEach(company => {
      const industry = company.category;
      const revenue = this.parseNumericValue(company.revenue);
      const revenueRange = this.getRevenueRangeForCompany(revenue);
      
      // Only group if the industry is in CATEGORY_SCHEMA and has valid revenue
      if (this.isValidIndustryCategory(industry) && revenue > 0) {
        if (!grouped[industry]) {
          grouped[industry] = {};
        }
        if (!grouped[industry][revenueRange]) {
          grouped[industry][revenueRange] = [];
        }
        grouped[industry][revenueRange].push(company);
      }
    });
    
    return grouped;
  }

  /**
   * Get list of all companies used in calculations, organized by industry
   */
  private getCompaniesUsedInCalculations(companiesByIndustry: Record<string, any[]>): Record<string, any[]> {
    const companiesUsed: Record<string, any[]> = {};
    
    Object.entries(companiesByIndustry).forEach(([industry, companies]) => {
      if (companies.length >= 3) { // Only industries that have enough data for analysis
        companiesUsed[industry] = companies.map(company => ({
          name: company.name,
          revenue: company.revenue,
          reportingPeriod: company.reportingPeriod,
          country: company.country,
          scope1: company.scope1,
          scope2Location: company.scope2Location,
          scope2Market: company.scope2Market,
          scope3: company.scope3,
          scope3Categories: {
            cat1: company.scope3Cat1,
            cat2: company.scope3Cat2,
            cat3: company.scope3Cat3,
            cat4: company.scope3Cat4,
            cat5: company.scope3Cat5,
            cat6: company.scope3Cat6,
            cat7: company.scope3Cat7,
            cat8: company.scope3Cat8,
            cat9: company.scope3Cat9,
            cat10: company.scope3Cat10,
            cat11: company.scope3Cat11,
            cat12: company.scope3Cat12,
            cat13: company.scope3Cat13,
            cat14: company.scope3Cat14,
            cat15: company.scope3Cat15
          }
        }));
      }
    });
    
    return companiesUsed;
  }

  /**
   * Get valid industry categories from CATEGORY_SCHEMA
   */
  private getValidIndustryCategories(): string[] {
    return [...CATEGORY_SCHEMA];
  }

  /**
   * Check if a value is a valid numeric value for calculations
   */
  private isValidValue(value: any): boolean {
    if (typeof value === 'number' && !isNaN(value) && value > 0) {
      return true;
    }
    if (typeof value === 'string') {
      return value.trim() !== '';
    }
    return false;
  }

  /**
   * Calculate industry averages for each category individually with category-specific outlier removal
   * Now segments by revenue ranges to avoid skewing and tracks summary data during processing
   */
  private calculateIndustryAveragesByCategory(companiesByIndustryAndRevenue: Record<string, Record<string, any[]>>): { results: Record<string, any>; summary: Record<string, any> } {
    const results: Record<string, any> = {};
    const companiesUsedSummary: Record<string, any> = {};
    
    Object.entries(companiesByIndustryAndRevenue).forEach(([industry, revenueRanges]) => {
      results[industry] = {};
      companiesUsedSummary[industry] = {};
      
      Object.entries(revenueRanges).forEach(([revenueRange, companies]) => {
        if (companies.length < 3) {
          // Skip revenue ranges with less than 3 companies
          this.logger.warn(`Skipping industry '${industry}' revenue range '${revenueRange}' - insufficient data (${companies.length} companies)`);
          return;
        }
        
        const { averages, summary } = this.calculateIndustryAveragesWithCategorySpecificOutliers(companies, industry);
        results[industry][revenueRange] = averages;
        companiesUsedSummary[industry][revenueRange] = summary;
      });
      
      // Remove empty industry entries
      if (Object.keys(results[industry]).length === 0) {
        delete results[industry];
        delete companiesUsedSummary[industry];
      }
    });
    
    return {
      results,
      summary: companiesUsedSummary
    };
  }

  /**
   * Calculate averages for a single industry across all GHG categories with category-specific outlier removal
   * Returns both averages and summary data to avoid duplicate calculations
   * Uses appropriate benchmarking (revenue vs employee count) based on category and industry type
   */
  private calculateIndustryAveragesWithCategorySpecificOutliers(companies: any[], industryCategory: string): { averages: any; summary: Record<string, any> } {
    const ghgCategories = this.getGhgCategoryMappings();
    const averages: Record<string, any> = {};
    const summary: Record<string, any> = {};
    
    Object.entries(ghgCategories).forEach(([categoryName, fieldName]) => {
      // Determine which benchmark to use for this category and industry
      const useEmployeeBenchmark = this.shouldUseEmployeeBenchmark(categoryName, industryCategory);
      
      // Calculate emissions ratios using appropriate benchmark
      const emissionsRatios = useEmployeeBenchmark 
        ? this.calculateEmissionsPerEmployeeForCategory(companies, fieldName)
        : this.calculateEmissionsPerDollarForCategory(companies, fieldName);
      
      const benchmarkUnit = useEmployeeBenchmark ? 'kg CO2e/employee' : 'kg CO2e/USD';
      const benchmarkType = useEmployeeBenchmark ? 'employee' : 'revenue';
      
      // Track summary data for this category
      summary[categoryName] = {
        totalCompaniesInSegment: companies.length,
        companiesWithValidData: emissionsRatios.length,
        companiesAfterOutlierRemoval: 0,
        outliersRemoved: 0,
        benchmarkType: benchmarkType
      };
      
      if (emissionsRatios.length > 0) {
        // Remove outliers specific to this category
        const cleanedData = this.removeOutliers(emissionsRatios);
        const outliersRemoved = emissionsRatios.length - cleanedData.length;
        
        // Update summary with actual outlier data
        summary[categoryName].companiesAfterOutlierRemoval = cleanedData.length;
        summary[categoryName].outliersRemoved = outliersRemoved;
        
        if (cleanedData.length >= 3) {
          // Log outlier removal for transparency
          if (outliersRemoved > 0) {
            this.logger.debug(`${categoryName} (${benchmarkType}): Removed ${outliersRemoved} outliers from ${emissionsRatios.length} companies (${((outliersRemoved/emissionsRatios.length)*100).toFixed(1)}%)`);
          }
          
          const averageKey = useEmployeeBenchmark ? 'averageEmissionsPerEmployee' : 'averageEmissionsPerDollar';
          
          averages[categoryName] = {
            [averageKey]: this.calculateMean(cleanedData),
            unit: benchmarkUnit,
            benchmarkType: benchmarkType,
            companiesIncluded: cleanedData.length,
            totalCompaniesWithData: emissionsRatios.length,
            outliersRemoved: outliersRemoved,
            outlierPercentage: parseFloat(((outliersRemoved/emissionsRatios.length)*100).toFixed(2)),
            standardDeviation: this.calculateStandardDeviation(cleanedData),
            median: this.calculateMedian(cleanedData),
            min: Math.min(...cleanedData),
            max: Math.max(...cleanedData)
          };
        } else {
          this.logger.warn(`${categoryName} (${benchmarkType}): Insufficient data after outlier removal (${cleanedData.length} companies remaining, minimum 3 required)`);
        }
      } else {
        this.logger.warn(`${categoryName} (${benchmarkType}): No companies with valid data for this category`);
      }
    });
    
    return {
      averages: {
        totalCompanies: companies.length,
        categories: averages
      },
      summary
    };
  }



  /**
   * Calculate emissions per dollar for a specific category
   * Converts from tons CO2e to kg CO2e before calculating ratio
   * IMPORTANT: Only includes companies with valid numeric values for both emissions and revenue
   */
  private calculateEmissionsPerDollarForCategory(companies: any[], fieldName: string): number[] {
    return companies
      .map(company => {
        const emissionsInTons = this.parseNumericValue(company[fieldName]);
        const revenue = this.parseNumericValue(company.revenue);
        
        // Only calculate ratio if both values are valid positive numbers
        if (emissionsInTons > 0 && revenue > 0) {
          // Convert tons CO2e to kg CO2e (multiply by 1000)
          const emissionsInKg = emissionsInTons * 1000;
          return emissionsInKg / revenue;
        }
        return null;
      })
      .filter(value => value !== null) as number[];
  }

  /**
   * Parse a value to a numeric type safely
   * Returns 0 for invalid numeric strings to ensure they're filtered out in calculations
   */
  private parseNumericValue(value: any): number {
    if (typeof value === 'number' && !isNaN(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      // Handle common non-numeric cases that might slip through validation
      if (trimmed === '' || trimmed.toLowerCase() === 'n/a' || trimmed.toLowerCase() === 'not specified') {
        return 0;
      }
      const parsed = parseFloat(trimmed);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * Remove outliers using the Interquartile Range (IQR) method with stricter bounds
   * This operates on emissions per dollar ratios, NOT raw emissions data
   */
  private removeOutliers(data: number[]): number[] {
    if (data.length < 4) {
      return data; // Can't calculate quartiles with less than 4 data points
    }
    
    const sorted = [...data].sort((a, b) => a - b);
    const q1Index = Math.floor(sorted.length * 0.25);
    const q3Index = Math.floor(sorted.length * 0.75);
    
    const q1 = sorted[q1Index];
    const q3 = sorted[q3Index];
    const iqr = q3 - q1;
    
    // Stricter outlier bounds: reduced from 1.5 to 1.0 for more aggressive outlier removal
    const lowerBound = q1 - (1.0 * iqr);
    const upperBound = q3 + (1.0 * iqr);
    
    return data.filter(value => value >= lowerBound && value <= upperBound);
  }

  /**
   * Calculate the mean of an array of numbers
   */
  private calculateMean(data: number[]): number {
    if (data.length === 0) return 0;
    return data.reduce((sum, value) => sum + value, 0) / data.length;
  }

  /**
   * Calculate the median of an array of numbers
   */
  private calculateMedian(data: number[]): number {
    if (data.length === 0) return 0;
    
    const sorted = [...data].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 0) {
      return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
  }

  /**
   * Calculate the standard deviation of an array of numbers
   */
  private calculateStandardDeviation(data: number[]): number {
    if (data.length <= 1) return 0;
    
    const mean = this.calculateMean(data);
    const squaredDifferences = data.map(value => Math.pow(value - mean, 2));
    const variance = this.calculateMean(squaredDifferences);
    
    return Math.sqrt(variance);
  }

  /**
   * Get GHG category mappings to spreadsheet field names
   */
  private getGhgCategoryMappings(): Record<string, string> {
    return {
      'scope1': 'scope1',
      'scope2_location': 'scope2Location',
      'scope2_market': 'scope2Market',
      'scope3_total': 'scope3',
      'scope3_cat1_purchased_goods_services': 'scope3Cat1',
      'scope3_cat2_capital_goods': 'scope3Cat2',
      'scope3_cat3_fuel_energy_activities': 'scope3Cat3',
      'scope3_cat4_upstream_transportation': 'scope3Cat4',
      'scope3_cat5_waste_generated': 'scope3Cat5',
      'scope3_cat6_business_travel': 'scope3Cat6',
      'scope3_cat7_employee_commuting': 'scope3Cat7',
      'scope3_cat8_upstream_leased_assets': 'scope3Cat8',
      'scope3_cat9_downstream_transportation': 'scope3Cat9',
      'scope3_cat10_processing_sold_products': 'scope3Cat10',
      'scope3_cat11_use_sold_products': 'scope3Cat11',
      'scope3_cat12_end_of_life_treatment': 'scope3Cat12',
      'scope3_cat13_downstream_leased_assets': 'scope3Cat13',
      'scope3_cat14_franchises': 'scope3Cat14',
      'scope3_cat15_investments': 'scope3Cat15'
    };
  }

  /**
   * Get GHG category definitions for documentation
   */
  private getGhgCategoryDefinitions(): Record<string, string> {
    return {
      'scope1': 'Direct GHG emissions from owned or controlled sources',
      'scope2_location': 'Indirect GHG emissions from purchased electricity (location-based)',
      'scope2_market': 'Indirect GHG emissions from purchased electricity (market-based)',
      'scope3_total': 'All other indirect GHG emissions in value chain',
      'scope3_cat1_purchased_goods_services': 'Purchased goods and services',
      'scope3_cat2_capital_goods': 'Capital goods',
      'scope3_cat3_fuel_energy_activities': 'Fuel and energy related activities',
      'scope3_cat4_upstream_transportation': 'Upstream transportation and distribution',
      'scope3_cat5_waste_generated': 'Waste generated in operations',
      'scope3_cat6_business_travel': 'Business travel',
      'scope3_cat7_employee_commuting': 'Employee commuting',
      'scope3_cat8_upstream_leased_assets': 'Upstream leased assets',
      'scope3_cat9_downstream_transportation': 'Downstream transportation and distribution',
      'scope3_cat10_processing_sold_products': 'Processing of sold products',
      'scope3_cat11_use_sold_products': 'Use of sold products',
      'scope3_cat12_end_of_life_treatment': 'End-of-life treatment of sold products',
      'scope3_cat13_downstream_leased_assets': 'Downstream leased assets',
      'scope3_cat14_franchises': 'Franchises',
      'scope3_cat15_investments': 'Investments'
    };
  }

  /**
   * Check and fix companies with revenue source errors
   * Re-extracts revenue data from reports and converts currencies to USD
   */
  async fixCompaniesWithRevenueSourceErrors(): Promise<{
    success: boolean,
    totalCompaniesProcessed: number,
    successfulUpdates: number,
    errors: string[]
  }> {
    try {
      this.logger.log('Starting revenue source error fix process');
      
      const companiesWithErrors = await this.getCompaniesWithRevenueSourceErrors();
      this.logger.log(`Found ${companiesWithErrors.length} companies with revenue source errors`);
      
      if (companiesWithErrors.length === 0) {
        return {
          success: true,
          totalCompaniesProcessed: 0,
          successfulUpdates: 0,
          errors: []
        };
      }
      
      const results = await this.processCompaniesWithRevenueErrors(companiesWithErrors);
      
      this.logger.log(`Revenue error fix completed. Processed: ${results.totalCompaniesProcessed}, Updated: ${results.successfulUpdates}`);
      
      return results;
    } catch (error) {
      this.logger.error(`Error in fixCompaniesWithRevenueSourceErrors: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get companies that have revenue source errors
   */
  private async getCompaniesWithRevenueSourceErrors(): Promise<any[]> {
    try {
      const allCompanies = await this.getExistingCompaniesFromSheet({ fromRow: 2, toRow: 10710 });
      
      return allCompanies.filter(company => {
        console.log(company);
        const hasRevenueSourceError = company.revenueUrl && 
          company.revenueUrl === 'Error occurred during retrieval';
        
        
        return hasRevenueSourceError;
      });
    } catch (error) {
      this.logger.error(`Error getting companies with revenue source errors: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process companies with revenue errors and update their data in batches of 5
   */
  private async processCompaniesWithRevenueErrors(companies: any[]): Promise<{
    success: boolean,
    totalCompaniesProcessed: number,
    successfulUpdates: number,
    errors: string[]
  }> {
    const errors: string[] = [];
    let successfulUpdates = 0;
    const BATCH_SIZE = 5;
    
    // Split companies into batches
    const batches = this.createBatches(companies, BATCH_SIZE);
    this.logger.log(`Processing ${companies.length} companies in ${batches.length} batches of ${BATCH_SIZE}`);
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      this.logger.log(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} companies`);
      
      // Process all companies in the current batch in parallel
      const batchPromises = batch.map(async (company) => {
        try {
          this.logger.log(`Processing revenue error fix for ${company.name}`);
          
          const revenueData = await this.reExtractRevenueFromReport(company);
          
          if (revenueData && revenueData.revenue) {
            const convertedRevenueData = await this.convertRevenueToUSD(revenueData, company);
            const updateSuccess = await this.updateCompanyRevenueData(company.name, convertedRevenueData);
            
            if (updateSuccess) {
              this.logger.log(`Successfully updated revenue for ${company.name}`);
              return { success: true, company: company.name };
            } else {
              const error = `Failed to update spreadsheet for ${company.name}`;
              this.logger.error(error);
              return { success: false, company: company.name, error };
            }
          } else {
            const error = `Failed to extract revenue data for ${company.name}`;
            this.logger.error(error);
            return { success: false, company: company.name, error };
          }
        } catch (error) {
          const errorMsg = `Error processing ${company.name}: ${error.message}`;
          this.logger.error(errorMsg);
          return { success: false, company: company.name, error: errorMsg };
        }
      });
      
      // Wait for all companies in the current batch to complete
      const batchResults = await Promise.all(batchPromises);
      
      // Process batch results
      for (const result of batchResults) {
        if (result.success) {
          successfulUpdates++;
        } else {
          errors.push(result.error);
        }
      }
      
      this.logger.log(`Batch ${batchIndex + 1}/${batches.length} completed. Successful: ${batchResults.filter(r => r.success).length}, Errors: ${batchResults.filter(r => !r.success).length}`);
      
      // Add a small delay between batches to prevent overwhelming the API
      if (batchIndex < batches.length - 1) {
        this.logger.log(`Waiting 2 seconds before processing next batch...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    return {
      success: errors.length === 0,
      totalCompaniesProcessed: companies.length,
      successfulUpdates,
      errors
    };
  }

  /**
   * Helper method to split an array into batches of specified size
   */
  private createBatches<T>(array: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < array.length; i += batchSize) {
      batches.push(array.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Re-extract revenue data from company report using Gemini
   */
  private async reExtractRevenueFromReport(company: any): Promise<RevenueData | null> {
    try {
      const targetYear = this.extractTargetYear(company.reportingPeriod);
      
      this.logger.log(`Re-extracting revenue data for ${company.name} from report: ${company.reportUrl}`);
      
      const prompt = this.buildRevenueAndCurrencyExtractionPrompt(company.name, targetYear);
      
      const response = await this.geminiAiService.processUrl(
        company.reportUrl,
        prompt,
        'revenueAndCurrencyExtraction'
      );
      
      const parsedResponse = this.geminiApiService.safelyParseJson(response);
      
      if (!parsedResponse?.revenue) {
        this.logger.warn(`No revenue found in re-extraction for ${company.name}`);
        return null;
      }
      
      return {
        revenue: parsedResponse.revenue,
        year: parsedResponse.year || targetYear,
        source: `Re-extracted from ${this.determineReportSource(company.reportUrl)}`,
        confidence: parsedResponse.confidence || 8,
        sourceUrl: company.reportUrl,
        currency: parsedResponse.currency || 'USD',
        employeeCount: parsedResponse.employeeCount || null
      };
    } catch (error) {
      this.logger.error(`Error re-extracting revenue for ${company.name}: ${error.message}`);
      return null;
    }
  }

  /**
   * Build enhanced prompt for revenue and currency extraction with currency validation
   */
  private buildRevenueAndCurrencyExtractionPrompt(companyName: string, targetYear: string): string {
    return `
      Extract accurate financial information for ${companyName} from this document.
      ${targetYear !== 'recent' ? `Focus on data for the year ${targetYear}.` : 'Use the most recent data available.'}
      
      CRITICAL INSTRUCTIONS FOR CURRENCY DETECTION:
      1. Find the total revenue/turnover for the company
      2. CAREFULLY identify the currency used for revenue reporting
      3. Look for currency symbols (£, €, ¥, $, etc.) or currency codes (USD, EUR, GBP, JPY, etc.)
      4. Check if revenue is reported in local currency or converted to USD
      5. Ensure revenue value matches the identified currency
      6. Convert revenue to a single numeric value (not thousands or millions notation)
      7. Find employee count if available
      
      CURRENCY VALIDATION REQUIREMENTS:
      - If you see "$" without country specification, determine if it's USD, CAD, AUD, etc. based on company location
      - If you see "million" or "thousand", convert to full numeric value
      - Be explicit about currency - don't assume USD unless clearly stated
      - Look for phrases like "in millions of USD" or "£ thousands"
      
      Return ONLY a JSON object in this exact format:
      {
        "revenue": 1234567890,
        "currency": "USD",
        "year": "2023",
        "employeeCount": 50000,
        "confidence": 9,
        "currencyConfidence": 9,
        "currencySource": "Clearly stated in financial statements as USD millions"
      }
      
      IMPORTANT: Set currencyConfidence (1-10) based on how certain you are about the currency identification.
      If currency is ambiguous, set currencyConfidence to 5 or lower and explain in currencySource.
    `;
  }

  /**
   * Convert revenue to USD if needed using exchange rates or Gemini for currency conversion
   */
   async convertRevenueToUSD(revenueData: RevenueData, company: any): Promise<RevenueData> {
    if (revenueData.currency === 'USD') {
      this.logger.log(`Revenue for ${company.name} already in USD`);
      return revenueData;
    }
    
    try {
      // First try using existing exchange rate data
      const exchangeRate = await this.getExchangeRate(company.reportingPeriod, revenueData.currency);
      
      if (exchangeRate && exchangeRate > 0) {
        const convertedRevenue = revenueData.revenue / exchangeRate;
        this.logger.log(`Converted ${company.name} revenue from ${revenueData.currency} to USD using stored rate: ${exchangeRate}`);
        
        return {
          ...revenueData,
          revenue: convertedRevenue,
          currency: 'USD',
          source: `${revenueData.source} (converted from ${revenueData.currency} using stored exchange rate)`
        };
      }
      
      // Fallback to Gemini for currency conversion
      return await this.convertCurrencyUsingGemini(revenueData, company);
    } catch (error) {
      this.logger.error(`Error converting currency for ${company.name}: ${error.message}`);
      return revenueData; // Return original data if conversion fails
    }
  }

  /**
   * Use Gemini to convert currency when exchange rate data is not available
   */
   async convertCurrencyUsingGemini(revenueData: RevenueData, company: any): Promise<RevenueData> {
    try {
      const year = this.extractYearFromPeriod(company.reportingPeriod);
      
      const prompt = `
        Convert the following revenue amount to USD:
        - Amount: ${revenueData.revenue}
        - Currency: ${revenueData.currency}
        - Year: ${year}
        
        Please find the accurate exchange rate for ${revenueData.currency} to USD for the year ${year}.
        Use reliable financial data sources for the exchange rate. If the year is in the future then just return the latest exchange rate.
        
        Return ONLY a JSON object:
        {
          "convertedAmount": 1234567890,
          "currency": "USD"
        }
      `;
      
      const conversionModel = this.geminiModelService.getModel('revenueConversion');
      const response = await this.geminiApiService.handleGeminiCall(
        () => conversionModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        })
      );

      console.log(response.text);
      
      const parsedResponse = this.geminiApiService.safelyParseJson(response.text);
      
      if (parsedResponse?.convertedAmount) {
        this.logger.log(`Converted ${company.name} revenue from ${revenueData.currency} to USD using Gemini conversion`);
        
        return {
          ...revenueData,
          revenue: parsedResponse.convertedAmount,
          currency: 'USD',
          source: `${revenueData.source} (converted from ${revenueData.currency} using Gemini with rate ${parsedResponse.exchangeRate})`
        };
      }
      
      this.logger.warn(`Failed to convert currency using Gemini for ${company.name}`);
      return revenueData;
    } catch (error) {
      this.logger.error(`Error in Gemini currency conversion for ${company.name}: ${error.message}`);
      return revenueData;
    }
  }

  /**
   * Update company revenue data in the spreadsheet with improved error handling
   */
  private async updateCompanyRevenueData(companyName: string, revenueData: RevenueData): Promise<boolean> {
    try {
      this.logger.log(`Updating revenue data for ${companyName} in spreadsheet`);
      
      // Find the company row
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `Analysed Data!A2:AH`
      );

      const rows = data.values || [];
      const companyIndex = rows.findIndex(row => row[0] === companyName);

      if (companyIndex === -1) {
        this.logger.error(`Company ${companyName} not found in 'Analysed Data' sheet`);
        return false;
      }

      const actualRowNumber = companyIndex + 2;

      // Update revenue (column F), currency (column G), and source (column AH)
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!F${actualRowNumber}:G${actualRowNumber}`,
        [[revenueData.revenue, revenueData.currency]]
      );

      // Update revenue source (column AH)
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AH${actualRowNumber}`,
        [[revenueData.source]]
      );

      // Update source URL if available (column AI)
      if (revenueData.sourceUrl) {
        await this.sheetsApiService.updateValues(
          this.SPREADSHEET_ID,
          `Analysed Data!AI${actualRowNumber}`,
          [[revenueData.sourceUrl]]
        );
      }

      this.logger.log(`Successfully updated revenue data for ${companyName}`);
      return true;
    } catch (error) {
      this.logger.error(`Error updating revenue data for ${companyName}: ${error.message}`);
      return false;
    }
  }

  /**
   * Calculate emissions per employee for a specific category/field
   */
  private calculateEmissionsPerEmployeeForCategory(companies: any[], fieldName: string): number[] {
    return companies
      .filter(company => {
        // Must have valid emissions data for this category and employee count
        const emissionsValue = this.parseNumericValue(company[fieldName]);
        const employeeCount = this.parseNumericValue(company.employeeCount);
        return this.isValidValue(emissionsValue) && this.isValidValue(employeeCount) && employeeCount > 0;
      })
      .map(company => {
        const emissionsValue = this.parseNumericValue(company[fieldName]);
        const employeeCount = this.parseNumericValue(company.employeeCount);
        // Convert tons to kg and calculate per employee
        return (emissionsValue * 1000) / employeeCount;
      });
  }

  /**
   * Determine if an industry should be considered office-based for Category 1 benchmarking
   */
  private isOfficeBased(industryCategory: string): boolean {
    const officeBasedIndustries = [
      'Financial intermediation services, except insurance and pension funding services',
      'Insurance and pension funding services, except compulsory social security services',
      'Services auxiliary to financial intermediation',
      'Financial services nec',
      'Research and development services',
      'Public administration and defence services; compulsory social security services',
      'Education services',
      'Health and social work services',
      'Membership organisation services n.e.c.',
      'Recreational, cultural and sporting services',
      'Other services',
      'Supporting and auxiliary transport services; travel agency services'
    ];
    
    return officeBasedIndustries.includes(industryCategory);
  }

  /**
   * Determine whether to use employee count or revenue as benchmark for a specific category
   */
  private shouldUseEmployeeBenchmark(categoryName: string, industryCategory: string): boolean {
    // Categories that should always use employee benchmarking
    const alwaysEmployeeBased = [
      'scope3_cat5_waste_generated',
      'scope3_cat6_business_travel', 
      'scope3_cat7_employee_commuting'
    ];
    
    if (alwaysEmployeeBased.includes(categoryName)) {
      return true;
    }
    
    // Category 1 (purchased goods and services) only for office-based industries
    if (categoryName === 'scope3_cat1_purchased_goods_services') {
      return this.isOfficeBased(industryCategory);
    }
    
    return false;
  }

  /**
   * Validate if a revenue source URL refers to the correct company
   */
  async validateRevenueSourceUrl(companyName: string, revenueUrl: string): Promise<boolean> {
    try {
      this.logger.log(`Validating revenue source URL for ${companyName}: ${revenueUrl}`);
            
      const prompt = `
        I need to validate if this revenue source URL refers to the correct company.
        
        Company Name: ${companyName}
        Revenue Source URL: ${revenueUrl}
        
        Please analyze the content at this URL and determine if it contains financial information 
        (revenue, financial statements, annual reports) for the company "${companyName}".
        
        Consider:
        1. Does the document mention the company name "${companyName}" or closely related variations?
        2. Does the URL domain or file path suggest it belongs to the company?
        3. Does the content contain financial data that would be relevant for revenue extraction?
        4. Is this likely to be the company's own official financial document?
        
        Return your response in JSON format:
        {
          "isValid": true/false,
          "confidence": 0-10,
          "companyMentioned": "company name found in the document",
          "reasoning": "brief explanation of why this URL is valid or invalid"
        }
        
        If the URL does not refer to ${companyName} or contains financial data for a different company,
        return isValid: false.
      `;
      
      const result = await this.geminiApiService.handleGeminiCall(
        () => this.geminiAiService.processUrl(revenueUrl, prompt, 'revenueSourceValidator'),
        2,
        1000,
        10 * 60 * 1000
      );
      
      if (!result) {
        this.logger.warn(`Failed to validate revenue source URL for ${companyName}, assuming invalid`);
        return false;
      }
      
      const parsedResponse = this.geminiApiService.safelyParseJson(result);
      
      if (!parsedResponse) {
        this.logger.warn(`Failed to parse validation response for ${companyName}, assuming invalid`);
        return false;
      }
      
      const isValid = parsedResponse.isValid === true;
      const confidence = parsedResponse.confidence || 0;
      
      this.logger.log(`Validation result for ${companyName}: ${isValid ? 'VALID' : 'INVALID'} (confidence: ${confidence}/10)`);
      if (parsedResponse.reasoning) {
        this.logger.log(`Reasoning: ${parsedResponse.reasoning}`);
      }
      
      // Only consider valid if confidence is reasonable (> 5) and explicitly marked as valid
      return isValid && confidence > 5;
      
    } catch (error) {
      this.logger.error(`Error validating revenue source URL for ${companyName}: ${error.message}`);
      // On error, assume the URL is invalid to be safe
      return false;
    }
  }

  /**
   * Compare company names between "Companies to Request" and "Analysed Data" sheets
   * Uses Gemini AI to intelligently determine if companies with the same names but different countries
   * are actually the same company or different entities, then outputs results to a new sheet
   */
  async compareCompanyNamesBetweenSheets(): Promise<any> {
    console.log(`[STEP] Starting company name comparison between sheets`);
    
    try {
      // Get companies from both sheets
      const requestCompanies = await this.getCompaniesFromRequestSheet();
      const analysedCompanies = await this.getExistingCompaniesFromSheet({ fromRow: 2, toRow: 10700 });
      
      console.log(`[INFO] Found ${requestCompanies.length} companies in 'Companies to Request' sheet`);
      console.log(`[INFO] Found ${analysedCompanies.length} companies in 'Analysed Data' sheet`);
      
      // Initialize the comparison sheet with headers
      await this.initializeCompanyComparisonSheet();
      
      let totalMatches = 0;
      const errors = [];
      const batchSize = 10;
      
      console.log(`[BATCHING] Processing ${requestCompanies.length} companies in batches of ${batchSize}`);
      
      // Process companies in batches of 10
      for (let i = 0; i < requestCompanies.length; i += batchSize) {
        const batch = requestCompanies.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(requestCompanies.length / batchSize);
        
        console.log(`[BATCH ${batchNumber}/${totalBatches}] Processing companies ${i + 1}-${Math.min(i + batchSize, requestCompanies.length)} of ${requestCompanies.length}`);
        
        // Process each company in the current batch
        const batchPromises = batch.map(async (requestCompany, index) => {
          try {
            const companyIndex = i + index + 1;
            console.log(`[PROCESSING ${companyIndex}/${requestCompanies.length}] Checking matches for: ${requestCompany.name}`);
            
            // Step 1: Use Gemini to find potential matches from the full list
            const potentialMatches = await this.findPotentialMatchesWithGemini(
              requestCompany.name, 
              requestCompany.country, 
              analysedCompanies
            );
            
            if (potentialMatches.length > 0) {
              console.log(`[POTENTIAL] Found ${potentialMatches.length} potential matches for ${requestCompany.name}`);
              
              // Step 2: Use Gemini to do detailed analysis of each potential match
              for (const potentialMatch of potentialMatches) {
                const detailedAnalysis = await this.compareCompaniesWithGemini(
                  requestCompany.name, 
                  requestCompany.country, 
                  potentialMatch.name, 
                  potentialMatch.country
                );
                
                if (detailedAnalysis.isSameCompany) {
                  // Immediately append this match to the sheet
                  await this.appendMatchToSheet({
                    requestCompanyName: requestCompany.name,
                    requestCompanyCountry: requestCompany.country,
                    analysedCompanyName: potentialMatch.name,
                    analysedCompanyCountry: potentialMatch.country,
                    confidence: detailedAnalysis.confidence,
                    reasoning: detailedAnalysis.reasoning
                  });
                  
                  totalMatches++;
                  console.log(`[CONFIRMED] Match confirmed and added to sheet: ${requestCompany.name} <-> ${potentialMatch.name}`);
                } else {
                  console.log(`[REJECTED] Match rejected for ${requestCompany.name} <-> ${potentialMatch.name}: ${detailedAnalysis.reasoning}`);
                }
              }
            } else {
              console.log(`[NO MATCHES] No potential matches found for ${requestCompany.name}`);
            }
          } catch (error) {
            console.log(`[ERROR] Error processing ${requestCompany.name}: ${error.message}`);
            errors.push(`Error processing ${requestCompany.name}: ${error.message}`);
          }
        });
        
        // Wait for all companies in the current batch to complete
        await Promise.all(batchPromises);
        
        console.log(`[BATCH COMPLETE] Finished batch ${batchNumber}/${totalBatches}. Total matches so far: ${totalMatches}`);
        
        // Add a small delay between batches to avoid rate limiting
        if (i + batchSize < requestCompanies.length) {
          console.log(`[DELAY] Waiting 2 seconds before next batch...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      console.log(`[RESULT] Found ${totalMatches} confirmed matches and added them to the sheet`);
      
      return {
        success: true,
        message: `Successfully compared ${requestCompanies.length} request companies with ${analysedCompanies.length} analysed companies`,
        totalRequestCompanies: requestCompanies.length,
        totalAnalysedCompanies: analysedCompanies.length,
        totalMatches,
        errors
      };
      
    } catch (error) {
      console.log(`[ERROR] Error in company name comparison: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get companies and countries from "Companies to Request" sheet
   */
  private async getCompaniesFromRequestSheet(): Promise<Array<{name: string, country: string}>> {
    console.log(`[STEP] Getting companies and countries from 'Companies to Request' sheet`);
    
    try {
      // Get companies and countries from columns A and B
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        "'Companies to Request'!A2:B"
      );
      
      const rows = data.values || [];
      const companies = rows.map(row => ({
        name: row[0] || '',
        country: row[1] || 'Unknown'
      })).filter(company => company.name.trim() !== '');
      
      console.log(`[RESULT] Found ${companies.length} companies in 'Companies to Request' sheet`);
      return companies;
    } catch (error) {
      console.log(`[ERROR] Error getting companies from request sheet: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Basic company name similarity check (more lenient than the existing isSameCompany method)
   */
  private isSameCompanyBasic(company1: string, company2: string): boolean {
    // Normalize company names
    const normalize = (name: string) => {
      return name.toLowerCase()
        .replace(/\s+/g, '') // Remove spaces
        .replace(/[,.'"]/g, '') // Remove punctuation
        .replace(/\b(inc|corp|co|ltd|llc|group|plc|sa|ag|gmbh|srl|spa|bv|nv)\b/g, ''); // Remove common company suffixes
    };
    
    const normalized1 = normalize(company1);
    const normalized2 = normalize(company2);
    
    // Check if the core company names are similar (at least 70% overlap)
    const shorter = normalized1.length < normalized2.length ? normalized1 : normalized2;
    const longer = normalized1.length >= normalized2.length ? normalized1 : normalized2;
    
    // Check for exact match or if shorter name is contained in longer name
    return longer.includes(shorter) || this.calculateStringSimilarity(normalized1, normalized2) > 0.7;
  }
  
  /**
   * Calculate string similarity using Levenshtein distance
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;
    
    if (len1 === 0) return len2 === 0 ? 1 : 0;
    if (len2 === 0) return 0;
    
    const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(null));
    
    for (let i = 0; i <= len1; i++) matrix[0][i] = i;
    for (let j = 0; j <= len2; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= len2; j++) {
      for (let i = 1; i <= len1; i++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j - 1][i] + 1,
          matrix[j][i - 1] + 1,
          matrix[j - 1][i - 1] + cost
        );
      }
    }
    
    const maxLen = Math.max(len1, len2);
    return (maxLen - matrix[len2][len1]) / maxLen;
  }
  
    /**
   * Use first-word matching followed by Gemini AI to find potential matches
   */
  private async findPotentialMatchesWithGemini(
    targetCompanyName: string,
    targetCompanyCountry: string,
    analysedCompanies: any[]
  ): Promise<Array<{name: string, country: string}>> {
    try {
      // Step 1: Extract first word from target company name and filter analyzed companies
      const targetFirstWord = this.extractFirstWord(targetCompanyName);
      console.log(`[FILTERING] Filtering by first word: "${targetFirstWord}" for ${targetCompanyName}`);
      
      const firstWordMatches = analysedCompanies.filter(company => {
        const companyFirstWord = this.extractFirstWord(company.name);
        return this.compareFirstWords(targetFirstWord, companyFirstWord);
      });
      
      console.log(`[FILTERED] Found ${firstWordMatches.length} companies with matching first words out of ${analysedCompanies.length} total`);
      
      if (firstWordMatches.length === 0) {
        console.log(`[NO MATCHES] No companies found with matching first word for ${targetCompanyName}`);
        return [];
      }
      
      // Step 2: Use Gemini to analyze only the first-word matches
      const companyList = firstWordMatches.map((company, index) => 
        `${index + 1}. ${company.name} (${company.country || 'Unknown'})`
      ).join('\n');

      const prompt = `
        I need to find potential matches for a target company from a pre-filtered list of companies that share the same first word.
        
        Target Company:
        - Name: ${targetCompanyName}
        - Country: ${targetCompanyCountry}
        
        Pre-filtered Companies (sharing first word "${targetFirstWord}"):
        ${companyList}
        
        Please identify which companies from this list could potentially be the same as the target company.
        
        Consider:
        1. Similar company names (ignoring corporate suffixes like Inc, Corp, Ltd, SA, GmbH, etc.)
        2. Companies that could be subsidiaries, branches, or international divisions
        3. Companies with slight name variations due to legal requirements in different countries
        4. Don't worry about country differences - multinational companies operate globally
        
        Rules:
        - Only include companies that have a reasonable chance of being the same entity
        - Be somewhat liberal in your matching to avoid missing legitimate matches
        - Since these companies already share the same first word, focus on the overall company identity
        
        Return your response in JSON format:
        {
          "potentialMatches": [
            {
              "companyNumber": 1,
              "reasoning": "brief explanation of why this could be a match"
            }
          ]
        }
        
        If no potential matches are found, return: {"potentialMatches": []}
      `;
      
      const result = await this.geminiApiService.handleGeminiCall(
        () => this.geminiModelService.getModel('companyNameChecker').generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
        2, // maxRetries
        1000, // initialDelayMs
        30000 // timeoutMs - shorter timeout since we're processing smaller lists
      );

      if (!result) {
        console.log(`[WARNING] Failed to get Gemini response for finding matches for ${targetCompanyName}`);
        return [];
      }

      const parsedResponse = this.geminiApiService.safelyParseJson(result.text);
      
      console.log(`[GEMINI RESPONSE] for ${targetCompanyName}:`, parsedResponse);
      
      if (!parsedResponse || !Array.isArray(parsedResponse.potentialMatches)) {
        console.log(`[WARNING] Invalid Gemini response format for ${targetCompanyName}`);
        return [];
      }

      // Convert the potential matches back to company objects from the first-word filtered list
      const potentialMatches = parsedResponse.potentialMatches
        .map(match => {
          const companyIndex = match.companyNumber - 1; // Convert to 0-based index
          if (companyIndex >= 0 && companyIndex < firstWordMatches.length) {
            return {
              name: firstWordMatches[companyIndex].name,
              country: firstWordMatches[companyIndex].country || 'Unknown'
            };
          }
          return null;
        })
        .filter(Boolean); // Remove null values

      console.log(`[POTENTIAL] Gemini found ${potentialMatches.length} potential matches for ${targetCompanyName} from ${firstWordMatches.length} first-word matches`);
      
      return potentialMatches;
      
    } catch (error) {
      console.log(`[ERROR] Error finding potential matches for ${targetCompanyName}: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Extract the first meaningful word from a company name
   */
  private extractFirstWord(companyName: string): string {
    if (!companyName) return '';
    
    // Clean and normalize the company name
    const cleaned = companyName.trim().toLowerCase();
    
    // Split by spaces and get the first word
    const words = cleaned.split(/\s+/);
    if (words.length > 0) {
      return words[0];
    }
    
    return cleaned;
  }
  
  /**
   * Compare two first words to see if they match (with some flexibility)
   */
  private compareFirstWords(word1: string, word2: string): boolean {
    if (!word1 || !word2) return false;
    
    const normalize = (word: string) => word.toLowerCase().trim();
    
    const normalized1 = normalize(word1);
    const normalized2 = normalize(word2);
    
    // Exact match
    if (normalized1 === normalized2) return true;
    
    // Check if one is contained in the other (for cases like "apple" vs "applecomputer")
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) return true;
    
    return false;
  }

  /**
   * Use Gemini AI to compare two companies considering their names and countries
   */
  private async compareCompaniesWithGemini(
    company1Name: string, 
    company1Country: string, 
    company2Name: string, 
    company2Country: string
  ): Promise<{isSameCompany: boolean, confidence: number, reasoning: string}> {
    try {
      const prompt = `
        I need to determine if these two companies are the same entity or different companies.
        
        Company 1:
        - Name: ${company1Name}
        - Country: ${company1Country}
        
        Company 2:
        - Name: ${company2Name}
        - Country: ${company2Country}
        
        Please analyze whether these represent the same company considering:
        1. Are the company names the same or very similar (ignoring common corporate suffixes like Inc, Corp, Ltd, etc.)?
        2. Could these be the same company operating in different countries (e.g., subsidiaries, international branches)?
        3. Could these be completely different companies that happen to have similar names?
        4. Are there any obvious indicators that these are different entities?
        
        Consider that:
        - Large multinational companies often have operations in multiple countries
        - Some companies have similar names but are completely unrelated
        - Country differences don't automatically mean different companies
        - Legal entity suffixes may vary by country (Inc vs Ltd vs SA vs GmbH, etc.)
        
        Return your response in JSON format:
        {
          "isSameCompany": true/false,
          "confidence": 0-10 (10 being absolutely certain),
          "reasoning": "detailed explanation of your decision"
        }
      `;
      
      const result = await this.geminiApiService.handleGeminiCall(
        () => this.geminiModelService.getModel('companyNameChecker').generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
        2, // maxRetries
        1000, // initialDelayMs
        30000 // timeoutMs
      );

      if (!result) {
        console.log(`[WARNING] Failed to get Gemini response for ${company1Name} vs ${company2Name}`);
        return {
          isSameCompany: false,
          confidence: 0,
          reasoning: "Failed to get AI analysis"
        };
      }

      const parsedResponse = this.geminiApiService.safelyParseJson(result.text);
      
      if (!parsedResponse || typeof parsedResponse.isSameCompany !== 'boolean') {
        console.log(`[WARNING] Invalid Gemini response for ${company1Name} vs ${company2Name}`);
        return {
          isSameCompany: false,
          confidence: 0,
          reasoning: "Invalid AI response format"
        };
      }

      return {
        isSameCompany: parsedResponse.isSameCompany,
        confidence: parsedResponse.confidence || 0,
        reasoning: parsedResponse.reasoning || "No reasoning provided"
      };
      
    } catch (error) {
      console.log(`[ERROR] Error in Gemini comparison for ${company1Name} vs ${company2Name}: ${error.message}`);
      return {
        isSameCompany: false,
        confidence: 0,
        reasoning: `Error during AI analysis: ${error.message}`
      };
    }
  }
  
  /**
   * Initialize the company comparison sheet with headers
   */
  private async initializeCompanyComparisonSheet(): Promise<void> {
    console.log(`[STEP] Initializing company comparison results sheet`);
    
    try {
      // Clear any existing data in the sheet first
      try {
        await this.sheetsApiService.clearValues(
          this.SPREADSHEET_ID,
          "'Company Name Matches'!A:G"
        );
      } catch (clearError) {
        // If clearing fails, it might be because the sheet doesn't exist yet, which is fine
        console.log(`[INFO] Could not clear existing data (sheet may not exist yet): ${clearError.message}`);
      }
      
      // Prepare header row
      const headers = [
        'Request Company Name',
        'Request Company Country', 
        'Analysed Company Name',
        'Analysed Company Country',
        'AI Confidence (0-10)',
        'AI Reasoning',
        'Comparison Date'
      ];
      
      // Add headers to the sheet
      await this.sheetsApiService.appendValues(
        this.SPREADSHEET_ID,
        "'Company Name Matches'!A1",
        [headers]
      );
      
      console.log(`[SUCCESS] Initialized 'Company Name Matches' sheet with headers`);
      
    } catch (error) {
      console.log(`[ERROR] Error initializing comparison sheet: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Append a single match to the company comparison sheet
   */
  private async appendMatchToSheet(match: {
    requestCompanyName: string;
    requestCompanyCountry: string;
    analysedCompanyName: string;
    analysedCompanyCountry: string;
    confidence: number;
    reasoning: string;
  }): Promise<void> {
    try {
      const rowData = [
        match.requestCompanyName,
        match.requestCompanyCountry,
        match.analysedCompanyName, 
        match.analysedCompanyCountry,
        match.confidence,
        match.reasoning,
        new Date().toISOString().split('T')[0] // Current date in YYYY-MM-DD format
      ];
      
      // Append the single match to the sheet
      await this.sheetsApiService.appendValues(
        this.SPREADSHEET_ID,
        "'Company Name Matches'!A2",
        [rowData]
      );
      
      console.log(`[SUCCESS] Appended match to sheet: ${match.requestCompanyName} <-> ${match.analysedCompanyName}`);
      
    } catch (error) {
      console.log(`[ERROR] Error appending match to sheet: ${error.message}`);
      throw error;
    }
  }
}