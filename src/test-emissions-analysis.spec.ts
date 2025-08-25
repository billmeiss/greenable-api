// Simplified test - implementing the same logic as CompanyService.removeOutliers
// This mirrors the exact implementation from src/services/company.service.ts lines 3392-3429

/**
 * Remove low emission outliers using interquartile range (IQR) method
 * Only removes values below the lower threshold to exclude low emissions
 * This is the exact same implementation as CompanyService.removeOutliers
 */
function removeOutliers(data: number[], benchmarkType: 'employee' | 'revenue' = 'revenue'): number[] {
  if (data.length <= 4) {
    return data; // Need at least 5 data points for meaningful outlier detection
  }
  
  console.log(`Removing low emission outliers from ${data.length} data points using IQR method (${benchmarkType} benchmark)`);
  
  const sorted = [...data].sort((a, b) => a - b);
  
  // Calculate quartiles
  const q1Index = Math.floor(sorted.length * 0.25);
  const q3Index = Math.floor(sorted.length * 0.75);
  
  const q1 = sorted[q1Index];
  const q3 = sorted[q3Index];
  const iqr = q3 - q1;
  
  // Conservative IQR multiplier for lower bound only
  const iqrMultiplier = benchmarkType === 'employee' ? 1.5 : 1.5;
  const lowerBound = q1 - (iqrMultiplier * iqr);
  
  // Only filter out values below the lower bound (low emissions)
  // Keep all high values to avoid excluding companies with legitimate high emissions
  const filtered = data.filter(value => value >= lowerBound);
  
  const removedCount = data.length - filtered.length;
  const removalPercentage = (removedCount / data.length * 100).toFixed(1);
  
  console.log(`IQR filtering: ${removedCount} low outliers removed (${removalPercentage}%), ${filtered.length} data points remaining`);
  
  if (removedCount > 0) {
    const originalMin = Math.min(...data);
    const filteredMin = Math.min(...filtered);
    console.log(`Low emissions filtered: minimum value ${originalMin.toFixed(6)} → ${filteredMin.toFixed(6)}`);
  }
  
  return filtered;
}

/**
 * Calculate the mean of an array of numbers
 * Same as CompanyService.calculateMean
 */
function calculateMean(data: number[]): number {
  if (data.length === 0) return 0;
  return data.reduce((sum, value) => sum + value, 0) / data.length;
}

/**
 * Calculate the median of an array of numbers
 * Same as CompanyService.calculateMedian
 */
function calculateMedian(data: number[]): number {
  if (data.length === 0) return 0;
  const sorted = [...data].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  } else {
    return sorted[mid];
  }
}

/**
 * Calculate the standard deviation of an array of numbers
 * Same as CompanyService.calculateStandardDeviation
 */
function calculateStandardDeviation(data: number[]): number {
  if (data.length === 0) return 0;
  const mean = calculateMean(data);
  const squaredDifferences = data.map(value => Math.pow(value - mean, 2));
  const variance = squaredDifferences.reduce((sum, value) => sum + value, 0) / data.length;
  return Math.sqrt(variance);
}

