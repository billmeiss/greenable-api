import { Injectable, Logger } from '@nestjs/common';
import { GeminiApiService } from './gemini-api.service';
import { GeminiModelService } from './gemini-model.service';
import { GeminiAiService } from './gemini-ai.service';
import { SearchService } from './search.service';
import axios from 'axios';

interface EmissionsResult {
  emissions: any;
  reportUrl: string;
}

interface CompanyTypeResult {
  companyType: 'fund' | 'ELSE';
  companyTypeConfidence: number;
  companyTypeReason: string;
}

@Injectable()
export class EmissionsReportService {
  private readonly logger = new Logger(EmissionsReportService.name);

  constructor(
    private readonly geminiApiService: GeminiApiService,
    private readonly geminiModelService: GeminiModelService,
    private readonly geminiAiService: GeminiAiService,
    private readonly searchService: SearchService,
  ) {}

  async checkExistingEmissions(company: string, reportUrl: string, emissions: any): Promise<any> {
    console.log(`[STEP] Checking existing emissions for ${company}: ${reportUrl}`);
    console.log(`[DETAIL] Emissions: ${emissions}`);

    console.log(Object.keys(emissions).map(key => `${key}: ${emissions[key]}`).join('\n'));

    // Prompt to check if the emissions are extreacted correctly
    const checkPrompt = `
      Check if the emissions are extreacted correctly for the company ${company}.
      If the emissions are not extreacted correctly, return what emissions are incorrect.
      If the emissions are extreacted correctly, return the emissions.

      The existing emissions are:
      ${Object.keys(emissions).map(key => `${key}: ${emissions[key]}`).join('\n')}

      If all the emissions are correct, return null
      If there is an emission that is included in the caluclations but their value is not provided or disaggrageted, return 'Not specified but included in calculation'

      Working from home is part of Scope 3 Category 7.
      Ignore Scope 2 market based vs location based nuances.
      Before stating scope 3 total is wrong make sure you added all the sub categories. If the scope 3 sum is less than the total, return the total, otherwise ignore the total.

      If you cannot read the report or are uncertain do not return anything.

      Also note that if there are no scope 1, or scope 2 emissions, then the scope 3 total represents the total emissions.

      Scope 3 Total cannot be 'Not specified but included in calculation', it must be a total specified, or the sum of the sub categories if the total is not specified or the sum is higher than the total.
      If you claim a category is not specified but included in the calculations, it MUST be included in the Scope 3 Total, otherwise it's null.

      If you see only a value in scope 2 and scope 1 is 'Not specified but included in calculation' it means that is the combined value of scope 1 and scope 2.
      If you see only a value in scope 3 and scope 1 and scope 2 are 'Not specified but included in calculation' it means that is the combined value of scope 1 and scope 2 and scope 3.

      Scope 3 Financed emissions should be part of the scope 3 total.

    

      Return the following structure:
      {

        "incorrectEmissions"?: Array<{
          {
            "correctValue": number,
            "reason": string,
            "scope": string,
            "value": number,
            "unit": string,
            "confidence": number (0-10)
          },
        ]
      }

      The instructions to help you extract the emissions are:
      Focus on finding precise values for:
        - Scope 1 emissions
        - Scope 2 emissions (both location-based and market-based if available)
        - Scope 3 emissions (total and breakdown by categories if available)
        - Third party assurance (if available)
      
        
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

        You must convert all values to the standard unit of tons of CO2 equivalent.
    `;

    const result = await this.geminiApiService.handleGeminiCall(
      () => this.geminiAiService.processUrl(reportUrl, checkPrompt), 2, 1000, 10 * 60 * 1000
    );

    const parsedResult = this.geminiApiService.safelyParseJson(result);

    if (!parsedResult) {
      return null;
    }

    return parsedResult.incorrectEmissions;
  }

