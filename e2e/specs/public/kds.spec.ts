import { test, expect } from '@playwright/test';

/**
 * KDS currently sends no Authorization token → 401 against the hardened backend
 * (ROADMAP 6.1). This spec is written for the FIXED behaviour and is SKIPPED until
 * the KDS page routes its request through the authenticated api client.
 * To enable: remove `.skip` and set KDS_BRANCH_ID in .env.
 */
test.skip('KDS board renders kitchen tickets for a branch', async ({ page }) => {
  const branchId = process.env.KDS_BRANCH_ID;
  test.skip(!branchId, 'Set KDS_BRANCH_ID in .env to run this');

  await page.goto(`/kds?branch_id=${branchId}`);
  // Fixed behaviour: the board renders (not a 401 / empty error state).
  await expect(page.getByText(/kitchen|tickets|orders|bump/i).first()).toBeVisible({ timeout: 15_000 });
});
