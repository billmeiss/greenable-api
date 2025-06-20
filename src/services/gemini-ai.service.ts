import { Injectable } from '@nestjs/common';
import { createPartFromUri, GoogleGenAI, Part, Type } from '@google/genai';
// import { ConfigService } from '@nestjs/config';
import fetch from 'node-fetch';
import { GeminiModelService } from './gemini-model.service';
import PuppeteerHTMLPDF from 'puppeteer-html-pdf';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

@Injectable()
export class GeminiAiService {
  private ai: GoogleGenAI;
  private htmlPdf: any;

  constructor(private geminiModelService: GeminiModelService) {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log({apiKey});
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not found in environment variables');
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.htmlPdf = new PuppeteerHTMLPDF();
    this.htmlPdf.setOptions({ 
      format: 'A4',
      timeout: 180000, // 3 minutes timeout
      printBackground: true
    });
  }

  /**
   * Upload a remote PDF file and wait for it to be processed
   * @param url URL of the PDF file or local file path
   * @param displayName Display name for the file
   * @returns Processed file object
   */
  async uploadRemotePDF(url: string, displayName: string) {
    try {
      console.log(`[INFO] Processing file: ${url}`);
      
      let pdfBuffer: ArrayBuffer;
      
      // Check if it's a local file path (file:// URL)
      if (url.startsWith('file://')) {
        const filePath = url.replace('file://', '');
        console.log(`[INFO] Reading local file: ${filePath}`);
        
        const fileBuffer = await fsPromises.readFile(filePath);
        pdfBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
        console.log(`[INFO] Read local file size: ${pdfBuffer.byteLength} bytes`);
      } else {
        // Handle remote URLs
        console.log(`[INFO] Fetching PDF from: ${url}`);
        
        // Set proper headers for any file download
        const response = await fetch(url, {
          method: 'GET',
          headers: {
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
        pdfBuffer = await response.arrayBuffer();
        console.log(`[INFO] Downloaded file size: ${pdfBuffer.byteLength} bytes`);
      }
      
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
          temperature: 0.0,
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

  /**
   * Convert HTML webpage to PDF using puppeteer-html-pdf
   * @param url URL to convert to PDF
   * @returns Path to the generated PDF file
   */
  async convertHtmlToPdf(url: string): Promise<string> {
    try {
      console.log(`[INFO] Converting HTML to PDF: ${url}`);
      
      // Create a temporary file path for the PDF
      const tempDir = os.tmpdir();
      const randomId = crypto.randomBytes(16).toString('hex');
      const pdfPath = path.join(tempDir, `webpage-${randomId}.pdf`);
      
      // Set PDF save path
      this.htmlPdf.setOptions({ path: pdfPath, userAgent: 'Mozilla/5.0 (compatible; GreenableAPI/1.0)' });
      
      // Generate PDF from URL
      await this.htmlPdf.create(url);
      console.log(`[INFO] PDF conversion successful: ${pdfPath}`);
      
      return pdfPath;
    } catch (error) {
      console.error('[ERROR] HTML to PDF conversion failed:', error);
      throw error;
    } finally {
      // Close browser tabs but keep browser instance for reuse
      // await this.htmlPdf.closeBrowserTabs();
    }
  }

  /**
   * Process any URL by converting HTML to PDF first
   * @param url URL to process
   * @param prompt Prompt to use with the content
   * @param modelType Model type to use
   * @returns Generated content based on the URL
   */
  async processUrl(
    url: string,
    prompt = 'Analyze this content',
    modelType = 'esg'
  ): Promise<any> {
    try {
      console.log(`[INFO] Processing URL: ${url}`);
      
      // Check if it's already a PDF
      const isPdf = url.toLowerCase().endsWith('.pdf') || 
                   url.toLowerCase().includes('.pdf');
      
      if (isPdf) {
        // Process directly as PDF
        console.log(`[INFO] Detected PDF URL, processing directly`);
        return this.processPDF(url, prompt, modelType);
      } else {
        // Convert HTML to PDF first
        console.log(`[INFO] Converting HTML to PDF before processing`);
        const pdfPath = await this.convertHtmlToPdf(url);
        
        try {
          // Create a file:// URL for the local PDF
          const pdfUrl = `file://${pdfPath}`;
          
          // Process the generated PDF
          const result = await this.processPDF(pdfUrl, prompt, modelType);
          
          // Clean up the temporary PDF file
          await fsPromises.unlink(pdfPath);
          
          return result;
        } catch (error) {
          // Make sure to clean up even if processing fails
          try {
            await fsPromises.unlink(pdfPath);
          } catch (cleanupError) {
            console.error('[ERROR] Failed to clean up temporary PDF:', cleanupError);
          }
          throw error;
        }
      }
    } catch (error) {
      console.error('[ERROR] URL processing failed:', error);
      throw error;
    } finally {
      // Close browser instance when done with all processing
      // Comment this out if you want to reuse the browser instance
      // await this.htmlPdf.closeBrowser();
    }
  }

  
} 