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
}
