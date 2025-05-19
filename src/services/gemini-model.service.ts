import { Injectable } from '@nestjs/common';
import { GoogleGenAI, Type } from '@google/genai';

@Injectable()
export class GeminiModelService {
  private modelConfigs: Record<string, any> = {};
  private ai: GoogleGenAI;
  
  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.initializeModelConfigs();
  }

  private initializeModelConfigs(): void {
    // Generic model
    this.modelConfigs.generic = {
      model: 'gemini-2.0-flash',
    };

    this.modelConfigs.companyNameChecker = {
      model: 'gemini-2.5-pro-preview-05-06',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: `You will return responses in this JSON format:
        {
          "exists": boolean
        }`
    };

    this.modelConfigs.companyCategory = {
      model: 'gemini-2.5-flash-preview-04-17',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: `You will return responses in this JSON format:
        {
          "companyCategory": "The category of the given company, can be one of the following:
            Basic Copper
            Publishing
            Printing
            Plastic Products
            Civil Engineering Construction
            Telecommunications
            Other Services
            Uranium Ores
            Hard Coal
            Raising Of Cattle
            Non-nitrogenous And Mixed Fertilizers
            Computers Electronic Products Optical And Precision Instruments
            Building Construction
            Growing Beverage Crops (coffee, Tea Etc)
            Quarrying Of Stone, Sand And Clay
            Growing Tobacco
            Growing Wheat
            Forestry And Logging
            Materials Recovery
            Basic Organic Chemicals
            Water Transport
            Basic Inorganic Chemicals
            Copper Ores
            Cereal Products
            Other Non-ferrous Ores (e.g. Nickel, Tin, Lead, Zinc, Silver, Gold)
            Hospitality
            Dyes, Paints, Glues, Detergents And Other Chemical Products
            Leather And Footwear
            Transport Via Pipeline
            Repair And Installation Of Machinery And Equipment
            Road Transport
            Government Social Security Defence Public Order
            Gas Extraction
            Motor Vehicles, Trailers And Semi-trailers
            Growing Crops N.e.c.
            Furniture And Other Manufacturing N.e.c
            Basic Non-ferrous Metals N.e.c.
            Information Services
            Other Ceramics N.e.c. (e.g. Cement, Lime, Plaster)
            Clay Building Materials
            Arts, Entertainment And Recreation
            Education
            Growing Grapes
            Fabricated Metal Products
            Electric Power Generation, Transmission And Distribution
            Motor Vehicles, Trailers And Semi-trailers
            Fishing
            Basic Aluminium
            Raising Of Poultry
            Growing Maize
            Basic Non-ferrous Metals N.e.c.
            Basic Copper
            Chemical And Fertilizer Minerals
            Rail Transport
            Growing Sugar Beet And Cane
            Animal Oils And Fats
            Civil Engineering Construction
            Growing Spices, Aromatic, Drug And Pharmaceutical Crops
            Other Non-ferrous Ores
            Raising Of Sheep
            Growing Grapes
            Distribution Of Gaseous Fuels Through Mains
            Dairy Products
            Sheep Meat
            Growing Crops N.e.c.
            Non-nitrogenous And Mixed Fertilizers
            Lead/zinc/silver Ores
            Fish Products
            Mining And Quarrying N.e.c. Services To Mining
            Basic Nickel
            Sawmill Products
            Waste Collection, Treatment, And Disposal
            Nickel Ores
            Road Transport
            Arts, Entertainment And Recreation
            Fruit Products
            Information Services
            Electrical Equipment
            Fabricated Metal Products
            Pharmaceuticals And Medicinal Products
            Professional, Scientific And Technical Services
            Copper Ores
            Postal And Courier Services
            Extraction Of Salt
            Growing Fruits And Nuts
            Quarrying Of Stone, Sand And Clay
            Coke Oven Products
            Growing Vegetables, Roots, Tubers
            Basic Iron And Steel
            Gas Extraction
            Forestry And Logging
            Sugar Refining Cocoa, Chocolate And Confectionery
            Vegetable Oils And Fats
            Vegetable Products
            Human Health And Social Work Activities
            Tobacco Products
            Materials Recovery
            Air Transport
            Aluminium Ore
            Pork
            Clay Building Materials
            Property And Real Estate
            Rubber Products
            Basic Organic Chemicals
            Water Collection, Treatment And Supply Sewerage
            Administrative Services
            Other Services (e.g. consulting, marketing, etc)
            Growing Fibre Crops
            Pulp And Paper
            Leather And Footwear
            Transport Via Pipeline
            Telecommunications
            Cereal Products
            Basic Tin
            Other Transport Equipment (e.g. Ships, Planes, Trains)
            Computers Electronic Products Optical And Precision Instruments
            Repair And Installation Of Machinery And Equipment
            Refined Petroleum Products
            Alcoholic And Other  Beverages
            Dyes, Paints, Glues, Detergents And Other Chemical Products
            Raising Of Cattle
            Finance And Insurance
            Food Products And Feeds N.e.c.
            Seeds And Plant Propagation
            Growing Leguminous Crops And Oil Seeds
            Growing Beverage Crops (coffee, Tea Etc)
            Hard Coal
            Other Non-metallic Mineral Products N.e.c.
            Services To Transport
            Textiles And Clothing
            Other Meat Products
            Hospitality
            Basic Petrochemical Products
            Basic Gold
            Other Ceramics N.e.c.
            Growing Rice
            Cement, Lime And Plaster Products
            Government Social Security Defence Public Order
            Growing Cereals N.e.c
            Uranium Ores
            Furniture And Other Manufacturing N.e.c
            Basic Inorganic Chemicals
            Basic Lead/zinc/silver
            Education
            Machinery And Equipment
            Raising Of Animals N.e.c. Services To Agriculture
            Water Transport
            Crustaceans And Molluscs
            Beef Meat
            Petroleum Extraction
            Wholesale And Retail Trade Repair Of Motor Vehicles And Motorcycles
            Growing Wheat
            Publishing
            Raising Of Swine/pigs
            Growing Tobacco
            Printing
            Lignite And Peat
            Plastic Products
            Tin Ores
            Poultry Meat
            Iron Ores
            Nitrogenous Fertilizers
            Building Construction
            Gold Ores
          "
        }`
    }

    // Related companies model
    this.modelConfigs.relatedCompanies = {
      model: 'gemini-2.5-flash-preview-04-17',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: `You will return responses in this JSON format:
        {
          "relatedCompanies": ["List of related companies excluding any existing companies"]
        }`
    };

    this.modelConfigs.countryFinder = {
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: `You will return responses in this JSON format:
            {
              "country": "The country of the given company",
              "confidence": 9,
              "headquarters": "The headquarters of the given company"
            }`
    };

    // Parent company finder model
    this.modelConfigs.parentCompanyFinder = {
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction:  `You will return responses in this JSON format:
            {
              "parentCompany": "The parent company of the given company"
            }`
    };

    // Report finder model
    this.modelConfigs.reportFinder = {
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0.1,
      },
      systemInstruction: `You will return responses in this JSON format:
            {
              "reportUrl": "The URL of the ESG report"
            }
            
            The reportUrl field is required and must be a string.`
    };

    // Direct report finder model
    this.modelConfigs.directReportFinder = {
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: `You will return responses in this JSON format:
            {
              "reportUrl": "The URL of the ESG report"
            }
            
            The reportUrl field is required and must be a string.`
    };

    this.modelConfigs.auditedCompanies = {
      model: 'gemini-2.5-flash-preview-04-17',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
      systemInstruction: `You will return responses in this JSON format:
                      "thirdPartyAssurance": {
                        "company": "The company that audited the report",
                        "notes": "Additional information about the audited company"
                      }, 
                      "notes": "Additional information about how scope 1, 2 and 3 emissions were calculated"`
    }

    // ESG model
    this.modelConfigs.esg = {
      model: 'gemini-2.5-pro-preview-05-06',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
      systemInstruction:  `You will return responses in this JSON format:
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
          
    };

    // Revenue model
    this.modelConfigs.revenue = {
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction:  `You will research and provide accurate financial information about companies.

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
          
      
    };
  }

  getModel(modelName: string) {
    if (!this.modelConfigs[modelName]) {
      throw new Error(`Model ${modelName} not found`);
    }
    
    // Create a wrapper that includes the model configuration
    return {
      generateContent: (params: any) => {
        const config = this.modelConfigs[modelName];
        return this.ai.models.generateContent({
          model: config.model,
          config: {
            ...config.generationConfig,
            systemInstruction: config.systemInstruction,
          },
          ...params
        });
      }
    };
  }

  getGenAI(): GoogleGenAI {
    return this.ai;
  }
} 