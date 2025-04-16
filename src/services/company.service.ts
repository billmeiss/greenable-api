import { Injectable, Logger } from '@nestjs/common';
import { GeminiApiService } from './gemini-api.service';
import { GeminiModelService } from './gemini-model.service';
import { GoogleAuthService } from './google-auth.service';
import { sheets_v4 } from 'googleapis';
import axios from 'axios';
import { readFile } from 'fs/promises';

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
  private sheets: sheets_v4.Sheets;
  private readonly FMP_API_BASE_URL = 'https://financialmodelingprep.com/stable';
  private readonly FMP_API_KEY = process.env.FMP_API_KEY;

  constructor(
    private readonly geminiApiService: GeminiApiService,
    private readonly geminiModelService: GeminiModelService,
    private readonly googleAuthService: GoogleAuthService,
  ) {}

  /**
   * Initialize the Google Sheets client if not already initialized
   */
  private async initializeSheetsClient(): Promise<void> {
    if (!this.sheets) {
      this.sheets = await this.googleAuthService.getSheetsClient();
    }
  }

  /**
   * Find the parent company of a given company
   */
  async findParentCompany(companyName: string): Promise<string | null> {
    try {
      const parentCompanyFinderModel = this.geminiModelService.getModel('parentCompanyFinder');
      
      const prompt = `
        I need you to research and determine the parent company of ${companyName}, if it has one.
        
        Rules:
        - If ${companyName} is already the top-level parent company, return "${companyName}" as the parent
        - If ${companyName} is a subsidiary, identify its ultimate parent company
        - If ${companyName} has been acquired or merged, identify the current parent
        - Use reliable, recent sources for your determination
        - If multiple parent companies exist (joint venture), identify the majority owner
        
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
      
      // First try getting revenue from Financial Modeling Prep API
      const fmpRevenueData = await this.getCompanyRevenueFromFMP(companyName, targetYear);
      console.log(targetYear, fmpRevenueData);
      if (fmpRevenueData) {
        this.logger.log(`Retrieved revenue data for ${companyName} from FMP API`);
        return fmpRevenueData;
      }
      
      // If FMP data not found, fall back to Gemini
      this.logger.log(`No revenue data found in FMP for ${companyName}, using Gemini fallback`);
      
      const revenueModel = this.geminiModelService.getModel('revenue');
      
      // Create user prompt with company and period information
      const userPrompt = `I need accurate financial information about ${companyName}${reportingPeriod ? ' specifically for the same period as their emissions report: ' + reportingPeriod : ' for the most recent period'}.${targetYear !== 'recent' ? ' Please focus on finding revenue data for the year ' + targetYear + '.' : ''}${reportingPeriod ? ' IMPORTANT: Please prioritize finding revenue data that matches the reporting period ' + reportingPeriod + ' to ensure data consistency with the emissions report.' : ''}`;
      
      const result = await this.geminiApiService.handleGeminiCall(
        () => revenueModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        })
      );
      
      if (!result || !result) {
        throw new Error('Failed to generate content from Gemini');
      }
      
      const parsedResponse = this.geminiApiService.safelyParseJson(result.text);
      
      if (!parsedResponse || !parsedResponse.revenue) {
        this.logger.warn(`Failed to get revenue data for ${companyName}`);
        return null;
      }
      
      return parsedResponse as RevenueData;
    } catch (error) {
      this.logger.error(`Error getting revenue for ${companyName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get related companies
   */
  async getRelatedCompanies(companyName: string): Promise<string[]> {
    try {
      const relatedCompaniesModel = this.geminiModelService.getModel('relatedCompanies');

      const existingCompanies = await this.getExistingCompaniesFromSheet();

      const result = await this.geminiApiService.handleGeminiCall(
        () => relatedCompaniesModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: `I need to find related competitors of similar size and region to ${companyName}. Please return a list of 10 related competitors in JSON format. IMPORTANT: Do not include any of the following companies in your response: ${existingCompanies.join(', ')}.` }] }],
        })
      );
      
      if (!result || !result) {
        console.error(result);
        return [];
      }
      
      const parsedResponse = this.geminiApiService.safelyParseJson(result.text);

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
      
      return parsedResponse.relatedCompanies;
    } catch (error) {
      this.logger.error(`Error getting related companies for ${companyName}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get companies from spreadsheet
   */
  async getCompaniesFromSheet(): Promise<string[]> {
    console.log(`[STEP] Getting companies list from Google Sheet`);
    
    try {
      console.log(`[STEP] Initializing Google Sheets client`);
      await this.initializeSheetsClient();
      
      console.log(`[STEP] Fetching data from 'Companies to Request' sheet`);
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg',
        range: "'Companies to Request'!A2:A",
      });
      
      const rows = response.data.values || [];
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

  async getExistingCompaniesFromSheet(): Promise<any[]> {
    try {
      console.log(`[STEP] Initializing Google Sheets client`);
      await this.initializeSheetsClient();

      console.log(`[STEP] Fetching data from 'Companies to Request' sheet`);
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg',
        range: "'Analysed Data'!A2:G",
      });
      
      const rows = response.data.values || [];
      const companies = rows.map(row => ({ name: row[0], reportingPeriod: row[3], revenueYear: row[4], revenue: row[5], exchangeRateCountry: row[6]})).filter(Boolean);

      return companies;
    } catch (error) {
      console.log(`[ERROR] Error getting companies from sheet: ${error.message}`);
      console.log(error);
      return [];
    }
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
    previousYearData: any = null,
    countryData: any = null,
  ): Promise<boolean> {
    console.log(`[STEP] Adding data for ${company} to spreadsheet`);
    
    try {
      console.log(`[STEP] Initializing Google Sheets client`);
      await this.initializeSheetsClient();
      
      // Extract the necessary data from emissions
      console.log(`[STEP] Extracting and formatting data for ${company}`);
      const reportingPeriod = emissions.reportingPeriod || 'Unknown';
      
      // Extract the standard unit used for emissions
      const emissionsUnit = emissions.standardUnit || 'tCO2e';
      console.log(`[DETAIL] Emissions unit: ${emissionsUnit}`);
      
      // Prepare scope 1 emissions
      const scope1 = emissions.scope1 || {};
      const scope1Value = scope1.value || null;
      const scope1Confidence = scope1.confidence || null;
      const scope1Notes = scope1.notes || '';
      const scope1Unit = scope1.unit || emissionsUnit;
      console.log(`[DETAIL] Scope 1: ${scope1Value || 'Not available'} ${scope1Unit}, Confidence: ${scope1Confidence || 'N/A'}`);
      
      // Prepare scope 2 emissions
      const scope2 = emissions.scope2 || {};
      const scope2LocationBased = scope2.locationBased || {};
      const scope2MarketBased = scope2.marketBased || {};
      const scope2LocationValue = scope2LocationBased.value || null;
      const scope2MarketValue = scope2MarketBased.value || null;
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
        categoryValues[`category${i}`] = category?.value || null;
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
        revenue = revenue / exchangeRate;
        revenueCurrency = 'USD';
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
      
      // Prepare previous year data for percentage calculations
      console.log(`[STEP] Calculating year-over-year changes for ${company}`);
      const previousScope1 = previousYearData?.emissions?.scope1?.value || null;
      const previousScope2LocationBased = previousYearData?.emissions?.scope2?.locationBased?.value || null;
      const previousScope2MarketBased = previousYearData?.emissions?.scope2?.marketBased?.value || null;
      const previousScope3 = previousYearData?.emissions?.scope3?.total?.value || null;
      
      // Calculate percentage changes
      const scope1Change = this.calculateChangePercentage(scope1Value, previousScope1);
      const scope2LocationChange = this.calculateChangePercentage(scope2LocationValue, previousScope2LocationBased);
      const scope2MarketChange = this.calculateChangePercentage(scope2MarketValue, previousScope2MarketBased);
      const scope3Change = this.calculateChangePercentage(scope3Value, previousScope3);
      
      if (previousScope1 || previousScope2LocationBased || previousScope2MarketBased || previousScope3) {
        console.log(`[DETAIL] Year-over-year changes:`);
        if (scope1Change) console.log(`[DETAIL] Scope 1: ${scope1Change}%`);
        if (scope2LocationChange) console.log(`[DETAIL] Scope 2 (Location): ${scope2LocationChange}%`);
        if (scope2MarketChange) console.log(`[DETAIL] Scope 2 (Market): ${scope2MarketChange}%`);
        if (scope3Change) console.log(`[DETAIL] Scope 3: ${scope3Change}%`);
      }
      
      // Calculate intensity metrics if revenue is available
      console.log(`[STEP] Calculating emissions intensity metrics for ${company}`);
      const scope1Intensity = revenue && scope1Value ? scope1Value / revenue : null;
      const scope2LocationIntensity = revenue && scope2LocationValue ? scope2LocationValue / revenue : null;
      const scope2MarketIntensity = revenue && scope2MarketValue ? scope2MarketValue / revenue : null;
      const scope3Intensity = revenue && scope3Value ? scope3Value / revenue : null;
      
      if (revenue) {
        console.log(`[DETAIL] Emissions intensity metrics:`);
        if (scope1Intensity) console.log(`[DETAIL] Scope 1 intensity: ${scope1Intensity} ${emissionsUnit}/${revenueCurrency}`);
        if (scope2LocationIntensity) console.log(`[DETAIL] Scope 2 (Location) intensity: ${scope2LocationIntensity} ${emissionsUnit}/${revenueCurrency}`);
        if (scope2MarketIntensity) console.log(`[DETAIL] Scope 2 (Market) intensity: ${scope2MarketIntensity} ${emissionsUnit}/${revenueCurrency}`);
        if (scope3Intensity) console.log(`[DETAIL] Scope 3 intensity: ${scope3Intensity} ${emissionsUnit}/${revenueCurrency}`);
      }
      
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
      ];
      
      // Add the data to the sheet
      console.log(`[STEP] Adding main data row to 'Analysed Data' sheet for ${company}`);
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg',
        range: 'Analysed Data!A2',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [rowData],
        },
      });
      
      // Add scope 3 categories summary to a separate sheet
      console.log(`[STEP] Adding scope 3 category data to 'Scope 3 Categories' sheet for ${company}`);
      const scope3SummaryData = [
        company,
        reportingPeriod,
        scope3Value,
        emissionsUnit,
        scope3Notes,
        scope3Confidence,
        includedCategories.join(', '),
        missingCategories.join(', '),
        country,
        overallConfidence,
        revenueSourceUrl,
        revenueCurrency,
      ];
      
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg',
        range: 'Scope 3 Categories!A2',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [scope3SummaryData],
        },
      });
      
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
      
      // Initialize Google Sheets client
      await this.initializeSheetsClient();

      // Find the row index of the company in the 'Analysed Data' sheet
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg',
        range: `Analysed Data!A2:E`,
      });

      const rows = response.data.values || [];
      const companyIndex = rows.findIndex(row => row[0] === company);

      // Update the cell with the new revenue data and year
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg',
        range: `Analysed Data!E${companyIndex + 2}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[revenueData.year, revenueData.revenue, revenueData.currency]],
        },
      });

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
      console.log(`[STEP] Initializing Google Sheets client`);
      await this.initializeSheetsClient();
      
      // Format the row data
      console.log(`[STEP] Preparing report URL data for ${company}`);
      const rowData = [
        company,
        reportUrl,
        new Date().toISOString().split('T')[0] // Current date in YYYY-MM-DD format
      ];
      
      // Add the data to the sheet
      console.log(`[STEP] Adding report URL data to 'Report URLs' sheet for ${company}`);
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg',
        range: 'Analysed Data!A2',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [rowData],
        },
      });
      
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

  async getExchangeRate(reportingPeriod: string, exchangeRateCountry: string): Promise<number> {
    const rates = await this.getExchangeRates();
    const year = this.extractYearFromPeriod(reportingPeriod);
    if (year !== 2021 && year !== 2022 && year !== 2023 && year !== 2024) {
      return rates['2024'][exchangeRateCountry];
    } else {
      return rates[year][exchangeRateCountry];
    }
  }

  async updateCompanyCountry(company: string, country: string): Promise<boolean> {
    try {
      console.log(`[STEP] Updating country for ${company} in 'Analysed Data' sheet`);
      
      // Initialize Google Sheets client
      await this.initializeSheetsClient();

      // Find the row index of the company in the 'Analysed Data' sheet
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg',
        range: `Analysed Data!A2:E`,
      });

      const rows = response.data.values || [];
      const companyIndex = rows.findIndex(row => row[0] === company);

      // Update the cell with the new country data
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: '1s1lwxtJHGg9REPYAXAClF5nA1JiqQt2Jl4Cd08qgXJg',
        range: `Analysed Data!AD${companyIndex + 2}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[country]],
        },
      });

      console.log(`[RESULT] Successfully updated country for ${company} in 'Analysed Data' sheet`);
      return true;
    } catch (error) {
      console.log(`[ERROR] Error updating country for ${company}: ${error.message}`);
      return false;
    }
  }
  

}