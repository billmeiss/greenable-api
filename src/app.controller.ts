import { Controller, Get, Post, Query, Body, Param } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getCompanyESGReports() {
    return this.appService.processCompanyReports({ withChunking: true });
  }

  @Post('/update-revenues')
  updateRevenues() {
    return this.appService.updateRevenues();
  }

  @Post('/exchange-rates')
  updateExchangeRates() {
    return this.appService.updateExchangeRatesForCompanies();
  }

  @Post('/update-countries')
  updateCountries() {
    return this.appService.updateCountries();
  }

  @Post('/update-categories')
  updateCategories() {
    return this.appService.updateCategories();
  }

  @Post('/company') 
  processCompany(@Body() {
    name,
    reportUrl
  }) {
    return this.appService.processCompany({
      name,
      reportUrl
    });
  }

  @Post('/audited-companies')
  updateAuditedCompanies() {
    return this.appService.updateAuditedCompanies();
  }

  @Post('/update-missing-revenues')
  updateMissingRevenues() {
    return this.appService.updateCompanyRevenues();
  }

  @Post('/check-missing-scopes')
  checkMissingScopes() {
    return this.appService.checkMissingScopes();
  }

  @Post('/update-inconsistent-revenues')
  updateInconsistentRevenues() {
    return this.appService.updateInconsistentRevenues();
  }

  @Post('/update-missing-employees')
  updateMissingEmployees() {
    return this.appService.updateMissingEmployees();
  }

  @Post('/check-incomplete-scopes')
  checkIncompleteScopes() {
    return this.appService.checkIncompleteScopes();
  }  

  

  @Post('/check-existing-reports')
  checkExistingReports() {
    return this.appService.checkExistingReports();
  }

  @Get('/unchecked-reports')
  getUncheckedReports() {
    return this.appService.getCompaniesWithUncheckedReports();
  }

  @Post('/update-checked-reports/:companyName')
  updateCheckedReports(
    @Param('companyName') companyName: string,
    @Body() body?: { fromRow?: number }
  ) {
    const fromRow = body?.fromRow || 5521; // Default to 5521, but allow override
    return this.appService.updateCheckedReports(companyName, fromRow);
  }

  @Post('/update-all-checked-reports')
  updateAllCheckedReports(@Body() body?: { fromRow?: number }) {
    const fromRow = body?.fromRow || 5500; // Default to 5521, but allow override
    return this.appService.updateAllCheckedReports(fromRow);
  }

  @Get('/companies-with-unchecked-reports')
  getCompaniesWithUncheckedReports(@Query('fromRow') fromRow?: string) {
    const startRow = fromRow ? parseInt(fromRow) : 5521; // Default to 5521, but allow override via query param
    return this.appService.getCompaniesWithUncheckedReports(startRow);
  }

  @Post('/classify-company-type')
  classifyCompanyType() {
    return this.appService.classifyCompanyType();
  }

  @Post('/clean-not-specified-values')
  cleanNotSpecifiedValues() {
    return this.appService.cleanNotSpecifiedValuesFromNoRows();
  }

  @Get('/average-emissions-by-industry')
  getAverageEmissionsByIndustry() {
    return this.appService.calculateAverageEmissionsByIndustry();
  }

  @Post('/create-industry-averages-sheet')
  createIndustryAveragesSheet() {
    return this.appService.createIndustryAveragesSheet();
  }

  @Post('/validate-data-quality')
  validateDataQuality(
    @Body() options: { fromRow?: number; toRow?: number } = {}
  ) {
    return this.appService.validateCompaniesDataQuality(options);
  }

  @Post('/fix-revenue-source-errors')
  fixRevenueSourceErrors() {
    return this.appService.fixRevenueSourceErrors();
  }

  /**
   * Validate revenue source URLs and retry revenue extraction if they don't refer to the correct company
   * @param options Configuration options for the validation process
   * @param options.fromRow Start row number in the spreadsheet (optional)
   * @param options.toRow End row number in the spreadsheet (optional)
   * @param options.batchSize Number of companies to process in parallel (default: 5)
   * @returns Summary of validation results including corrected companies
   */
  @Post('/validate-revenue-source-urls')
  validateAndFixRevenueSourceUrls(
    @Body() options: {
      fromRow?: number;
      toRow?: number;
      batchSize?: number;
    } = {}
  ) {
    return this.appService.validateAndFixRevenueSourceUrls(options);
  }

  /**
   * Compare company names between "Companies to Request" and "Analysed Data" sheets
   * Uses Gemini AI to intelligently determine if companies with same names but different countries
   * are actually the same company or different entities
   * @returns Summary of matched companies that will be added to a new comparison sheet
   */
  @Post('/compare-company-names')
  compareCompanyNames() {
    return this.appService.compareCompanyNamesBetweenSheets();
  }

  
}
