import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Owner authentication.
 *
 * Mirrors the real login UI in apps/dashboard/src/pages/LoginPage.tsx:
 *   email input (type=email) → password input (type=password) → "Sign in".
 * On success the app navigates to /dashboard (or /change-password if a reset
 * was forced). Owner tokens live in localStorage + the Supabase session, both
 * of which storageState captures.
 */

const authFile = 'playwright/.auth/owner.json';

setup('authenticate as owner', async ({ page }) => {
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'Missing OWNER_EMAIL / OWNER_PASSWORD. Copy e2e/.env.example to e2e/.env and fill them in.',
    );
  }

  await page.goto('/login');

  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Either the dashboard or a forced password-change screen is acceptable proof
  // that credentials were accepted; we assert the dashboard for the happy path.
  await page.waitForURL(/\/dashboard|\/change-password/, { timeout: 20_000 });
  await expect(page, 'owner should land on /dashboard after login').toHaveURL(/\/dashboard/);

  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  await page.context().storageState({ path: authFile });
});
