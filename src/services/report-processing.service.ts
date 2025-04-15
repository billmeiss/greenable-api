import { Injectable, Logger } from '@nestjs/common';
import { GeminiApiService } from './gemini-api.service';
import { EmissionsReportService } from './emissions-report.service';
import { ReportFinderService } from './report-finder.service';
import { CompanyService } from './company.service';

@Injectable()
export class ReportProcessingService {
  private readonly logger = new Logger(ReportProcessingService.name);

  constructor(
    private readonly geminiApiService: GeminiApiService,
    private readonly emissionsReportService: EmissionsReportService,
    private readonly reportFinderService: ReportFinderService,
    private readonly companyService: CompanyService,
  ) {}

  /**
   * Process ESG reports for all companies in the spreadsheet
   */
  async processCompanyReports(): Promise<string> {
    try {
      this.logger.log('Starting company report processing');
      
      // Get list of companies from the spreadsheet
      const companies = await this.companyService.getCompaniesFromSheet();
      
      if (!companies || companies.length === 0) {
        return 'No companies found in the spreadsheet.';
      }
      
      this.logger.log(`Found ${companies.length} companies to process`);
      
      // Process each company
      for (const company of companies) {
        await this.processCompany(company);
      }
      
      return `Processed ${companies.length} companies successfully.`;
    } catch (error) {
      this.logger.error(`Error in processCompanyReports: ${error.message}`);
      return `Error processing companies: ${error.message}`;
    }
  }

  /**
   * Process a single company
   */
  private async processCompany(company: string): Promise<void> {
    try {
      this.logger.log(`Processing company: ${company}`);
      
      // 1. Check for parent company
      const parentCompany = await this.companyService.findParentCompany(company);
      
      // If parent company is different and not null, use parent company instead
      const companyToProcess = parentCompany && parentCompany !== company 
        ? parentCompany 
        : company;
      
      if (parentCompany && parentCompany !== company) {
        this.logger.log(`Using parent company ${parentCompany} for ${company}`);
      }
      
      // 2. Get current year ESG report
      const currentYear = new Date().getFullYear();
      
      // Try to find the latest report
      const reportData = await this.getCompanyESGReports(companyToProcess);
      
      if (!reportData) {
        this.logger.warn(`No report found for ${companyToProcess}`);
        return;
      }
      
      // Check if emissions extraction timed out
      if (reportData.emissions && reportData.emissions.timedOut) {
        this.logger.warn(`TIMEOUT: Emissions extraction for ${companyToProcess} exceeded 5 minutes.`);
        this.logger.warn(`MANUAL CHECK NEEDED: Please manually check emissions data at: ${reportData.reportUrl}`);
        
        // Add timeout information to spreadsheet
        await this.companyService.addCompanyToSheet(
          company,
          { timedOut: true, reportUrl: reportData.reportUrl },
          reportData.reportUrl,
          null,
          null
        );
        
        return; // Skip further processing for this company
      }
      
      // 3. Get company revenue data for the same reporting period as emissions
      const reportingPeriod = reportData.emissions?.reportingPeriod || null;
      const revenueData = await this.companyService.getCompanyRevenue(companyToProcess, reportingPeriod);

      const countryData = await this.companyService.determineCompanyCountry(companyToProcess);

      console.log(countryData);

      
      // 5. Add data to spreadsheet
      await this.companyService.addCompanyToSheet(
        company,
        reportData.emissions,
        reportData.reportUrl,
        revenueData,
        null,
        countryData
      );
      
      this.logger.log(`Successfully processed ${company}`);
    } catch (error) {
      this.logger.error(`Error processing company ${company}: ${error.message}`);
    }
  }

  /**
   * Get ESG reports for a company
   */
  async getCompanyESGReports(company: string): Promise<{emissions: any, reportUrl: string} | null> {
    try {
      this.logger.log(`Getting ESG reports for ${company}`);
      
      const currentYear = new Date().getFullYear();
      
      // Try to find the latest report
      for (let year = currentYear; year >= currentYear - 2; year--) {
        this.logger.log(`Searching for ${company} report from ${year}`);
        
        const reportData = await this.reportFinderService.findReportWithGemini(company, year);
        
        if (reportData) {
          this.logger.log(`Found ${company} report for ${year}`);
          return reportData;
        }
      }
      
      this.logger.warn(`No ESG report found for ${company} in the last 3 years`);
      return null;
    } catch (error) {
      this.logger.error(`Error getting ESG reports for ${company}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get previous year report for a company
   */
  async getPreviousYearReport(
    company: string, 
    currentYear: number
  ): Promise<{emissions: any, reportUrl: string} | null> {
    try {
      const previousYear = currentYear - 1;
      
      this.logger.log(`Looking for previous year (${previousYear}) report for ${company}`);
      
      // First, try to find the previous year report directly
      const reportData = await this.findPreviousYearReportWithGemini(
        company, 
        previousYear
      );
      
      if (reportData) {
        return reportData;
      }
      
      this.logger.warn(`No previous year report found for ${company}`);
      return null;
    } catch (error) {
      this.logger.error(`Error getting previous year report for ${company}: ${error.message}`);
      return null;
    }
  }

  /**
   * Find previous year report for a company
   */
  private async findPreviousYearReportWithGemini(
    company: string, 
    targetYear: number, 
    publishYear: number = null
  ): Promise<{emissions: any, reportUrl: string} | null> {
    try {
      // Search with historical flag
      const searchResults = await this.reportFinderService.searchForESGReports(
        company, 
        targetYear, 
        true // Use historical search
      );
      
      if (!searchResults || searchResults.length === 0) {
        this.logger.warn(`No search results for historical report ${company} ${targetYear}`);
        return null;
      }
      
      // Process results specifically looking for the target year
      // and rejecting the current year
      return await this.reportFinderService.processSearchResultsForReport(
        company,
        searchResults,
        targetYear, // expecting this year
        publishYear, // rejecting this year (if provided)
        10 // increase max attempts for historical reports
      );
    } catch (error) {
      this.logger.error(`Error finding previous year report for ${company}: ${error.message}`);
      return null;
    }
  }
} 