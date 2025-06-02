import { Injectable, Logger } from '@nestjs/common';
import { sheets_v4 } from 'googleapis';
import { GoogleAuthService } from './google-auth.service';
import { RetryUtilsService } from './retry-utils.service';

@Injectable()
export class SheetsApiService {
  private readonly logger = new Logger(SheetsApiService.name);
  private sheets: sheets_v4.Sheets;
  private requestsThisMinute = 0;
  private minuteStartTime = Date.now();
  private readonly MAX_REQUESTS_PER_MINUTE = 300;

  constructor(
    private readonly googleAuthService: GoogleAuthService,
    private readonly retryUtilsService: RetryUtilsService,
  ) {}

  /**
   * Initialize the Google Sheets client if not already initialized
   */
  private async initializeSheetsClient(): Promise<void> {
    if (!this.sheets) {
      this.sheets = await this.googleAuthService.getSheetsClient();
    }
  }

  /**
   * Get values from a spreadsheet with retry logic and rate limiting
   */
  async getValues(
    spreadsheetId: string,
    range: string,
    options: sheets_v4.Params$Resource$Spreadsheets$Values$Get = {}
  ): Promise<any> {
    await this.initializeSheetsClient();
    
    await this.applyRateLimit();

    return this.retryUtilsService.withExponentialBackoff(
      async () => {
        const response = await this.sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
          ...options,
        });
        return response.data;
      },
      this.retryUtilsService.isGoogleApiRetryableError.bind(this.retryUtilsService),
      { operationName: `Sheets API Get Values: ${range}` }
    );
  }

  /**
   * Apply rate limiting to stay within 300 requests per minute
   */
  private async applyRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsedMs = now - this.minuteStartTime;
    
    if (elapsedMs >= 60000) {
      this.requestsThisMinute = 0;
      this.minuteStartTime = now;
    }
    
    this.requestsThisMinute++;
    
    if (this.requestsThisMinute > this.MAX_REQUESTS_PER_MINUTE) {
      const waitTimeMs = 60000 - elapsedMs;
      this.logger.log(`Rate limit of ${this.MAX_REQUESTS_PER_MINUTE} requests reached. Waiting ${waitTimeMs}ms before next request.`);
      await new Promise(resolve => setTimeout(resolve, waitTimeMs));
      
      this.requestsThisMinute = 1;
      this.minuteStartTime = Date.now();
    }
  }

  /**
   * Append values to a spreadsheet with retry logic
   */
  async appendValues(
    spreadsheetId: string,
    range: string,
    values: any[][],
    options: Partial<sheets_v4.Params$Resource$Spreadsheets$Values$Append> = {}
  ): Promise<any> {
    await this.initializeSheetsClient();

    return this.retryUtilsService.withExponentialBackoff(
      async () => {
        const response = await this.sheets.spreadsheets.values.append({
          spreadsheetId,
          range,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values },
          ...options,
        });
        return response.data;
      },
      this.retryUtilsService.isGoogleApiRetryableError.bind(this.retryUtilsService),
      { operationName: `Sheets API Append Values: ${range}` }
    );
  }

  /**
   * Update values in a spreadsheet with retry logic
   */
  async updateValues(
    spreadsheetId: string,
    range: string,
    values: any[][],
    options: Partial<sheets_v4.Params$Resource$Spreadsheets$Values$Update> = {}
  ): Promise<any> {
    await this.initializeSheetsClient();

    return this.retryUtilsService.withExponentialBackoff(
      async () => {
        const response = await this.sheets.spreadsheets.values.update({
          spreadsheetId,
          range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values },
          ...options,
        });
        return response.data;
      },
      this.retryUtilsService.isGoogleApiRetryableError.bind(this.retryUtilsService),
      { operationName: `Sheets API Update Values: ${range}` }
    );
  }

  /**
   * Clear values from a spreadsheet with retry logic
   */
  async clearValues(
    spreadsheetId: string,
    range: string,
    options: Partial<sheets_v4.Params$Resource$Spreadsheets$Values$Clear> = {}
  ): Promise<any> {
    await this.initializeSheetsClient();

    return this.retryUtilsService.withExponentialBackoff(
      async () => {
        const response = await this.sheets.spreadsheets.values.clear({
          spreadsheetId,
          range,
          ...options,
        });
        return response.data;
      },
      this.retryUtilsService.isGoogleApiRetryableError.bind(this.retryUtilsService),
      { operationName: `Sheets API Clear Values: ${range}` }
    );
  }
} 