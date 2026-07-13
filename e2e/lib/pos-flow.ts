import { Page, expect } from '@playwright/test';

/**
 * Shared POS flow steps, reused across specs.
 */

/** Open a shift with a starting float if the "Open Shift" modal is blocking the screen. */
export async function openShiftIfNeeded(page: Page): Promise<void> {
  const openShiftBtn = page.getByRole('button', { name: 'Open Shift' });
  try {
    await openShiftBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('input[type="number"]').first().fill('5000');
    await openShiftBtn.click();
    await openShiftBtn.waitFor({ state: 'hidden', timeout: 10_000 });
  } catch {
    // No shift modal (already open) — continue.
  }
}

/**
 * If the cashier surface shows a tables view (restaurant/café), switch to the Grid
 * layout and open an order on a free table. Returns the opened table's name, or
 * null if this isn't a table-based flow (product grid shown directly).
 */
export async function startDineInOrderIfTables(page: Page): Promise<string | null> {
  await page
    .locator('[data-testid="table-tile"], [data-testid="product-card"]')
    .first()
    .waitFor({ timeout: 15_000 });

  const gridToggle = page.getByRole('button', { name: 'Grid' });
  if (await gridToggle.count()) await gridToggle.first().click();

  const freeTable = page.locator('[data-testid="table-tile"][data-status="free"]').first();
  if (!(await freeTable.count())) return null;

  const tableName = await freeTable.getAttribute('data-name');
  await freeTable.click();
  await page.getByRole('button', { name: 'Open Table' }).click();
  return tableName;
}

/** Add the first product that has variants to the cart (choose one option per group). */
export async function addFirstVariantProductToCart(page: Page): Promise<void> {
  const variantTile = page.locator('[data-testid="product-card"][data-has-variants="true"]').first();
  await expect(variantTile, 'a product with variants should be on the menu').toBeVisible({ timeout: 15_000 });
  await variantTile.click();

  const addToOrder = page.getByRole('button', { name: 'Add to Order' });
  await expect(addToOrder).toBeVisible();

  const options = page.locator('[data-testid="variant-option"]');
  const optionCount = await options.count();
  const chosenGroups = new Set<string>();
  for (let i = 0; i < optionCount; i++) {
    const opt = options.nth(i);
    const group = (await opt.getAttribute('data-group')) ?? String(i);
    if (!chosenGroups.has(group)) {
      await opt.click();
      chosenGroups.add(group);
    }
  }

  await expect(addToOrder, 'Add to Order should enable once required options are chosen').toBeEnabled();
  await addToOrder.click();
}

/**
 * Sell the first variant product, paying cash (blank tender = pay exact).
 * Asserts the "Payment successful" confirmation.
 */
export async function sellFirstVariantProductCash(page: Page): Promise<void> {
  await addFirstVariantProductToCart(page);

  await page.locator('[data-testid="charge-button"]').click();
  const confirm = page.locator('[data-testid="payment-confirm"]');
  await expect(confirm).toBeVisible();
  await expect(confirm, 'confirm should be enabled with exact (blank) tender').toBeEnabled();
  await confirm.click();

  await expect(page.getByText('Payment successful')).toBeVisible({ timeout: 15_000 });
}
