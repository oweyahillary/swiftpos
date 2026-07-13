import { test, expect } from '@playwright/test';
import { loginViaPin } from '../../lib/pos-login';
import { openShiftIfNeeded, startDineInOrderIfTables, sellFirstVariantProductCash } from '../../lib/pos-flow';

/**
 * "Needs verify" fix: a dine-in table should free itself immediately after
 * payment — no separate "clear table" step. We open a table, complete a cash
 * sale, close the receipt, and assert that same table is back to `free`.
 */
test('dine-in table auto-clears after payment', async ({ page }) => {
  const email = process.env.CASHIER_EMAIL;
  const pin = process.env.CASHIER_PIN;
  test.skip(!email || !pin, 'Run `npm run seed:users` first (CASHIER_* missing from .env)');

  await loginViaPin(page, email!, pin!, /\/pos\/cashier/);
  await openShiftIfNeeded(page);

  const tableName = await startDineInOrderIfTables(page);
  test.skip(!tableName, 'Not a table-based (restaurant) flow — nothing to auto-clear');

  await sellFirstVariantProductCash(page);

  // Close the receipt ("New order") to return to the tables view.
  await page.getByRole('button', { name: 'New order' }).click();

  // The table we used should now be free again — cleared by payment, not by hand.
  const usedTable = page.locator(`[data-testid="table-tile"][data-name="${tableName}"]`).first();
  await expect(usedTable, 'the paid table should return to free').toHaveAttribute('data-status', 'free', {
    timeout: 15_000,
  });
});
