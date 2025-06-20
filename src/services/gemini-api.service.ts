import { Injectable, Logger } from '@nestjs/common';
import { GeminiModelService } from './gemini-model.service';
import { error } from 'console';

@Injectable()
export class GeminiApiService {
  private readonly logger = new Logger(GeminiApiService.name);

  constructor(private readonly geminiModelService: GeminiModelService) {}

  /**
   * Safely handles Gemini API calls with retry logic, timeout, and error handling
   */
  async handleGeminiCall<T>(
    apiCall: () => Promise<T>,
    maxRetries: number = 5,
    retryDelayMs: number = 60000, // 1 minute default delay
    timeoutMs: number = 10 * 60 * 1000 // 10 minute timeout
  ): Promise<T> {
    let retries = 0;
    const startTime = Date.now();
    
    while (retries < maxRetries) {
      try {
        // Check if we've exceeded the overall timeout
        if (Date.now() - startTime > timeoutMs) {
          this.logger.warn(`TIMEOUT: Gemini API call timed out after ${timeoutMs / 1000} seconds`);
          throw new Error(`TIMEOUT: Gemini API call timed out after ${timeoutMs / 1000} seconds`);
        }
        
        // Create the main processing promise
        const processingPromise = apiCall();
        
        // Create a timeout promise for this specific attempt
        const timeoutPromise = new Promise<never>((_, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error(`TIMEOUT: Gemini API call exceeded ${timeoutMs / 1000} seconds`));
          }, timeoutMs);
          
          // Ensure timeout is cleared if processingPromise resolves first
          processingPromise.then(() => clearTimeout(timeoutId)).catch(() => clearTimeout(timeoutId));
        });
        
        // Race the promises
        return await Promise.race([processingPromise, timeoutPromise]);
      } catch (error) {
        console.log({error})
        // Skip retries for "too large" files - immediately throw the error
        if (error.message && error.message.includes('too large')) {
          this.logger.warn(`File is too large to process. Skipping without retry.`);
          throw error;
        }
        
        // Skip retries for timeout errors after overall timeout reached
        if (error.message && error.message.includes('TIMEOUT')) {
          this.logger.warn(`Timeout error: ${error.message}`);
          throw error;
        }
        
        retries++;
        
        // Check if we've reached max retries
        if (retries >= maxRetries) {
          this.logger.error(`Maximum retries (${maxRetries}) reached for Gemini API call`);
          // Check for rate limit errors or server errors
          const isRateLimitError = 
          error.message?.includes('rate limit') ||
          error.message?.includes('quota exceeded') || error.message?.includes('RESOURCE_EXHAUSTED');
              
          // Kill the process if we get a rate limit error
          if (isRateLimitError) {
          this.logger.error(`Fatal error from Gemini API: ${error.message}. Killing process.`);
          process.exit(1);
          }
          throw error;
        }
        
        
        // Use exponential backoff for other errors
        let delay = retryDelayMs;
        delay = retryDelayMs * Math.pow(2, retries - 1);
        this.logger.warn(`Error in Gemini API call: ${error.message}. Retrying in ${delay / 1000} seconds...`);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw new Error('Failed to complete Gemini API call after all retries');
  }

  /**
   * Extract JSON from text response
   */
  extractJsonFromText(text: string): string {
    if (!text) return null;
    
    // Try to find JSON object in the response
    const jsonRegex = /{[\s\S]*}/;
    const match = text.match(jsonRegex);
    
    if (match && match[0]) {
      try {
        // Test if it's valid JSON
        JSON.parse(match[0]);
        return match[0];
      } catch (e) {
        // If not valid JSON, try more aggressive parsing
        return this.createFallbackJson(text);
      }
    }
    
    return this.createFallbackJson(text);
  }

  /**
   * Create fallback JSON when extraction fails
   */
  private createFallbackJson(text: string): string {
    if (!text) return null;
    
    try {
      // Look for JSON patterns and fix common issues
      let jsonCandidate = text;
      
      // Remove markdown code block markers
      jsonCandidate = jsonCandidate.replace(/```json|```/g, '');
      
      // Fix missing commas
      jsonCandidate = jsonCandidate.replace(/}(\s*){/g, '},{');
      
      // Fix trailing commas
      jsonCandidate = jsonCandidate.replace(/,(\s*)}|,(\s*)]|,(\s*)$/g, '}');
      
      // Attempt to complete truncated JSON
      if (jsonCandidate.includes('{') && !jsonCandidate.includes('}')) {
        jsonCandidate += '}';
      }
      
      // Try to parse the fixed JSON
      JSON.parse(jsonCandidate);
      return jsonCandidate;
    } catch (e) {
      // Last resort - try to find any valid JSON object or partial object
      try {
        // Look for best JSON-like structure
        console.log(e)
        const bestJsonRegex = /{[^{]*?(?:}|$)/g;
        const matches = text.match(bestJsonRegex);
        
        if (matches) {
          for (const match of matches) {
            try {
              // Try to complete the JSON if it appears truncated
              let fixedMatch = match;
              
              // Count opening and closing braces
              const openBraces = (match.match(/{/g) || []).length;
              const closeBraces = (match.match(/}/g) || []).length;
              
              // Add missing closing braces if needed
              if (openBraces > closeBraces) {
                fixedMatch += '}'.repeat(openBraces - closeBraces);
              }
              
              // Try to parse
              JSON.parse(fixedMatch);
              return fixedMatch;
            } catch (jsonError) {
              console.log({jsonError})
              // Try to repair common issues
              try {
                // Replace truncated strings with empty strings
                const repairedMatch = match.replace(/"[^"]*$/, '""');
                
                // Fix potential trailing commas
                const noTrailingComma = repairedMatch.replace(/,\s*}$/, '}');
                
                // Try to parse again
                JSON.parse(noTrailingComma);
                return noTrailingComma;
              } catch (repairError) {
                // Continue trying other matches
              }
            }
          }
        }
        
        // If we still haven't found valid JSON, try a more lenient approach
        // Extract key-value pairs and rebuild a simple JSON object
        const keyValueRegex = /"([^"]+)":\s*([^,}]+)/g;
        const keyValues = [...text.matchAll(keyValueRegex)];
        
        if (keyValues.length > 0) {
          const rebuiltJson = '{' + keyValues.map(match => 
            `"${match[1]}": ${match[2].trim()}`
          ).join(',') + '}';
          
          try {
            JSON.parse(rebuiltJson);
            return rebuiltJson;
          } catch (rebuildError) {
            console.log({rebuildError})
            // Last effort failed
          }
        }
      } catch (fallbackError) {
        // All fallback attempts failed
      }
      
      this.logger.error(`Failed to extract valid JSON from text: ${text.substring(0, 150)}...`, text);
      return null;
    }
  }

  /**
   * Safely parse JSON with fallback
   */
  safelyParseJson(responseText: string, defaultValue: any = null): any {
    if (!responseText) return defaultValue;
    
    try {
      // Try direct parsing first
      try {
        return JSON.parse(responseText);
      } catch (e) {
        // If direct parsing fails, try to extract JSON from the text
        const jsonText = this.extractJsonFromText(responseText);
        if (!jsonText) {
          return defaultValue;
        }
        
        try {
          return JSON.parse(jsonText);
        } catch (parseError) {
          // If parsing still fails, return the raw text for human inspection
          this.logger.warn(`Could not parse extracted JSON, returning default value`);
          return defaultValue;
        }
      }
    } catch (error) {
      this.logger.error(`Error parsing JSON: ${error.message}`);
      return defaultValue;
    }
  }
} 