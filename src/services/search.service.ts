import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class SearchService {
  private readonly serpApiKey = process.env.SERP_API_KEY || '';
  
  /**
   * Performs a web search using SerpApi
   * @param query The search query
   * @returns An array of search results
   */
  async performWebSearch(query: string): Promise<any[]> {
    try {
      console.log(`Performing web search for query: ${query}`);
      
      const api_key = '6814da39aa4c4974fe0c63d4';
      const url = 'https://api.scrapingdog.com/google/';
      
      const params = {
        api_key: api_key,
        query: query,
        results: 10,
        country: 'us',
        page: 0,
        advance_search: "false"
      };
      
      const response = await axios.get(url, { params });
      
      if (!response.data || !response.data.organic_results) {
        console.log('No search results returned from SerpApi');
        return [];
      }
      
      const results = response.data.organic_results.map((result: any) => {
        return {
          title: result.title || '',
          link: result.link || '',
          snippet: result.snippet || '',
          position: result.position || 0,
          displayed_link: result.displayed_link || '',
        };
      });
      
      console.log(`Found ${results.length} search results`);
      return results;
    } catch (error) {
      console.error(`Error performing web search: ${error.message}`);
      return [];
    }
  }
} 