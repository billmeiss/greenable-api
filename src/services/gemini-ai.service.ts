import { Injectable } from '@nestjs/common';
import { createPartFromUri, GoogleGenAI, Type } from '@google/genai';
import { ConfigService } from '@nestjs/config';
import fetch from 'node-fetch';

@Injectable()
export class GeminiAiService {
  private ai: GoogleGenAI;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
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
    const response = await fetch(url);
    const pdfBuffer = await response.arrayBuffer();

    // Check if the file is too large (50MB limit)
    const FILE_SIZE_LIMIT = 50 * 1024 * 1024; // 50MB in bytes
    if (pdfBuffer.byteLength > FILE_SIZE_LIMIT) {
      console.log(`[WARNING] PDF file is too large (${(pdfBuffer.byteLength / (1024 * 1024)).toFixed(2)}MB). Skipping.`);
      throw new Error('PDF file is too large to process');
    }

    const fileBlob = new Blob([pdfBuffer], { type: 'application/pdf' });

    const file = await this.ai.files.upload({
      file: fileBlob,
      config: {
        displayName,
      },
    });

    // Wait for the file to be processed with a timeout
    let getFile = await this.ai.files.get({ name: file.name });
    let processingStartTime = Date.now();
    const maxProcessingTime = 5 * 60 * 1000; // 5 minute timeout for processing
    
    while (getFile.state === 'PROCESSING') {
      // Check if processing has taken too long
      if (Date.now() - processingStartTime > maxProcessingTime) {
        console.log(`[TIMEOUT] PDF processing exceeded ${maxProcessingTime/1000} seconds`);
        throw new Error(`TIMEOUT: PDF processing exceeded ${maxProcessingTime/1000} seconds`);
      }
      
      // Wait before checking status again
      await new Promise((resolve) => {
        setTimeout(resolve, 5000);
      });
      
      getFile = await this.ai.files.get({ name: file.name });
      console.log(`current file status: ${getFile.state}`);
    }
    
    if (getFile.state === 'FAILED') {
      throw new Error('File processing failed.');
    }

    return getFile;
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
    modelName = 'gemini-2.0-flash'
  ): Promise<any> {
    try {
      const content = [prompt];

      // Upload and process PDF
      const file = await this.uploadRemotePDF(url, "Document");
      if (file.uri && file.mimeType) {
        const fileContent = createPartFromUri(file.uri, file.mimeType);
        // @ts-ignore
        content.push(fileContent);
      }

      // Generate content with the PDF
      const response = await this.ai.models.generateContent({
        model: modelName,
        contents: content,
        config: {
          temperature: 0.1,
        },
      });

      return response.text;
    } catch (error) {
      console.error('Error processing PDF:', error);
      throw error;
    }
  }
} 