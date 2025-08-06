# Google Sheets Emissions Completion Formula - Implementation Guide

## Overview
This solution creates a comprehensive formula that fills missing Scope 1, Scope 2, and Scope 3 (categories 1-8) emissions data using industry averages based on:
- Industry category
- Revenue band (0-10M, 10M-100M, 100M-1B, 1B+)  
- Employee count band (0-100, 100-1000, 1000-10000, 10000+)

## Step 1: Create Industry Averages Sheet

1. **Create a new sheet** called `Industry_Averages`
2. **Import the sample data** from `industry_averages_sample.csv`
3. **Column structure:**
   - A: Category (Industry names)
   - B: Revenue_Band 
   - C: Employee_Band
   - D: Avg_Scope1_Per_Dollar
   - E: Avg_Scope2_Per_Dollar
   - F-M: Avg_Scope3_Cat1_Per_Dollar through Avg_Scope3_Cat8_Per_Dollar

## Step 2: Add Formulas to Main Data Sheet

### Main Formula: Completed Emissions Per Dollar
**Add this in a new column (e.g., column AM):**

```excel
=LET(
  current_revenue, G2,
  current_employees, H2,
  current_category, AE2,
  current_scope1, J2,
  current_scope2_location, K2,
  current_scope2_market, L2,
  current_scope3_cat1, N2,
  current_scope3_cat2, O2,
  current_scope3_cat3, P2,
  current_scope3_cat4, Q2,
  current_scope3_cat5, R2,
  current_scope3_cat6, S2,
  current_scope3_cat7, T2,
  current_scope3_cat8, U2,
  
  revenue_band, IF(current_revenue <= 10000000, "0-10M", 
                IF(current_revenue <= 100000000, "10M-100M", 
                IF(current_revenue <= 1000000000, "100M-1B", "1B+"))),
  
  employee_band, IF(current_employees <= 100, "0-100", 
                 IF(current_employees <= 1000, "100-1000", 
                 IF(current_employees <= 10000, "1000-10000", "10000+"))),
  
  industry, IF(OR(REGEXMATCH(current_category, "Cement"), REGEXMATCH(current_category, "Clinker"), REGEXMATCH(current_category, "Concrete")), "Cement",
           IF(OR(REGEXMATCH(current_category, "Paddy rice"), REGEXMATCH(current_category, "Wheat"), REGEXMATCH(current_category, "Crops"), REGEXMATCH(current_category, "Cattle")), "Agriculture",
           IF(OR(REGEXMATCH(current_category, "machinery"), REGEXMATCH(current_category, "Capital Goods")), "Capital Goods",
           IF(OR(REGEXMATCH(current_category, "Chemicals"), REGEXMATCH(current_category, "Plastics")), "Chemicals",
           IF(OR(REGEXMATCH(current_category, "Coal"), REGEXMATCH(current_category, "Lignite")), "Coal",
           IF(REGEXMATCH(current_category, "Construction"), "Construction",
           IF(REGEXMATCH(current_category, "Electricity"), "Electric Utilities",
           IF(REGEXMATCH(current_category, "Financial"), "Financial Services",
           IF(OR(REGEXMATCH(current_category, "Food"), REGEXMATCH(current_category, "Beverages")), "Food & Beverage",
           "Other"))))))))),
  
  avg_scope1, INDEX(Industry_Averages!D:D, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  avg_scope2, INDEX(Industry_Averages!E:E, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  avg_scope3_cat1, INDEX(Industry_Averages!F:F, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  avg_scope3_cat2, INDEX(Industry_Averages!G:G, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  avg_scope3_cat3, INDEX(Industry_Averages!H:H, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  avg_scope3_cat4, INDEX(Industry_Averages!I:I, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  avg_scope3_cat5, INDEX(Industry_Averages!J:J, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  avg_scope3_cat6, INDEX(Industry_Averages!K:K, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  avg_scope3_cat7, INDEX(Industry_Averages!L:L, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  avg_scope3_cat8, INDEX(Industry_Averages!M:M, MATCH(1, (Industry_Averages!A:A = industry) * (Industry_Averages!B:B = revenue_band) * (Industry_Averages!C:C = employee_band), 0)),
  
     completed_scope1, IF(AND(NOT(ISBLANK(current_scope1)), current_scope1 <> 0, current_scope1 <> ""), current_scope1, 
                       IF(ISNUMBER(avg_scope1), avg_scope1 * current_revenue, 0)),
   
   completed_scope2, IF(AND(NOT(ISBLANK(current_scope2_market)), current_scope2_market <> 0, current_scope2_market <> ""), current_scope2_market,
                       IF(AND(NOT(ISBLANK(current_scope2_location)), current_scope2_location <> 0, current_scope2_location <> ""), current_scope2_location,
                         IF(ISNUMBER(avg_scope2), avg_scope2 * current_revenue, 0))),
   
   completed_scope3_cat1, IF(AND(NOT(ISBLANK(current_scope3_cat1)), current_scope3_cat1 <> 0, current_scope3_cat1 <> ""), current_scope3_cat1, 
                            IF(ISNUMBER(avg_scope3_cat1), avg_scope3_cat1 * current_revenue, 0)),
   
   completed_scope3_cat2, IF(AND(NOT(ISBLANK(current_scope3_cat2)), current_scope3_cat2 <> 0, current_scope3_cat2 <> ""), current_scope3_cat2, 
                            IF(ISNUMBER(avg_scope3_cat2), avg_scope3_cat2 * current_revenue, 0)),
   
   completed_scope3_cat3, IF(AND(NOT(ISBLANK(current_scope3_cat3)), current_scope3_cat3 <> 0, current_scope3_cat3 <> ""), current_scope3_cat3, 
                            IF(ISNUMBER(avg_scope3_cat3), avg_scope3_cat3 * current_revenue, 0)),
   
   completed_scope3_cat4, IF(AND(NOT(ISBLANK(current_scope3_cat4)), current_scope3_cat4 <> 0, current_scope3_cat4 <> ""), current_scope3_cat4, 
                            IF(ISNUMBER(avg_scope3_cat4), avg_scope3_cat4 * current_revenue, 0)),
   
   completed_scope3_cat5, IF(AND(NOT(ISBLANK(current_scope3_cat5)), current_scope3_cat5 <> 0, current_scope3_cat5 <> ""), current_scope3_cat5, 
                            IF(ISNUMBER(avg_scope3_cat5), avg_scope3_cat5 * current_revenue, 0)),
   
   completed_scope3_cat6, IF(AND(NOT(ISBLANK(current_scope3_cat6)), current_scope3_cat6 <> 0, current_scope3_cat6 <> ""), current_scope3_cat6, 
                            IF(ISNUMBER(avg_scope3_cat6), avg_scope3_cat6 * current_revenue, 0)),
   
   completed_scope3_cat7, IF(AND(NOT(ISBLANK(current_scope3_cat7)), current_scope3_cat7 <> 0, current_scope3_cat7 <> ""), current_scope3_cat7, 
                            IF(ISNUMBER(avg_scope3_cat7), avg_scope3_cat7 * current_revenue, 0)),
   
   completed_scope3_cat8, IF(AND(NOT(ISBLANK(current_scope3_cat8)), current_scope3_cat8 <> 0, current_scope3_cat8 <> ""), current_scope3_cat8, 
                            IF(ISNUMBER(avg_scope3_cat8), avg_scope3_cat8 * current_revenue, 0)),
  
     total_completed_emissions, 
     (IF(ISNUMBER(completed_scope1), completed_scope1, 0)) +
     (IF(ISNUMBER(completed_scope2), completed_scope2, 0)) +
     (IF(ISNUMBER(completed_scope3_cat1), completed_scope3_cat1, 0)) +
     (IF(ISNUMBER(completed_scope3_cat2), completed_scope3_cat2, 0)) +
     (IF(ISNUMBER(completed_scope3_cat3), completed_scope3_cat3, 0)) +
     (IF(ISNUMBER(completed_scope3_cat4), completed_scope3_cat4, 0)) +
     (IF(ISNUMBER(completed_scope3_cat5), completed_scope3_cat5, 0)) +
     (IF(ISNUMBER(completed_scope3_cat6), completed_scope3_cat6, 0)) +
     (IF(ISNUMBER(completed_scope3_cat7), completed_scope3_cat7, 0)) +
     (IF(ISNUMBER(completed_scope3_cat8), completed_scope3_cat8, 0)),
  
  IF(AND(ISNUMBER(current_revenue), current_revenue > 0), 
    total_completed_emissions / current_revenue, 
    "Invalid Revenue")
)
```

