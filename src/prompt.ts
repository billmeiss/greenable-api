import { SchemaType } from "@google/generative-ai";

// The ESG model template using JSON-prompt
export const schema = `You will return responses in this JSON format:
{
  "format": "The format of the response",
  "containsRelevantData": true,
  "reportingPeriod": "The time period covered by the emissions data",
  "standardUnit": "The standardized unit used for all emissions data (use EXACTLY one of: 'tCO2e', 'tCO₂e', or 'metric tons CO2e')",
  "confidence": {
    "overall": 0,
    "notes": "Explanation of confidence level and any potential issues",
    "missingData": ["List of data points that were not found or were unclear in the report"],
    "potentialErrors": ["List of potential errors or uncertainties in the extracted data"]
  },
  "scope1": {
    "value": 0,
    "notes": "Additional information about scope 1 emissions",
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
    "notes": "Additional information about scope 2 emissions"
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
    },
    "includedCategories": ["List of scope 3 categories explicitly included"],
    "missingCategories": ["List of scope 3 categories excluded or not mentioned"],
    "notes": "Additional information about scope 3 emissions",
    "confidence": 0
  }
}

All fields are required.
format, reportingPeriod, standardUnit, and notes fields must be strings.
containsRelevantData must be a boolean.
confidence.overall and all other confidence scores must be numbers from 0-10.
missingData and potentialErrors must be arrays of strings.
All emission values (scope1.value, scope2.locationBased.value, scope2.marketBased.value, scope3.total.value, and category values) must be non-zero numbers.
scope3.includedCategories and scope3.missingCategories must be arrays of strings.
The included field for each category must be a boolean.

Note: For scope3.categories, include entries for all 15 categories following the same structure as category 1.

IMPORTANT: A report is only considered to contain relevant data (containsRelevantData = true) if it has non-zero numerical values for any of the following:
- scope1.value
- scope2.locationBased.value
- scope2.marketBased.value
- scope3.total.value

If any of these values are missing, zero, or non-numerical, containsRelevantData must be set to false.`;

/**
 * Returns a sample JSON object with the schema structure
 */
export function getSampleSchema() {
  return {
    format: "Format description",
    containsRelevantData: true,
    reportingPeriod: "2023",
    standardUnit: "tCO2e",
    confidence: {
      overall: 8,
      notes: "High confidence in extracted data",
      missingData: ["Some category details missing"],
      potentialErrors: []
    },
    scope1: {
      value: 500,
      notes: "Direct emissions from operations",
      confidence: 9
    },
    scope2: {
      locationBased: {
        value: 300,
        confidence: 8
      },
      marketBased: {
        value: 250,
        confidence: 8
      },
      notes: "Electricity consumption emissions"
    },
    scope3: {
      total: {
        value: 1500,
        confidence: 7
      },
      categories: {
        "1": {
          value: 400,
          description: "Purchased goods and services",
          included: true,
          notes: "Based on procurement data",
          confidence: 7
        },
        "2": {
          value: 200,
          description: "Capital goods",
          included: true,
          notes: "Based on capital expenditure",
          confidence: 6
        }
        // Additional categories would be included here
      },
      includedCategories: ["1", "2", "3", "6", "7"],
      missingCategories: ["4", "5", "8", "9", "10", "11", "12", "13", "14", "15"],
      notes: "Limited scope 3 reporting",
      confidence: 6
    }
  };
}