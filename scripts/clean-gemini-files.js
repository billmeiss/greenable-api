// Script to list and delete all files in Google AI
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fetch = require('node-fetch');

// Configure fetch for the GoogleGenAI client
global.fetch = fetch;

async function main() {
  // Check if API key is available
  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY environment variable is not set');
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  console.log("Listing all files in Google AI:");
  
  try {
    // Using the pager style to list files
    const pager = await ai.files.list({ config: { pageSize: 10 } });
    let page = pager.page;
    const names = [];
    
    // First, list all files
    while (true) {
      for (const f of page) {
        console.log("  ", f.name);
        names.push(f.name);
      }
      if (!pager.hasNextPage()) break;
      page = await pager.nextPage();
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
      try {
        await ai.files.delete({ name });
        console.log(`  Deleted: ${name}`);
      } catch (error) {
        console.error(`  Failed to delete ${name}:`, error.message);
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