### Helper Formulas (Add in separate columns)

**Industry Classification (Column AN):**
```excel
=IF(OR(REGEXMATCH(AE2, "Cement"), REGEXMATCH(AE2, "Clinker"), REGEXMATCH(AE2, "Concrete")), "Cement",
 IF(OR(REGEXMATCH(AE2, "Paddy rice"), REGEXMATCH(AE2, "Wheat"), REGEXMATCH(AE2, "Crops"), REGEXMATCH(AE2, "Cattle")), "Agriculture",
 IF(OR(REGEXMATCH(AE2, "machinery"), REGEXMATCH(AE2, "Capital Goods")), "Capital Goods",
 IF(OR(REGEXMATCH(AE2, "Chemicals"), REGEXMATCH(AE2, "Plastics")), "Chemicals",
 IF(OR(REGEXMATCH(AE2, "Coal"), REGEXMATCH(AE2, "Lignite")), "Coal",
 IF(REGEXMATCH(AE2, "Construction"), "Construction",
 IF(REGEXMATCH(AE2, "Electricity"), "Electric Utilities",
 IF(REGEXMATCH(AE2, "Financial"), "Financial Services",
 IF(OR(REGEXMATCH(AE2, "Food"), REGEXMATCH(AE2, "Beverages")), "Food & Beverage", "Other")))))))))
```

