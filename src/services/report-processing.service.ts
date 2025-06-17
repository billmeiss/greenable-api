import { Injectable, Logger } from '@nestjs/common';
import { GeminiApiService } from './gemini-api.service';
import { EmissionsReportService } from './emissions-report.service';
import { ReportFinderService } from './report-finder.service';
import { CompanyService } from './company.service';

// Define the BatchLogger interface
interface BatchLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

@Injectable()
export class ReportProcessingService {
  private readonly logger = new Logger(ReportProcessingService.name);
  private readonly colors = [
    '\x1b[31m', // Red
    '\x1b[32m', // Green
    '\x1b[33m', // Yellow
    '\x1b[34m', // Blue
    '\x1b[35m', // Magenta
    '\x1b[36m', // Cyan
    '\x1b[91m', // Bright Red
    '\x1b[92m', // Bright Green
    '\x1b[93m', // Bright Yellow
    '\x1b[94m', // Bright Blue
  ];
  private readonly resetColor = '\x1b[0m';
  private readonly mainColor = '\x1b[97m'; // Bright white

  constructor(
    private readonly geminiApiService: GeminiApiService,
    private readonly emissionsReportService: EmissionsReportService,
    private readonly reportFinderService: ReportFinderService,
    private readonly companyService: CompanyService,
  ) {}

  /**
   * Process ESG reports for all companies in the spreadsheet
   */
  async processCompanyReports({ withChunking = false }: { withChunking?: boolean }): Promise<string> {
    try {
      const mainLogger = this.createLogger('MAIN', this.mainColor);
      mainLogger.log('Starting company report processing');
      
      // Get and deduplicate companies from the spreadsheet
      const companies = await this.getUniqueCompanies();
      if (companies.length === 0) {
        return 'No companies found in the spreadsheet.';
      }
      
      mainLogger.log(`Found ${companies.length} unique companies to process`);

      if (withChunking) {
        // Process all companies in parallel chunks
        const totalProcessed = await this.processCompaniesInParallelChunks(companies, 5, mainLogger);
        
        mainLogger.log(`Completed processing of all chunks. Total companies processed: ${totalProcessed}`);
        return `Processed ${totalProcessed} companies successfully.`;
      } else {
        // Process all companies in parallel
        const totalProcessed = await this.processCompaniesInParallelChunks(companies, 1, mainLogger);
        
        mainLogger.log(`Completed processing of all chunks. Total companies processed: ${totalProcessed}`);
        return `Processed ${totalProcessed} companies successfully.`;
      }
    } catch (error) {
      this.logger.error(`Error in processCompanyReports: ${error.message}`);
      return `Error processing companies: ${error.message}`;
    }
  }

  /**
   * Fetch and deduplicate companies from the spreadsheet
   */
  private async getUniqueCompanies(): Promise<string[]> {
    const companies = await this.companyService.getCompaniesFromSheet();
    return companies ? [...new Set(companies)] : [];
  }

  /**
   * Process companies in parallel chunks
   */
  private async processCompaniesInParallelChunks(
    companies: string[], 
    numChunks: number,
    mainLogger: BatchLogger
  ): Promise<number> {
    const chunks = this.divideCompaniesIntoChunks(companies, numChunks);
    mainLogger.log(`Divided ${companies.length} companies into ${chunks.length} chunks for parallel processing`);
    
    // Process each chunk in parallel
    const chunkResults = await Promise.all(
      chunks.map((chunk, index) => this.processCompanyChunk(chunk, index))
    );
    
    // Return total processed companies
    return chunkResults.reduce((sum, count) => sum + count, 0);
  }

  /**
   * Create a colored logger for a specific batch or context
   */
  private createLogger(prefix: string, color: string): BatchLogger {
    const coloredPrefix = `${color}[${prefix}]${this.resetColor}`;
    
    return {
      log: (message: string) => this.logger.log(`${coloredPrefix} ${message}`),
      warn: (message: string) => this.logger.warn(`${coloredPrefix} ${message}`),
      error: (message: string) => this.logger.error(`${coloredPrefix} ${message}`)
    };
  }

  /**
   * Divide companies array into specified number of chunks
   */
  private divideCompaniesIntoChunks(companies: string[], numChunks: number): string[][] {
    // Ensure we're creating at most the requested number of chunks
    numChunks = Math.min(numChunks, companies.length);
    
    const result: string[][] = Array.from({ length: numChunks }, () => []);
    
    // Distribute companies evenly across chunks
    companies.forEach((company, index) => {
      const chunkIndex = index % numChunks;
      result[chunkIndex].push(company);
    });

    console.log(result);
    
    return result;
  }

