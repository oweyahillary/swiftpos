import { Page, expect } from '@playwright/test';

/**
 * Log in on the POS/manager PIN screen (apps/dashboard/src/pages/pos/POSLoginScreen.tsx).
 *
 * Flow: go to /pos → fill email → tap PIN digits on the on-screen keypad. The app
 * auto-submits at 4 digits; after login it resolves the staff member's route
 * (manager/supervisor → /manager, everyone else → /pos/cashier).
 *
 * Single-branch environments (like Test Café Corner) auto-resolve the branch and
 * navigate straight through. If you run this against a MULTI-branch business, a
 * branch picker appears after the PIN and you'll need to add a click for it here —
 * shout and I'll wire it once we see the picker markup.
 *
 * @param expectUrl  regex the destination URL should match (proves the right role landed).
 */
export async function loginViaPin(
  page: Page,
  email: string,
  pin: string,
  expectUrl: RegExp,
): Promise<void> {
  await page.goto('/pos');

  // Email first — the keypad stays disabled until an email is entered.
  await page.locator('input[type="email"]').fill(email);

  // Tap each digit on the keypad (buttons are labelled with the digit).
  for (const digit of pin.trim()) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }

  // 4-digit PINs auto-submit; wait for the resolved destination.
  await page.waitForURL(expectUrl, { timeout: 15_000 });
  await expect(page).toHaveURL(expectUrl);
}
