import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

// Load e2e/.env (never committed). Falls back to real env vars in CI.
dotenv.config();

/**
 * Target under test.
 *   - Local (default):    have the dashboard (Vite) + API running, then just run the tests.
 *   - Deployed/staging:   set PLAYWRIGHT_BASE_URL=https://your-dashboard-url in e2e/.env
 *
 * We intentionally do NOT auto-boot the dev servers here — you already run them
 * day-to-day, and booting the API needs its own Supabase env. Point-and-run is
 * simpler and less brittle. (We can add a `webServer` block later if you want
 * one command to rule them all.)
 */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';

export default defineConfig({
  testDir: './',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    // ── Auth setup (runs first, saves storageState) ──────────────────────────
    { name: 'setup:owner', testMatch: /auth\/owner\.setup\.ts/ },

    // ── Owner surface (Supabase login) ───────────────────────────────────────
    {
      name: 'owner',
      testMatch: /specs\/owner\/.*\.spec\.ts/,
      dependencies: ['setup:owner'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/owner.json',
      },
    },

    // ── POS + Manager surfaces ───────────────────────────────────────────────
    // These log in per-test with a PIN (via lib/pos-login.ts) rather than reusing
    // storageState — the cashier session marker lives in sessionStorage, which
    // storageState doesn't capture, so a fresh PIN login is simpler and robust.
    // Specs self-skip until `npm run seed:users` has populated the PINs in .env.
    {
      name: 'pos',
      testMatch: /specs\/pos\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'manager',
      testMatch: /specs\/manager\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },

    // ── Public routes (no auth): /kds, /menu/:slug ───────────────────────────
    {
      name: 'public',
      testMatch: /specs\/public\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