  /**
   * Process a chunk of companies in parallel
   */
  private async processCompanyChunk(companies: string[], chunkIndex: number): Promise<number> {
    const batchLogger = this.createBatchLogger(chunkIndex);
    batchLogger.log(`Starting processing of chunk with ${companies.length} companies`);
    
    let processedCount = 0;
    
    for (const company of companies) {
      try {
        const relatedCompanies = await this.companyService.getRelatedCompanies(company);
        for (const relatedCompany of [company, ...relatedCompanies]) {
          const companyName = await this.processCompany(relatedCompany);
          this.companyService.addAttemptToSheet(company, companyName);
          if (companyName) {
            processedCount += 1;
          }
        }
      } catch (error) {
        batchLogger.error(`Error processing company ${company}: ${error.message}`);
      }
    }
    
    batchLogger.log(`Finished processing chunk, processed ${processedCount} companies`);
    return processedCount;
  }

  /**
   * Create a batch-specific logger
   */
  private createBatchLogger(batchIndex: number): BatchLogger {
    const batchColor = this.colors[batchIndex % this.colors.length];
    return this.createLogger(`BATCH ${batchIndex + 1}`, batchColor);
  }

  async processCompanyAfterEmissionsExtraction(company: string, emissionsData: any, reportUrl: string): Promise<string | null> {
    
    const doesCompanyExist = await this.companyService.doesCompanyExist(emissionsData.company.name);

    if (doesCompanyExist) {
      this.logger.log(`Company ${emissionsData.company.name} already exists, skipping...`);
      return `Company ${emissionsData.company.name} already exists, skipping...`;
    }
    
    // 3. Get company revenue data for the same reporting period as emissions
    const reportingPeriod = emissionsData?.reportingPeriod || null;
    const revenueData = await this.companyService.getCompanyRevenue(emissionsData.company.name, reportingPeriod);
    const countryData = await this.companyService.determineCompanyCountry(emissionsData.company.name);
    const companyCategory = await this.companyService.getCompanyCategory(emissionsData.company.name);
    
    // 5. Add data to spreadsheet
    await this.companyService.addCompanyToSheet(
      emissionsData.company.name,
      emissionsData,
      reportUrl,
      revenueData,
      companyCategory,
      countryData
    );
    
    this.logger.log(`Successfully processed ${emissionsData.company.name}`);
  }

  /**
   * Process a single company
   */
  async processCompany(company: string, reportUrl?: string): Promise<string | null> {
    try {
      this.logger.log(`Processing company: ${company}`);
      
      // 1. Check for parent company
      const parentCompany = await this.companyService.findParentCompany(company);

      const companyToProcess = parentCompany ? parentCompany : company;
    

        const reportData = await this.getCompanyESGReportData(companyToProcess, reportUrl);

        if (reportData.emissions.portfolioCompanies?.length > 0) {
          for (const portfolioCompany of reportData.emissions.portfolioCompanies) {
            try { 
              await this.processCompanyAfterEmissionsExtraction(portfolioCompany.company.name, portfolioCompany, reportData.reportUrl);
            } catch (error) {
              this.logger.error(`Error processing portfolio company ${portfolioCompany.company.name}: ${error.message}`);
              continue;
            }
          }
        }
        
        if (!reportData) {
          this.logger.warn(`No report found for ${company}`);
          return null;
        }
        
        // Check if emissions extraction timed out
        if (reportData.emissions && reportData.emissions.timedOut) {
          this.logger.warn(`TIMEOUT: Emissions extraction for ${company} exceeded 5 minutes.`);
          this.logger.warn(`MANUAL CHECK NEEDED: Please manually check emissions data at: ${reportData.reportUrl}`);
          
          // Add timeout information to spreadsheet
          await this.companyService.addCompanyToSheet(
            companyToProcess,
            { timedOut: true, reportUrl: reportData.reportUrl },
            reportData.reportUrl,
            null,
            null
          );
          
          return `Emissions extraction timed out for ${company}`; // Return company name to indicate processing completed
        }

        await this.processCompanyAfterEmissionsExtraction(companyToProcess, reportData.emissions, reportData.reportUrl);

        return reportData.emissions.company?.name ?? companyToProcess;
    } catch (error) {
      this.logger.error(`Error processing company ${company}: ${error.message}`);
      return error.message; // Return null in case of error
    }
  }

  /**
   * Get ESG reports for a company
   */
  async getCompanyESGReportData(company: string, reportUrl?: string): Promise<{emissions: any, reportUrl: string} | null> {
    try {
      this.logger.log(`Getting ESG reports for ${company}`);

      if (reportUrl) {
        this.emissionsReportService.validateAndExtractReportData(
          reportUrl, 
          company, 
          null
        );
      }
      
      const currentYear = new Date().getFullYear();
      
      // Try to find the latest report
      for (let year = currentYear; year >= currentYear - 2; year--) {
        this.logger.log(`Searching for ${company} report from ${year}`);
        
        const reportData = await this.reportFinderService.findReportDataWithGemini(company, year);
        
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
} 