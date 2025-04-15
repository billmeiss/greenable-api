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
      
      const params = {
        q: query,
        api_key: this.serpApiKey,
        engine: 'google',
        num: 10,
        hl: 'en',
        gl: 'us',
      };
      
      const response = await axios.get('https://serpapi.com/search', { params });
      
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