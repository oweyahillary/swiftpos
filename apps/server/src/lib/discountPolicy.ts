// Discount ceiling — single source of truth.
//
// Lives here rather than inside orders.ts because two places need it and they
// must never drift: orders.ts enforces it on write, and pos/init advertises it
// to the till so the till clamps to the same number BEFORE printing a receipt.
//
// Before this was advertised, the till clamped only to 0-100% while the server
// capped at 10% and stored the capped figure. A cashier who entered 25% took
// 25% off at the drawer, printed a receipt saying so, and the order landed in
// the database discounted by 10 — payment legs no longer summed to the order
// total (finding H1) and expected cash came back high, reporting a shortage
// that never happened.
//
// This is NOT the M4 fix. It is a blunt ceiling that bounds the exposure while
// the real control (permission + reason code + approval trail) is built.
// Override per-deployment with MAX_DISCOUNT_PCT, but raise it deliberately —
// and note that a till only learns the new value on its next catalogue pull.

export const MAX_DISCOUNT_PCT = Number(process.env.MAX_DISCOUNT_PCT ?? 10);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function capDiscount(requested: unknown, subtotal: number): number {
  const asked = Math.max(0, Number(requested) || 0);
  return round2(Math.min(asked, subtotal * (MAX_DISCOUNT_PCT / 100), subtotal));
}
