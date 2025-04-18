import { Controller, Get, Post, Query, Body, Param } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getCompanyESGReports() {
    return this.appService.processCompanyReports();
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
}
