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

ok('A258: Overview puts Top Items + Payment Methods in a 2-col grid (no blank)', () => {
  const d = r('apps/dashboard/src/pages/manager/ManagerDashboard.tsx');
  assert.match(d, /grid grid-cols-1 lg:grid-cols-2 gap-4">\s*\n\s*\{hourly\.length > 0/);
  assert.match(d, /Payment methods — beside Top Items/);
  assert.doesNotMatch(d, /grid grid-cols-1 sm:grid-cols-3 gap-4/); // payment methods restacked for the narrower column
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
  assert.match(e, /renderTicket\(\{ order: withDate\(order\), business, station, reprint \}\)/);
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
ok('A263: report period selector — one active preset, no Apply button, Today default', () => {
  const rp = r('apps/dashboard/src/pages/manager/ManagerReportsPage.tsx');
  assert.match(rp, /const \[active, setActive\] = useState<string>/);
  assert.match(rp, /active === p\.label \? 'bg-blue-600 text-white'/);
  assert.doesNotMatch(rp, /'Apply'/);                                   // Apply button gone (auto-applies)
  assert.doesNotMatch(rp, /useState\(weekAgo\(\)\)/);               // Today is the default range
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'} (${pass} passed)`);
process.exit(fail ? 1 : 0);
