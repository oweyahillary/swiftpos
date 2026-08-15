/**
 * negative-stock-alerts.test.mjs — proves the stock-alert classification and
 * the resolve-on-receive rule, with NO database.
 *
 *   node tests/negative-stock-alerts.test.mjs
 *
 * What it pins (register A74 / A75):
 *
 *   1. classifyStockLevel splits NEGATIVE (sold beyond recorded stock — the
 *      transferred-but-not-received case) from merely LOW, and handles the
 *      PostgREST numeric-as-string trap. A negative quantity must never be
 *      mislabelled "low" and must fire regardless of the threshold.
 *
 *   2. shouldResolveStockAlert only clears an alert once the on-hand actually
 *      recovers — a negative_stock alert clears at >= 0, a low_stock alert only
 *      at/above its threshold — so a partial receipt that lifts stock above 0
 *      but still below the low line clears the negative and leaves the low.
 *
 * The functions live in apps/server/src/lib/stockAlerts.ts (no supabase import),
 * so importing the compiled dist here has no side effects. If the server has not
 * been built (dist missing), the suite SKIPS rather than fails — run-all and CI
 * build the server first, which is where this is graded.
 */

import assert from 'node:assert';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}`); }
};

const distPath = path.resolve('apps/server/dist/lib/stockAlerts.js');
if (!existsSync(distPath)) {
  console.log('SKIP  apps/server/dist/lib/stockAlerts.js not built — run the server build first.');
  process.exit(0);
}

const { classifyStockLevel, shouldResolveStockAlert, stockAlertMarker } =
  await import(pathToFileURL(distPath).href);

// ── 1. classifyStockLevel ────────────────────────────────────────────────────

ok('negative quantity → negative_stock (below any threshold)',
   classifyStockLevel(-3, 10) === 'negative_stock');

ok('negative quantity fires even with NO threshold set (0)',
   classifyStockLevel(-1, 0) === 'negative_stock');

ok('negative quantity fires with a null threshold',
   classifyStockLevel(-1, null) === 'negative_stock');

ok('0 <= qty < threshold → low_stock',
   classifyStockLevel(3, 5) === 'low_stock');

ok('qty at threshold is NOT low (>= clears)',
   classifyStockLevel(5, 5) === null);

ok('qty above threshold → no alert',
   classifyStockLevel(9, 5) === null);

ok('threshold of 0 means no low line — a positive qty is fine',
   classifyStockLevel(3, 0) === null);

// The C7 trap: PostgREST returns numeric columns as strings.
ok('string "9" and "10" compared as NUMBERS, not lexically → low_stock',
   classifyStockLevel('9', '10') === 'low_stock');

ok('string negative quantity still classifies as negative_stock',
   classifyStockLevel('-2.00', '5') === 'negative_stock');

ok('non-numeric quantity → no alert (defensive)',
   classifyStockLevel('abc', 5) === null);

// ── 2. shouldResolveStockAlert ───────────────────────────────────────────────

ok('negative_stock clears once qty is back to 0',
   shouldResolveStockAlert('negative_stock', 0, 5) === true);

ok('negative_stock clears once qty is positive',
   shouldResolveStockAlert('negative_stock', 4, 5) === true);

ok('negative_stock does NOT clear while still negative',
   shouldResolveStockAlert('negative_stock', -1, 5) === false);

ok('low_stock clears only at/above threshold',
   shouldResolveStockAlert('low_stock', 5, 5) === true);

ok('low_stock does NOT clear below threshold',
   shouldResolveStockAlert('low_stock', 4, 5) === false);

// The partial-receipt case both features exist for:
ok('partial receipt (qty 2, threshold 5): negative clears, low stays',
   shouldResolveStockAlert('negative_stock', 2, 5) === true &&
   shouldResolveStockAlert('low_stock',      2, 5) === false);

ok('low_stock with no threshold clears at any non-negative',
   shouldResolveStockAlert('low_stock', 0, 0) === true);

ok('resolve reads numeric strings correctly',
   shouldResolveStockAlert('negative_stock', '0.00', '5') === true &&
   shouldResolveStockAlert('low_stock', '4', '5') === false);

// ── 3. stockAlertMarker (branch-scoped dedupe key) ───────────────────────────

ok('marker embeds product and branch so two branches never collide',
   stockAlertMarker('prod-1', 'branch-A') === '[prod-1|branch-A]' &&
   stockAlertMarker('prod-1', 'branch-A') !== stockAlertMarker('prod-1', 'branch-B'));

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
