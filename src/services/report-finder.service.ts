import { Injectable, Logger } from '@nestjs/common';
import { GeminiApiService } from './gemini-api.service';
import { GeminiModelService } from './gemini-model.service';
import { SearchService } from './search.service';
import { EmissionsReportService } from './emissions-report.service';
import axios from 'axios';
import { CompanyService } from './company.service';

// Add type definition for Gemini API response
interface GeminiResponse {
  response: {
    text(): string;
  };
}

@Injectable()
export class ReportFinderService {
  private readonly logger = new Logger(ReportFinderService.name);

  constructor(
    private readonly geminiApiService: GeminiApiService,
    private readonly geminiModelService: GeminiModelService,
    private readonly searchService: SearchService,
    private readonly emissionsReportService: EmissionsReportService,
    private readonly companyService: CompanyService,
  ) {}

  /**
   * Search for ESG reports for a company
   */
  async searchForESGReports(company: string, targetYear: number, isHistorical = false): Promise<any[]> {
    const yearStr = targetYear.toString();

    const searchQuery = `${company} ${yearStr} sustainability esg report fact sheet pdf`;
    const searchResults = await this.searchService.performWebSearch(searchQuery);
    
    // Remove duplicates based on link
    const uniqueResults = this.removeDuplicateSearchResults(searchResults);
    
    // Filter results to prioritize likely report links
    return this.prioritizeReportResults(uniqueResults, company, yearStr);
  }

  /**
   * Remove duplicate search results
   */
  private removeDuplicateSearchResults(results: any[]): any[] {
    const seen = new Set();
    return results.filter(result => {
      if (seen.has(result.link)) {
        return false;
      }
      seen.add(result.link);
      return true;
    });
  }

  /**
   * Prioritize search results that are likely reports
   */
  private prioritizeReportResults(results: any[], company: string, year: string): any[] {
    // Keywords that indicate a result is likely an ESG report
    const reportKeywords = ['sustainability', 'esg', 'environmental', 'report', 'annual'];
    const pdfKeyword = 'pdf';
    const companyKeywords = company.toLowerCase().split(' ');
    
    return results
      .map(result => {
        // Create a score for each result
        let score = 0;
        const title = result.title?.toLowerCase() || '';
        const snippet = result.snippet?.toLowerCase() || '';
        const link = result.link?.toLowerCase() || '';
        
        // Check for direct PDF links
        if (link.endsWith('.pdf')) {
          score += 10;
        }
        
        // Check for PDF mention
        if (title.includes(pdfKeyword) || link.includes(pdfKeyword)) {
          score += 5;
        }
        
        // Check for report keywords
        reportKeywords.forEach(keyword => {
          if (title.includes(keyword)) score += 3;
          if (snippet.includes(keyword)) score += 2;
          if (link.includes(keyword)) score += 1;
        });
        
        // Check for company name
        companyKeywords.forEach(keyword => {
          if (title.includes(keyword)) score += 2;
          if (link.includes(keyword)) score += 1;
        });
        
        // Check for year
        if (title.includes(year) || snippet.includes(year)) {
          score += 5;
        }
        
        return { ...result, score };
      })
      .sort((a, b) => b.score - a.score); // Sort by score descending
  }

  /**
   * Get a company's ESG report PDF from a webpage URL
   */
  async getPDFReportFromWithinURL(url: string, companyName: string): Promise<string | null> {
    try {
      // Extract all PDF links from the webpage
      const pdfLinks = await this.emissionsReportService.extractEmissionsReportLinks(url, companyName);
      
      if (pdfLinks.length === 0) {
        this.logger.warn(`No PDF links found at ${url}`);
        return null;
      }
      
      // Use Gemini to identify the most likely report URL
      const directReportFinderModel = this.geminiModelService.getModel('directReportFinder');
      
      const prompt = `
        I'm looking for the most likely ESG/sustainability report PDF for ${companyName} from this list of PDFs found on their website:
        ${pdfLinks.join('\n')}
        
        Please analyze these URLs and identify which one is most likely to be their latest sustainability report.
        Consider file naming patterns, URL structure, and any date/year information visible in the URLs.
      `;
      
      const result = await this.geminiApiService.handleGeminiCall(
        () => directReportFinderModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        })
      );
      
      if (!result || !result) {
        throw new Error('Failed to generate content from Gemini');
      }
      
      // Parse the response
      const responseText = result.text;
      const parsedResponse = this.geminiApiService.safelyParseJson(responseText);
      
      if (!parsedResponse || !parsedResponse.reportUrl) {
        // If parsing fails or no reportUrl, return the first PDF
        this.logger.warn('Failed to parse Gemini response, using first PDF link as fallback');
        return pdfLinks[0];
      }
      
