/**
 * shift-zreport.test.mjs — A433: a manager on any till sees every till's shifts and confirms them (owner, 2026-10-10:
 * "yes if they have logged in as the manager, and under sales report it should cover all tills").
 *
 *   node tests/shift-zreport.test.mjs
 *
 * RUNS the real apps/server/src/lib/shiftZReport.ts (another till's shift as a Z-report in the till's own shape), then pins
 * the routes: /:id/zreport (a manager only), /state (carries the confirmation back to the till that holds the shift),
 * /branch-report (Item Mix for every till; the methods to recount).
 *
 * MUTATIONS TO CONFIRM BITE: a refund row left out of the drawer → "cash in the drawer nets the refund" fails; a cash
 * expense not taken off → "expected cash" fails; a confirmed shift reported as awaiting → its check fails; /state without
 * confirmed_at → "the confirmation travels back" fails; the zreport manager check removed → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const Z = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/shiftZReport.ts')).href);

const order = (net, pays, refunded = 0, tip = 0) => ({
  gross: net + refunded, refunded, net, vat: net * 0.16 / 1.16, ctl: 0, tip,
  payments: pays.map(([method, amount, status = 'completed']) => ({ method, amount, status })),
});
const shift = (over = {}) => ({
  id: 'sh-1', status: 'closed', opened_at: '2026-10-10T05:00:00Z', closed_at: '2026-10-10T13:00:00Z', cashier_id: 'u1',
  opening_float: 1000, closing_float: 2350, expected_cash: 2400, cash_variance: -50, notes: null,
  confirmed_at: null, confirm_self: false, ...over,
});
const orders = [
  order(1000, [['cash', 1000]]),
  order(500, [['mpesa', 500]]),
  order(300, [['cash', 1500], ['cash', -1200, 'refunded']], 1200),   // a 1,500 cash sale, 1,200 handed back
  order(200, [['card', 99, 'pending'], ['card', 200]]),
];
const base = {
  cashierName: 'Jane', orders, voidCount: 2,
  floatTxns: [{ type: 'float_in', amount: 100 }, { type: 'float_out', amount: 200 }],
  expenses: [
    { description: 'Ice', amount: 50, created_at: '2026-10-10T09:00:00Z', payment_method: 'cash', paid_by_name: 'Jane' },
    { description: 'Gas', amount: 300, created_at: '2026-10-10T10:00:00Z', payment_method: 'mpesa', paid_by_name: 'Jane' },
  ],
  expectedNow: null, ctlLevied: false,
};

const closed = Z.buildShiftZReport({ ...base, shift: shift(), confirmation: {
  declared: { mpesa: 500, card: 200 }, methods: ['cash', 'mpesa', 'card'], confirmedByName: null,
  lines: [{ method: 'cash', declared: null, expected: null, confirmed: null, variance: null, mismatch: false }],
} });

console.log("\nAnother till's shift, as a Z-report\n");
ok('sales: gross 3,200, refunds 1,200, net 2,000; 4 orders, 2 voids', () => {
  assert.equal(closed.totals.grossSales, 3200); assert.equal(closed.totals.refunds, 1200); assert.equal(closed.totals.netSales, 2000);
  assert.equal(closed.totals.orderCount, 4); assert.equal(closed.totals.voidCount, 2);
});
ok('cash in the drawer nets the refund (1,000 + 1,500 − 1,200 = 1,300); a pending card payment is not counted', () => {
  assert.equal(closed.totals.cashSales, 1300);
  assert.deepEqual(closed.byMethod.find((m) => m.method === 'card'), { method: 'card', amount: 200, orders: 1 });
});
ok('expected cash: a closed shift keeps what the close stored (2,400)', () => assert.equal(closed.totals.expectedCash, 2400));
ok('expected cash: an open one is worked out — 1,000 + 1,300 + 100 − 200 − 50 (cash expense) = 2,150', () => {
  const open = Z.buildShiftZReport({ ...base, shift: shift({ status: 'open', closed_at: null, expected_cash: null }), confirmation: null });
  assert.equal(open.totals.expectedCash, 2150);
});
ok('an expense paid by M-Pesa is not out of the drawer — it is listed against M-Pesa', () => {
  assert.equal(closed.totals.expenses, 50); assert.deepEqual(closed.totals.expensesByMethod, { mpesa: 300 });
  assert.equal(closed.expenseLines.length, 2);
});
ok('awaiting a manager: the methods to recount', () => {
  assert.equal(closed.confirmation.status, 'awaiting'); assert.deepEqual(closed.confirmation.methods, ['cash', 'mpesa', 'card']);
});
ok('confirmed: by whom and when', () => {
  const c = Z.buildShiftZReport({ ...base, shift: shift({ confirmed_at: '2026-10-10T14:00:00Z', confirm_self: true }),
    confirmation: { declared: { mpesa: 500 }, methods: ['cash', 'mpesa'], confirmedByName: 'Grace', lines: [] } });
  assert.equal(c.confirmation.status, 'confirmed'); assert.equal(c.confirmation.confirmed_by_name, 'Grace'); assert.equal(c.confirmation.self, true);
});
ok('a shift closed before A365 (no declaration) has no confirmation block', () => {
  assert.equal(Z.buildShiftZReport({ ...base, shift: shift(), confirmation: null }).confirmation, null);
});
ok("the till's own shape: shift, byMethod, totals", () => {
  for (const k of ['id', 'opened_at', 'closed_at', 'status', 'cashier_name', 'opening_float', 'expected_cash']) assert.ok(k in closed.shift, k);
  for (const k of ['orderCount', 'grossSales', 'cashSales', 'floatIn', 'floatOut', 'expectedCash', 'voidCount']) assert.ok(k in closed.totals, k);
});

console.log('\nThe routes\n');
const route = read('apps/server/src/routes/shifts.ts');
ok('GET /:id/zreport: a manager only, the caller\'s branch', () => {
  assert.match(route, /router\.get\('\/:id\/zreport', async \(req, res\) => \{\s*if \(!callerMayConfirm\(req\)\) \{ res\.status\(403\)/);
  assert.match(route, /if \(!shift \|\| \(branchId && shift\.branch_id !== branchId\)\) \{ res\.status\(404\)/);
});
ok('the confirmation travels back: /state answers confirmed_at, who and the counts', () => {
  const st = route.slice(route.indexOf("router.get('/state'"), route.indexOf("router.post('/open'"));
  for (const c of ['confirmed_at', 'confirmed_by', 'confirmed_methods', 'expected_methods', 'confirm_reasons', 'confirm_self']) assert.ok(st.includes(c), c);
  assert.match(st, /confirmed_by_name:/);
});
ok('a manager on a till confirms as themselves — the replay path (confirmed_by) is only the holding till\'s', () => {
  assert.match(route, /if \(req\.surface === 'desktop' && typeof req\.body\?\.confirmed_by === 'string'\) \{[\s\S]*?if \(!sameTill\)/);
  assert.match(route, /\} else if \(callerMayConfirm\(req\)\) \{\s*confirmer = \{ id: req\.userId!, name: null \};/);
});
ok('a manager on another till: its own path, a person\'s sign-in only, never the replay field', () => {
  assert.ok(route.includes("router.post('/:id/manager-confirm', async (req, res) => {\n  if (req.body && typeof req.body === 'object') delete req.body.confirmed_by;\n  await confirmShiftRoute(req, res);"));
  const tw = read('apps/server/src/lib/terminalWrites.ts');
  assert.ok(tw.indexOf('manager-confirm') > tw.indexOf('export const MANAGER_WRITES'), 'manager-confirm is a MANAGER write (never the device token)');
});
ok('branch-report: Item Mix for every till, paged; each shift\'s methods to recount', () => {
  assert.match(route, /from\('order_items'\)\.select\('id, product_name, quantity, subtotal'\)\s*\.in\('order_id', chunk\)\.order\('id', \{ ascending: true \}\)\.range\(at, at \+ REPORT_PAGE - 1\)/);
  assert.match(route, /shifts: report\.shifts\.map\(\(x\) => \(\{ \.\.\.x, declare_codes: declaredCodes\.get\(x\.id\) \?\? \[\] \}\)\),\s*topProducts,/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
