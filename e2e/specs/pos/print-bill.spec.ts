import { test, expect } from '@playwright/test';
import { loginViaPin } from '../../lib/pos-login';
import { openShiftIfNeeded, startDineInOrderIfTables, addFirstVariantProductToCart } from '../../lib/pos-flow';

/**
 * Regression: "Print Bill" once hung the tab (popup window). It now prints via a
 * hidden iframe, so clicking it must NOT freeze the cashier. We click it and then
 * confirm the screen is still responsive (Charge remains usable).
 */
test('Print Bill does not freeze the cashier', async ({ page }) => {
  const email = process.env.CASHIER_EMAIL;
  const pin = process.env.CASHIER_PIN;
  test.skip(!email || !pin, 'Run `npm run seed:users` first (CASHIER_* missing from .env)');

  await loginViaPin(page, email!, pin!, /\/pos\/cashier/);
  await openShiftIfNeeded(page);

  const tableName = await startDineInOrderIfTables(page);
  test.skip(!tableName, 'Print Bill is a restaurant (dine-in) action');

  await addFirstVariantProductToCart(page);

  const printBill = page.getByRole('button', { name: /Print Bill/i });
  await expect(printBill).toBeVisible();
  await printBill.click();

  // Still responsive: the Charge button remains usable right after printing.
  await expect(page.locator('[data-testid="charge-button"]')).toBeEnabled({ timeout: 10_000 });
});
