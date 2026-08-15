// Pure stock-alert classification — NO database, NO side effects. Kept separate
// from lowStockChecker.ts (which imports supabase and mailer) so the decision
// logic can be exercised in isolation by tests/negative-stock-alerts.test.mjs
// without standing up env or a DB. Both the checker and the resolve-on-receive
// path share these, so "when does an alert fire" and "when does it clear" can
// never drift apart. (Register A74.)

export type StockAlertType = 'negative_stock' | 'low_stock';

// Number() on every operand: quantity and low_stock_threshold are `numeric`,
// which PostgREST hands back as STRINGS, and "9" < "10" is FALSE under string
// comparison (audit C7). Coerce or the alert fires on some digit pairs and not
// others, which reads like a flaky feature rather than a bug.

/**
 * What alert, if any, a product's on-hand warrants at one branch.
 *
 *   quantity < 0             → 'negative_stock' — sold past recorded stock. The
 *                              usual cause is a transfer that physically arrived
 *                              but was never received in the system; booking the
 *                              receipt (GRN / transfer receive) clears it.
 *   0 <= quantity < threshold → 'low_stock'
 *   otherwise                → null (no alert)
 *
 * A missing or non-positive threshold means "no low-stock line configured", so
 * only genuine negatives fire — matching the pre-existing filter behaviour.
 */
export function classifyStockLevel(quantity: unknown, threshold: unknown): StockAlertType | null {
  const q = Number(quantity);
  if (!Number.isFinite(q)) return null;
  if (q < 0) return 'negative_stock';
  const t = Number(threshold);
  if (Number.isFinite(t) && t > 0 && q < t) return 'low_stock';
  return null;
}

/**
 * Whether an existing UNREAD alert of `type` should be resolved now that the
 * product's on-hand is `quantity`. Used by the receive path so a booked-in
 * transfer auto-clears the warning instead of leaving it to be dismissed by
 * hand.
 *
 *   negative_stock → clears once quantity is back to >= 0
 *   low_stock      → clears once quantity is at/above threshold (>= 0 when none set)
 */
export function shouldResolveStockAlert(
  type: StockAlertType,
  quantity: unknown,
  threshold: unknown,
): boolean {
  const q = Number(quantity);
  if (!Number.isFinite(q)) return false;
  if (type === 'negative_stock') return q >= 0;
  if (type === 'low_stock') {
    const t = Number(threshold);
    if (!Number.isFinite(t) || t <= 0) return q >= 0;
    return q >= t;
  }
  return false;
}

// The per-product, per-branch marker embedded in a notification's message so
// dedupe and resolution can find exactly the rows for one product at one branch
// via ILIKE — the same shape the ingredient path already uses ([id|branch]).
// branch is part of the key so the same product low at two branches gets two
// alerts, not one that hides the other.
export function stockAlertMarker(productId: string, branchId: string): string {
  return `[${productId}|${branchId}]`;
}
