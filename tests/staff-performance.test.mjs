/**
 * staff-performance.test.mjs — owner, 2026-10-10: "on the web under this report [Reports › Staff Performance] can we add
 * a small feature which shows view payment method and list each payment method (A439); also can we add a staff
 * performance report on the desktop maybe under overview (A440), and also under overview can we add select date to view
 * that date? (A441)".
 *
 *   node tests/staff-performance.test.mjs
 *
 * RUNS the real rules: the cloud's split of a cashier's money by method (server lib/staffMethods.ts), the cloud's branch
 * report staff rows (server lib/branchReport.ts), the till's offline staff rows (desktop main/branchDay.ts staffRows,
 * lifted out — its file needs Electron), the Overview's day (desktop renderer/lib/overviewDate.ts); then pins the screens.
 *
 * MUTATIONS TO CONFIRM BITE: the split not scaled to the kept total → "methods add up to revenue" fails; the staff route
 * not paged → its pin fails; a sale credited to the shift's owner instead of who rang it up → "B's sale is B's" fails; the
 * Overview asking for today whatever the date → "a past day is that whole day" fails; the day stepping past today →
 * "never past today" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.STAFF_PERF_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, STAFF_PERF_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const M = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/staffMethods.ts')).href);
const B = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/branchReport.ts')).href);
const D = await import(pathToFileURL(path.join(ROOT, 'apps/desktop/src/renderer/lib/overviewDate.ts')).href);
// The till's staffRows, run as written (its file imports Electron): the function lifted into a temp .ts file with money2.
const bd = read('apps/desktop/src/main/branchDay.ts');
const fnStart = bd.indexOf('export function staffRows(');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a440-'));
fs.writeFileSync(path.join(tmp, 'staffRows.ts'), 'type StaffRow = any;\nconst money2 = (n: number) => Math.round(n * 100) / 100;\n'
  + bd.slice(fnStart, bd.indexOf('\n}\n', fnStart) + 3));
const { staffRows } = await import(pathToFileURL(path.join(tmp, 'staffRows.ts')).href);

console.log('\nA439 — the web: each cashier\'s money by payment method');
ok('a split sale: each method its share of what was kept', () => {
  assert.deepEqual(M.splitByMethod(1200, [{ method: 'cash', amount: 600, status: 'completed' }, { method: 'mpesa', amount: 600, status: 'completed' }]), { cash: 600, mpesa: 600 });
});
ok('cash over-tendered (change given) and refunds: methods add up to revenue', () => {
  const m = M.splitByMethod(900, [{ method: 'cash', amount: 1000 }, { method: 'mpesa', amount: 500 }]);   // a 1,000 sale, 100 refunded
  assert.equal(Math.round((m.cash + m.mpesa) * 100) / 100, 900);
  assert.equal(Math.round(m.cash), 600);
});
ok('a failed payment is not counted; no payment at all is "unpaid"', () => {
  assert.deepEqual(M.splitByMethod(500, [{ method: 'mpesa', amount: 500, status: 'failed' }, { method: 'cash', amount: 500, status: 'completed' }]), { cash: 500 });
  assert.deepEqual(M.splitByMethod(300, []), { unpaid: 300 });
});
ok('the list: to the cent, biggest first', () => {
  const into = {}; M.addMethods(into, { cash: 100.004, mpesa: 300 }); M.addMethods(into, { cash: 50 });
  assert.deepEqual(M.methodList(into), [{ method: 'mpesa', amount: 300 }, { method: 'cash', amount: 150 }]);
});
const rep = read('apps/server/src/routes/reports.ts');
ok('the staff route is paged (a busy month has more than 1,000 sales) and sends by_method', () => {
  const route = rep.slice(rep.indexOf("router.get('/staff'"), rep.indexOf("router.get('/inventory'"));
  assert.ok(route.includes(".order('id', { ascending: true }).range(at, at + 999)"));
  assert.ok(route.includes('payments ( method, amount, status )'));
  assert.ok(route.includes('addMethods(staffMap[key].methods, splitByMethod(kept, (o as any).payments));'));
  assert.ok(route.includes('by_method:       methodList(v.methods),'));
});
const web = read('apps/dashboard/src/pages/ReportsPage.tsx');
ok('Reports › Staff Performance: "Payment methods" per cashier, and for everyone', () => {
  assert.ok(web.includes('data-testid="staff-methods-toggle"') && web.includes('data-testid="staff-methods-all"'));
  assert.ok(web.includes('data-testid="staff-methods-row"'));
});

console.log('\nA440 — the till: staff performance under the Overview');
const at = (h) => `2026-10-10T${String(h).padStart(2, '0')}:00:00Z`;
const order = (id, cashier, shift, net, payments) => ({ id, created_at: at(10), device_id: 'd1', shift_id: shift, cashier_id: cashier,
  gross: net, refunded: 0, net, vat: 0, ctl: 0, discount: 0, tip: 0, payments });
const pay = (method, amount) => ({ method, amount, status: 'completed' });
const shift = { id: 'sh-A', device_id: 'd1', terminal_code: 'T1', cashier_id: 'u-a', status: 'open', opened_at: at(8), closed_at: null,
  opening_float: 0, closing_float: null, expected_cash: null, cash_variance: null, close_method: null, declared_methods: null, confirmed_at: null, confirmed_by: null };
const orders = [
  order('o1', 'u-a', 'sh-A', 1000, [pay('cash', 1000)]),
  order('o2', 'u-b', 'sh-A', 600, [pay('mpesa', 600)]),         // B on A's shift
  order('o3', null, 'sh-A', 400, [pay('cash', 400)]),           // an old row: the shift's owner
];
const report = B.buildBranchReport({ orders, shifts: [shift], shiftOrders: orders, names: new Map(), people: new Map([['u-a', 'Alice'], ['u-b', 'Brian']]), expectedOpen: new Map(), tzOffsetMin: 180 });
ok('the cloud: B\'s sale on A\'s shift is B\'s; a row with no cashier is the shift owner\'s', () => {
  assert.deepEqual(report.byStaff.map((r) => [r.name, r.orders, r.revenue]), [['Alice', 2, 1400], ['Brian', 1, 600]]);
});
ok('the cloud: each person\'s money by method, and the average', () => {
  assert.deepEqual(report.byStaff[0].by_method, [{ method: 'cash', amount: 1400 }]);
  assert.equal(report.byStaff[0].avg, 700);
});
ok('offline, the till gives the same answer from its own rows', () => {
  const rows = staffRows([
    { id: 'o1', who: 'u-a', name: 'Alice', kept: 1000 }, { id: 'o2', who: 'u-b', name: 'Brian', kept: 600 }, { id: 'o3', who: 'u-a', name: 'Alice', kept: 400 },
  ], [{ order_id: 'o1', method: 'cash', amount: 1000 }, { order_id: 'o2', method: 'mpesa', amount: 600 }, { order_id: 'o3', method: 'cash', amount: 400 }]);
  assert.deepEqual(rows.map((r) => [r.name, r.orders, r.revenue, r.by_method]), report.byStaff.map((r) => [r.name, r.orders, r.revenue, r.by_method]));
});
ok('the till\'s offline query credits who rang it up first, the shift\'s owner only when none', () => {
  assert.ok(bd.includes('SELECT o.id, COALESCE(o.cashier_id, s.cashier_id) AS who'));
});
const mp = read('apps/desktop/src/renderer/pages/ManagerPage.tsx');
ok('the Overview shows it, with payment methods per person or for everyone', () => {
  assert.ok(mp.includes('<StaffPerformance day={day} currency={currency} when={when} />'));
  assert.ok(mp.includes('data-testid="overview-staff-methods"') && mp.includes('data-testid="overview-staff-all"'));
  assert.ok(read('apps/server/src/routes/shifts.ts').includes("const ORDER_COLS = 'id, created_at, device_id, shift_id, cashier_id, total,"));
});

console.log('\nA441 — the Overview\'s day');
const now = new Date(2026, 9, 10, 15, 0);   // Sat 10 Oct 2026, 15:00 local
ok('today asks for today (the business-day cut-off applies)', () => {
  assert.deepEqual(D.overviewRange(null, now), { preset: 'today' });
  assert.deepEqual(D.overviewRange('2026-10-10', now), { preset: 'today' });
});
ok('a past day is that whole day', () => {
  assert.deepEqual(D.overviewRange('2026-10-04', now), { preset: 'custom', from: '2026-10-04', to: '2026-10-04' });
});
ok('the cards say which day', () => {
  assert.equal(D.dayWord(null, now), 'today');
  assert.equal(D.dayWord('2026-10-09', now), 'yesterday');
  assert.match(D.dayWord('2026-10-04', now), /Sun 4 Oct/);
  assert.match(D.dayWord('2025-12-31', now), /2025/);
});
ok('a day back and forward — never past today', () => {
  assert.equal(D.stepDay(null, -1, now), '2026-10-09');
  assert.equal(D.stepDay('2026-10-01', -1, now), '2026-09-30');
  assert.equal(D.stepDay('2026-10-08', 1, now), '2026-10-09');
  assert.equal(D.stepDay('2026-10-09', 1, now), null);
  assert.equal(D.stepDay(null, 1, now), null);
});
ok('every Overview asks for the day chosen and reloads when it changes', () => {
  assert.equal(mp.split('posApi.manager.branchDay(overviewRange(date))').length - 1, 3);
  const ov = mp.slice(mp.indexOf('function RestaurantOverview('), mp.indexOf('function RetailOverview('));
  assert.ok((ov.match(/\}, \[date\]\);/g) ?? []).length >= 2);
  assert.ok(mp.includes('<OverviewForDay render={(date) =>'));
  assert.ok(mp.includes('max={today}'));
});
ok('fuel: the live pump cards only for today; another day says so', () => {
  // A468: the web's Pump Monitor card (title, "today", the totals), still today only.
  assert.ok(mp.includes("{when === 'today' && (\n        <div className=\"bg-gray-900 border border-gray-800 rounded-xl overflow-hidden\" data-testid=\"overview-pump-monitor\">"));
  assert.ok(mp.includes('<span className="text-white text-sm font-medium">Pump Monitor</span>'));
  assert.ok(mp.includes('data-testid="overview-pumps-today-only"'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