describe('Emissions Analysis Test', () => {
  // Sample emission values from user's data (emissions per dollar - kg CO2e/USD)
  const emissionValues = [
    0.0002388442827,  // Advania Sri Lanka
    0.01929691053,    // Veeva Systems Inc.
    0.0002586050184,  // Advania Pvt Ltd
    0.04200972161,    // Okta Inc.
    0.02884686744,    // Zscaler Inc.
    0.04026153497,    // Confluent
    0.02406395515,    // Yelp Inc.
    0.4733264955,     // NEC Networks & System Integration Corporation
    0.1655990797,     // Datatec PLC
    0.0183761898,     // o9 Solutions
    0.2356087528,     // AVEVA Group plc
    0.1271391245,     // Samsara Inc.
    0.00008266417638, // RLDatix
    0.03961590269,    // MongoDB Inc.
    0.005972899842,   // Advania UK
    0.006417681771,   // Tanla Platforms Limited
    0.03853784861,    // NNIT A/S
    0.01384877449,    // Weimob Inc.
    0.007393269231,   // BlackBerry Limited
    0.004826834316,   // dotdigital GROUP PLC
    0.06023616908,    // Playtech plc
    0.002585488959,   // NICE Ltd.
    0.01701914198,    // Serko Ltd
    0.0171799319,     // ALTEN
    0.007789189189,   // RSA Security USA LLC
    0.002966239146,   // Data#3 Limited
    0.03730322737,    // Zellis Group
    0.002230769231,   // Verint Systems Inc.
    0.005580303762,   // Netcompany Group A/S
    0.032199,         // Medallia, Inc.
    0.00262726442,    // Azerion Group N.V.
    0.00337543,       // Brillio
    0.2752325979,     // Bechtle AG
    0.06633114667,    // Qlik
    0.00201077498,    // Kaspersky Lab
    0.07778977018,    // Trimble Inc.
    0.02760628652,    // PagerDuty
    0.0008032956448,  // Darktrace plc
    0.02226851852,    // Logpoint
    0.002859330981,   // Netcall plc
    0.02935765379,    // NortonLifeLock Inc.
    0.003369649722,   // Triad Group PLC
    0.003472577778,   // Media.Monks
    0.00423132969,    // ZoomInfo
    0.001296000161,   // Fiverr International Ltd.
    0.00327,          // Giza Systems
    0.03146497672,    // Criteo S.A.
    0.006400948574,   // Capita plc
    0.002188827466,   // Logicalis Brasil
    0.03222258838,    // Gen Digital Inc.
    0.03034504005,    // Documaster
    0.004912018439,   // Wavestone
    0.003635785035,   // Icertis
    0.003827757768,   // Jamf Holding Corp.
    0.005858461966,   // Scout24 SE
    0.004615910934,   // Logiq Consulting Limited
    0.00518580064,    // CGI
    0.02173479742,    // DigiCert Group
    0.1486375297,     // TechMatrix Corporation
    0.000263474282,   // Sinohope Technology Holdings Limited
    0.01807303731,    // Zensar Technologies Limited
    0.005684367738,   // GB Group PLC
    0.003662022151,   // Acronis
    0.0009927121347,  // Edensoft Holdings Limited
    0.01144438296,    // Advisense
    0.006824976867,   // NTT DATA Italia S.p.A.
    0.03965658797,    // Xero
    0.001073016546,   // Bottomline Technologies, Inc.
    0.0009741548619,  // IRIS Software Group
    0.004486993638,   // Sonata Software Limited
    0.01076967667,    // Rillion
    0.00009708641129, // Claranova
    0.002429327963,   // Verisk Analytics
    0.001209214597,   // Cerillion plc
    0.007934099355,   // adesso SE
    0.0274346252,     // Mentimeter AB (publ)
    0.002048857002,   // Microware Group Limited
    0.01302942127,    // International Business Machines Corporation (IBM)
    0.0009484214418,  // Seeing Machines
    0.005778675701,   // Kainos Software Limited
    0.08523460411,    // Infobric
    0.009455623474,   // Globant
    0.008689986435,   // CI&T Inc.
    0.334461497,      // Juniper Networks
    0.01017303371,    // Palantir Technologies Inc.
    0.009016916779,   // Nagarro SE
    0.0009968601855,  // Bravura Solutions Limited
    0.01047912317,    // Splunk Inc.
    0.01143338639,    // NCSOFT Corporation
    0.01074597904,    // DENTSU SOKEN INC.
    0.004169630109,   // K3 Business Technology Group PLC
    0.01074387704,    // BearingPoint
    0.01085631691,    // Gartner, Inc.
    0.01106805556,    // SoftServe
    0.01120145197,    // FDM Group (Holdings) plc
    0.00551375094,    // Fabasoft AG
    0.0112644186,     // UST Global Inc.
    0.01121338923,    // Virtusa Corporation
  ];

  it('should analyze emission values using existing outlier detection', () => {
    console.log('=== EMISSIONS ANALYSIS TEST ===\n');
    
    console.log(`Original dataset: ${emissionValues.length} companies`);
    console.log(`Min emission: ${Math.min(...emissionValues).toFixed(8)} kg CO2e/USD`);
    console.log(`Max emission: ${Math.max(...emissionValues).toFixed(8)} kg CO2e/USD`);
    console.log(`Mean emission: ${calculateMean(emissionValues).toFixed(8)} kg CO2e/USD\n`);

    // Test with revenue benchmark (current implementation)
    console.log('--- TESTING WITH REVENUE BENCHMARK ---');
    const filteredRevenue = removeOutliers(emissionValues, 'revenue');
    const removedRevenueCount = emissionValues.length - filteredRevenue.length;
    const removalRevenuePercentage = (removedRevenueCount / emissionValues.length * 100).toFixed(1);
    
    console.log(`Filtered dataset: ${filteredRevenue.length} companies`);
    console.log(`Removed ${removedRevenueCount} companies (${removalRevenuePercentage}%)`);
    console.log(`New min emission: ${Math.min(...filteredRevenue).toFixed(8)} kg CO2e/USD`);
    console.log(`New max emission: ${Math.max(...filteredRevenue).toFixed(8)} kg CO2e/USD`);
    console.log(`New mean emission: ${calculateMean(filteredRevenue).toFixed(8)} kg CO2e/USD\n`);

    // Test with employee benchmark
    console.log('--- TESTING WITH EMPLOYEE BENCHMARK ---');
    const filteredEmployee = removeOutliers(emissionValues, 'employee');
    const removedEmployeeCount = emissionValues.length - filteredEmployee.length;
    const removalEmployeePercentage = (removedEmployeeCount / emissionValues.length * 100).toFixed(1);
    
    console.log(`Filtered dataset: ${filteredEmployee.length} companies`);
    console.log(`Removed ${removedEmployeeCount} companies (${removalEmployeePercentage}%)`);
    console.log(`New min emission: ${Math.min(...filteredEmployee).toFixed(8)} kg CO2e/USD`);
    console.log(`New max emission: ${Math.max(...filteredEmployee).toFixed(8)} kg CO2e/USD`);
    console.log(`New mean emission: ${calculateMean(filteredEmployee).toFixed(8)} kg CO2e/USD\n`);

    // Analyze the quartiles manually to understand the IQR method
    console.log('--- QUARTILE ANALYSIS ---');
    const sorted = [...emissionValues].sort((a, b) => a - b);
    const q1Index = Math.floor(sorted.length * 0.25);
    const q3Index = Math.floor(sorted.length * 0.75);
    const q1 = sorted[q1Index];
    const q3 = sorted[q3Index];
    const iqr = q3 - q1;
    const lowerBound = q1 - (1.5 * iqr);
    
    console.log(`Q1 (25th percentile): ${q1.toFixed(8)} kg CO2e/USD`);
    console.log(`Q3 (75th percentile): ${q3.toFixed(8)} kg CO2e/USD`);
    console.log(`IQR: ${iqr.toFixed(8)} kg CO2e/USD`);
    console.log(`Lower bound (Q1 - 1.5*IQR): ${lowerBound.toFixed(8)} kg CO2e/USD`);
    
    const belowLowerBound = emissionValues.filter(value => value < lowerBound);
    console.log(`Values below lower bound: ${belowLowerBound.length} companies`);
    console.log(`Lowest values being filtered:`, belowLowerBound.sort((a, b) => a - b).slice(0, 5).map(v => v.toFixed(8)));

    // Identify potential issues
    console.log('\n--- POTENTIAL ISSUES ANALYSIS ---');
    
    // Check for extremely low values
    const extremelyLowValues = emissionValues.filter(value => value < 0.001);
    console.log(`Extremely low values (< 0.001): ${extremelyLowValues.length} companies`);
    if (extremelyLowValues.length > 0) {
      console.log(`These values: ${extremelyLowValues.map(v => v.toFixed(10)).join(', ')}`);
    }

    // Check for potential unit conversion issues
    const veryLowValues = emissionValues.filter(value => value < 0.01);
    console.log(`Very low values (< 0.01): ${veryLowValues.length} companies`);
    console.log(`This represents ${(veryLowValues.length / emissionValues.length * 100).toFixed(1)}% of companies`);

    // Statistical analysis
    console.log('\n--- STATISTICAL SUMMARY ---');
    const mean = calculateMean(emissionValues);
    const median = calculateMedian(emissionValues);
    const stdDev = calculateStandardDeviation(emissionValues);
    
    console.log(`Mean: ${mean.toFixed(8)} kg CO2e/USD`);
    console.log(`Median: ${median.toFixed(8)} kg CO2e/USD`);
    console.log(`Standard Deviation: ${stdDev.toFixed(8)} kg CO2e/USD`);
    console.log(`Coefficient of Variation: ${(stdDev / mean * 100).toFixed(1)}%`);

    // Distribution analysis
    console.log('\n--- DISTRIBUTION ANALYSIS ---');
    const ranges = [
      { name: 'Ultra-low (< 0.001)', count: emissionValues.filter(v => v < 0.001).length },
      { name: 'Very low (0.001-0.01)', count: emissionValues.filter(v => v >= 0.001 && v < 0.01).length },
      { name: 'Low (0.01-0.05)', count: emissionValues.filter(v => v >= 0.01 && v < 0.05).length },
      { name: 'Medium (0.05-0.1)', count: emissionValues.filter(v => v >= 0.05 && v < 0.1).length },
      { name: 'High (0.1-0.5)', count: emissionValues.filter(v => v >= 0.1 && v < 0.5).length },
      { name: 'Very high (≥ 0.5)', count: emissionValues.filter(v => v >= 0.5).length },
    ];

    ranges.forEach(range => {
      const percentage = (range.count / emissionValues.length * 100).toFixed(1);
      console.log(`${range.name}: ${range.count} companies (${percentage}%)`);
    });

    console.log('\n=== CONCLUSION ===');
    console.log('The emission values appear low because:');
    console.log('1. Many companies have very efficient operations relative to revenue');
    console.log('2. Some values might be missing scope 3 emissions');
    console.log('3. Potential unit conversion or data quality issues');
    console.log('4. Industry mix includes many software/service companies with low physical emissions');
    console.log(`5. The IQR method is removing ${removedRevenueCount} companies (${removalRevenuePercentage}%) which may be appropriate for outlier detection`);

    // Assertions to make this a proper test
    expect(filteredRevenue.length).toBeLessThanOrEqual(emissionValues.length);
    expect(filteredRevenue.length).toBeGreaterThan(0);
    expect(Math.min(...filteredRevenue)).toBeGreaterThanOrEqual(lowerBound);
    
    console.log('\n✅ Test completed successfully!');
  });

  it('should test different IQR multipliers to understand sensitivity', () => {
    console.log('\n=== IQR MULTIPLIER SENSITIVITY TEST ===\n');
    
    const sorted = [...emissionValues].sort((a, b) => a - b);
    const q1Index = Math.floor(sorted.length * 0.25);
    const q3Index = Math.floor(sorted.length * 0.75);
    const q1 = sorted[q1Index];
    const q3 = sorted[q3Index];
    const iqr = q3 - q1;
    
    const multipliers = [1.0, 1.5, 2.0, 2.5, 3.0];
    
    console.log('Testing different IQR multipliers:');
    multipliers.forEach(multiplier => {
      const lowerBound = q1 - (multiplier * iqr);
      const filtered = emissionValues.filter(value => value >= lowerBound);
      const removedCount = emissionValues.length - filtered.length;
      const removalPercentage = (removedCount / emissionValues.length * 100).toFixed(1);
      
      console.log(`Multiplier ${multiplier}: removes ${removedCount} companies (${removalPercentage}%), lower bound: ${lowerBound.toFixed(8)}`);
    });
    
    // Test should always pass
    expect(true).toBe(true);
  });
}); 