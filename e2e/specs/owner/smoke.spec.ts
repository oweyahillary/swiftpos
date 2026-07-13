import { test, expect } from '@playwright/test';

/**
 * Increment-1 smoke test.
 * Purpose: prove the whole pipeline works — setup logs in once, this test reuses
 * that session (no login code here) and reaches an authenticated page.
 * Keep assertions on stable shell elements, not data that depends on seed state.
 */

test('owner reaches the dashboard using the saved session', async ({ page }) => {
  await page.goto('/dashboard');

  // Not bounced back to the login page.
  await expect(page).toHaveURL(/\/dashboard/);

  // Dashboard shell rendered (footer string from DashboardLayout.tsx).
  await expect(page.getByText('Powered by SwiftPOS')).toBeVisible({ timeout: 15_000 });
});
