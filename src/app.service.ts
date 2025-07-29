import { Injectable, Logger } from '@nestjs/common';
import { ReportProcessingService } from './services/report-processing.service';
import { CompanyService } from './services/company.service';
import { GeminiModelService } from './services/gemini-model.service';
import { GeminiApiService } from './services/gemini-api.service';
import { EmissionsReportService } from './services/emissions-report.service';
import { ReportFinderService } from './services/report-finder.service';
import { CATEGORY_SCHEMA } from './constants';

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
      const { name, reportUrl } = company;
      const { country } = await this.companyService.determineCompanyCountry(name, reportUrl);
      await this.companyService.updateCompanyCountry(name, country);
    }
  }

  /**
   * Update revenues
   */
  async updateRevenues(): Promise<any> {
    const existingCompanies = await this.companyService.getExistingCompaniesFromSheet();

    for (const company of existingCompanies) {
      const { name, reportingPeriod, reportUrl } = company;

      const revenueData = await this.companyService.getCompanyRevenue(name, reportingPeriod, reportUrl);

      if (revenueData) {
        await this.companyService.updateCompanyRevenue(name, revenueData);
        console.log(`[SUCCESS] Updated revenue for ${name}`, revenueData);
      } else {
        console.log(`[ERROR] Failed to update revenue for ${name}`);
      }
    }
  }

  async updateCategories(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 7180, toRow: 10710 });
    
    if (companies.length === 0) {
      this.logger.log('No companies found for category update');
      return {
        success: true,
        message: 'No companies found for category update',
        totalCompanies: 0,
        successfulUpdates: 0,
        failedUpdates: 0
      };
    }
    
    this.logger.log(`Found ${companies.length} companies to update categories`);
    
    let successfulUpdates = 0;
    let failedUpdates = 0;
    
    // Process companies in batches to avoid overwhelming the system
    const batchSize = 10;
    for (let i = 0; i < companies.length; i += batchSize) {
      const batch = companies.slice(i, i + batchSize);
      
      this.logger.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(companies.length / batchSize)} (${batch.length} companies)`);
      
      const batchPromises = batch.map(async (company) => {
        try {
          const { name, country, reportUrl } = company;
          const category = await this.companyService.getCompanyCategory(name, country, reportUrl);
          
          if (category) {
            await this.companyService.updateCompanyCategory(name, category);
            this.logger.log(`[SUCCESS] Updated category for ${name}: ${category}`);
            return { success: true, company: name };
          } else {
            this.logger.warn(`[WARNING] No category found for ${name}`);
            return { success: false, company: name, error: 'No category found' };
          }
        } catch (error) {
          this.logger.error(`[ERROR] Failed to update category for ${company.name}: ${error.message}`);
          return { success: false, company: company.name, error: error.message };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      
      // Count results for this batch
      batchResults.forEach(result => {
        if (result.success) {
          successfulUpdates++;
        } else {
          failedUpdates++;
        }
      });
      
      // Add a small delay between batches to avoid rate limiting
      if (i + batchSize < companies.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const result = {
      success: true,
      message: `Category update completed. ${successfulUpdates} successful, ${failedUpdates} failed`,
      totalCompanies: companies.length,
      successfulUpdates,
      failedUpdates
    };
    
    this.logger.log(`Category update completed: ${JSON.stringify(result)}`);
    return result;
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

  async updateMissingEmployees(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 3142, toRow: 5500 });
    
    if (companies.length === 0) {
      this.logger.log('No companies found for employee count update');
      return {
        success: true,
        message: 'No companies found for employee count update',
        totalCompanies: 0,
        successfulUpdates: 0,
        failedUpdates: 0
      };
    }
    
    this.logger.log(`Found ${companies.length} companies to update missing employees`);
    
    let successfulUpdates = 0;
    let failedUpdates = 0;
    
    // Process companies in batches to avoid overwhelming the system
    const batchSize = 5;
    for (let i = 0; i < companies.length; i += batchSize) {
      const batch = companies.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (company) => {
        try {
          const { name, reportUrl, reportingPeriod } = company;
          let result = await this.companyService.checkReportUrlForMissingEmployees(name, reportUrl, reportingPeriod);
          console.log(result);
          
          if (!result?.employeeCount) {
            // Search for the annual report if employee count not found
            const annualReportUrl = await this.companyService.searchForCompanyAnnualReport(name, reportingPeriod);
            if (annualReportUrl) {
              const annualReportData = await this.companyService.checkReportUrlForMissingEmployees(name, annualReportUrl, reportingPeriod);
              result = annualReportData;
            }
          }
          
          await this.companyService.updateMissingEmployees(name, result.employeeCount, company);
          successfulUpdates++;
          this.logger.log(`Successfully updated employee count for ${name}`);
          
        } catch (error) {
          console.log(`[ERROR] Failed to update missing employees for ${company.name}: ${error.message}`);
          failedUpdates++;
        }
      });
      
      // Wait for all companies in the current batch to complete
      await Promise.all(batchPromises);
      
      this.logger.log(`Processed batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(companies.length / batchSize)} (companies ${i + 1}-${Math.min(i + batchSize, companies.length)})`);
    }
    
    const summary = {
      success: failedUpdates === 0,
      message: `Processed ${companies.length} companies: ${successfulUpdates} successful, ${failedUpdates} failed`,
      totalCompanies: companies.length,
      successfulUpdates,
      failedUpdates
    };
    
    this.logger.log(summary.message);
    return summary;
  }

  async updateInconsistentRevenues(): Promise<any> {
    const allCompanies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 2, toRow: 10710 });
    let companies = allCompanies;
    
    if (companies.length === 0) {
      this.logger.log('No companies found for revenue update');
      return {
        success: true,
        message: 'No companies found for revenue update',
        totalCompanies: 0,
        successfulUpdates: 0,
        failedUpdates: 0
      };
    }

    //filter out companies with revenue amount
    // companies = companies.filter(company => company.revenue === null || company.revenue === undefined || company.revenue === '0' || company.revenue === 0 || company.revenue === '');

    console.log(companies.length);
    
    this.logger.log(`Found ${companies.length} companies to update inconsistent revenues`);
    
    let successfulUpdates = 0;
    let failedUpdates = 0;
    
    // Process companies in batches to avoid overwhelming the system
    const batchSize = 8;
    for (let i = 0; i < companies.length; i += batchSize) {
      const batch = companies.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (company) => {
        try {
          const { name, reportingPeriod, revenueYear, revenue: revenueAmount, exchangeRateCountry, revenueUrl, reportUrl, category, country } = company;

          if (revenueUrl!== 'Error occurred during retrieval') {
            return;
          }
          
          // if (revenueAmount && exchangeRateCountry !== 'USD') {
          //   const exchangeRate = await this.companyService.getExchangeRate(reportingPeriod, exchangeRateCountry);
          //   if (exchangeRate) {
          //     const updatedRevenue = revenueAmount / exchangeRate;
          //     await this.companyService.updateNewRevenue(name, {
          //       revenue: updatedRevenue,
          //       currency: 'USD'
          //     });
          //   } else {
          //     const revenueData = await this.companyService.convertCurrencyUsingGemini({
          //       revenue: revenueAmount,
          //       currency: exchangeRateCountry,
          //       year: revenueYear,
          //       source: 'Gemini',
          //       confidence: 1
          //     }, company);
          //     await this.companyService.updateNewRevenue(name, {
          //       revenue: revenueData.revenue,
          //       currency: 'USD',
          //       year: revenueYear,
          //       source: 'Gemini',
          //       confidence: 1
          //     });
          //   }
          //   return;
          // }
          
          // Check if the revenue source is not Financial Modeling Prep or Vertex AI
          if (revenueUrl?.includes('financialmodelingprep') || revenueUrl?.includes('vertexai')) {
            return;
          }

          // if (Boolean(revenueAmount) && revenueAmount !== 0 && revenueAmount !== null && revenueAmount !== undefined && revenueAmount !== '0') {
          //   return;
          // }

          // if (revenueAmount) {
          //         // Check if the existing revenue source returns a 404
          // try {
          //   const response = await axios.get(revenueUrl);
          //   if (response.status === 200) return;
          // } catch (error) {
          //   console.log(`[ERROR] existing url ${revenueUrl} is not valid`);
          // }
          // }

          // Update the revenue source to the annual report
          const revenue = await this.companyService.getCompanyRevenue(name, revenueYear, reportUrl, category, country);
          console.log(revenue);
          
          if (!revenue || !revenue.revenue) {
            console.log(`[ERROR] No annual report found for ${name}`);
            await this.companyService.updateCompanyRevenue(name, {
              revenue: 0,
              year: revenueYear,
              source: 'Could not find annual report',
              sourceUrl: revenue?.sourceUrl || 'Could not find annual report',
              confidence: 1,
            });
            return;
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
          
          successfulUpdates++;
          this.logger.log(`Successfully updated revenue for ${name}`);
          
        } catch (error) {
          console.log(`[ERROR] Failed to update inconsistent revenues for ${company.name}: ${error.message}`);
          failedUpdates++;
        }
      });
      
      // Wait for all companies in the current batch to complete
      await Promise.all(batchPromises);
      
      this.logger.log(`Processed batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(companies.length / batchSize)} (companies ${i + 1}-${Math.min(i + batchSize, companies.length)})`);
    }
    
    const summary = {
      success: failedUpdates === 0,
      message: `Processed ${companies.length} companies: ${successfulUpdates} successful, ${failedUpdates} failed`,
      totalCompanies: companies.length,
      successfulUpdates,
      failedUpdates
    };
    
    this.logger.log(summary.message);
    return summary;
  }

  async checkIncompleteScopes(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 1534, toRow: 10685 });
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
        await this.companyService.updateScope3(name, scope3Values.reason, scope3Values?.scope3Values, scope3Values?.isCorrect);
      } catch (error) {
        console.log(`[ERROR] Failed to check incomplete revenues: ${error.message}`);
        continue;
      }
    }
  }

  async checkExistingReports(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 1585 });
    
    // Process companies in batches of 3
    const batchSize = 9;
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

  /**
   * Get all companies that have unchecked reports (notes in column AU that haven't been processed)
   */
  async getCompaniesWithUncheckedReports(fromRow: number = 5521): Promise<any[]> {
    try {
      this.logger.log(`Getting companies with unchecked reports from row ${fromRow}`);
      return await this.companyService.getCompaniesWithUncheckedReports(fromRow);
    } catch (error) {
      this.logger.error(`Error getting companies with unchecked reports: ${error.message}`);
      return [];
    }
  }

  /**
   * Update checked reports for a specific company by parsing notes from column AU
   */
  async updateCheckedReports(companyName: string, fromRow: number = 5521): Promise<any> {
    try {
      this.logger.log(`Updating checked reports for company: ${companyName} from row ${fromRow}`);
      const result = await this.companyService.updateCheckedReports(companyName, fromRow);
      
      if (result.success) {
        this.logger.log(`Successfully updated ${result.updatedCount} emission values for ${companyName}`);
      } else {
        this.logger.error(`Failed to update checked reports for ${companyName}: ${result.errors.join(', ')}`);
      }
      
      return result;
    } catch (error) {
      this.logger.error(`Error updating checked reports for ${companyName}: ${error.message}`);
      return {
        success: false,
        updatedCount: 0,
        errors: [error.message]
      };
    }
  }

  /**
   * Update checked reports for all companies that have unchecked reports
   */
  async updateAllCheckedReports(fromRow: number = 5521): Promise<any> {
    try {
      this.logger.log(`Starting bulk update of all checked reports from row ${fromRow}`);
      
      const companiesWithUncheckedReports = await this.companyService.getCompaniesWithUncheckedReports(fromRow);
      
      if (companiesWithUncheckedReports.length === 0) {
        this.logger.log('No companies with unchecked reports found');
        return {
          success: true,
          message: 'No companies with unchecked reports found',
          totalCompanies: 0,
          successfulUpdates: 0,
          failedUpdates: 0,
          results: []
        };
      }
      
      this.logger.log(`Found ${companiesWithUncheckedReports.length} companies with unchecked reports`);
      
      const results = [];
      let successfulUpdates = 0;
      let failedUpdates = 0;
      
      // Process companies in batches to avoid overwhelming the system
      const batchSize = 5;
      for (let i = 0; i < companiesWithUncheckedReports.length; i += batchSize) {
        const batch = companiesWithUncheckedReports.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (company) => {
          try {
            const result = await this.companyService.updateCheckedReports(company.name, fromRow);
            
            if (result.success) {
              successfulUpdates++;
              this.logger.log(`Successfully updated ${result.updatedCount} values for ${company.name}`);
            } else {
              failedUpdates++;
              this.logger.error(`Failed to update ${company.name}: ${result.errors.join(', ')}`);
            }
            
            return {
              companyName: company.name,
              ...result
            };
          } catch (error) {
            failedUpdates++;
            this.logger.error(`Error processing ${company.name}: ${error.message}`);
            return {
              companyName: company.name,
              success: false,
              updatedCount: 0,
              errors: [error.message]
            };
          }
        });
        
        // Wait for all companies in the current batch to complete
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        this.logger.log(`Processed batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(companiesWithUncheckedReports.length / batchSize)} (companies ${i + 1}-${Math.min(i + batchSize, companiesWithUncheckedReports.length)})`);
      }
      
      const summary = {
        success: failedUpdates === 0,
        message: `Processed ${companiesWithUncheckedReports.length} companies: ${successfulUpdates} successful, ${failedUpdates} failed`,
        totalCompanies: companiesWithUncheckedReports.length,
        successfulUpdates,
        failedUpdates,
        results
      };
      
      this.logger.log(summary.message);
      return summary;
      
    } catch (error) {
      this.logger.error(`Error in bulk update of checked reports: ${error.message}`);
      return {
        success: false,
        message: `Error in bulk update: ${error.message}`,
        totalCompanies: 0,
        successfulUpdates: 0,
        failedUpdates: 0,
        results: []
      };
    }
  }

  /**
   * Classify company type based on report content
   */
  async classifyCompanyType(): Promise<any> {
    const companies = await this.companyService.getExistingCompaniesFromSheet({ fromRow: 7667 });
    
    if (companies.length === 0) {
      this.logger.log('No companies found for classification');
      return {
        success: true,
        message: 'No companies found for classification',
        totalCompanies: 0,
        successfulClassifications: 0,
        failedClassifications: 0
      };
    }
    
    this.logger.log(`Found ${companies.length} companies to classify`);
    
    let successfulClassifications = 0;
    let failedClassifications = 0;
    
    // Process companies in batches to avoid overwhelming the system
    const batchSize = 5;
    for (let i = 0; i < companies.length; i += batchSize) {
      const batch = companies.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (company) => {
        const { name, reportUrl } = company;
        this.logger.log(`Classifying company type for ${name} with report URL: ${reportUrl}`);
        
        try {
          const result = await this.emissionsReportService.classifyCompanyType(name, reportUrl);
        
          if (result) {
            await this.companyService.updateCompanyType(name, result.companyType === 'ELSE' ? '' : result.companyType, result.companyTypeConfidence, result.companyTypeReason);
            successfulClassifications++;
            this.logger.log(`Successfully classified ${name} as ${result.companyType}`);
          } else {
            await this.companyService.updateCompanyType(name, 'unknown', 0, 'Could not classify company type');
            failedClassifications++;
            this.logger.warn(`Could not classify company type for ${name}`);
          }
        } catch (error) {
          this.logger.error(`Error classifying company type for ${name}: ${error.message}`);
          await this.companyService.updateCompanyType(name, 'unknown', 0, 'Error classifying company type');
          failedClassifications++;
        }
      });
      
      // Wait for all companies in the current batch to complete
      await Promise.all(batchPromises);
      
      this.logger.log(`Processed batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(companies.length / batchSize)} (companies ${i + 1}-${Math.min(i + batchSize, companies.length)})`);
    }
    
    const summary = {
      success: failedClassifications === 0,
      message: `Processed ${companies.length} companies: ${successfulClassifications} successful, ${failedClassifications} failed`,
      totalCompanies: companies.length,
      successfulClassifications,
      failedClassifications
    };
    
    this.logger.log(summary.message);
    return summary;
  }

  /**
   * Clean "Not specified" values from scope3 categories when column AP contains "no"
   */
  async cleanNotSpecifiedValuesFromNoRows(): Promise<any> {
    try {
      this.logger.log('Starting cleanup of "Not specified" values from rows with "no" in column AP');
      const result = await this.companyService.cleanNotSpecifiedValuesFromNoRows();
      
      this.logger.log(`Cleanup completed successfully. Processed ${result.totalRowsProcessed} rows, cleaned ${result.totalCellsCleaned} cells`);
      return result;
    } catch (error) {
      this.logger.error(`Error in cleaning not specified values: ${error.message}`);
      return {
        success: false,
        error: error.message,
        totalRowsProcessed: 0,
        totalCellsCleaned: 0
      };
    }
  }

  /**
   * Calculate average emissions per dollar for every GHG emission category by industry
   */
  async calculateAverageEmissionsByIndustry(): Promise<any> {
    try {
      this.logger.log('Starting calculation of average emissions per dollar by industry');
      const result = await this.companyService.calculateAverageEmissionsByIndustry();
      
      this.logger.log(`Average emissions calculation completed for ${Object.keys(result.industries || {}).length} industries`);
      return result;
    } catch (error) {
      this.logger.error(`Error calculating average emissions by industry: ${error.message}`);
      return {
        success: false,
        error: error.message,
        industries: {}
      };
    }
  }

  /**
   * Fix companies with revenue source errors by re-extracting revenue data and converting currencies
   */
  async fixRevenueSourceErrors(): Promise<any> {
    try {
      this.logger.log('Starting revenue source error fix process');
      const result = await this.companyService.fixCompaniesWithRevenueSourceErrors();
      
      this.logger.log(`Revenue source error fix completed. ${result.successfulUpdates} companies updated successfully out of ${result.totalCompaniesProcessed} processed`);
      return result;
    } catch (error) {
      this.logger.error(`Error fixing revenue source errors: ${error.message}`);
      return {
        success: false,
        totalCompaniesProcessed: 0,
        successfulUpdates: 0,
        errors: [error.message]
      };
    }
  }
}