**Revenue Band (Column AO):**
```excel
=IF(G2<=10000000, "0-10M", IF(G2<=100000000, "10M-100M", IF(G2<=1000000000, "100M-1B", "1B+")))
```

**Employee Band (Column AP):**
```excel
=IF(H2<=100, "0-100", IF(H2<=1000, "100-1000", IF(H2<=10000, "1000-10000", "10000+")))
```

**Missing Data Indicator (Column AQ):**
```excel
=CONCATENATE(
  IF(OR(ISBLANK(J2), J2=0, J2=""), "Scope1 ", ""),
  IF(OR(AND(ISBLANK(K2), ISBLANK(L2)), AND(K2=0, L2=0), AND(K2="", L2="")), "Scope2 ", ""),
  IF(OR(ISBLANK(N2), N2=0, N2=""), "S3-Cat1 ", ""),
  IF(OR(ISBLANK(O2), O2=0, O2=""), "S3-Cat2 ", ""),
  IF(OR(ISBLANK(P2), P2=0, P2=""), "S3-Cat3 ", ""),
  IF(OR(ISBLANK(Q2), Q2=0, Q2=""), "S3-Cat4 ", ""),
  IF(OR(ISBLANK(R2), R2=0, R2=""), "S3-Cat5 ", ""),
  IF(OR(ISBLANK(S2), S2=0, S2=""), "S3-Cat6 ", ""),
  IF(OR(ISBLANK(T2), T2=0, T2=""), "S3-Cat7 ", ""),
  IF(OR(ISBLANK(U2), U2=0, U2=""), "S3-Cat8 ", "")
)
```

