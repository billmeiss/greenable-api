import path from 'path';
import dotenv from 'dotenv';

// Load environment variables from project root .env.test
const envPath = path.resolve(process.cwd(), '.env.test');
dotenv.config({ path: envPath });

// Normalize GOOGLE_PRIVATE_KEY to have real newlines if provided with escaped \n
if (process.env.GOOGLE_PRIVATE_KEY) {
  process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
} 