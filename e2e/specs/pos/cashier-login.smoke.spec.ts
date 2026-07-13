import { test } from '@playwright/test';
import { loginViaPin } from '../../lib/pos-login';

test('cashier PIN login reaches the cashier screen', async ({ page }) => {
  const email = process.env.CASHIER_EMAIL;
  const pin = process.env.CASHIER_PIN;
  test.skip(!email || !pin, 'Run `npm run seed:users` first (CASHIER_* missing from .env)');

  await loginViaPin(page, email!, pin!, /\/pos\/cashier/);
});
