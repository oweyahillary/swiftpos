import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';

/**
 * Dedicated config for the one-time user seed. Kept separate so `npm test` never
 * runs it. Invoke with:  npm run seed:users
 */
export default defineConfig({
  testDir: './seed',
  testMatch: /seed-users\.setup\.ts/,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    ...devices['Desktop Chrome'],
  },
});
