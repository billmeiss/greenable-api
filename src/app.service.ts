import { Injectable, Logger } from '@nestjs/common';
import { ReportProcessingService } from './services/report-processing.service';
import { CompanyService } from './services/company.service';
import { GeminiModelService } from './services/gemini-model.service';
import { GeminiApiService } from './services/gemini-api.service';
import { EmissionsReportService } from './services/emissions-report.service';
import { ReportFinderService } from './services/report-finder.service';
import axios from 'axios';
@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private readonly reportProcessingService: ReportProcessingService,
    private readonly companyService: CompanyService,
    private readonly geminiModelService: GeminiModelService,
    private readonly geminiApiService: GeminiApiService,
    private readonly emissionsReportService: EmissionsReportService,
    private readonly reportFinderService: ReportFinderService,
  ) {}

  /**
   * Process all company reports in the spreadsheet
   */
  async processCompanyReports({ withChunking = false }: { withChunking?: boolean }): Promise<string> {
    this.logger.log('Starting company reports processing from AppService');
    
    try {
      // Delegate to the ReportProcessingService
      return await this.reportProcessingService.processCompanyReports({ withChunking });
    } catch (error) {
      this.logger.error(`Error in AppService.processCompanyReports: ${error.message}`);
      return `Error processing company reports: ${error.message}`;
    }
  }

  /** 
   * Process a single company with provided report URL
   */
  async processCompany({
      name,
      reportUrl
  }): Promise<any> {
    this.logger.log(`Processing report for company: ${name} with provided URL: ${reportUrl}`);
    
    try {
      const result = await this.reportProcessingService.processCompany(name, reportUrl);
      return { 
        success: !!result, 
        processedCompany: result || name,
        message: result ? 'Successfully processed company' : 'Company processing did not result in data extraction'
      };
    } catch (error) {
      this.logger.error(`Error processing company ${name}: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async updateExchangeRatesForCompanies(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 5250 });
    // If exchange rate is not USD, convert the revenue to USD
    for (const company of companies) {
      const { name, reportingPeriod, revenue, revenueYear, exchangeRateCountry } = company;
      if (exchangeRateCountry === 'USD') {
        continue;
      }
      // Look up the exchange rate for the reporting period in rates.json
      const exchangeRate = await this.companyService.getExchangeRate(reportingPeriod, exchangeRateCountry);
      if (!exchangeRate) {
        console.log(`[ERROR] No exchange rate found for ${name} in ${reportingPeriod}`);
        continue;
      }
      // Update the revenue with the exchange rate
      const updatedRevenue = revenue / exchangeRate;
      // Update the company with the new revenue
      await this.companyService.updateCompanyRevenue(name, {
        revenue: updatedRevenue,
        year: revenueYear,
        source: 'Exchange Rate',
        confidence: 1,
        currency: 'USD'
      });
    }
  }

  async updateCountries(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet();
    for (const company of companies) {
      const { name } = company;
      const { country } = await this.companyService.determineCompanyCountry(name);
      await this.companyService.updateCompanyCountry(name, country);
    }
  }

  /**
   * Update revenues
   */
  async updateRevenues(): Promise<any> {
    const existingCompanies = await this.companyService.getExistingCompaniesFromSheet();

    for (const company of existingCompanies) {
      const { name, reportingPeriod, revenueYear } = company;

      const revenueData = await this.companyService.getCompanyRevenue(name, reportingPeriod);

      if (revenueData) {
        await this.companyService.updateCompanyRevenue(name, revenueData);
        console.log(`[SUCCESS] Updated revenue for ${name}`, revenueData);
      } else {
        console.log(`[ERROR] Failed to update revenue for ${name}`);
      }
    }
  }

  async updateCategories(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 4641 });
    for (const company of companies) {
      const { name, category: existingCategory } = company;
      const category = await this.companyService.getCompanyCategory(name);
      try {
        await this.companyService.updateCompanyCategory(name, category);
      } catch (error) {
        console.log(`[ERROR] Failed to update category for ${name}: ${error.message}`);
        continue;
      }
    }
  }

  async updateAuditedCompanies(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 4498 });
    for (const company of companies) {
      const { name, notes } = company;
      try {
        if (notes) {
          continue;
        }
        const result = await this.companyService.getCompanyAudited(company);
        if (!result) {
          console.log(`[ERROR] Failed to update audited companies for ${company.name}`);
          continue;
        }
        await this.companyService.updateCompanyAudited(company.name, result.thirdPartyAssurance, result.notes);
      } catch (error) {
        console.log(`[ERROR] Failed to update audited companies for ${company.name}: ${error.message}`);
        continue;
      }
    }
  }

  async updateCompanyRevenues(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet();
    for (const company of companies) {
      const { name, reportingPeriod, revenueYear, revenueSource } = company;
      const parsedReportingPeriod = this.companyService.extractYearFromPeriod(reportingPeriod);
      const parsedRevenueYear = this.companyService.extractYearFromPeriod(revenueYear);
      console.log(parsedReportingPeriod, parsedRevenueYear);
      if (parsedReportingPeriod === parsedRevenueYear && revenueSource?.includes('Financial Modeling Prep')) {
        continue;
      }
      const revenue = await this.companyService.getCompanyRevenue(name, company.reportingPeriod);
      await this.companyService.updateCompanyRevenue(name, revenue);
    }
  }

  async checkMissingScopes(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 5280 });
    for (const company of companies) {
      const { name, reportUrl, scope1, scope2Location, scope2Market, scope3, scope3Cat1, scope3Cat2, scope3Cat3, scope3Cat4, scope3Cat5, scope3Cat6, scope3Cat7, scope3Cat8, scope3Cat9, scope3Cat10, scope3Cat11, scope3Cat12, scope3Cat13, scope3Cat14, scope3Cat15 } = company;
      const missingAScope = !scope1 || (!scope2Location && !scope2Market) || (scope3 && !scope3Cat1 && !scope3Cat2 && !scope3Cat3 && !scope3Cat4 && !scope3Cat5 && !scope3Cat6 && !scope3Cat7 && !scope3Cat8 && !scope3Cat9 && !scope3Cat10 && !scope3Cat11 && !scope3Cat12 && !scope3Cat13 && !scope3Cat14 && !scope3Cat15);
      if (missingAScope) {
        console.log(`[ERROR] Missing scope for ${name}`);
        try {
          const result = await this.companyService.checkReportUrlForMissingScopes(name, reportUrl);
          await this.companyService.updateMissingScopes(name, result, company);
        } catch (error) {
          console.log(`[ERROR] Failed to update missing scopes for ${name}: ${error.message}`);
          continue;
        }
      }
    }
  }

  async updateInconsistentRevenues(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 5250 });
    for (const company of companies) {
      const { name, reportingPeriod, revenueYear, revenue: revenueAmount, exchangeRateCountry, revenueUrl, newRevenueUrl, country, newRevenueCurrency, newRevenueAmount } = company;
      if (revenueAmount && exchangeRateCountry !== 'USD') {
        const exchangeRate = await this.companyService.getExchangeRate(reportingPeriod, exchangeRateCountry);
        if (exchangeRate) {
          const updatedRevenue = revenueAmount / exchangeRate;
          await this.companyService.updateNewRevenue(name, {
            revenue: updatedRevenue,
            currency: 'USD'
          });
        }
        continue;
      }
      // Check if the revenue source is not Financial Modeling Prep or Vertex AI
      if (revenueUrl?.includes('financialmodelingprep') || revenueUrl?.includes('vertexai')) {
        continue;
      }

      if (revenueAmount) {
              // Check if the existing revenue source returns a 404
      try {
        const response = await axios.get(revenueUrl);
        if (response.status === 200) continue;
      } catch (error) {
        console.log(`[ERROR] existing url ${revenueUrl} is not valid`);
      }
      }


      // Update the revenue source to the annual report
      const revenue = await this.companyService.getCompanyRevenue(name, revenueYear);
      console.log(revenue);
      if (!revenue || !revenue.revenue) {
        console.log(`[ERROR] No annual report found for ${name}`);
        await this.companyService.updateCompanyRevenue(name, {
          revenue: null,
          year: null,
          source: null,
          sourceUrl: revenue?.sourceUrl || 'Error occurred during retrieval',
          confidence: 1,
          currency: 'USD'
        });
        continue;
      }
      let updatedRevenue = revenue.revenue;
      let updatedCurrency = revenue.currency;
      if (revenue.currency !== 'USD') {
        // Look up the exchange rate for the reporting period in rates.json
        const exchangeRate = await this.companyService.getExchangeRate(reportingPeriod, revenue.currency);
        if (exchangeRate) {
          updatedRevenue = revenue.revenue / exchangeRate;
          updatedCurrency = 'USD';
        }
      }
      await this.companyService.updateCompanyRevenue(name, {
        ...revenue,
        revenue: updatedRevenue,
        currency: updatedCurrency
      });
    }
  }

  async checkIncompleteScopes(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 5371 });
    for (const company of companies) {
      try {
      const { name, reportUrl, scope3, scope3Cat1, scope3Cat2, scope3Cat3, scope3Cat4, scope3Cat5, scope3Cat6, scope3Cat7, scope3Cat8, scope3Cat9, scope3Cat10, scope3Cat11, scope3Cat12, scope3Cat13, scope3Cat14, scope3Cat15, scope3Mismatch } = company;
      if (!scope3Mismatch) {
        continue;
      }
      const scope3Values = await this.companyService.checkMismatchedScope3(name, reportUrl, {
        scope3,
        scope3Cat1,
        scope3Cat2,
        scope3Cat3,
        scope3Cat4,
        scope3Cat5,
        scope3Cat6,
        scope3Cat7,
        scope3Cat8,
        scope3Cat9,
        scope3Cat10,
        scope3Cat11,
        scope3Cat12,
        scope3Cat13,
        scope3Cat14,
        scope3Cat15,
      });

      console.log(scope3Values);
      if (!scope3Values.isCorrect) {
        await this.companyService.updateScope3(name, scope3Values.reason, scope3Values?.scope3Values);
      }
      } catch (error) {
        console.log(`[ERROR] Failed to check incomplete revenues: ${error.message}`);
        continue;
      }
    }
  }

  async checkExistingReports(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 2219 });
    
    // Process companies in batches of 3
    const batchSize = 5;
    for (let i = 0; i < companies.length; i += batchSize) {
      const batch = companies.slice(i, i + batchSize);
      
      // Process batch synchronously (all 3 companies in parallel)
      const batchPromises = batch.map(async (company) => {
        try {
          const { name, reportUrl, scope1, scope2Location, scope2Market, scope3, scope3Cat1, scope3Cat2, scope3Cat3, scope3Cat4, scope3Cat5, scope3Cat6, scope3Cat7, scope3Cat8, scope3Cat9, scope3Cat10, scope3Cat11, scope3Cat12, scope3Cat13, scope3Cat14, scope3Cat15 } = company;
          
          // Async get emissions from the report  
          const emissionValues = { scope1, scope2Location, scope2Market, scope3, scope3Cat1, scope3Cat2, scope3Cat3, scope3Cat4, scope3Cat5, scope3Cat6, scope3Cat7, scope3Cat8, scope3Cat9, scope3Cat10, scope3Cat11, scope3Cat12, scope3Cat13, scope3Cat14, scope3Cat15 };
          const report = await this.emissionsReportService.checkExistingEmissions(name, reportUrl, emissionValues);
          
          if (report) {
            await this.companyService.updateIncorrectEmissions(name, report);
          }
        } catch (error) {
          console.log(`[ERROR] Failed to check existing reports: ${error.message} for ${company.name}`);
          await this.companyService.updateCompanyNotes(company.name, `Error checking existing reports: ${error.message}`);
        }
      });
      
      // Wait for all companies in the current batch to complete
      await Promise.all(batchPromises);
      
      this.logger.log(`Processed batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(companies.length / batchSize)} (companies ${i + 1}-${Math.min(i + batchSize, companies.length)})`);
    }
  }
}