      // Verify the URL exists
      const recommendedUrl = parsedResponse.reportUrl;
      
      // Check if the URL is from our original list
      const isInOriginalList = pdfLinks.some(link => link === recommendedUrl);
      
      // If not in the original list, check if it's valid by making a HEAD request
      if (!isInOriginalList) {
        try {
          const response = await axios.head(recommendedUrl);
          if (response.status !== 200) {
            throw new Error(`Non-success status code: ${response.status}`);
          }
        } catch (error) {
          // If the URL is invalid, return the first PDF
          this.logger.warn(`Recommended URL ${recommendedUrl} is invalid, using first PDF link as fallback`);
          return pdfLinks[0];
        }
      }
      
      return recommendedUrl;
    } catch (error) {
      this.logger.error(`Error getting PDF report from ${url}: ${error.message}`);
      return null;
    }
  }

  /**
   * Find a report using Gemini's AI capabilities
   */
  async findReportDataWithGemini(
    company: string, 
    targetYear: number, 
    isHistorical = false,
    withEmissions = true
  ): Promise<{emissions: any, reportUrl: string | null}> {
    try {
      // Search for reports
      const searchResults = await this.searchForESGReports(company, targetYear, isHistorical);
      
      if (!searchResults || searchResults.length === 0) {
        this.logger.warn(`No search results found for ${company} ${targetYear} reports`);
        return null;
      }
      
      console.log(`[STEP] Found ${searchResults.length} search results for ${company} ${targetYear} reports`, searchResults);

      // Process the search results to find a valid report
      return await this.processSearchResultsForReport(company, searchResults, targetYear, null, 5, withEmissions);
    } catch (error) {
      this.logger.error(`Error finding report with Gemini for ${company}: ${error.message}`);
      return null;
    }
  }

  /**
   * Process search results to find a valid report
   */
  async processSearchResultsForReport(
    company: string, 
    searchResults: any[], 
    expectedYear: number | null = null, 
    rejectYear: number | null = null,
    maxAttempts: number = 5,
    withEmissions: boolean = true
  ): Promise<{emissions: any, reportUrl: string} | null> {
    
    // Track URLs we've already tried
    const triedUrls = new Set<string>();
    let attemptCount = 0;

    console.log({ withEmissions})
    
    for (const result of searchResults) {
      if (attemptCount >= maxAttempts) {
        this.logger.warn(`Reached maximum attempts (${maxAttempts}) for finding report`);
        break;
      }

      const untriedUrls = searchResults.filter(result => !triedUrls.has(result.link)).map(result => result.link);
      
      const url = await this.verifyCorrectReport(untriedUrls, company);

      console.log(url)
      
      // Skip if we've already tried this URL
      if (triedUrls.has(url)) {
        continue;
      }
      
      triedUrls.add(url);
      attemptCount++;
      
      try {
        // If it's a PDF, process directly
        if (url.toLowerCase().includes('.pdf') && withEmissions) {
          const validationResult = await this.emissionsReportService.validateAndExtractReportData(
            url, 
            company, 
            expectedYear, 
          );
          
          if (validationResult) {
            // Check if this result contains emissions data
            if (validationResult && validationResult.emissions) {
              // Handle the timeout case - if timedOut is true, immediately return to skip to next company
              if (validationResult.emissions.timedOut) {
                this.logger.warn(`TIMEOUT: Emissions extraction for ${company} exceeded 5 minutes.`);
                this.logger.warn(`Report URL: ${validationResult.reportUrl}`);
                console.log(`[SKIP] Skipping company ${company} due to timeout and moving to next company`);
                return validationResult; // Return the result with timeout information
              }
            }
            return validationResult;
          }
        } else {
          // If it's a webpage, look for PDF links
          const pdfUrl = await this.getPDFReportFromWithinURL(url, company);
          
          if (pdfUrl && !triedUrls.has(pdfUrl)) {
            triedUrls.add(pdfUrl);
            attemptCount++;

            if (withEmissions) {
              const validationResult = await this.emissionsReportService.validateAndExtractReportData(
                pdfUrl, 
                company, 
                expectedYear, 
              );

              if (validationResult) {
                // Check if this result contains emissions data
                if (validationResult && validationResult.emissions) {
                  // Handle the timeout case - if timedOut is true, immediately return to skip to next company
                  if (validationResult.emissions.timedOut) {
                    this.logger.warn(`TIMEOUT: Emissions extraction for ${company} exceeded 5 minutes.`);
                    this.logger.warn(`Report URL: ${validationResult.reportUrl}`);
                    console.log(`[SKIP] Skipping company ${company} due to timeout and moving to next company`);
                    return validationResult; // Return the result with timeout information
                  }
                }
                return validationResult;
              }
            } else {
              return { emissions: null, reportUrl: pdfUrl };
            }
          }
        }
      } catch (error) {
        this.logger.error(`Error processing search result ${url}: ${error.message}`);
      }
    }
    
    this.logger.warn(`No valid report found after trying ${attemptCount} URLs`);
    return null;
  }

  /**
   * Verify which report URL is the correct emissions/sustainability report for a company
   * @param reportUrls Array of potential report URLs
   * @param company Company name
   * @returns The most appropriate report URL or null if none found
   */
  async verifyCorrectReport(reportUrls: string[], company: string): Promise<string | null> {
    if (!reportUrls || reportUrls.length === 0) {
      console.log(`[WARNING] No report URLs provided for ${company}`);
      return null;
    }

    const existingCompanies = await this.companyService.getExistingCompaniesFromSheet();
    const attempts = await this.companyService.getAttemptsFromSheet();

    const companiesToExclude = [...existingCompanies.map(company => company.name), ...attempts];
    
    console.log(`[STEP] Verifying correct report for ${company} from ${reportUrls.length} candidates`);
    
    try {
      // Get the report finder model
      const reportFinderModel = this.geminiModelService.getModel('reportFinder');
      
      // Prepare a detailed prompt for the AI
      const prompt = `
        I need to find the most appropriate sustainability or ESG report for ${company}.
        
        Here are the candidate report URLs I found:
        ${reportUrls.map((url, index) => `${index + 1}. ${url}`).join('\n')}
        
        Please analyze these URLs and determine which one is most likely to be:
        1. The latest official sustainability/ESG/annual report that contains scope 1, 2, and 3 emissions data
        2. From the company's own website (rather than a third-party site)
        3. A comprehensive primary source (not a summary or press release)
        4. The most recent available report

        Make sure to disclude any reports from this list:
        ${companiesToExclude.join(', ')}
        
        Consider factors like:
        - URL patterns (e.g., contains terms like 'sustainability', 'ESG', 'annual', 'report')
        - File naming conventions that suggest it's an official report
        - Year indicators in the URL (prefer most recent)
        - Company domain name in the URL (prefer official company sources)
        
        Return your response in JSON format with these fields:
        - bestReportUrl: the URL of the most appropriate report
        - companyName: the name of the company that the report belongs to
        - confidence: a score from 0-10 indicating your confidence in this selection
        - reasoning: brief explanation of why you selected this report
        - year: the likely year of the report (if detectable from the URL)
      `;
      
      console.log(`[STEP] Sending verification request to Gemini AI for ${company}`);
      
      // Make the AI call
      const result = await this.geminiApiService.handleGeminiCall(
        () => reportFinderModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        })
      );
      
      if (!result || !result) {
        console.log(`[ERROR] Failed to get response from Gemini for ${company} report verification`);
        return reportUrls[0]; // Fall back to first URL
      }
      
      // Parse the response
      const responseText = result.text;
      const parsedResponse = this.geminiApiService.safelyParseJson(responseText);

      console.log(parsedResponse)
      
      if (!parsedResponse) {
        console.log(`[WARNING] Failed to parse Gemini response for ${company} report verification, using first URL as fallback`);
        console.log(`[DETAIL] Raw response: ${responseText.substring(0, 200)}...`);
        return reportUrls[0]; // Fall back to first URL
      }
      
      const bestReportUrl = parsedResponse.reportUrl;
      console.log(`[RESULT] Best report URL for ${company}: ${bestReportUrl}`);
      console.log(`[DETAIL] Confidence: ${parsedResponse.confidence}/10`);
      console.log(`[DETAIL] Reasoning: ${parsedResponse.reasoning}`);

      const doesCompanyExist = await this.companyService.doesCompanyExist(parsedResponse.companyName);

      if (doesCompanyExist) {
        const newReportUrls = reportUrls.filter(url => url !== bestReportUrl);
        return await this.verifyCorrectReport(newReportUrls, company);
      }
      
      // Verify URL exists in our original list
      if (!reportUrls.includes(bestReportUrl)) {
        console.log(`[WARNING] Selected URL not in original list for ${company}, using first URL as fallback`);
        return reportUrls[0];
      }
      
      return bestReportUrl;
    } catch (error) {
      console.log(`[ERROR] Error verifying correct report for ${company}: ${error.message}`);
      // Return the first URL as a fallback
      return reportUrls.length > 0 ? reportUrls[0] : null;
    }
  }
} 