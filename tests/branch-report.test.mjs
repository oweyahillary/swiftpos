/**
 * branch-report.test.mjs — A431 / A432: GET /api/shifts/branch-report — every till's sales and every shift at the branch,
 * for a manager on any till (owner, 2026-10-09: "the manager should view sales across all tills no matter the till they
 * have logged into … add a shift report in the overview").
 *
 *   node tests/branch-report.test.mjs
 *
 * RUNS the real apps/server/src/lib/branchReport.ts on a two-till day, then pins the route (the cloud is not run here).
 *
 * MUTATIONS TO CONFIRM BITE: revenue summed from `gross` not `net` → "refunds come off" fails; a pending payment counted →
 * "only completed payments" fails; shiftState calling an unconfirmed declared close 'closed' → "awaiting a manager" fails;
 * localHour ignoring the offset → "the branch's own hour" fails; the route's manager check removed → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const B = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/branchReport.ts')).href);

const order = (id, device, shift, at, net, pays, refunded = 0) => ({
  id, created_at: at, device_id: device, shift_id: shift,
  gross: net + refunded, refunded, net, vat: net * 0.16 / 1.16, ctl: 0, discount: 0, tip: 0,
  payments: pays.map(([method, amount, status = 'completed']) => ({ method, amount, status })),
});
const shift = (id, device, over = {}) => ({
  id, device_id: device, terminal_code: null, cashier_id: 'u-' + id, status: 'closed',
  opened_at: '2026-10-09T05:00:00Z', closed_at: '2026-10-09T12:00:00Z', opening_float: 1000,
  closing_float: 3000, expected_cash: 3000, cash_variance: 0, close_method: 'counted',
  declared_methods: { mpesa: 500 }, confirmed_at: null, confirmed_by: null, ...over,
});
// Till A (T1) and till B (T2); a web POS sale (no device). 07:30 UTC is 10:30 in Nairobi.
const orders = [
  order('o1', 'dev-a', 's1', '2026-10-09T07:30:00Z', 1000, [['cash', 1000]]),
  order('o2', 'dev-a', 's1', '2026-10-09T07:45:00Z', 500, [['mpesa', 500], ['card', 99, 'pending']]),
  order('o3', 'dev-b', 's2', '2026-10-09T09:10:00Z', 300, [['cash', 1500]], 1200),   // 1,500 sale, 1,200 refunded
  order('o4', null, null, '2026-10-09T10:00:00Z', 200, [['card', 200]]),
];
const names = new Map([['dev-a', { device_id: 'dev-a', terminal_code: 'T1', device_label: 'Front' }],
  ['dev-b', { device_id: 'dev-b', terminal_code: null, device_label: 'Bar' }]]);
const people = new Map([['u-s1', 'Jane'], ['u-s2', 'Ali'], ['u-s3', 'Wanjiru'], ['m1', 'Grace']]);
const shifts = [
  shift('s1', 'dev-a'),
  shift('s2', 'dev-b', { status: 'open', closed_at: null, closing_float: null, expected_cash: null, cash_variance: null, opened_at: '2026-10-09T08:00:00Z', declared_methods: null }),
  shift('s3', 'dev-a', { confirmed_at: '2026-10-09T13:00:00Z', confirmed_by: 'm1', cash_variance: -50, closing_float: 950, expected_cash: 1000, close_method: 'forced', opened_at: '2026-10-09T03:00:00Z' }),
];
const r = B.buildBranchReport({
  orders, shifts, shiftOrders: orders.filter((o) => o.shift_id), names, people,
  expectedOpen: new Map([['s2', 2500]]), tzOffsetMin: 180,
});

console.log('\nThe branch, every till\n');
ok('refunds come off: revenue 1,000 + 500 + 300 + 200 = 2,000 (before refunds 3,200)', () => {
  assert.equal(r.summary.totalRevenue, 2000);
  assert.equal(r.summary.grossBeforeRefunds, 3200);
  assert.equal(r.summary.totalRefunded, 1200);
  assert.equal(r.summary.totalOrders, 4);
  assert.equal(r.summary.avgOrderValue, 500);
});
ok('only completed payments count in the method split', () => {
  assert.deepEqual(r.paymentMethods, { cash: 2500, mpesa: 500, card: 200 });
});
ok("every till, by name: T1's code, Bar's label, the web POS as Web Till", () => {
  assert.deepEqual(r.byTill.map((t) => [t.label, t.orders, t.revenue]), [['T1', 2, 1500], ['Bar', 1, 300], ['Web Till', 1, 200]]);
});
ok("the branch's own hour (Nairobi 10:00, not 07:00 UTC)", () => {
  assert.deepEqual(r.hourly.map((h) => h.hour), [10, 12, 13]);
  assert.equal(r.hourly[0].revenue, 1500);
});

console.log('\nThe shift report\n');
ok('open shifts first, then newest first', () => assert.deepEqual(r.shifts.map((s) => s.id), ['s2', 's1', 's3']));
ok('each shift: its till, cashier, own sales and method split', () => {
  const s1 = r.shifts.find((s) => s.id === 's1');
  assert.equal(s1.till, 'T1'); assert.equal(s1.cashier, 'Jane');
  assert.equal(s1.sales, 1500); assert.equal(s1.orders, 2);
  assert.deepEqual(s1.by_method, [{ method: 'cash', amount: 1000 }, { method: 'mpesa', amount: 500 }]);
});
ok('an open shift: expected cash now, nothing counted, no difference', () => {
  const s2 = r.shifts.find((s) => s.id === 's2');
  assert.equal(s2.state, 'open'); assert.equal(s2.expected_cash, 2500);
  assert.equal(s2.counted_cash, null); assert.equal(s2.variance, null);
});
ok('awaiting a manager: closed with a declaration, not yet confirmed', () => assert.equal(r.shifts.find((s) => s.id === 's1').state, 'awaiting'));
ok('confirmed: by whom, the difference, forced', () => {
  const s3 = r.shifts.find((s) => s.id === 's3');
  assert.equal(s3.state, 'confirmed'); assert.equal(s3.confirmed_by, 'Grace');
  assert.equal(s3.variance, -50); assert.equal(s3.counted_cash, 950); assert.equal(s3.force_closed, true);
});
ok('a close with no declaration (before A365) is just closed', () => {
  assert.equal(B.shiftState({ status: 'closed', declared_methods: null, confirmed_at: null }), 'closed');
});

console.log('\nThe route\n');
const route = read('apps/server/src/routes/shifts.ts');
ok('a manager only — never a cashier (blind close) nor the till itself (A415)', () => {
  assert.match(route, /router\.get\('\/branch-report', async \(req, res\) => \{\s*if \(!callerMayConfirm\(req\)\) \{ res\.status\(403\)/);
});
ok('it comes before /:id (else "branch-report" is read as a shift id)', () => {
  assert.ok(route.indexOf("router.get('/branch-report'") < route.indexOf("router.get('/:id'"));
});
ok('orders are paged (a plain select stops silently at the row cap) and refund-adjusted by orderTax', () => {
  assert.match(route, /\.order\('id', \{ ascending: true \}\)\.range\(at, at \+ REPORT_PAGE - 1\)/);
  assert.match(route, /const t = orderTax\(o\);/);
  assert.doesNotMatch(route.slice(route.indexOf("router.get('/branch-report'"), route.indexOf('// GET /api/shifts\n')), /chunkIn</);
});
ok("the branch is the caller's (branchScope), the range at most a month", () => {
  assert.match(route, /const branchId = branchScope\(req\);/);
  assert.match(route, /if \(t - f > 32 \* 86_400_000\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
