import { test, expect } from '@playwright/test';

// A608 (owner, 2026-10-29: "they don't key in a PIN on the web POS; PIN on the web strictly remains for cashiers"): a
// manager's PIN on the web POS is refused — they are sent to the web dashboard's email-and-password sign-in. On the
// desktop POS their PIN still works.
test('manager PIN on the web POS points to the web dashboard sign-in', async ({ page }) => {
  const email = process.env.MANAGER_EMAIL;
  const pin = process.env.MANAGER_PIN;
  test.skip(!email || !pin, 'Run `npm run seed:users` first (MANAGER_* missing from .env)');

  await page.goto('/pos');
  await page.locator('input[type="email"]').fill(email!);
  for (const digit of pin!.trim()) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: /Confirm PIN/ }).click();
  await expect(page.getByTestId('pos-use-dashboard')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Go to the dashboard sign-in' })).toHaveAttribute('href', '/login');
});
