/**
 * A258/A259 — Overview layout (Top Items + Payment Methods side by side) and the
 * reports fixes (cashier name falls back to email instead of "Unknown"; open
 * shifts appear in the period even when opened earlier).
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

// A608 (2026-10-29): the web manager portal is retired — its checks are gone; the manager Overview half of A258
// (ManagerDashboard.tsx) is gone; the owner Overview (next) pins the same pairing.
ok('A258: the OWNER Overview also pairs Payment methods with Top sellers (not stacked)', () => {
  // The original A258 fix only reached the manager Overview; the owner OverviewPage still
  // stacked them (found in the 2026-09-09 browser pass). Guard the owner path too: within
  // one 2-col grid, Payment methods must be immediately followed by Top sellers/grades.
  const o = r('apps/dashboard/src/pages/OverviewPage.tsx');
  assert.match(o, /A258:[\s\S]{0,120}side by side/); // the A258 intent comment (wraps two lines)
  assert.match(o, /title="Payment methods"[\s\S]{0,1600}\{\/\* Top sellers \*\/\}/);
});
ok('A259: OWNER staff report reads staff_name/staff_id (not the stale name/cashier_id)', () => {
  // The A259d server fix emits staff_name/staff_id; the owner ReportsPage still read
  // s.name/s.cashier_id, so the Cashier column rendered blank (2026-09-09 browser pass).
  const rp = r('apps/dashboard/src/pages/ReportsPage.tsx');
  assert.match(rp, /staff_id:\s*string;\s*staff_name:\s*string/); // the corrected type
  // the staff-performance row keys on staff_id and renders staff_name (other tables keep
  // their own s.name / s.cashier_id — this check is scoped to the staff row).
  assert.match(rp, /key=\{s\.staff_id\}[\s\S]{0,400}\{s\.staff_name\}/);
});
ok('A257: empty category/product submit shows a message, not a silent no-op', () => {
  for (const f of ['apps/dashboard/src/pages/products/CategoriesPage.tsx',
                   'apps/dashboard/src/pages/products/ProductsPage.tsx']) {
    const s = r(f);
    assert.match(s, /if \(!form\.name\.trim\(\)\) \{ setError\('Name is required'\); return; \}/);
    assert.doesNotMatch(s, /disabled=\{saving \|\| !form\.name\.trim\(\)\}/); // button enabled so the click surfaces the message
  }
});
ok('A259: staff report falls back to email when name is null (not "Unknown")', () => {
  const rep = r('apps/server/src/routes/reports.ts');
  assert.match(rep, /userMap\[u\.id\] = u\.name \|\| u\.email \|\| 'Unknown'/);
  assert.match(rep, /nameMap\[u\.id\] = u\.name \|\| u\.email \|\| 'Unknown'/);
});
ok('A259: shift queries include active OPEN shifts opened before the period', () => {
  const rep = r('apps/server/src/routes/reports.ts');
  // the two user-facing shift reports (Shifts tab + Summary Z-report) now include open shifts;
  // the labour report's status='closed' query is intentionally left exclusive.
  assert.strictEqual((rep.match(/status\.eq\.open,opened_at\.gte\.\$\{start\}/g) || []).length, 2);
});

ok('A260: api token lookup falls back to the POS token (documents get the real business name)', () => {
  const api = r('apps/dashboard/src/lib/api.ts');
  assert.match(api, /localStorage\.getItem\(accessKey\(\)\)\s*\n\s*\|\| localStorage\.getItem\(TOKEN_KEYS\.posAccess\)/);
});
ok('A261: reprint reuses the built receipt renderer with the duplicate marker', () => {
  const e = r('scripts/escpos-renderer/entry.ts');
  assert.match(e, /renderReceiptEscPos\(order, business, paperWidth, reprint\)/);
  // 0.6.28: `voided` rides along (a kitchen void's VOID ticket); reprint and proforma unchanged.
  assert.match(e, /renderTicket\(\{ order: withDate\(order\), business, station, reprint, proforma,\s*voided:/);
  const rp = r('apps/dashboard/src/lib/reprintReceipt.ts');
  assert.match(rp, /renderReceiptEscPos\(toReceiptOrder\(order\), biz as any, receipt\.paper_width, \{ at: new Date\(\), count: 1 \}\)/);
  assert.match(rp, /printBytesToServer\(`printer:\$\{receipt\.printer_name\}`, bytes\)/);
  const op = r('apps/dashboard/src/pages/OrdersPage.tsx');
  assert.match(op, /reprintOrderReceipt\(o\.id\)/);
  assert.match(op, /Reprint receipt/);
  // A261b: the manager's Orders tab is the CARD view (POSOrderHistoryTab), not the table.
  const pos = r('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx');
  assert.match(pos, /reprintOrderReceipt\(order\.id\)/);
  assert.match(pos, /Reprint receipt/);
});

ok('A259b: staff report attributes via shift.cashier_id when the order cashier is unresolved + returns avg', () => {
  const rep = r('apps/server/src/routes/reports.ts');
  assert.match(rep, /coveringCashier\(o\.branch_id, o\.created_at\)/);   // A259c: time-window shift attribution
  assert.match(rep, /cashier_id, shift_id, branch_id, created_at, branches/);
  // A259d — THE actual "Unknown" fix: server must emit staff_id/staff_name (the fields
  // the StaffRow frontend reads), not cashier_id/name.
  assert.match(rep, /staff_id:\s+id/);
  assert.match(rep, /staff_name:\s+v\.name/);
  assert.match(rep, /avg_order_value: v\.orders \? v\.revenue \/ v\.orders : 0/);
});
// A608 (2026-10-29): the web manager portal is retired — its checks are gone; A263 pinned the manager Reports
// period selector (ManagerReportsPage.tsx) only.

ok('A262: shift report reuses the shared renderer + prints via the bridge, wired to a button', () => {
  const e = r('scripts/escpos-renderer/entry.ts');
  assert.match(e, /export function renderShiftReportEscPos/);
  const lib = r('apps/dashboard/src/lib/printShiftReport.ts');
  assert.match(lib, /renderShiftReportEscPos\(data as any, receipt\.paper_width\)/);
  assert.match(lib, /api\.get<any>\(`\/api\/shifts\/\$\{shiftId\}`\)/);
  const srv = r('apps/server/src/routes/shifts.ts');
  assert.match(srv, /by_method: byMethod/);           // endpoint returns the breakdown
  assert.match(srv, /expected_cash_computed/);
  // A608 (2026-10-29): the button moved from the retired manager Shifts tab to the dashboard's Open drawers page.
  const tab = r('apps/dashboard/src/pages/OpenShiftsPage.tsx');
  assert.match(tab, /printShiftReport\(s\.id\)/);
  assert.match(tab, /Shift report/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'} (${pass} passed)`);
process.exit(fail ? 1 : 0);
