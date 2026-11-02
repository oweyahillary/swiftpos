import { test } from '@playwright/test';
import { loginViaPin } from '../../lib/pos-login';

// The custom "Waiter" role has orders.create but no manager rights, so it should
// resolve to the cashier screen (not be refused as back office — A608: the web POS sends
// back-office staff to the dashboard sign-in; the old /manager portal is retired).
test('custom-role (Waiter) PIN login reaches the cashier screen', async ({ page }) => {
  const email = process.env.WAITER_EMAIL;
  const pin = process.env.WAITER_PIN;
  test.skip(!email || !pin, 'Run `npm run seed:users` first (WAITER_* missing from .env)');

  await loginViaPin(page, email!, pin!, /\/pos\/cashier/);
});