  /**
   * Classify company type based on report content
   */
  async classifyCompanyType(companyName: string, reportUrl: string): Promise<CompanyTypeResult | null> {
    console.log(`[STEP] Classifying company type for ${companyName}: ${reportUrl}`);

    const classificationPrompt = `
      Analyze the company ${companyName} and determine its type based on the report content and company name, report url: ${reportUrl}.

      If you cannot access the report, just continue based on the company name. Do not say you cannot access the report.

      Company Type Classification:
      - "fund": Investment funds, mutual funds, ETFs, private equity funds, hedge funds, venture capital funds, etc. but they have to be able to be invested in and tradeable. 
      - "ELSE": All other companies and real estate investment trusts

      Please analyze the company's business model, activities, and structure described in the report.
      Look for indicators such as:
      - Investment activities and portfolio management
      - Real estate holdings and management
      - Manufacturing or service operations
      - Financial services provision
      - Asset management activities

      Return the following JSON structure:
      {
        "companyType": "fund" | "ELSE",
        "companyTypeConfidence": number (0-10),
        "companyTypeReason": "string explaining why this classification was chosen"
      }

      If you cannot determine the company type with reasonable confidence, return null.
    `;

    try {
      // don't upload the report to the model
      const companyTypeModel = this.geminiModelService.getModel('generic');
      const processedResult = await this.geminiApiService.handleGeminiCall(
        () => companyTypeModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: classificationPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.0,
          },
          systemInstruction: `You will return responses in this JSON format:
          {
            "companyType": "fund" | "ELSE",
            "companyTypeConfidence": number (0-10),
            "companyTypeReason": "string explaining why this classification was chosen"
          }`
        })
      );

      const parsedResult = this.geminiApiService.safelyParseJson(processedResult.text);

      if (!parsedResult || !parsedResult.companyType) {
        console.log(`[RESULT] Could not classify company type for ${companyName}`);
        return null;
      }

      console.log(`[RESULT] Company type classification for ${companyName}: ${parsedResult.companyType} (confidence: ${parsedResult.companyTypeConfidence})`);
      console.log(`[DETAIL] Reason: ${parsedResult.companyTypeReason}`);

      return {
        companyType: parsedResult.companyType,
        companyTypeConfidence: parsedResult.companyTypeConfidence,
        companyTypeReason: parsedResult.companyTypeReason
      };
    } catch (error) {
      console.log(`[ERROR] Error classifying company type for ${companyName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get scoped emissions data from a company report
   */
  async getScopedEmissionsFromReport(reportUrl: string, company: string): Promise<any> {
    console.log(`[STEP] Getting emissions data from report for ${company}: ${reportUrl}`);
    
    try {
      // Configure prompt for emissions data extraction
      const extractionPrompt = `
        Extract greenhouse gas emissions data from this sustainability/ESG report for ${company}. If you cannot find ${company} company, return the company of the report.

        If the company has a portfolio of other companies, you must extract the emissions data for each company in the portfolio and return those emissions under the field "portfolioCompanies".
        Only return portfolio companies for companies that are investment holding, or financial companies.
        The porftolio companies must be individual legal entities that are legally separate from the main company, and not sectors or aggregated parts of the portfolio. Do not return funds as portfolio companies. Do not return sectors or aggregated parts of the portfolio as portfolio companies. Do not return other physical mines as portfolio companies. ONLY legal companies that serve a purpose.
        The purpose of a company or portfolio company is that it's a holistic company with its own operations, revenue, legal entity, purpose, customers etc. which are distinct from the parent company.
        A subsidiary is not a portfolio company.
        An asset is not a portfolio company.
        A fund is not a portfolio company.
        A sector is not a portfolio company.
        A part of a portfolio is not a portfolio company.
        A part of a group is not a portfolio company.
        A part of a sector is not a portfolio company.
        A part of a fund is not a portfolio company.
        A regional branch is not a portfolio company.
        If a company has portfolio companies, make sure you still return the main company's / group's emissions data.

        If a value is only provided for Scope 1&2 total, you must check if Scope 1 is included in the calculations.
        If a value is only provided for Scope 1&2 total, you must check if Scope 2 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 1 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 2 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 3 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 4 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 5 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 6 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 7 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 8 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 9 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 10 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 11 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 12 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 13 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 14 is included in the calculations.
        If a value is only provided for Scope 3 total, you must check if Scope 3 Category 15 is included in the calculations.

        If there is a mismatch between the scope 3 values and the total, recheck your work before concluding that the values are included in the calculations.

      -This is because sometimes a report will mention scope 3 but not include any of the categories. So we need to confirm that none are mentioned. And if they are return their values. Or at least what scope were included in calculations.
      -This is because sometimes a report will mention Scope 1 & 2 total but not differentiate between the scope 1 and scope 2. So we need to confirm if their values are mentioned or at least what scopes were included in calculations.
      -This is because sometimes a repor twill mention Total Emissions but not mention the scope. So we need to confirm if their values are mentioned or at least what scopes were included in calculations.
        
        YOUR RESPONSE MUST BE VALID JSON. Use the following structure:
        {
          "containsRelevantData": true|false,
          "reportingPeriod": "string - the reporting year or period (e.g., '2022' or 'FY 2021-2022')",
          "standardUnit": "string - the standard unit used for emissions",
          "company": {
            "country": "string - the country of the company",
            "name": "string - the name of the company"
          },
          "scope1": {
            "value": number,
            "included": boolean,
            "unit": "string",
            "confidence": number (0-10)
          },
          "scope2": {
            "locationBased": {
              "value": number,
              "included": boolean,
              "unit": "string",
              "confidence": number (0-10)
            },
            "marketBased": {
              "value": number,
              "included": boolean,
              "unit": "string",
              "confidence": number (0-10)
            }
          },
          "notes": "notes about the scope 1, 2, 3 total, and the categories and the third party assurance. Do not include notes about what the user requested, treat the report you are reading as a source of truth.",
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
          "thirdPartyAssurance": {
            "company": "string",
          },
          "portfolioCompanies": Array<{
            "reportingPeriod": "string - the reporting year or period (e.g., '2022' or 'FY 2021-2022')",
            "standardUnit": "string - the standard unit used for emissions",
            "company": {
              "country": "string - the country of the company",
              "name": "string - the name of the company"
            },
              "scope1": { "value": number, "unit": "string", "confidence": number (0-10) },
              "scope2": { "locationBased": { "value": number, "unit": "string", "confidence": number (0-10) },
                "marketBased": { "value": number, "unit": "string", "confidence": number (0-10) } },
              "scope3": { "total": { "value": number, "unit": "string", "confidence": number (0-10) },
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
                  "15": { "value": number, "unit": "string", "confidence": number (0-10), "included": boolean, "notes": "string" },
                }
              }>,
          }
        }
        
        If no emissions data with absolute values are found, return:
        {
          "containsRelevantData": false
        }
        
        Focus on finding precise values for:
        - Scope 1 emissions
        - Scope 2 emissions (both location-based and market-based if available)
        - Scope 3 emissions (total and breakdown by categories if available)
        - Third party assurance (if available)
      
        
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
        15. Investments (Look for the absolute emissions value of investments/loans)
        
        For each category, determine:
        - The precise emissions value (if provided)
        - Whether the category is explicitly included in reporting (even if no value is given)
        - Any notes or explanations about the category
        - If categories are excluded, note the reasons provided
        - In your notes be critical of any categories that are excluded or of their calculations
        
        Assign confidence scores (0-10) to each data point based on clarity and reliability.
        Note any potential issues, missing data, or uncertainties.

        Fetch the company name from the report.

        If the report contains a third party assurance statement, extract the company name that provided the assurance and the notes. If no third party assurance is found, return null for the third party assurance company and notes. If the report has undergone third party assurance but no assurance company is named, return 'Undergone, No name provided' for the third party assurance company and the notes from the report.

        You must convert all values to the standard unit of tons of CO2 equivalent.
      `;
      
      console.log(`[STEP] Processing PDF with Gemini AI for ${company}`);
      
      
      // Create the main processing promise
      const result = await this.geminiApiService.handleGeminiCall(
        () => this.geminiAiService.processUrl(reportUrl, extractionPrompt, 'esg'), 2, 1000, 10 * 60 * 1000
      );
      
      
      if (!result) {
        console.log(`[ERROR] Failed to process PDF: ${reportUrl}`);
        throw new Error('Failed to process PDF');
      }
      
      console.log(`[STEP] Parsing Gemini AI response for ${company}`);

      console.log(result);
      
      // Extract the processed data
      const processedData = this.geminiApiService.safelyParseJson(
        result,
        { containsRelevantData: false }
      );
      
      if (!processedData || !processedData.containsRelevantData) {
        console.log(`[RESULT] No relevant emissions data found in report for ${company}: ${reportUrl}`);
        return { containsRelevantData: false };
      }
                  
      console.log(`[RESULT] Successfully extracted emissions data for ${company}`);
      console.log(`[DETAIL] Report period: ${processedData.reportingPeriod || 'Unknown'}`);
      console.log(`[DETAIL] Scope 1: ${processedData.scope1?.value || 'Not found'} ${processedData.standardUnit || ''}`);
      console.log(`[DETAIL] Scope 2 (Location): ${processedData.scope2?.locationBased?.value || 'Not found'} ${processedData.standardUnit || ''}`);
      console.log(`[DETAIL] Scope 2 (Market): ${processedData.scope2?.marketBased?.value || 'Not found'} ${processedData.standardUnit || ''}`);
      console.log(`[DETAIL] Scope 3 (Total): ${processedData.scope3?.total?.value || 'Not found'} ${processedData.standardUnit || ''}`);
      
      return processedData;
    } catch (error) {
      if (error.message && (error.message.includes('TIMEOUT') || error.message.toLowerCase().includes('timeout'))) {
        console.log(`[TIMEOUT] Emissions extraction for ${company} exceeded time limit: ${reportUrl}`);
        return { 
          containsRelevantData: false, 
          timedOut: true,
          error: 'Emissions extraction timed out',
          reportUrl
        };
      }
      
      if (error.message && error.message.includes('too large')) {
        console.log(`[INFO] Skipping report for ${company}: PDF file is too large to process`);
        return { 
          containsRelevantData: false, 
          error: 'Report file size exceeds the limit and was skipped',
          skipped: true
        };
      }
      
      console.log(`[ERROR] Error processing emissions report for ${company}: ${error.message}`);
      return { 
        containsRelevantData: false, 
        error: error.message 
      };
    }
  }

  /**
   * Validate and extract report data
   */
  async validateAndExtractReportData(
    reportUrl: string, 
    company: string, 
    expectedYear: number | null = null, 
  ): Promise<EmissionsResult | null> {
    console.log(`[STEP] Validating report data for ${company}: ${reportUrl}`);
    console.log(`[DETAIL] Expected year: ${expectedYear || 'Any'}`);
    
    try {
      // 1. Get emissions data from report
      console.log(`[STEP] Extracting emissions data from report for ${company}`);
      const emissions = await this.getScopedEmissionsFromReport(reportUrl, company);
      
      // 2. Check if the report was skipped due to size or timed out
      if (emissions && emissions.skipped) {
        console.log(`[INFO] Report for ${company} was skipped: ${emissions.error}`);
        return null;
      }
      
      // 2a. Check if extraction timed out - return the timeout information to skip to next company
      if (emissions && emissions.timedOut) {
        console.log(`[TIMEOUT] Extraction timed out for ${company} report: ${reportUrl}`);
        return { 
          emissions: { 
            containsRelevantData: false, 
            timedOut: true,
            reportUrl 
          }, 
          reportUrl 
        };
      }
      
      // 3. Check if the report contains relevant data
      if (!emissions || !emissions.containsRelevantData) {
        console.log(`[RESULT] Report doesn't contain relevant data for ${company}: ${reportUrl}`);
        return null;
      }
      
      // 4. Extract year from reporting period
      console.log(`[STEP] Extracting year from reporting period: ${emissions.reportingPeriod || 'Unknown'}`);
      const reportYear = this.extractYearFromPeriod(emissions.reportingPeriod);
      console.log(`[DETAIL] Extracted report year: ${reportYear || 'Unknown'}`);

      // Add third party assurance to portfolio companies
      if (emissions.portfolioCompanies?.length > 0) {
        emissions.portfolioCompanies.forEach(company => {
          company.thirdPartyAssurance = emissions.thirdPartyAssurance;
        });
      }
      
      console.log(`[RESULT] Successfully validated report data for ${company}`);
      return { emissions, reportUrl };
    } catch (error) {
      console.log(`[ERROR] Error validating report data for ${company}: ${error.message}`);
      return null;
    }
  }

  /**
   * Extract year from reporting period string
   */
  extractYearFromPeriod(reportingPeriod: string): number | null {
    if (!reportingPeriod) return null;
    
    // Look for year patterns in the reporting period
    const yearMatches = reportingPeriod.match(/\b(20\d{2})\b/g);
    if (yearMatches && yearMatches.length > 0) {
      // If multiple years found, take the later one (likely the end of reporting period)
      const years = yearMatches.map(y => parseInt(y));
      return Math.max(...years);
    }
    
    return null;
  }

  /**
   * Extract emissions report links from a webpage
   */
  async extractEmissionsReportLinks(url: string, company: string): Promise<string[]> {
    try {
      // Fetch HTML content from URL
      // Add headers to avoid 403
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GreenableAPI/1.0)',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'credentials': 'include',
          'Upgrade-Insecure-Requests': '1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
          'redirect': 'follow',
          'Referer': 'https://www.google.com',
        },
      });
      
      const html = response.data;
      
      // Find all links in the HTML
      const linkRegex = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
      const links: Array<{url: string, text: string}> = [];
      let match;
      
      while ((match = linkRegex.exec(html)) !== null) {
        let linkUrl = match[1];
        const linkText = match[2].replace(/<[^>]*>/g, '').trim();
        
        // Normalize URL
        if (!linkUrl.startsWith('http')) {
          // Handle relative URLs
          const baseUrl = new URL(url);
          linkUrl = new URL(linkUrl, baseUrl.origin).toString();
        }
        
        links.push({ url: linkUrl, text: linkText });
      }
      
      // Filter links to find potential report PDFs
      const reportKeywords = ['sustainability', 'esg', 'report', 'annual', 'environmental'];
      const pdfLinks = links.filter(link => {
        const linkUrl = link.url.toLowerCase();
        const linkText = link.text.toLowerCase();
        
        // Check if it's a PDF
        const isPdf = linkUrl.endsWith('.pdf');
        
        // Check if link contains report keywords
        const containsKeyword = (text: string): boolean => 
          reportKeywords.some(keyword => text.includes(keyword));
        
        return isPdf && (containsKeyword(linkUrl) || containsKeyword(linkText));
      }).map(link => link.url);
      
      return [...new Set(pdfLinks)]; // Remove duplicates
    } catch (error) {
      this.logger.error(`Error extracting links from ${url}: ${error.message}`);
      return [];
    }
  }
}