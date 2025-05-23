import { Injectable } from '@nestjs/common';
import { DynamicRetrievalConfigMode, GoogleGenAI, Type } from '@google/genai';

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
      model: 'gemini-2.5-flash-preview-05-20',
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
      model: 'gemini-2.5-flash-preview-05-20',
      generationConfig: {
        temperature: 0.1,
      },
      systemInstruction: `You will return responses in this JSON format only :
        {
          "companyCategory": "The category of the given company, is the most appropriate category possible from the following list:
            Paddy rice

Wheat
Cereal grains nec
Vegetables, fruit, nuts
Oil seeds
Sugar cane, sugar beet
Plant-based fibers
Crops nec
Cattle
Pigs
Poultry
Meat animals nec
Animal products nec
Raw milk
Wool, silk-worm cocoons
Manure (conventional treatment)
Manure (biogas treatment)
Products of forestry, logging and related services
Fish and other fishing products; services incidental of fishing
Anthracite
Coking Coal
Other Bituminous Coal
Sub-Bituminous Coal
Patent Fuel
Lignite/Brown Coal
BKB/Peat Briquettes
Peat
Crude petroleum and services related to crude oil extraction, excluding surveying
Natural gas and services related to natural gas extraction, excluding surveying
Natural Gas Liquids
Other Hydrocarbons
Uranium and thorium ores
Iron ores
Copper ores and concentrates
Nickel ores and concentrates
Aluminium ores and concentrates
Precious metal ores and concentrates
Lead, zinc and tin ores and concentrates
Other non-ferrous metal ores and concentrates
Stone
Sand and clay
Chemical and fertilizer minerals, salt and other mining and quarrying products n.e.c.
Products of meat cattle
Products of meat pigs
Products of meat poultry
Meat products nec
products of Vegetable oils and fats
Dairy products
Processed rice
Sugar
Food products nec
Beverages
Fish products
Tobacco products
Textiles
Wearing apparel; furs
Leather and leather products
Wood and products of wood and cork; articles of straw and plaiting materials
Wood material for treatment, Re-processing of secondary wood material into new wood material
Pulp
Secondary paper for treatment, Re-processing of secondary paper into new pulp
Paper and paper products
Printed matter and recorded media
Coke Oven Coke
Gas Coke
Coal Tar
Motor Gasoline
Aviation Gasoline
Gasoline Type Jet Fuel
Kerosene Type Jet Fuel
Kerosene
Gas/Diesel Oil
Heavy Fuel Oil
Refinery Gas
Liquefied Petroleum Gases (LPG)
Refinery Feedstocks
Ethane
Naphtha
White Spirit & SBP
Lubricants
Bitumen
Paraffin Waxes
Petroleum Coke
Non-specified Petroleum Products
Nuclear fuel
Plastics, basic
Secondary plastic for treatment, Re-processing of secondary plastic into new plastic
N-fertiliser
P- and other fertiliser
Chemicals nec
Charcoal
Additives/Blending Components
Biogasoline
Biodiesels
Other Liquid Biofuels
Rubber and plastic products
Glass and glass products
Secondary glass for treatment, Re-processing of secondary glass into new glass
Ceramic goods
Bricks, tiles and construction products, in baked clay
Cement, lime and plaster
Ash for treatment, Re-processing of ash into clinker
Other non-metallic mineral products
Basic iron and steel and of ferro-alloys and first products thereof
Secondary steel for treatment, Re-processing of secondary steel into new steel
Precious metals
Secondary preciuos metals for treatment, Re-processing of secondary preciuos metals into new preciuos metals
Aluminium and aluminium products
Secondary aluminium for treatment, Re-processing of secondary aluminium into new aluminium
Lead, zinc and tin and products thereof
Secondary lead for treatment, Re-processing of secondary lead into new lead
Copper products
Secondary copper for treatment, Re-processing of secondary copper into new copper
Other non-ferrous metal products
Secondary other non-ferrous metals for treatment, Re-processing of secondary other non-ferrous metals into new other non-ferrous metals
Foundry work services
Fabricated metal products, except machinery and equipment
Machinery and equipment n.e.c.
Office machinery and computers
Electrical machinery and apparatus n.e.c.
Radio, television and communication equipment and apparatus
Medical, precision and optical instruments, watches and clocks
Motor vehicles, trailers and semi-trailers
Other transport equipment
Furniture; other manufactured goods n.e.c.
Secondary raw materials
Bottles for treatment, Recycling of bottles by direct reuse
Electricity by coal
Electricity by gas
Electricity by nuclear
Electricity by hydro
Electricity by wind
Electricity by petroleum and other oil derivatives
Electricity by biomass and waste
Electricity by solar photovoltaic
Electricity by solar thermal
Electricity by tide, wave, ocean
Electricity by Geothermal
Electricity nec
Transmission services of electricity
Distribution and trade services of electricity
Coke oven gas
Blast Furnace Gas
Oxygen Steel Furnace Gas
Gas Works Gas
Biogas
Distribution services of gaseous fuels through mains
Steam and hot water supply services
Collected and purified water, distribution services of water
Construction work
Secondary construction material for treatment, Re-processing of secondary construction material into aggregates
Sale, maintenance, repair of motor vehicles, motor vehicles parts, motorcycles, motor cycles parts and accessoiries
Retail trade services of motor fuel
Wholesale trade and commission trade services, except of motor vehicles and motorcycles
Retail trade services, except of motor vehicles and motorcycles; repair services of personal and household goods
Hotel and restaurant services
Railway transportation services
Other land transportation services
Transportation services via pipelines
Sea and coastal water transportation services
Inland water transportation services
Air transport services 
Supporting and auxiliary transport services; travel agency services
Post and telecommunication services
Financial intermediation services, except insurance and pension funding services
Insurance and pension funding services, except compulsory social security services
Services auxiliary to financial intermediation
Financial services nec
Real estate services
Renting services of machinery and equipment without operator and of personal and household goods
Computer and related services
Research and development services
Other business services
Public administration and defence services; compulsory social security services 
Education services
Health and social work services
Food waste for treatment: incineration
Paper waste for treatment: incineration
Plastic waste for treatment: incineration
Intert/metal waste for treatment: incineration
Textiles waste for treatment: incineration
Wood waste for treatment: incineration
Oil/hazardous waste for treatment: incineration
Food waste for treatment: biogasification and land application
Paper waste for treatment: biogasification and land application
Sewage sludge for treatment: biogasification and land application
Food waste for treatment: composting and land application
Paper and wood waste for treatment: composting and land application
Food waste for treatment: waste water treatment
Other waste for treatment: waste water treatment
Food waste for treatment: landfill
Paper for treatment: landfill
Plastic waste for treatment: landfill
Inert/metal/hazardous waste for treatment: landfill
Textiles waste for treatment: landfill
Wood waste for treatment: landfill
Membership organisation services n.e.c.
Recreational, cultural and sporting services
Other services
Private households with employed persons
Extra-territorial organizations and bodies
          "
        }`
    }

    // Related companies model
    this.modelConfigs.relatedCompanies = {
      model: 'gemini-2.5-flash-preview-05-20',
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: `You will return responses in this JSON format:
        {
          "relatedCompanies": ["List of related companies excluding any existing companies"]
        }`
    };

    this.modelConfigs.countryFinder = {
      model: 'gemini-2.5-flash-preview-05-20',
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
      model: 'gemini-2.5-flash-preview-05-20',
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
      model: 'gemini-2.5-flash-preview-05-20',
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
      model: 'gemini-2.5-flash-preview-05-20',
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
      model: 'gemini-2.5-flash-preview-05-20',
      generationConfig: {
        temperature: 0.1,
        tools: [{googleSearch: {}}],
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