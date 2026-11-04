/**
 * history-by-cashier.test.mjs — A438 (owner, 2026-10-10: "assume cashier A opened a shift and sold; when cashier B logs
 * into the till B will continue to sell using cashier A's shift but the manager can't tell who sold what … in addition
 * to the payment method filter the manager can add a filter by cashier and they get their reports individually, with
 * the payment method filter or as a separate filter").
 *
 *   node tests/history-by-cashier.test.mjs
 *
 * RUNS the rules (packages/core/src/historyView.ts: the cashier filter, the choices, historyByCashier), then pins the till's History
 * (React is not run here) and that each sale is stamped with the person signed in, not the shift's owner.
 *
 * MUTATIONS TO CONFIRM BITE: historyView ignoring the cashier → "only B's sales" fails; historyByCashier not splitting a
 * split payment → "a split sale counts each part under its method" fails; refunds not taken off → its check fails; the
 * cashier filter shown to a cashier (not manager-only) → its pin fails; the sale stamped with the shift's cashier → the
 * attribution pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.HIST_CASHIER_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, HIST_CASHIER_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const H = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/historyView.ts')).href);

// One shift (A's), two people selling on it.
const at = (h) => `2026-10-10T${String(h).padStart(2, '0')}:00:00Z`;
const A = { cashier_id: 'u-a', cashier_name: 'Alice' };
const B = { cashier_id: 'u-b', cashier_name: 'Brian' };
const orders = [
  { id: '1', ...A, created_at: at(8), status: 'completed', total: 1000, payments: [{ method: 'cash', amount: 1000 }] },
  { id: '2', ...A, created_at: at(9), status: 'completed', total: 500, payments: [{ method: 'mpesa', amount: 500 }] },
  { id: '3', ...B, created_at: at(10), status: 'completed', total: 800, payments: [{ method: 'cash', amount: 800 }] },
  { id: '4', ...B, created_at: at(11), status: 'completed', total: 1200, payments: [{ method: 'cash', amount: 600 }, { method: 'mpesa', amount: 600 }] },
  { id: '5', ...B, created_at: at(12), status: 'voided', total: 300, payments: [{ method: 'cash', amount: 300 }] },
  { id: '6', ...B, created_at: at(13), status: 'completed', total: 400, refunded_amount: 100, payments: [{ method: 'mpesa', amount: 400 }] },
  { id: '7', cashier_id: null, created_at: at(14), status: 'completed', total: 50, payments: [{ method: 'cash', amount: 50 }] },
];

console.log('\nThe filter');
ok('only B\'s sales — B selling on A\'s shift is still B\'s', () => {
  assert.deepEqual(H.historyView(orders, { cashier: 'u-b' }).map((o) => o.id), ['6', '5', '4', '3']);
});
ok('with the payment filter: B\'s cash sales', () => {
  assert.deepEqual(H.historyView(orders, { cashier: 'u-b', method: 'cash' }).map((o) => o.id), ['5', '3']);
});
ok('no cashier chosen: everyone (the filter is off)', () => {
  assert.equal(H.historyView(orders, { cashier: '' }).length, orders.length);
});
ok('the choices: each cashier once, by name; a sale with none recorded says so', () => {
  assert.deepEqual(H.historyChoices(orders).cashiers,
    [{ id: 'u-a', name: 'Alice' }, { id: 'u-b', name: 'Brian' }, { id: '', name: 'No cashier recorded' }]);
});
ok('ordered by cashier: grouped by name, newest first in each', () => {
  assert.deepEqual(H.historyView(orders.slice(0, 4), { sort: 'cashier' }).map((o) => o.id), ['2', '1', '4', '3']);
});
ok('the total row follows the cashier filter', () => {
  assert.deepEqual(H.historyTotal(H.historyView(orders, { cashier: 'u-a' })), { orders: 2, sales: 1500 });
});

console.log('\nEach cashier\'s report');
const rep = H.historyByCashier(orders);
const b = rep.find((r) => r.id === 'u-b');
ok('biggest seller first; every cashier listed', () => {
  assert.deepEqual(rep.map((r) => r.name), ['Brian', 'Alice', 'No cashier recorded']);
});
ok('B: 4 orders, sales 2,300 (a voided sale is an order, not a sale; refunds come off)', () => {
  assert.equal(b.orders, 4);
  assert.equal(b.sales, 800 + 1200 + 300);
});
ok('a split sale counts each part under its method', () => {
  const m = Object.fromEntries(b.methods.map((x) => [x.method, x.amount]));
  assert.equal(m.cash, 800 + 600);
  assert.equal(m.mpesa, 600 + 300);
});
ok('by cashier with the payment filter: B\'s M-Pesa only', () => {
  const r = H.historyByCashier(H.historyView(orders, { method: 'mpesa' }));
  assert.deepEqual(r.map((x) => [x.name, x.sales]), [['Alice', 500], ['Brian', 300]]);
});
ok('A\'s sales by method', () => {
  const a = rep.find((r) => r.id === 'u-a');
  assert.deepEqual(a.methods, [{ method: 'cash', amount: 1000 }, { method: 'mpesa', amount: 500 }]);
});

console.log('\nOn the till');
const pos = read('apps/desktop/src/renderer/pages/POSPage.tsx');
ok('managers only: the cashier filter, the "By cashier" report, the Cashier column and order', () => {
  assert.ok(pos.includes('{historyManager && (\n                  <select value={historyCashier}'));
  assert.ok(pos.includes('{historyManager && showByCashier && recentOrders.length > 0 && ('));
  assert.ok(pos.includes("...(historyManager ? ['Cashier'] : [])"));
  assert.ok(pos.includes('{historyManager && <option value="cashier">Cashier</option>}'));
  assert.ok(pos.includes('setHistoryManager(h.scope.manager === true);'));
});
ok('the list and the total use the cashier filter (never for a cashier)', () => {
  assert.equal(pos.split("cashier: historyManager ? historyCashier : ''").length - 1, 2);
});
ok('the report follows the payment and type filters', () => {
  assert.ok(pos.includes('historyByCashier(historyView(recentOrders, { method: historyMethod, type: historyType }))'));
});
ok('one file for the rules: packages/core (no copies left)', () => {
  assert.ok(read('packages/core/src/historyView.ts').length > 0);
  for (const p of ['shared/historyView.ts', 'apps/desktop/src/shared/historyView.ts', 'apps/dashboard/src/lib/historyView.ts']) assert.ok(!fs.existsSync(path.join(ROOT, p)), p);
});

console.log('\nWho a sale belongs to');
ok('a till sale is stamped with the person signed in, not the shift\'s owner', () => {
  const sync = read('apps/desktop/src/main/syncEngine.ts');
  assert.ok(sync.includes("const staff = db.prepare(`SELECT staff_id FROM staff_session WHERE id=1`).get() as any;\n  const cashierId = staff?.staff_id ?? null;"));
  assert.ok(/INSERT INTO orders \([^)]*cashier_id, shift_id/.test(sync));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
