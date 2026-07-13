import { test, expect } from '@playwright/test';
import { loginViaPin } from '../../lib/pos-login';
import { openShiftIfNeeded, startDineInOrderIfTables, sellFirstVariantProductCash } from '../../lib/pos-flow';

/**
 * Verifies the reporting timezone fix end to end: a sale made *now* must count
 * toward TODAY on the owner cockpit ("Revenue today"). If the EAT business-day
 * logic were wrong, a same-day sale could land under yesterday and this wouldn't move.
 */

function parseKes(text: string | null): number {
  const m = text?.match(/KES\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
}

test('cockpit "Revenue today" increases after a same-day sale', async ({ page, browser }) => {
  const email = process.env.CASHIER_EMAIL;
  const pin = process.env.CASHIER_PIN;
  test.skip(!email || !pin, 'Run `npm run seed:users` first (CASHIER_* missing from .env)');

  // Owner cockpit (this page is owner-authed via the project's saved session).
  await page.goto('/dashboard');
  const revCard = () => page.getByText('Revenue today', { exact: true }).locator('..');
  await expect(revCard()).toContainText('KES', { timeout: 15_000 });
  const before = parseKes(await revCard().textContent());

  // Make a real same-day sale in a separate cashier session.
  const cashierCtx = await browser.newContext();
  const cashier = await cashierCtx.newPage();
  await loginViaPin(cashier, email!, pin!, /\/pos\/cashier/);
  await openShiftIfNeeded(cashier);
  await startDineInOrderIfTables(cashier);
  await sellFirstVariantProductCash(cashier);
  await cashierCtx.close();

  // The cockpit should now count that sale under today.
  await page.reload();
  await expect(revCard()).toContainText('KES', { timeout: 15_000 });
  await expect
    .poll(async () => parseKes(await revCard().textContent()), { timeout: 20_000 })
    .toBeGreaterThan(before);
});
