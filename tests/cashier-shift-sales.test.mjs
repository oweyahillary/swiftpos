/**
 * cashier-shift-sales.test.mjs — A627: "see own shift sales at close" is a per-person RIGHT (shifts.see_shift_sales); the
 * old business/branch 'cashier_sees_shift_sales' switch (A416) and all its plumbing are gone.
 *
 *   node tests/cashier-shift-sales.test.mjs
 *
 * Pins: the cloud blind close and the till's blind report read the right; the count stays blind (no expected cash, no
 * method figure); both close screens show the sales; and the retired switch plumbing is removed everywhere.
 *
 * MUTATIONS TO CONFIRM BITE: blindReport reading a device flag instead of the right → "only when the right is held" fails;
 * blindReport putting expected cash back → "the count stays blind" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

console.log('\nThe cloud\n');
const shifts = read('apps/server/src/routes/shifts.ts');
ok("a cashier's blind shift carries their sales only when they hold the shifts.see_shift_sales right", () => {
  assert.match(shifts, /const seesSales = can\(req, 'shifts\.see_shift_sales'\);/);
  // A442 adds each person's part (sales only) inside the same switch.
  assert.match(shifts, /\.\.\.\(seesSales \? \{ cashier_sales: \{ total: Math\.round\(kept \* 100\) \/ 100, orders: \(orders \?\? \[\]\)\.length,\s*\/\/[^\n]*\n\s*by_cashier: byCashier\.map\(\(c\) => \(\{ name: c\.name, orders: c\.orders, sales: c\.sales \}\)\) \} \} : \{\}\)/);
});

console.log('\nThe till\n');
const svc = read('apps/desktop/src/main/shiftService.ts');
const blind = svc.slice(svc.indexOf('export function blindReport'), svc.indexOf('/** A manager for shift purposes'));
ok('the blind report adds the sales kept and the orders only when the shifts.see_shift_sales right is held', () => {
  assert.match(blind, /seesSales: boolean = signedInCan\('shifts\.see_shift_sales'\)\)/);
  // A442 adds each person's part (sales only) inside the same switch, and strips the per-person figures when it is off.
  assert.match(blind, /\.\.\.\(seesSales \? \{ cashierSales: \{ total: money2\(z\.totals\.netSales \?\? z\.totals\.grossSales\), orders: z\.totals\.orderCount,\s*byCashier: \(z\.byCashier \?\? \[\]\)\.map\(\(c\) => \(\{ name: c\.name, orders: c\.orders, sales: c\.sales \}\)\) \} \} : \{\}\)/);
  assert.match(blind, /byCashier: seesSales \? \(z\.byCashier \?\? \[\]\)\.map\(\(c\) => \(\{ \.\.\.c, byMethod: \[\] \}\)\) : \[\],/);
});
ok('the count stays blind: expected cash 0, no variance, no method figures', () => {
  assert.match(blind, /shift: \{ \.\.\.z\.shift, expected_cash: 0, cash_variance: null \}/);
  assert.match(blind, /byMethod: z\.byMethod\.map\(\(m\) => \(\{ \.\.\.m, amount: 0, orders: 0 \}\)\)/);
  assert.match(blind, /cashSales: 0, expectedCash: 0/);
});
ok('both close screens show it — the till and the web POS', () => {
  assert.match(read('apps/desktop/src/renderer/pages/ShiftPanel.tsx'), /\{report\.cashierSales && \(\s*<p className="mt-2 text-white" data-testid="cashier-sales">/);
  assert.match(read('apps/dashboard/src/pages/pos/ShiftModal.tsx'), /\{blind && cashierSales && \(\s*<p style=\{s\.subtitle\} data-testid="cashier-sales">/);
});

console.log('\nThe retired switch is gone\n');
ok('the cashier_sees_shift_sales / cashier_history_totals switch plumbing is removed', () => {
  const prof = read('apps/dashboard/src/pages/settings/BusinessProfileTab.tsx');
  assert.ok(!/saveSetting\('cashier_sees_shift_sales'/.test(prof), 'the A416 toggle is removed');
  assert.ok(!/saveSetting\('cashier_history_totals'/.test(prof), 'the A418 toggle is removed');
  assert.match(prof, /data-testid="cashier-sales-rights-note"/);
  // the cloud no longer sends it; the till no longer caches, reads or keeps a column for it
  assert.ok(!/cashierSeesShiftSales/.test(read('apps/server/src/routes/pos.ts')), 'pos.ts no longer sends the flag');
  assert.ok(!/export function getCashierSeesShiftSales/.test(read('apps/desktop/src/main/deviceConfig.ts')), 'the getter is gone');
  assert.ok(!/\['cashier_sees_shift_sales', 'INTEGER'\]/.test(read('apps/desktop/src/main/localDb.ts')), 'the device_config column is off the create-list');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
