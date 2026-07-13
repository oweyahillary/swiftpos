import { test } from '@playwright/test';
import { loginViaPin } from '../../lib/pos-login';
import { openShiftIfNeeded, startDineInOrderIfTables, sellFirstVariantProductCash } from '../../lib/pos-flow';

/**
 * The old 100%-blocker: a product WITH a variant must be sellable end to end.
 * Cashier → open shift → open a table (restaurant) → variant product →
 * one option per group → Add to Order → charge cash → "Payment successful".
 */
test('variant product → cash checkout completes', async ({ page }) => {
  const email = process.env.CASHIER_EMAIL;
  const pin = process.env.CASHIER_PIN;
  test.skip(!email || !pin, 'Run `npm run seed:users` first (CASHIER_* missing from .env)');

  await loginViaPin(page, email!, pin!, /\/pos\/cashier/);
  await openShiftIfNeeded(page);
  await startDineInOrderIfTables(page);
  await sellFirstVariantProductCash(page);
});
