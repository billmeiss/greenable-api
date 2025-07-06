// Script to list and delete all files in Google AI
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fetch = require('node-fetch');

// Configure fetch with increased timeout for the GoogleGenAI client
const fetchWithTimeout = (url, options = {}) => {
  // Set timeout to 10 minutes (600,000ms) to handle slow API responses
  const timeout = options.timeout || 600000;
  
  return Promise.race([
    fetch(url, {
      ...options,
      timeout: undefined // Remove timeout from fetch options since we're handling it ourselves
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Request timeout after ${timeout}ms`)), timeout)
    )
  ]);
};

global.fetch = fetchWithTimeout;

async function deleteFilesInBatch(ai, files, batchNumber) {
  console.log(`\nDeleting batch ${batchNumber} (${files.length} files)...`);
  
  for (const file of files) {
    let deleteRetryCount = 0;
    const deleteMaxRetries = 3;
    let deleteSuccess = false;
    
    while (deleteRetryCount < deleteMaxRetries && !deleteSuccess) {
      try {
        await ai.files.delete({ name: file.name });
        console.log(`  Deleted: ${file.name}`);
        deleteSuccess = true;
      } catch (error) {
        deleteRetryCount++;
        if (deleteRetryCount >= deleteMaxRetries) {
          console.error(`  Failed to delete ${file.name} after ${deleteMaxRetries} attempts:`, error.message);
        } else {
          console.log(`  Delete attempt ${deleteRetryCount} for ${file.name} failed: ${error.message}. Retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
  }
  
  console.log(`Batch ${batchNumber} completed.`);
}

async function main() {
  // Check if API key is available
  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY environment variable is not set');
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  console.log("Processing files in Google AI (deleting after each batch):");
  
  try {
    // Using the pager style to list files with retry logic
    let pager;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        console.log(`Attempting to list files (attempt ${retryCount + 1}/${maxRetries})...`);
        pager = await ai.files.list({ config: { pageSize: 10 } });
        break; // Success, exit retry loop
      } catch (error) {
        retryCount++;
        if (retryCount >= maxRetries) {
          throw error; // Re-throw if we've exhausted retries
        }
        console.log(`Attempt ${retryCount} failed: ${error.message}. Retrying in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    let page = pager.page;
    let batchNumber = 1;
    let totalFilesProcessed = 0;
    
    // Ask for confirmation before starting deletion
    console.log("\nWARNING: This will delete ALL files in batches as they are found.");
    console.log("Press Ctrl+C to cancel or wait 5 seconds to continue...");
    
    // Wait for 5 seconds to give user a chance to cancel
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Process and delete files batch by batch
    while (true) {
      const currentBatch = [];
      
      // Collect files in current batch
      for (const f of page) {
        console.log("  ", f.name);
        currentBatch.push(f);
      }
      
      // Delete files in current batch if any exist
      if (currentBatch.length > 0) {
        await deleteFilesInBatch(ai, currentBatch, batchNumber);
        totalFilesProcessed += currentBatch.length;
        batchNumber++;
      }
      
      // Check if there are more pages
      if (!pager.hasNextPage()) break;
      
      // Add retry logic for pagination as well
      retryCount = 0;
      while (retryCount < maxRetries) {
        try {
          page = await pager.nextPage();
          break;
        } catch (error) {
          retryCount++;
          if (retryCount >= maxRetries) {
            throw error;
          }
          console.log(`Pagination attempt ${retryCount} failed: ${error.message}. Retrying in 3 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    }
    
    if (totalFilesProcessed === 0) {
      console.log("No files found to delete.");
    } else {
      console.log(`\nOperation completed. Total files processed: ${totalFilesProcessed} in ${batchNumber - 1} batches.`);
    }
    
  } catch (error) {
    console.error("Error listing or deleting files:", error.message);
    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response data:", error.response.data);
    }
    process.exit(1);
  }
}

main().catch(error => {
  console.error("Error:", error);
  process.exit(1);
}); 