import { test, expect } from '@playwright/test';
import { loginViaPin } from '../../lib/pos-login';
import { openShiftIfNeeded } from '../../lib/pos-flow';

/**
 * Security hardening: an expired/invalid POS session must return the terminal to
 * the PIN lock — it must NOT keep the cashier on the sales screen. We invalidate
 * both POS tokens (so a refresh can't save it) and trigger a fetch via reload.
 */
test('expired POS session returns to the PIN lock', async ({ page }) => {
  const email = process.env.CASHIER_EMAIL;
  const pin = process.env.CASHIER_PIN;
  test.skip(!email || !pin, 'Run `npm run seed:users` first (CASHIER_* missing from .env)');

  await loginViaPin(page, email!, pin!, /\/pos\/cashier/);
  await openShiftIfNeeded(page);
  await page
    .locator('[data-testid="table-tile"], [data-testid="product-card"]')
    .first()
    .waitFor({ timeout: 15_000 });

  // Invalidate both POS tokens so the 401 can't be refreshed away.
  await page.evaluate(() => {
    localStorage.setItem('swiftpos_pos_token', 'expired.invalid.token');
    localStorage.removeItem('swiftpos_pos_refresh_token');
  });

  // Trigger an authenticated fetch → 401 → unrecoverable → back to PIN lock.
  await page.reload();

  // PIN login screen is back; the cashier surface is gone.
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="table-tile"], [data-testid="product-card"]')).toHaveCount(0);
});
