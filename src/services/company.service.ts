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
    const searchResults = await this.searchService.performWebSearch(`${companyName} ${year} annual report revenue pdf`);

    // Use gemini to check which one is the annual report based ont the results
    const result = await this.geminiApiService.handleGeminiCall(
      () => this.geminiModelService.getModel('annualReportFinder').generateContent({
        contents: [{ role: 'user', parts: [{ text: `I need to find the annual report for ${companyName} in ${year}. Please return the link to the annual report, or a document containing its revenue in the JSON format. The results are: ${searchResults.map(result => result.link).join(', ')}. If you cannot find the annual report, return null.` }] }],
      })
    );

    let parsedResponse = this.geminiApiService.safelyParseJson(result?.candidates[0]?.content?.parts[0]?.text);

    console.log(result);

    if (!parsedResponse || !parsedResponse.annualReportUrl) {
      // Try again with a different search query
      const searchResults = await this.searchService.performWebSearch(`${companyName} ${year} revenue`);
      const result = await this.geminiApiService.handleGeminiCall(
        () => this.geminiModelService.getModel('annualReportFinder').generateContent({
          contents: [{ role: 'user', parts: [{ text: `I need to find the revenue for ${companyName} in ${year}. Please return the link to any website or document containing or referencing its revenue in the JSON format. It can be an external website, press release or a document on the company's website. The results are: ${searchResults.map(result => { return `link: ${result.link} - title: ${result.title} - snippet: ${result.snippet}` }).join(', ')}. If you cannot find any relevant report with revenue, return the most likely link to the annual report.` }] }],
        })
      );
      console.log(result?.candidates[0]?.content?.parts[0]?.text);
      parsedResponse = this.geminiApiService.safelyParseJson(result?.candidates[0]?.content?.parts[0]?.text);

      if (!parsedResponse || !parsedResponse.annualReportUrl) {
        return null;
      }
    }

    return parsedResponse.annualReportUrl;
  }

  /**
   * Get company revenue data
   */
  async getCompanyRevenue(companyName: string, reportingPeriod?: string): Promise<RevenueData | null> {
    try {
      // Extract target year from reporting period if provided
      let targetYear = 'recent';
      if (reportingPeriod) {
        const year = this.extractYearFromPeriod(reportingPeriod);
        if (year) {
          targetYear = year.toString();
        }
      }
      
      // First try getting revenue data from Financial Modeling Prep API
      const fmpRevenueData = await this.getCompanyRevenueFromFMP(companyName, targetYear);
      console.log(targetYear, fmpRevenueData);
      if (fmpRevenueData && fmpRevenueData.year === targetYear) {
        this.logger.log(`Retrieved revenue data for ${companyName} from FMP API`);
        return fmpRevenueData;
      }
      
      // If FMP data not found, fall back to Gemini
      this.logger.log(`No revenue data found in FMP for ${companyName}, using Gemini fallback`);
            
      // Create user prompt with company and period information
      let userPrompt = `I need accurate financial information about ${companyName}${reportingPeriod ? ' specifically for the same period as their emissions report: ' + reportingPeriod : ' for the most recent period'}.${targetYear !== 'recent' ? ' Please focus on finding revenue data for the year ' + targetYear + '.' : ''}${reportingPeriod ? ' IMPORTANT: Please prioritize finding revenue data that matches the reporting period ' + reportingPeriod + ' to ensure data consistency with the emissions report.' : ''}`;

      
      let result;

      // Check if the company has an annual report
      const annualReport = await this.searchForCompanyAnnualReport(companyName, targetYear);
      if (annualReport) {
        this.logger.log(`Found annual report for ${companyName}: ${annualReport}`);
        userPrompt += `\n\nIMPORTANT: Please use the revenue data from the attached pdf to ensure data consistency with the emissions report. Only return the numerical value of the revenue. It must be in the specified JSON format. "revenue": 0, "currency": "The currency of the revenue", "year": "The year of the revenue". Revenue must be converted to single $ value, not thousands or millions.`;

        const response = await this.geminiAiService.processUrl(annualReport, userPrompt, 'revenueFromAnnualReport');
        console.log(response);
        const parsedResponse = this.geminiApiService.safelyParseJson(response);
        result = {
          ...parsedResponse,
          source: 'Annual Report',
          sourceUrl: annualReport,
          year: targetYear
        }
      } else {
        return null;
      }
      
      if (!result || !result) {
        throw new Error('Failed to generate content from Gemini');
      }
      
      return result as RevenueData;
    } catch (error) {
      this.logger.error(`Error getting revenue for ${companyName}: ${error.message}`);
      
      // Capture the annual report URL if it was found before the error
      try {
        const targetYear = reportingPeriod ? (this.extractYearFromPeriod(reportingPeriod)?.toString() || 'recent') : 'recent';
        const annualReport = await this.searchForCompanyAnnualReport(companyName, targetYear);
        
        if (annualReport) {
          this.logger.log(`Despite error, found annual report for ${companyName}: ${annualReport}`);
          return {
            revenue: null,
            year: targetYear,
            source: 'Annual Report (Error occurred during processing)',
            confidence: 1,
            sourceUrl: annualReport,
            currency: 'USD'
          };
        }
      } catch (innerError) {
        this.logger.error(`Error in error handler when getting annual report URL: ${innerError.message}`);
      }
      
      // If no annual report was found or an error occurred while finding it, return a minimal valid object
      return {
        revenue: null,
        year: reportingPeriod ? (this.extractYearFromPeriod(reportingPeriod)?.toString() || 'unknown') : 'unknown',
        source: 'Error occurred during retrieval',
        confidence: 0,
        currency: 'USD'
      };
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
  async getCompanyCategory(companyName: string): Promise<string | null> {
    const companyCategoryModel = this.geminiModelService.getModel('companyCategory');

    const result = await this.geminiApiService.handleGeminiCall(
      () => companyCategoryModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: `I need to find the category of ${companyName}. Please return the most appropriate category possible in the JSON format. If the comony is Other business services, return Other business services - {The type of service provided by the company}. Do not provide any additional text.` }] }],
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

  async getExistingCompaniesFromSheet({ fromRow }: { fromRow?: number } = {}): Promise<any[]> {
    try {
      console.log(`[STEP] Fetching data from 'Analysed Data' sheet`);
      
      // Use the SheetsApiService with built-in exponential backoff
      const data = await this.sheetsApiService.getValues(
        this.SPREADSHEET_ID,
        `'Analysed Data'!A${fromRow || 2}:AR`
      );
      
      const rows = data.values || [];
      const companies = rows.map(row => ({ 
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
        scope3Mismatch: row[43]
      })).filter(Boolean);

      return companies;
    } catch (error) {
      console.log(`[ERROR] Error getting companies from sheet: ${error.message}`);
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
  async determineCompanyCountry(companyName: string): Promise<CountryData | null> {
    try {
      const countryFinderModel = this.geminiModelService.getModel('countryFinder');
      
      const prompt = `
        I need you to determine the primary country of headquarters or registration for the company "${companyName}".
        
        Rules:
        - Identify the primary country where the company is headquartered
        - If the company has multiple headquarters, identify the main/global HQ location
        - For multinational companies, identify where the parent company is registered
        - Use reliable, recent sources for your determination
        
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
      
      const result = await this.geminiApiService.handleGeminiCall(
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
      const thirdPartyAssuranceNotes = thirdPartyAssurance.notes || null;
      console.log(`[DETAIL] Third party assurance: ${thirdPartyAssuranceCompany || 'Not available'}, Notes: ${thirdPartyAssuranceNotes || 'N/A'}`);
      
      // Prepare scope 1 emissions
      const scope1 = emissions.scope1 || {};
      const scope1Value = scope1.value || (scope1.included ? 'Not specified but included in calculation' : null);
      const scope1Confidence = scope1.confidence || null;
      const scope1Notes = scope1.notes || '';
      const scope1Unit = scope1.unit || emissionsUnit;
      console.log(`[DETAIL] Scope 1: ${scope1Value || 'Not available'} ${scope1Unit}, Confidence: ${scope1Confidence || 'N/A'}`);
      
      // Prepare scope 2 emissions
      const scope2 = emissions.scope2 || {};
      const scope2LocationBased = scope2.locationBased || {};
      const scope2MarketBased = scope2.marketBased || {};
      const scope2LocationValue = scope2LocationBased.value || (scope2LocationBased.included && !scope2MarketBased.included ? 'Not specified but included in calculation' : null);
      const scope2MarketValue = scope2MarketBased.value || (scope2MarketBased.included ? 'Not specified but included in calculation' : null);
      const scope2Notes = scope2.notes || '';
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
      const categoryNotes = {};
      const categoryUnits = {};
      
      // Map each category (1-15) to its value, inclusion status, and notes
      for (let i = 1; i <= 15; i++) {
        const category = scope3Categories[i.toString()];
        categoryValues[`category${i}`] = category?.value || (category?.included ? 'Not specified but included in calculation' : null);
        categoryIncluded[`category${i}Included`] = category?.included || false;
        categoryNotes[`category${i}Notes`] = category?.notes || '';
        categoryUnits[`category${i}Unit`] = category?.unit || emissionsUnit;
        
        if (category?.value) {
          console.log(`[DETAIL] Category ${i}: ${category.value} ${category?.unit || emissionsUnit}, Included: ${category.included ? 'Yes' : 'No'}`);
        }
      }
      
      // Get included and missing categories
      const includedCategories = scope3.includedCategories || [];
      const missingCategories = scope3.missingCategories || [];
      const scope3Notes = scope3.notes || '';
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
        emissionsUnit,
        scope1Value,
        scope2LocationValue,
        scope2MarketValue,
        scope3Value,
        ...Object.values(categoryValues),
        revenueSource,
        country,
        companyCategory,
        thirdPartyAssuranceCompany,
        `Scope 1: ${scope1Notes} Scope 2: ${scope2Notes} Scope 3: ${scope3Notes} Third Party Assurance: ${thirdPartyAssuranceNotes}`
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
        `Analysed Data!AN${companyIndex + 2}`,
        [[revenueData.revenue, revenueData.currency]]
      );

      // Update the source url
      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AL${companyIndex + 2}`,
        [['Annual Report', revenueData.sourceUrl]]
      );

      if (revenueData.sourceUrl) {
        await this.sheetsApiService.updateValues(
          this.SPREADSHEET_ID,
          `Analysed Data!AH${companyIndex + 2}`,
          [['Annual Report', revenueData.sourceUrl]]
        );
      }

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
        `${sheetName}!A1:A`
      );
      
      const attempts = data.values || [];
      return attempts.map(attempt => attempt[0]);
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
        `Analysed Data!AN${companyIndex + 2}`,
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

  async updateScope3(company: string, {scope3Values}: any, reason: string): Promise<boolean> {
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

      await this.sheetsApiService.updateValues(
        this.SPREADSHEET_ID,
        `Analysed Data!AS${companyIndex + 2}`,
        [[reason, scope3Values.scope3Total, scope3Values.scope3Cat1, scope3Values.scope3Cat2, scope3Values.scope3Cat3, scope3Values.scope3Cat4, scope3Values.scope3Cat5, scope3Values.scope3Cat6, scope3Values.scope3Cat7, scope3Values.scope3Cat8, scope3Values.scope3Cat9, scope3Values.scope3Cat10, scope3Values.scope3Cat11, scope3Values.scope3Cat12, scope3Values.scope3Cat13, scope3Values.scope3Cat14, scope3Values.scope3Cat15]]
      );

      console.log(`[RESULT] Successfully updated scope3 for ${company} in 'Analysed Data' sheet`);
      return true;
    } catch (error) {
      console.log(`[ERROR] Error updating scope3 for ${company}: ${error.message}`);
      return false;
    }
  }
}