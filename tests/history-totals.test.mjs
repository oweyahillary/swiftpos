/**
 * history-totals.test.mjs — A418 (owner, 2026-10-09: "add a feature which an owner can toggle to allow cashiers to filter
 * their sales and it gives them a subtotal using the current filter for payment methods or any other filter … even when
 * they sort history"; and "one should be on for the other to be active" — only while A416 is on).
 *
 *   node tests/history-totals.test.mjs
 *
 * RUNS the till's rule (packages/core/src/historyView.ts historyTotal, with historyView) and checks the cloud's copy
 * (server/src/lib/cashierShiftSales.ts historyTotal) gives the same answers; then pins who sees it.
 *
 * MUTATIONS TO CONFIRM BITE: a voided sale counted in sales → "voided: an order, not a sale" fails; a refund not taken off
 * → "refunds come off" fails; the cloud sending totals without the switches → its pin fails; the till's getter not
 * requiring A416 → "only while A416 is on" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.HIST_TOTALS_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, HIST_TOTALS_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const H = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/historyView.ts')).href);
// The cloud's copy, run as written (its file imports the supabase client, so the function is lifted out).
const srv = read('apps/server/src/lib/cashierShiftSales.ts');
const fnSrc = srv.slice(srv.indexOf('export function historyTotal('), srv.indexOf('\n}\n', srv.indexOf('export function historyTotal(')) + 2)
  .replace('export function', 'function').replace(/: Array<\{[\s\S]*?\}>\): \{ orders: number; sales: number \}/, ')');
const cloudTotal = new Function(`${fnSrc}; return historyTotal;`)();

const at = (h) => `2026-10-10T${String(h).padStart(2, '0')}:00:00Z`;
const orders = [
  { created_at: at(9),  status: 'completed', total: 1000, order_type: 'retail',   payments: [{ method: 'cash', amount: 1000 }] },
  { created_at: at(10), status: 'completed', total: 500,  order_type: 'delivery', payments: [{ method: 'mpesa', amount: 500 }] },
  { created_at: at(11), status: 'voided',    total: 700,  order_type: 'retail',   payments: [{ method: 'cash', amount: 700 }] },
  { created_at: at(12), status: 'completed', total: 1500, refunded_amount: 1200, order_type: 'retail', payments: [{ method: 'cash', amount: 1500 }] },
  { created_at: at(13), status: 'completed', total: 900,  order_type: 'retail', history_partial: true, history_shown_total: 400,
    payments: [{ method: 'mpesa', amount: 400 }, { method: 'card', amount: 500 }] },
];

console.log('\nThe total of what the filters show\n');
ok('every order shown; sales of the completed ones, refunds out, a split sale\'s allowed part (1,000 + 500 + 300 + 400)', () => {
  assert.deepEqual(H.historyTotal(orders), { orders: 5, sales: 2200 });
});
ok('voided: an order, not a sale', () => assert.deepEqual(H.historyTotal([orders[2]]), { orders: 1, sales: 0 }));
ok('refunds come off (a 1,500 sale with 1,200 back is 300)', () => assert.deepEqual(H.historyTotal([orders[3]]), { orders: 1, sales: 300 }));
ok('follows the filter: cash only → 1,000 + 300 (the voided cash sale counts as an order)', () => {
  assert.deepEqual(H.historyTotal(H.historyView(orders, { method: 'cash' })), { orders: 3, sales: 1300 });
});
ok('sorting never changes it', () => {
  for (const sort of ['time', 'method', 'type']) assert.deepEqual(H.historyTotal(H.historyView(orders, { sort })), { orders: 5, sales: 2200 });
});
ok('the cloud\'s copy agrees on every case', () => {
  for (const list of [orders, [orders[2]], [orders[3]], H.historyView(orders, { method: 'cash' }), []]) {
    assert.deepEqual(cloudTotal(list), H.historyTotal(list));
  }
});

console.log('\nWho sees it\n');
ok('the cloud: asked for, and a manager — or a cashier while BOTH switches are on', () => {
  const o = read('apps/server/src/routes/orders.ts');
  assert.match(o, /if \(req\.query\.with_totals === '1'\s*&& \(manager \|\| await cashierHistoryTotals\(/);
  assert.match(srv, /return \(await cashierSeesShiftSales\(businessId, branchId\)\) && \(await branchSwitch\(businessId, branchId, CASHIER_HISTORY_TOTALS_KEY\)\);/);
});
ok('the cloud totals every page the filters show (the same filters, paged), not the page on screen', () => {
  const o = read('apps/server/src/routes/orders.ts');
  assert.match(o, /const \{ data: page, error: tErr \} = await filtered\(supabase\.from\('orders'\)/);
  assert.match(o, /\.order\('id', \{ ascending: true \}\)\.range\(at, at \+ 499\)/);
});
ok('only while A416 is on: the till told already combined, and checks again', () => {
  assert.match(read('apps/server/src/routes/pos.ts'), /cashierHistoryTotals: historyTotalsOn\(receiptText\.cashier_sees_shift_sales, receiptText\.cashier_history_totals\),/);
  assert.match(read('apps/desktop/src/main/deviceConfig.ts'), /return c\?\.cashier_history_totals === 1 && c\?\.cashier_sees_shift_sales === 1;/);
  assert.match(read('apps/desktop/src/main/shiftService.ts'), /showTotal: manager \|\| getCashierHistoryTotals\(\),/);
});
ok('both History screens show it; the owner\'s switch is greyed out until A416 is on', () => {
  assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /\{historyShowTotal && recentOrders\.length > 0 && \(\(\) => \{\s*const t = historyTotal\(historyView\(recentOrders,/);
  assert.match(read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx'), /params\.set\('with_totals', '1'\);/);
  assert.match(read('apps/dashboard/src/pages/settings/BusinessProfileTab.tsx'), /<button data-testid="cashier-history-totals-toggle" disabled=\{!seesSales\}/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
