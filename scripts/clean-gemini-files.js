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

async function main() {
  // Check if API key is available
  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY environment variable is not set');
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  console.log("Listing all files in Google AI:");
  
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
    const names = [];
    
    // First, list all files
    while (true) {
      for (const f of page) {
        console.log("  ", f.name);
        names.push(f.name);
      }
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
    
    console.log(`\nFound ${names.length} files.`);
    
    if (names.length === 0) {
      console.log("No files to delete.");
      return;
    }
    
    // Ask for confirmation before deletion
    console.log("\nWARNING: This will delete ALL files listed above.");
    console.log("Press Ctrl+C to cancel or wait 5 seconds to continue...");
    
    // Wait for 5 seconds to give user a chance to cancel
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Delete all files
    console.log("\nDeleting files...");
    for (const name of names) {
      let deleteRetryCount = 0;
      const deleteMaxRetries = 3;
      let deleteSuccess = false;
      
      while (deleteRetryCount < deleteMaxRetries && !deleteSuccess) {
        try {
          await ai.files.delete({ name });
          console.log(`  Deleted: ${name}`);
          deleteSuccess = true;
        } catch (error) {
          deleteRetryCount++;
          if (deleteRetryCount >= deleteMaxRetries) {
            console.error(`  Failed to delete ${name} after ${deleteMaxRetries} attempts:`, error.message);
          } else {
            console.log(`  Delete attempt ${deleteRetryCount} for ${name} failed: ${error.message}. Retrying in 2 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
    }
    
    console.log("\nOperation completed.");
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