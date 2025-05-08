import { Injectable, Logger } from '@nestjs/common';
import { sheets_v4 } from 'googleapis';
import { GoogleAuthService } from './google-auth.service';
import { RetryUtilsService } from './retry-utils.service';

@Injectable()
export class SheetsApiService {
  private readonly logger = new Logger(SheetsApiService.name);
  private sheets: sheets_v4.Sheets;

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
   * Get values from a spreadsheet with retry logic
   */
  async getValues(
    spreadsheetId: string,
    range: string,
    options: sheets_v4.Params$Resource$Spreadsheets$Values$Get = {}
  ): Promise<any> {
    await this.initializeSheetsClient();

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