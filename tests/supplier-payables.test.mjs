/**
 * supplier-payables.test.mjs — A395: what the business owes its suppliers — bills, payments, returns, balances, ageing,
 * the statement.
 *
 * Owner, 2026-10-04: supplier bills and payables, with returns to supplier ("Yes proceed").
 *
 * The rules (lib/payables.ts, pure) run for real; source pins on the routes and the screens.
 *
 * MUTATIONS TO CONFIRM BITE: billView counting a voided payment → "a voided payment pays nothing" fails;
 * paymentProblem allowing more than the bill owes → "never more than the bill still owes" fails; supplierPosition
 * leaving out return credits → "balance = bills − payments − credits" fails; a return without the stock check →
 * its pin fails; payables.manage dropped from MANAGER_DENY → "the owner's by default" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const P = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/payables.ts')).href);
const T = '2026-10-04';
const bill = (id, amount, bill_date, due_date = null, status = 'open') => ({ id, amount, bill_date, due_date, status });

console.log('\nThe rules\n');
await ok('amounts, methods and dates as people type them', () => {
  assert.equal(P.parseAmount('12,500'), 12500); assert.equal(P.parseAmount(' 99.999 '), 100); assert.equal(P.parseAmount(450.5), 450.5);
  for (const bad of ['', '0', '-5', 'abc', null, undefined, '1e4']) assert.equal(P.parseAmount(bad), null, String(bad));
  assert.equal(P.cleanMethod('M-Pesa'), 'mpesa'); assert.equal(P.cleanMethod('BANK'), 'bank'); assert.equal(P.cleanMethod('card'), null);
  assert.equal(P.cleanDate('2026-02-29'), null); assert.equal(P.cleanDate('2026-10-04'), '2026-10-04'); assert.equal(P.cleanDate('4/10/2026'), null);
  assert.equal(P.addDays('2026-10-04', 30), '2026-11-03'); assert.equal(P.daysBetween('2026-09-04', T), 30);
  assert.equal(P.payablesRef('BILL', 0), 'BILL-0001'); assert.equal(P.payablesRef('RTN', 9), 'RTN-0010');
});
await ok('a bill: paid, owed and where it stands — open, part paid, overdue, paid, void', () => {
  const b = bill('b1', 10000, '2026-09-01', '2026-10-01');
  assert.deepEqual(P.billView(b, [], T), { paid: 0, due: 10000, state: 'overdue', daysOverdue: 3 });
  assert.deepEqual(P.billView({ ...b, due_date: '2026-10-20' }, [{ bill_id: 'b1', amount: 4000 }], T), { paid: 4000, due: 6000, state: 'part_paid', daysOverdue: 0 });
  assert.equal(P.billView({ ...b, due_date: '2026-10-20' }, [], T).state, 'open');
  assert.equal(P.billView(b, [{ bill_id: 'b1', amount: '10000.00' }], T).state, 'paid');
  assert.deepEqual(P.billView({ ...b, status: 'void' }, [], T), { paid: 0, due: 0, state: 'void', daysOverdue: 0 });
  assert.equal(P.billView(bill('b2', 500, '2026-10-01'), [], T).daysOverdue, 3, 'no due date = due on the bill date');
});
await ok('a voided payment pays nothing; another bill\'s payment is not this one\'s', () => {
  const b = bill('b1', 1000, T, '2026-10-30');
  assert.equal(P.billView(b, [{ bill_id: 'b1', amount: 600, voided_at: '2026-10-04T10:00:00Z' }, { bill_id: 'b9', amount: 300 }], T).due, 1000);
});
await ok('a payment is never more than the bill still owes; none against a void or paid bill; on account is free', () => {
  const b = bill('b1', 1000, T, '2026-10-30');
  assert.equal(P.paymentProblem(b, [{ bill_id: 'b1', amount: 700 }], 300, T), null);
  assert.match(P.paymentProblem(b, [{ bill_id: 'b1', amount: 700 }], 301, T), /more than the bill still owes \(300\.00\)/);
  assert.match(P.paymentProblem(b, [{ bill_id: 'b1', amount: 1000 }], 1, T), /already paid/);
  assert.match(P.paymentProblem({ ...b, status: 'void' }, [], 1, T), /voided/);
  assert.equal(P.paymentProblem(null, [], 99999, T), null);
});
await ok('balance = open bills − payments − return credits; overdue, due soon and ageing from what each bill still owes', () => {
  const bills = [
    bill('a', 10000, '2026-06-01', '2026-06-15'),   // 111 days late
    bill('b', 5000, '2026-08-20', '2026-09-20'),    // 14 days late, 2000 paid → 3000
    bill('c', 8000, '2026-10-01', '2026-10-08'),    // due in 4 days
    bill('d', 4000, '2026-10-01', '2026-11-30'),    // not yet due
    bill('e', 2000, '2026-08-01', '2026-08-20'),    // 45 days late
    bill('v', 9999, '2026-10-01', null, 'void'),
  ];
  const pays = [{ bill_id: 'b', amount: 2000 }, { bill_id: null, amount: 1500 }, { bill_id: 'a', amount: 50, voided_at: 'x' }];
  const pos = P.supplierPosition(bills, pays, [{ credit_amount: 500 }], T);
  assert.equal(pos.billed, 29000); assert.equal(pos.paid, 3500); assert.equal(pos.credits, 500);
  assert.equal(pos.balance, 25000);
  assert.equal(pos.overdue, 15000); assert.equal(pos.dueSoon, 8000); assert.equal(pos.openBills, 5);
  assert.deepEqual(pos.ageing, { current: 12000, d1_30: 3000, d31_60: 2000, d61_90: 0, d90plus: 10000 });
});
await ok('the statement: in date order, bills then returns then payments on a day, a running balance, voids left out', () => {
  const s = P.statement(
    [{ ...bill('b1', 1000, '2026-10-01'), ref: 'BILL-0001', invoice_number: 'INV-9' }, { ...bill('b2', 300, '2026-10-02', null, 'void'), ref: 'BILL-0002' }],
    [{ id: 'p1', bill_id: 'b1', amount: 400, paid_on: '2026-10-01', method: 'mpesa', reference: 'QWE123' },
     { id: 'p2', bill_id: null, amount: 100, paid_on: '2026-10-03', method: 'cash', voided_at: 'x' }],
    [{ id: 'r1', ref: 'RTN-0001', return_date: '2026-10-01', credit_amount: 150 }],
  );
  assert.deepEqual(s.map((e) => [e.kind, e.ref, e.debit, e.credit, e.balance]), [
    ['bill', 'BILL-0001', 1000, 0, 1000], ['return', 'RTN-0001', 0, 150, 850], ['payment', 'QWE123', 0, 400, 450],
  ]);
  assert.match(s[2].detail, /Payment — mpesa for BILL-0001/);
});
await ok('a delivery\'s value is what was received at its cost', () => {
  assert.equal(P.grnValue([{ quantity_received: '10', unit_cost: '250.5' }, { quantity_received: 3, unit_cost: null }]), 2505);
});

console.log('\nThe cloud and the screens\n');
const r = read('apps/server/src/routes/payables.ts');
await ok("bills, payments and balances are the owner's by default; a manager who receives may send goods back", () => {
  for (const route of ["'/summary'", "'/suppliers/:id'", "'/bills'", "'/bills/:id/void'", "'/payments'", "'/payments/:id/void'"]) {
    assert.match(r, new RegExp(`router\\.(get|post)\\(${route.replace(/[/:]/g, (c) => '\\' + c)}, requirePermission\\('payables\\.manage'\\)`), route);
  }
  assert.match(r, /router\.post\('\/returns', requireAnyPermission\('inventory\.receive', 'payables\.manage'\)/);
  assert.match(read('apps/server/src/lib/defaultRolePermissions.ts'), /'reports\.financial',\n\s+\/\/ A395[^\n]*\n\s+'payables\.manage',\n\]\);/);
  assert.match(read('apps/server/src/lib/permissionCatalogue.ts'), /key: 'payables\.manage'/);
  assert.match(read('apps/server/src/routes/index.ts'), /router\.use\('\/payables',\s+payablesRoutes\);/);
  assert.doesNotMatch(read('migrations/121_supplier_payables.sql'), /INSERT INTO public\.role_permissions/);
});
await ok('a payment against a bill is checked against what it still owes; a bill with payments cannot be voided', () => {
  assert.match(r, /const problem = paymentProblem\(bill, \(paid \?\? \[\]\) as PaymentLike\[\], amount, today\(\)\);\n\s+if \(problem\) \{ res\.status\(409\)/);
  assert.match(r, /code: 'BILL_HAS_PAYMENTS'/);
  assert.match(r, /\.eq\('bill_id', req\.params\.id\)\.is\('voided_at', null\);/);
});
await ok('a bill for a delivery: only this supplier\'s delivery, at most one open bill per delivery', () => {
  assert.match(r, /code: 'GRN_NOT_SUPPLIER'/); assert.match(r, /code: 'GRN_BILLED'/);
  assert.match(read('migrations/121_supplier_payables.sql'), /supplier_bills_one_per_grn\s+ON public\.supplier_bills \(grn_id\) WHERE grn_id IS NOT NULL AND status = 'open'/);
});
await ok('a return: never more than the branch holds; the stock leaves atomically, each change naming the return', () => {
  assert.match(r, /if \(qty > held \+ 0\.004\) \{ res\.status\(409\)\.json\(\{ error: `\$\{p\.name\}: only \$\{held\} at this branch\.`, code: 'MORE_THAN_HELD' \}\)/);
  assert.match(r, /p_qty_delta: l\.byPiece \? 0 : -l\.quantity, p_piece_delta: l\.byPiece \? -Math\.round\(l\.quantity\) : 0,/);
  assert.match(r, /p_delta: -l\.quantity,/);
  assert.equal((r.match(/reference_type: 'supplier_return', reference_id: r\.id/g) ?? []).length, 2);
  assert.match(r, /code: 'REASON_REQUIRED'/);
});
await ok('the screens: balances only for payables.manage; the account with statement, bills, unbilled deliveries; a clear note', () => {
  const sp = read('apps/dashboard/src/pages/stock/SuppliersPage.tsx');
  assert.match(sp, /const canPay = can\('payables\.manage'\);/);
  assert.match(sp, /if \(canPay\) setSummary\(await api\.get<Summary>\('\/api\/payables\/summary'\)/);
  const a = read('apps/dashboard/src/components/SupplierAccount.tsx');
  assert.match(a, /api\.get<Account>\(`\/api\/payables\/suppliers\/\$\{supplierId\}`\)/);
  assert.match(a, /docType: 'SUPPLIER STATEMENT'/);
  assert.match(a, /A payment recorded here is not an expense and does not come out of a till drawer\./);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
