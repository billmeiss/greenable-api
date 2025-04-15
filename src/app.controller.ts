import { Controller, Get, Post, Query, Body, Param } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getCompanyESGReports() {
    return this.appService.processCompanyReports();
  }

  @Get('company/:name')
  getCompanyReport(@Param('name') companyName: string) {
    return this.appService.processCompanyReport(companyName);
  }

  @Get('companies')
  getCompanies() {
    return this.appService.getCompanies();
  }

  @Post('/update-revenues')
  updateRevenues() {
    return this.appService.updateRevenues();
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

  @Get('/report-urls')
  getReportUrls() {
    return this.appService.getReportUrls();
  }
}
