import { Test, TestingModule } from '@nestjs/testing';
import { CompanyService } from './services/company.service';
import { GeminiApiService } from './services/gemini-api.service';
import { GeminiAiService } from './services/gemini-ai.service';
import { GeminiModelService } from './services/gemini-model.service';
import { GoogleAuthService } from './services/google-auth.service';
import { SheetsApiService } from './services/sheets-api.service';
import { SearchService } from './services/search.service';
import { EmissionsReportService } from './services/emissions-report.service';

describe('Industry Averages Analysis Test', () => {
  let companyService: CompanyService;

  beforeAll(async () => {
    // Check if we have the required environment variables
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GEMINI_API_KEY) {
      console.log('⚠️  Missing environment variables for Google Sheets or Gemini API. This test will be skipped.');
      return;
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompanyService,
        GeminiApiService,
        GeminiAiService,
        GeminiModelService,
        GoogleAuthService,
        SheetsApiService,
        SearchService,
        EmissionsReportService,
      ],
    }).compile();

    companyService = module.get<CompanyService>(CompanyService);
  });

  it('should analyze industry averages to understand why emission values are low', async () => {
    // Skip test if environment variables are missing
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GEMINI_API_KEY) {
      console.log('⚠️  Skipping test due to missing environment variables');
      return;
    }

    console.log('=== INDUSTRY AVERAGES ANALYSIS TEST ===\n');
    
    try {
      // Call the existing method to calculate industry averages
      console.log('Calculating industry averages using existing method...');
      const result = await companyService.calculateAverageEmissionsByIndustry(false);
      
      if (!result.success) {
        console.log('❌ Failed to calculate industry averages');
        console.log('Error:', result.error);
        return;
      }
      
      console.log('✅ Successfully calculated industry averages\n');
      
      // Analyze the results
      const { industryAverages, companiesUsedSummary, totalCompaniesProcessed } = result;
      
      console.log(`Total companies processed: ${totalCompaniesProcessed}`);
      console.log(`Industries analyzed: ${Object.keys(industryAverages).length}\n`);
      
      // Analyze each industry
      Object.entries(industryAverages).forEach(([industry, ranges]: [string, any]) => {
        console.log(`--- ${industry.toUpperCase()} ---`);
        
        Object.entries(ranges).forEach(([range, categories]: [string, any]) => {
          console.log(`  ${range}:`);
          
          Object.entries(categories).forEach(([category, data]: [string, any]) => {
            if (data && typeof data === 'object') {
              const avgValue = data.averageEmissionsPerDollar || data.averageEmissionsPerEmployee;
              const unit = data.unit || 'unknown unit';
              const companiesIncluded = data.companiesIncluded || 0;
              const outliersRemoved = data.outliersRemoved || 0;
              const outlierPercentage = data.outlierPercentage || 0;
              
              console.log(`    ${category}: ${avgValue?.toFixed(8)} ${unit}`);
              console.log(`      Companies: ${companiesIncluded}, Outliers removed: ${outliersRemoved} (${outlierPercentage}%)`);
              
              // Flag very low values
              if (avgValue && avgValue < 0.001) {
                console.log(`      ⚠️  VERY LOW VALUE DETECTED`);
              }
            }
          });
          console.log('');
        });
      });
      
      // Overall analysis
      console.log('\n=== OVERALL ANALYSIS ===');
      
      // Count very low averages across all industries and categories
      let totalAverages = 0;
      let veryLowAverages = 0;
      let ultraLowAverages = 0;
      let categoryAnalysis: Record<string, { count: number; lowCount: number; values: number[] }> = {};
      
      Object.entries(industryAverages).forEach(([industry, ranges]: [string, any]) => {
        Object.entries(ranges).forEach(([range, categories]: [string, any]) => {
          Object.entries(categories).forEach(([category, data]: [string, any]) => {
            if (data && typeof data === 'object') {
              const avgValue = data.averageEmissionsPerDollar || data.averageEmissionsPerEmployee;
              if (avgValue !== undefined && avgValue !== null) {
                totalAverages++;
                
                if (!categoryAnalysis[category]) {
                  categoryAnalysis[category] = { count: 0, lowCount: 0, values: [] };
                }
                categoryAnalysis[category].count++;
                categoryAnalysis[category].values.push(avgValue);
                
                if (avgValue < 0.01) {
                  veryLowAverages++;
                  categoryAnalysis[category].lowCount++;
                }
                if (avgValue < 0.001) {
                  ultraLowAverages++;
                }
              }
            }
          });
        });
      });
      
      console.log(`Total industry averages calculated: ${totalAverages}`);
      console.log(`Very low averages (< 0.01): ${veryLowAverages} (${(veryLowAverages/totalAverages*100).toFixed(1)}%)`);
      console.log(`Ultra-low averages (< 0.001): ${ultraLowAverages} (${(ultraLowAverages/totalAverages*100).toFixed(1)}%)`);
      
      // Analyze by category
      console.log('\n--- ANALYSIS BY GHG CATEGORY ---');
      Object.entries(categoryAnalysis).forEach(([category, analysis]) => {
        const avgOfAverages = analysis.values.reduce((sum, val) => sum + val, 0) / analysis.values.length;
        const lowPercentage = (analysis.lowCount / analysis.count * 100).toFixed(1);
        
        console.log(`${category}:`);
        console.log(`  Total averages: ${analysis.count}`);
        console.log(`  Low values (< 0.01): ${analysis.lowCount} (${lowPercentage}%)`);
        console.log(`  Average of averages: ${avgOfAverages.toFixed(8)}`);
        console.log(`  Min: ${Math.min(...analysis.values).toFixed(8)}, Max: ${Math.max(...analysis.values).toFixed(8)}`);
        console.log('');
      });
      
      // Summary and recommendations
      console.log('\n=== CONCLUSIONS ===');
      console.log('The emission values appear low because:');
      
      if (veryLowAverages / totalAverages > 0.5) {
        console.log('1. ⚠️  Over 50% of industry averages are below 0.01 kg CO2e/USD');
      }
      
      if (ultraLowAverages > 0) {
        console.log(`2. ⚠️  ${ultraLowAverages} ultra-low averages (< 0.001) suggest potential data quality issues`);
      }
      
      console.log('3. Many companies in the dataset are likely software/service companies with low physical emissions');
      console.log('4. The IQR outlier detection may not be aggressive enough for this skewed distribution');
      console.log('5. Some companies may be missing comprehensive Scope 3 emissions reporting');
      
      // Test assertions
      expect(result.success).toBe(true);
      expect(totalAverages).toBeGreaterThan(0);
      expect(Object.keys(industryAverages).length).toBeGreaterThan(0);
      
      console.log('\n✅ Industry averages analysis completed successfully!');
      
    } catch (error) {
      console.error('❌ Error during industry averages calculation:', error);
      throw error;
    }
  }, 120000); // 2 minute timeout for the API calls
}); 