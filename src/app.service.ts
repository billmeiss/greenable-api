import { Injectable, Logger } from '@nestjs/common';
import { ReportProcessingService } from './services/report-processing.service';
import { CompanyService } from './services/company.service';
import { GeminiModelService } from './services/gemini-model.service';
import { GeminiApiService } from './services/gemini-api.service';
import { EmissionsReportService } from './services/emissions-report.service';
import { ReportFinderService } from './services/report-finder.service';

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
  async processCompanyReports(): Promise<string> {
    this.logger.log('Starting company reports processing from AppService');
    
    try {
      // Delegate to the ReportProcessingService
      return await this.reportProcessingService.processCompanyReports();
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
      
      // Extract emissions data from the provided report URL
      const emissionsData = await this.emissionsReportService.getScopedEmissionsFromReport(
       reportUrl,
       name
      );
      
      // Check if emissions extraction timed out
      if (emissionsData && emissionsData.timedOut) {
        return {
          success: false,
          timedOut: true,
          message: `Emissions extraction timed out after 5 minutes for ${name}`,
          company: name,
          parentCompany: null,
          reportUrl: reportUrl
        };
      }
      
      // Get revenue data that matches the emissions reporting period
      const reportingPeriod = emissionsData?.reportingPeriod || null;
      const revenueData = await this.companyService.getCompanyRevenue(
        name,
        reportingPeriod
      );
      
      // Return the results
      return {
        success: true,
        company: name,
        parentCompany: null,
        emissions: emissionsData,
        reportUrl: reportUrl,
        revenue: revenueData
      };
    } catch (error) {
      this.logger.error(`Error processing company ${name}: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get report URLs
   */
  async getReportUrls(): Promise<any> {
    const companies = await this.companyService.getCompaniesFromSheet();
    const reportUrls = [];
    for (const company of companies) {
      const { reportUrl } = await this.processCompanyReport(company, false);
      if (reportUrl) {
        await this.companyService.addCompanyReportUrlToSheet(company, reportUrl);
        reportUrls.push({ company, reportUrl });
      }
    }
    return reportUrls;
  }

  

  /**
   * Process a single company report
   */
  async processCompanyReport(company: string, withEmissions: boolean = true): Promise<any> {
    this.logger.log(`Processing report for company: ${company}`);
    
    try {
      // Find parent company
      const parentCompany = await this.companyService.findParentCompany(company);
      
      // Get ESG report
      const reportData = await this.reportFinderService.findReportWithGemini(
        parentCompany || company,
        new Date().getFullYear(),
        false,
        withEmissions
      );

      console.log({ reportData})
      
      if (!reportData) {
        return { success: false, message: `No report found for ${company}` };
      }
      
      // Check if emissions extraction timed out
      if (reportData.emissions && reportData.emissions.timedOut) {
        return {
          success: false,
          timedOut: true,
          message: `Emissions extraction timed out after 5 minutes for ${company}`,
          company,
          parentCompany: parentCompany !== company ? parentCompany : null,
          reportUrl: reportData.reportUrl
        };
      }
      
      // Get revenue data that matches the emissions reporting period
      const reportingPeriod = reportData.emissions?.reportingPeriod || null;
      const revenueData = await this.companyService.getCompanyRevenue(parentCompany || company, reportingPeriod);
      
      // Return the results
      return {
        success: true,
        company,
        parentCompany: parentCompany !== company ? parentCompany : null,
        emissions: reportData.emissions,
        reportUrl: reportData.reportUrl,
        revenue: revenueData
      };
    } catch (error) {
      this.logger.error(`Error processing company ${company}: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get companies from the spreadsheet
   */
  async getCompanies(): Promise<string[]> {
    try {
      return await this.companyService.getCompaniesFromSheet();
    } catch (error) {
      this.logger.error(`Error getting companies: ${error.message}`);
      return [];
    }
  }

  /**
   * Extract emissions data from a report URL
   */
  async extractEmissionsData(reportUrl: string, company: string): Promise<any> {
    try {
      return await this.emissionsReportService.getScopedEmissionsFromReport(reportUrl, company);
    } catch (error) {
      this.logger.error(`Error extracting emissions data: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get parent company
   */
  async getParentCompany(company: string): Promise<string> {
    try {
      return await this.companyService.findParentCompany(company);
    } catch (error) {
      this.logger.error(`Error finding parent company: ${error.message}`);
      return company;
    }
  }

  /**
   * Get company revenue
   */
  async getCompanyRevenue(company: string, reportingPeriod?: string): Promise<any> {
    try {
      return await this.companyService.getCompanyRevenue(company, reportingPeriod);
    } catch (error) {
      this.logger.error(`Error getting revenue: ${error.message}`);
      return null;
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
}


