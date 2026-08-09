/**
 * discount-clamp.test.mjs — proves the web POS clamps a discount to the server
 * ceiling and charges exactly what the server will store.
 *
 *   node discount-clamp.test.mjs
 *
 * No browser, no build. capDiscountPct and the PaymentModal charge computation
 * are copied here (kept in sync by hand) so the arithmetic is verified without a
 * React runtime. The property under test: the number this client charges must
 * equal subtotal - server_capped_discount, or the payment legs will not
 * reconcile to the recomputed total and the atomic-order guard rejects the sale.
 */

// ── copies of the client and server clamps ──────────────────────────────────
// client: cashier/types.ts
function capDiscountPct(requested, subtotal, maxPct) {
  const asked = Math.max(0, Number(requested) || 0);
  const ceiling = subtotal * (Math.max(0, maxPct) / 100);
  return Math.round(Math.min(asked, ceiling, subtotal) * 100) / 100;
}
// server: lib/discountPolicy.ts capDiscount (MAX_DISCOUNT_PCT default 10)
function serverCapDiscount(requested, subtotal, maxPct = 10) {
  const asked = Math.max(0, Number(requested) || 0);
  return Math.round(Math.min(asked, subtotal * (maxPct / 100), subtotal) * 100) / 100;
}

// ── what PaymentModal now computes for the payload ──────────────────────────
function clientCharge(subtotal, rawLoyalty, rawPromo, tip, maxPct) {
  const rawDiscount = rawLoyalty + rawPromo;
  const cappedDiscount = capDiscountPct(rawDiscount, subtotal, maxPct);
  const loyaltyDiscount = Math.min(rawLoyalty, cappedDiscount);
  const promoDiscount   = Math.max(0, cappedDiscount - loyaltyDiscount);
  const chargedTotal = Math.round((subtotal - cappedDiscount) * 100) / 100;
  const grandTotal = chargedTotal + tip;
  return { cappedDiscount, loyaltyDiscount, promoDiscount, chargedTotal, grandTotal,
           discountWasCapped: cappedDiscount < rawDiscount - 0.005 };
}

// ── what the server stores for that payload ─────────────────────────────────
function serverStores(subtotal, sentDiscount, maxPct = 10) {
  const capped = serverCapDiscount(sentDiscount, subtotal, maxPct);
  return { discount: capped, total: Math.round((subtotal - capped) * 100) / 100 };
}

let pass = 0, fail = 0;
const approx = (a, b) => Math.abs(a - b) < 0.005;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

// ── 1. The bug scenario: 25% asked, 10% ceiling ─────────────────────────────
{
  const c = clientCharge(1000, 250, 0, 0, 10);
  ok('over-ceiling discount capped to 100', approx(c.cappedDiscount, 100), `${c.cappedDiscount}`);
  ok('charged total is 900, not 750', approx(c.chargedTotal, 900), `${c.chargedTotal}`);
  ok('cap notice fires', c.discountWasCapped === true);

  // The critical reconciliation: what the client charges === what the server stores.
  const s = serverStores(1000, c.cappedDiscount);
  ok('client charge matches server-stored total', approx(c.chargedTotal, s.total),
     `client ${c.chargedTotal} vs server ${s.total}`);
  ok('legs would reconcile (no rejected sale)', approx(c.chargedTotal, s.total));

  // Contrast: the OLD client sent the uncapped total.
  const oldSent = 1000 - 250;               // 750, uncapped
  const oldServer = serverStores(1000, 250); // server caps to 100 -> stores 900
  ok('OLD client charged 750 but server stored 900 (the bug)',
     !approx(oldSent, oldServer.total), `${oldSent} vs ${oldServer.total}`);
}

// ── 2. A discount under the ceiling is untouched ────────────────────────────
{
  const c = clientCharge(1000, 50, 0, 0, 10);   // 5%
  ok('under-ceiling discount unchanged', approx(c.cappedDiscount, 50), `${c.cappedDiscount}`);
  ok('charged total is 950', approx(c.chargedTotal, 950));
  ok('no cap notice', c.discountWasCapped === false);
  const s = serverStores(1000, 50);
  ok('client and server agree', approx(c.chargedTotal, s.total));
}

// ── 3. Combined loyalty + promo, split preserved after capping ──────────────
{
  // loyalty 80, promo 200 = 280 asked; ceiling 100.
  const c = clientCharge(1000, 80, 200, 0, 10);
  ok('combined capped to 100', approx(c.cappedDiscount, 100));
  ok('loyalty honoured first (80)', approx(c.loyaltyDiscount, 80), `${c.loyaltyDiscount}`);
  ok('promo takes the remainder (20)', approx(c.promoDiscount, 20), `${c.promoDiscount}`);
  ok('split sums to the cap', approx(c.loyaltyDiscount + c.promoDiscount, c.cappedDiscount));
}

// ── 4. Tip rides on top of the (capped) total ───────────────────────────────
{
  const c = clientCharge(1000, 250, 0, 50, 10);  // cap 100 -> 900, +50 tip
  ok('grand total = capped total + tip = 950', approx(c.grandTotal, 950), `${c.grandTotal}`);
  // The order total sent to the server excludes tip; legs incl tip reconcile to
  // total+tip on the client, and the server validates legs against total.
  const s = serverStores(1000, c.cappedDiscount);
  ok('order total (excl tip) matches server', approx(c.chargedTotal, s.total));
}

// ── 5. A higher configured ceiling flows through ────────────────────────────
{
  // If the deployment raised MAX_DISCOUNT_PCT to 20, a 15% discount is allowed.
  const c = clientCharge(1000, 150, 0, 0, 20);
  ok('15% under a 20% ceiling is untouched', approx(c.cappedDiscount, 150));
  const s = serverStores(1000, 150, 20);
  ok('client and server agree at the higher ceiling', approx(c.chargedTotal, s.total));
}

console.log(`\n${fail === 0 ? 'All checks passed. The web POS charges what the server stores.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
