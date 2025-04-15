#!/usr/bin/env node

/**
 * This script extracts Google OAuth credentials from the existing files
 * and sets them up as environment variables in a .env file.
 * 
 * Usage: node scripts/setup-google-credentials.js
 */

const fs = require('fs');
const path = require('path');

// Paths to credential files
const credentialsPath = path.join(process.cwd(), 'credentials.json');
const tokenPath = path.join(process.cwd(), 'token.json');
const envPath = path.join(process.cwd(), '.env');

// Check if credential files exist
if (!fs.existsSync(credentialsPath)) {
  console.error('Error: credentials.json file not found');
  process.exit(1);
}

if (!fs.existsSync(tokenPath)) {
  console.error('Error: token.json file not found');
  process.exit(1);
}

try {
  // Read and parse credential files
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  // Extract credentials
  const key = credentials.installed || credentials.web;
  const clientId = key.client_id;
  const clientSecret = key.client_secret;
  const refreshToken = token.refresh_token;

  // Create or update .env file
  let envContent = '';
  
  // Check if .env file exists and read its content
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    
    // Remove existing Google credential lines if they exist
    envContent = envContent
      .split('\n')
      .filter(line => !line.startsWith('GOOGLE_CLIENT_ID=') && 
                      !line.startsWith('GOOGLE_CLIENT_SECRET=') && 
                      !line.startsWith('GOOGLE_REFRESH_TOKEN='))
      .join('\n');
  }

  // Add Google credentials to .env content
  const googleCredentials = `
# Google OAuth Credentials
GOOGLE_CLIENT_ID=${clientId}
GOOGLE_CLIENT_SECRET=${clientSecret}
GOOGLE_REFRESH_TOKEN=${refreshToken}
`;

  // Write updated .env file
  fs.writeFileSync(envPath, envContent + googleCredentials);
  
  console.log('Successfully extracted Google OAuth credentials and added them to .env file');
  console.log('You can now safely remove credentials.json and token.json from your repository');
  console.log('Make sure to add these files to .gitignore if they are not already there');
} catch (error) {
  console.error('Error processing credential files:', error.message);
  process.exit(1);
} 