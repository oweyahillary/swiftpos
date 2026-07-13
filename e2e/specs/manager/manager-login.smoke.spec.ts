import { test } from '@playwright/test';
import { loginViaPin } from '../../lib/pos-login';

// Manager (and supervisor) roles resolve to the manager dashboard.
test('manager PIN login reaches the manager dashboard', async ({ page }) => {
  const email = process.env.MANAGER_EMAIL;
  const pin = process.env.MANAGER_PIN;
  test.skip(!email || !pin, 'Run `npm run seed:users` first (MANAGER_* missing from .env)');

  await loginViaPin(page, email!, pin!, /\/manager/);
});
