/**
 * sync-stock-merge.test.mjs — proves the offline stock picture is correct after
 * a pull (A80) and that offline oversell can go negative like the server (A81).
 *
 *   node tests/sync-stock-merge.test.mjs
 *
 * No server, no database. Models the two decisions pullCatalogue + createLocalOrder
 * now make (mirror, in the style of offline-dating-and-repricing.test.mjs):
 *
 *   A80  After the stock upsert sets every level to the SERVER baseline (which
 *        reflects only SYNCED orders), the pull re-applies the quantity deducted
 *        by orders still 'pending' — for tracked products only, grouped by
 *        product+branch — so the till shows true on-hand while offline sales
 *        await push, instead of the stale-high baseline.
 *          local = serverBaseline − Σ(pending tracked deductions)
 *
 *   A81  Neither the local sale deduction nor the merge floors at 0: quantity may
 *        go negative, which is the "sold beyond stock" state the server keeps.
 */

import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

// ── Mirror of createLocalOrder's local deduction (A81: no floor) ──────────────
function localDeduct(currentQty, soldQty) {
  return currentQty - soldQty;          // was Math.max(0, …) before A81
}

// ── Mirror of pullCatalogue's stock upsert + A80 delta re-apply ───────────────
// serverBaseline: { [productId]: qty }         (what the pull writes first)
// pendingOrders:  [{ items: [{ productId, qty }] }]  (orders still sync_status='pending')
// trackStock:     { [productId]: boolean }
function mergedLocalStock(serverBaseline, pendingOrders, trackStock) {
  const deducted = {};
  for (const o of pendingOrders) {
    for (const it of o.items) {
      if (!trackStock[it.productId]) continue;      // untracked products never deduct
      deducted[it.productId] = (deducted[it.productId] ?? 0) + it.qty;
    }
  }
  const merged = { ...serverBaseline };
  for (const pid of Object.keys(deducted)) {
    merged[pid] = (serverBaseline[pid] ?? 0) - deducted[pid];   // no floor (A81)
  }
  return merged;
}

// ── A81: local deduction ──────────────────────────────────────────────────────
ok('offline sale deducts locally', localDeduct(10, 3) === 7);
ok('offline oversell goes NEGATIVE, not clamped to 0', localDeduct(1, 3) === -2);
ok('exact-to-zero is zero', localDeduct(3, 3) === 0);

// ── A80: pull re-applies pending deltas, does not clobber ─────────────────────
const track = { A: true, B: true, U: false };

{
  // Server baseline still 10 (our sale hasn't pushed yet); one pending sale of 3.
  const merged = mergedLocalStock({ A: 10 }, [{ items: [{ productId: 'A', qty: 3 }] }], track);
  ok('pending deduction survives the pull (10 − 3 = 7, not reset to 10)', merged.A === 7, `${merged.A}`);
}

{
  // The old bug: without re-apply the till would show the baseline 10.
  const baseline = { A: 10 };
  ok('OLD behaviour (plain overwrite) would have shown stale 10', baseline.A === 10);
}

{
  // Multiple pending orders for the same product sum.
  const merged = mergedLocalStock(
    { A: 20 },
    [{ items: [{ productId: 'A', qty: 3 }] }, { items: [{ productId: 'A', qty: 4 }] }],
    track,
  );
  ok('multiple pending orders sum (20 − 7 = 13)', merged.A === 13, `${merged.A}`);
}

{
  // Pending sale drives it below zero — must stay negative (A74/A81).
  const merged = mergedLocalStock({ A: 2 }, [{ items: [{ productId: 'A', qty: 5 }] }], track);
  ok('pending deduction below zero stays negative (2 − 5 = −3)', merged.A === -3, `${merged.A}`);
}

{
  // Untracked product: pending line must NOT deduct.
  const merged = mergedLocalStock({ U: 9 }, [{ items: [{ productId: 'U', qty: 4 }] }], track);
  ok('untracked product is untouched by the merge', merged.U === 9, `${merged.U}`);
}

{
  // A product with no pending orders keeps the server baseline exactly.
  const merged = mergedLocalStock({ A: 10, B: 5 }, [{ items: [{ productId: 'A', qty: 2 }] }], track);
  ok('product with no pending orders keeps server baseline', merged.B === 5, `${merged.B}`);
  ok('the other product still merges', merged.A === 8, `${merged.A}`);
}

{
  // Synced orders are NOT in the pending set, so they must not double-deduct.
  // (Modelled by simply not passing them — the SQL filters sync_status='pending'.)
  const merged = mergedLocalStock({ A: 7 }, [], track);
  ok('synced orders do not double-deduct (baseline already reflects them)', merged.A === 7, `${merged.A}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
