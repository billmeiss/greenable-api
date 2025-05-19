import { Injectable } from '@nestjs/common';
import { createPartFromUri, GoogleGenAI, Part, Type } from '@google/genai';
// import { ConfigService } from '@nestjs/config';
import fetch from 'node-fetch';
import { GeminiModelService } from './gemini-model.service';

@Injectable()
export class GeminiAiService {
  private ai: GoogleGenAI;

  constructor(private geminiModelService: GeminiModelService) {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log({apiKey});
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not found in environment variables');
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Upload a remote PDF file and wait for it to be processed
   * @param url URL of the PDF file
   * @param displayName Display name for the file
   * @returns Processed file object
   */
  async uploadRemotePDF(url: string, displayName: string) {
    try {
      console.log(`[INFO] Fetching PDF from: ${url}`);
      
      // Set proper headers for PDF file download
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/pdf',
          'User-Agent': 'Mozilla/5.0 (compatible; GreenableAPI/1.0)',
          // add headers to avoid 403
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'credentials': 'include',
          'Upgrade-Insecure-Requests': '1',          
        },
        redirect: 'follow' // Follow redirects automatically
      });

      if (!response.ok) {
        console.error(`[ERROR] Failed to fetch PDF: ${response.status} ${response.statusText}`);
        throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
      }

      // Check content type
      const contentType = response.headers.get('content-type');
      console.log(`[INFO] Content-Type: ${contentType}`);
      
      
      // Check content length
      const contentLength = response.headers.get('content-length');
      console.log(`[INFO] Content-Length: ${contentLength || 'unknown'} bytes`);

      // Download the PDF content
      const pdfBuffer = await response.arrayBuffer();
      console.log(`[INFO] Downloaded file size: ${pdfBuffer.byteLength} bytes`);
      
      // Check if the file is too large
      const FILE_SIZE_LIMIT = 200 * 1024 * 1024; // 200MB in bytes
      if (pdfBuffer.byteLength > FILE_SIZE_LIMIT) {
        console.log(`[WARNING] PDF file is too large (${(pdfBuffer.byteLength / (1024 * 1024)).toFixed(2)}MB). Skipping.`);
        throw new Error('PDF file is too large to process');
      }

      // Create a Blob with the proper MIME type
      const fileBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
      console.log(`[INFO] Created Blob of size ${fileBlob.size} bytes`);

      // Upload the file to Gemini API
      console.log('[INFO] Uploading to Gemini API...');
      const file = await this.ai.files.upload({
        file: fileBlob,
      });
      
      console.log(`[INFO] File uploaded successfully: ${file.name}`);

      // Wait for the file to be processed with a timeout
      let getFile = await this.ai.files.get({ name: file.name });
      console.log(`[INFO] Initial file state: ${getFile.state}, size: ${getFile.sizeBytes} bytes`);
      
      let processingStartTime = Date.now();
      const maxProcessingTime = 10 * 60 * 1000; // 10 minute timeout
      
      while (getFile.state === 'PROCESSING') {
        // Check if processing has taken too long
        if (Date.now() - processingStartTime > maxProcessingTime) {
          console.log(`[TIMEOUT] PDF processing exceeded ${maxProcessingTime/1000} seconds`);
          throw new Error(`TIMEOUT: PDF processing exceeded ${maxProcessingTime/1000} seconds`);
        }

        getFile = await this.ai.files.get({ name: file.name });
        
        // Wait before checking status again
        await new Promise((resolve) => {
          setTimeout(resolve, 5000);
        });
        
        console.log(`[INFO] Current file status: ${getFile.state}`);
      }
      
      if (getFile.state === 'FAILED') {
        console.error('[ERROR] File processing failed.');
        throw new Error('File processing failed.');
      }

      return getFile;
    } catch (error) {
      console.log(process.env.GEMINI_API_KEY, 'here');
      console.error('[ERROR] PDF upload/processing failed:', error);
      throw error;
    }
  }
  
  /**
   * Process a single PDF file using Gemini AI
   * @param url URL of the PDF file
   * @param prompt Prompt to use with the PDF
   * @returns Generated content based on the PDF
   */
  async processPDF(
    url: string,
    prompt = 'Summarize this document',
    modelType = 'esg'
  ): Promise<any> {
    try {
      console.log(`[DEBUG] Processing PDF: ${url}`);
      const content: (string | Part)[] = [prompt];

      // Upload and process PDF
      const file = await this.uploadRemotePDF(url, "Document");
      
      if (!file || !file.uri || !file.mimeType) {
        throw new Error('Invalid file response from PDF upload');
      }
      
      console.log(`[DEBUG] File URI: ${file.uri}, MIME Type: ${file.mimeType}, Size: ${file.sizeBytes} bytes`);
      
      const fileContent = createPartFromUri(file.uri, file.mimeType);
      console.log(fileContent);
      content.push(fileContent);

      const model = this.geminiModelService.getModel(modelType);
      console.log('[DEBUG] Generating content with model...');

      // Generate content with the PDF
      const response = await model.generateContent({
        contents: content,
        config: {
          temperature: 0.1,
        },
      });

      await this.deleteFile(file.name);

      return response.text;
    } catch (error) {
      console.error('Error processing PDF:', error);
      throw error;
    }
  }

  async deleteFile(name: string) {
    console.log(`[DEBUG] Deleting file: ${name}`);
    return this.ai.files.delete({ name });
  }
} 