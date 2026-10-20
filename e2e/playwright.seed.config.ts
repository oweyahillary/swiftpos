import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import { assertNotProduction, chromiumBlockProdArgs, targetsFromEnv } from './lib/prod-guard.mjs';

dotenv.config();

// A536: the same target names and the same production guard as playwright.config.ts.
if (process.env.E2E_WEB_URL) process.env.PLAYWRIGHT_BASE_URL = process.env.E2E_WEB_URL;
if (process.env.E2E_API_URL) process.env.API_BASE_URL = process.env.E2E_API_URL;
assertNotProduction(targetsFromEnv());

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';

/**
 * Dedicated config for the one-time user seed. Kept separate so `npm test` never
 * runs it. Invoke with:  npm run seed:users
 * (CI uses the browser-free seed/seed-staff-api.mjs instead — A536.)
 */
export default defineConfig({
  testDir: './seed',
  testMatch: /seed-users\.setup\.ts/,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    ...devices['Desktop Chrome'],
    launchOptions: { args: chromiumBlockProdArgs([BASE_URL, process.env.API_BASE_URL ?? '']) },
  },
});
