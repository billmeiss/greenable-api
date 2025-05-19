import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { GoogleAuthService } from './services/google-auth.service';
import { GeminiAiService } from './services/gemini-ai.service';
import { SearchService } from './services/search.service';
import { GeminiModelService } from './services/gemini-model.service';
import { GeminiApiService } from './services/gemini-api.service';
import { EmissionsReportService } from './services/emissions-report.service';
import { ReportFinderService } from './services/report-finder.service';
import { CompanyService } from './services/company.service';
import { ReportProcessingService } from './services/report-processing.service';
import { RetryUtilsService } from './services/retry-utils.service';
import { SheetsApiService } from './services/sheets-api.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService, 
    GoogleAuthService, 
    GeminiAiService, 
    SearchService,
    GeminiModelService,
    GeminiApiService,
    EmissionsReportService,
    ReportFinderService,
    CompanyService,
    ReportProcessingService,
    RetryUtilsService,
    SheetsApiService,
  ],
})
export class AppModule {}
