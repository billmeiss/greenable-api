import { Injectable } from '@nestjs/common';
import { GenerativeModel, GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

@Injectable()
export class GeminiModelService {
  private genAI: GoogleGenerativeAI;
  private models: Record<string, GenerativeModel> = {};

  constructor() {
    this.genAI = new GoogleGenerativeAI(
      process.env.GEMINI_API_KEY || 'AIzaSyC7TjgbmLdhHbpQVeAryMYd3joJYh-D2Cc',
    );
    this.initializeModels();
  }

  private initializeModels(): void {
    // Generic model
    this.models.generic = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
    });

    this.models.countryFinder = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: {
        role: 'system',
        parts: [
          {
            text: `You will return responses in this JSON format:
            {
              "country": "The country of the given company",
              "confidence": 9,
              "headquarters": "The headquarters of the given company"
            }`
          }
        ]
      },
      
    });

    // Parent company finder model
    this.models.parentCompanyFinder = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            parentCompany: { 
              type: SchemaType.STRING, 
              description: 'The parent company of the given company', 
              nullable: false 
            },
          },
        },
      },
    });

    // Report finder model
    this.models.reportFinder = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0.1,
      },
      systemInstruction: {
        role: 'system',
        parts: [
          {
            text: `You will return responses in this JSON format:
            {
              "reportUrl": "The URL of the ESG report"
            }
            
            The reportUrl field is required and must be a string.`
          }
        ]
      }
    });

    // Direct report finder model
    this.models.directReportFinder = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            reportUrl: { 
              type: SchemaType.STRING, 
              description: 'The direct URL to the company\'s latest ESG/sustainability report PDF' 
            },
            reportYear: { 
              type: SchemaType.STRING, 
              description: 'The year of the report (e.g., "2023", "2023-2024", etc.)' 
            },
            confidence: { 
              type: SchemaType.NUMBER, 
              description: 'Confidence score from 0-10 that this is the correct and latest report for the company' 
            },
            reasoning: { 
              type: SchemaType.STRING, 
              description: 'Brief explanation of why this is believed to be the correct report URL' 
            }
          },
          required: ["reportUrl", "confidence"]
        },
        temperature: 0.1,
      },
    });

    // ESG model
    this.models.esg = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: {
        role: 'system',
        parts: [
          {
            text: `You will return responses in this JSON format:
            {
              "format": "The format of the response",
              "containsRelevantData": true,
              "reportingPeriod": "The time period covered by the emissions data",
              "standardUnit": "The standardized unit used for all emissions data",
              "confidence": {
                "overall": 0,
                "notes": "Explanation of confidence level and any potential issues",
                "missingData": ["List of data points that were not found or were unclear in the report"],
                "potentialErrors": ["List of potential errors or uncertainties in the extracted data"]
              },
              "scope1": {
                "value": 0,
                "notes": "Additional information about scope 1 emissions, including if combined with scope 2",
                "confidence": 0
              },
              "scope2": {
                "locationBased": {
                  "value": 0,
                  "confidence": 0
                },
                "marketBased": {
                  "value": 0,
                  "confidence": 0
                },
                "notes": "Additional information about scope 2 emissions, including if combined with scope 1"
              },
              "scope3": {
                "total": {
                  "value": 0,
                  "confidence": 0
                },
                "categories": {
                  "1": {
                    "value": 0,
                    "description": "Purchased goods and services",
                    "included": true,
                    "notes": "Additional details about this category",
                    "confidence": 0
                  }
                  // Additional categories would continue here
                }
              }
            }`
          }
        ]
      }
    });

    // Revenue model
    this.models.revenue = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: {
        role: 'system',
        parts: [
          {
            text: `You will research and provide accurate financial information about companies.

When asked about a company, you will:
1. Find the annual revenue for the requested year or most recent year available
2. Identify the currency of the revenue (e.g., USD, EUR, JPY)
3. Determine the exact fiscal year or period for this revenue data
4. Find the specific source of this financial information
5. Provide the direct URL to the source document or webpage
6. Assign a confidence score from 0-10

Confidence score guidelines:
- 10 = Direct from official company financial reports
- 7-9 = From reliable financial news sources or databases
- 4-6 = From industry estimates or analyst reports
- 1-3 = From less reliable or outdated sources
- 0 = Unable to find reliable information

IMPORTANT FORMATTING RULES:
- For the "year" field, provide ONLY the year or fiscal period in a CONCISE format (e.g., "2023", "FY 2022-2023")
- DO NOT include explanatory text, notes, or qualifiers in the "year" field
- DO NOT repeat information in any field
- If data is preliminary, simply add "(preliminary)" after the year, nothing more

You will return responses in this JSON format:
{
  "revenue": 45600000000,
  "currency": "USD",
  "year": "FY 2022",
  "source": "Company Annual Report",
  "sourceUrl": "https://example.com/annual-report-2022.pdf",
  "confidence": 9
}

Example 1:
For "Microsoft", the response might be:
{
  "revenue": 211900000000,
  "currency": "USD",
  "year": "FY 2023",
  "source": "Microsoft Annual Report",
  "sourceUrl": "https://microsoft.com/investor-relations/annual-report-2023",
  "confidence": 10
}

Example 2:
For a smaller European company with preliminary data:
{
  "revenue": 250000000,
  "currency": "EUR",
  "year": "2022 (preliminary)",
  "source": "Forbes Private Companies List",
  "sourceUrl": "https://forbes.com/private-companies/2022",
  "confidence": 6
}`
          }
        ]
      }
    });
  }

  getModel(modelName: string): GenerativeModel {
    if (!this.models[modelName]) {
      throw new Error(`Model ${modelName} not found`);
    }
    return this.models[modelName];
  }

  getGenAI(): GoogleGenerativeAI {
    return this.genAI;
  }
} 