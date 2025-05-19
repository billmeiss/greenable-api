import { Injectable } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import * as fs from 'fs/promises';
import * as path from 'path';
import { authenticate } from '@google-cloud/local-auth';

@Injectable()
export class GoogleAuthService {
  private readonly SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
  ];
  private readonly TOKEN_PATH = path.join(process.cwd(), 'token.json');
  private readonly CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

  /**
   * Reads previously authorized credentials from the save file.
   */
  private async loadSavedCredentialsIfExist(): Promise<any> {
    try {
      // Check if we're using environment variables
      if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
        return this.getAuthFromEnvVars();
      }
      
      // Fall back to file-based authentication for local development
      const content = await fs.readFile(this.TOKEN_PATH);
      const credentials = JSON.parse(content.toString());
      return google.auth.fromJSON(credentials);
    } catch (err) {
      return null;
    }
  }

  /**
   * Creates auth client from environment variables
   */
  private getAuthFromEnvVars(): any {
    const credentials = {
      type: 'authorized_user',
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    };
    return google.auth.fromJSON(credentials);
  }

  /**
   * Serializes credentials to a file compatible with GoogleAuth.fromJSON.
   */
  private async saveCredentials(client: any): Promise<void> {
    // Only save credentials to file in development environment
    if (process.env.NODE_ENV !== 'production') {
      const content = await fs.readFile(this.CREDENTIALS_PATH);
      const keys = JSON.parse(content.toString());
      const key = keys.installed || keys.web;
      const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      });
      await fs.writeFile(this.TOKEN_PATH, payload);
    }
  }

  /**
   * Load or request authorization to call APIs.
   */
  public async authorize(): Promise<any> {
    let client = await this.loadSavedCredentialsIfExist();
    console.log('client', client);
    if (client) {
      return client;
    }
    
    // In production, we should always have environment variables
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Google OAuth credentials not found in environment variables');
    }
    
    // For local development, we can use file-based authentication
    client = await authenticate({
      scopes: this.SCOPES,
      keyfilePath: this.CREDENTIALS_PATH,
    });
    if (client.credentials) {
      await this.saveCredentials(client);
    }
    return client;
  }

  /**
   * Get an authenticated Sheets API client
   */
  public async getSheetsClient(): Promise<sheets_v4.Sheets> {
    const auth = await this.authorize();
    return google.sheets({ version: 'v4', auth }) as sheets_v4.Sheets;
  }
} 