**Data Completion Percentage (Column AR):**
```excel
=ROUND((10 - LEN(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(
  CONCATENATE(
    IF(OR(ISBLANK(J2), J2=0, J2=""), "1", ""),
    IF(OR(AND(ISBLANK(K2), ISBLANK(L2)), AND(K2=0, L2=0), AND(K2="", L2="")), "1", ""),
    IF(OR(ISBLANK(N2), N2=0, N2=""), "1", ""),
    IF(OR(ISBLANK(O2), O2=0, O2=""), "1", ""),
    IF(OR(ISBLANK(P2), P2=0, P2=""), "1", ""),
    IF(OR(ISBLANK(Q2), Q2=0, Q2=""), "1", ""),
    IF(OR(ISBLANK(R2), R2=0, R2=""), "1", ""),
    IF(OR(ISBLANK(S2), S2=0, S2=""), "1", ""),
    IF(OR(ISBLANK(T2), T2=0, T2=""), "1", ""),
    IF(OR(ISBLANK(U2), U2=0, U2=""), "1", "")
  ), "1", ""), "1", ""), "1", ""), "1", ""), "1", ""), "1", ""), "1", ""), "1", ""), "1", ""), "1", "")) / 10 * 100, 1) & "%"
```

## Step 3: Column Headers

Add these headers to your new columns:
- AM: "Completed Emissions Per Dollar"
- AN: "Industry Classification"
- AO: "Revenue Band"
- AP: "Employee Band"
- AQ: "Missing Data"
- AR: "Data Completion %"

## Step 4: Copy Formulas Down

1. Select the range with your formulas (AM2:AR2)
2. Copy down to all rows with data
3. Google Sheets will automatically adjust the row references

## Key Features

### 1. Smart Data Completion
- **Preserves all existing data:** Whether numbers OR text strings
- **Only fills truly missing data:** Blank cells, zeros, or empty strings
- **Uses industry averages:** When data is missing, applies relevant benchmarks
- **Prioritizes Scope 2 market-based** over location-based values
- **Multiplies per-dollar averages** by company revenue for missing values

### 2. Industry Classification
- Automatically categorizes companies based on existing category patterns
- Supports 17 major industry categories
- Falls back to "Other" for unmatched categories

### 3. Segmentation
- **Revenue Bands:** 0-10M, 10M-100M, 100M-1B, 1B+
- **Employee Bands:** 0-100, 100-1000, 1000-10000, 10000+
- Provides more precise benchmarking

### 4. Analysis Tools
- Shows which data was missing
- Calculates completion percentage
- Identifies industry classification and bands

## Customization Options

### Add More Industries
1. Update the industry classification logic in the formulas
2. Add corresponding rows to the Industry_Averages sheet

### Modify Revenue/Employee Bands
1. Change the threshold values in the band formulas
2. Update the Industry_Averages sheet with new band categories

### Alternative Formula for Older Google Sheets
If your Google Sheets doesn't support the LET function, use the simplified version provided in the `emissions_completion_formula.txt` file.

## Validation

1. **Check Industry Averages:** Ensure all industry/band combinations have data
2. **Verify Calculations:** Spot-check a few rows manually
3. **Review Missing Data:** Use the helper columns to identify patterns
4. **Compare Results:** Compare completed vs. original emissions per dollar

## Important Note About String Values

⚠️ **Calculation Limitation:** When emissions values are text strings, the formula will preserve them but cannot include them in the mathematical total for "emissions per dollar" calculation. The formula will:

1. **Keep all existing string values** in their original form
2. **Only sum numerical values** (both original and industry-average filled)
3. **Calculate emissions per dollar** based only on the numerical portion

If you need to convert string values to numbers for calculation purposes, consider:
- Adding a separate "cleanup" step to convert strings to numbers where appropriate
- Using a modified formula that attempts to extract numbers from text strings
- Manually reviewing and converting critical string values before applying the formula

## Troubleshooting

### #N/A Errors
- Check that Industry_Averages sheet exists and has data
- Verify industry classification matches exactly
- Ensure revenue and employee values are numeric

### Unexpected Results
- Review industry classification logic
- Check revenue/employee band thresholds
- Verify Industry_Averages data is per-dollar values
- Remember that string values are preserved but not included in totals

### Performance Issues
- Consider using named ranges instead of full column references
- Break complex formulas into multiple columns if needed

### Mixed Data Types
- Check which values are strings vs. numbers using ISNUMBER() function
- Consider data cleaning if numerical calculations are critical 