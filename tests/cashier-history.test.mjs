/**
 * cashier-history.test.mjs — A387 / A627: cashierHistoryView, the pure filter for which payments a cashier sees in History.
 *
 * Which methods a cashier sees is a per-person RIGHT now (sales.history_all_payments): [] (every method) with it or as a
 * manager, else ['cash']. The server (orders.ts) and the till apply cashierHistoryView with that list. The old
 * 'cashier_history_methods' business/branch/till setting is gone. The till is run for real in
 * apps/desktop/test/cashier-history.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: cashierHistoryView keeping a whole split sale → "a split sale shows only its allowed part"
 * fails; dropping the empty-list pass-through → "nothing chosen = every method" fails; orders.ts not gating on the right
 * → "the right decides the methods" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const H = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/cashierHistory.ts')).href);

const sale = (id, payments, total) => ({ id, total, payments });
const ORDERS = [
  sale('cash-only', [{ method: 'cash', amount: 500 }], 500),
  sale('mpesa-only', [{ method: 'mpesa', amount: 800 }], 800),
  sale('split', [{ method: 'cash', amount: 300 }, { method: 'mpesa', amount: 700 }], 1000),
  sale('card-only', [{ method: 'card', amount: 1200 }], 1200),
  sale('no-rows', [], 250),
  sale('zero-leg', [{ method: 'cash', amount: 0 }, { method: 'mpesa', amount: 450 }], 450),
];

await ok('nothing chosen = every method: the list is unchanged', () => {
  assert.strictEqual(H.cashierHistoryView(ORDERS, []), ORDERS);
  assert.strictEqual(H.cashierHistoryView(ORDERS, null), ORDERS);
});

await ok('M-Pesa only: the M-Pesa sales, whole; no cash or card sale', () => {
  const v = H.cashierHistoryView(ORDERS, ['mpesa']);
  assert.deepStrictEqual(v.map((o) => o.id), ['mpesa-only', 'split', 'zero-leg']);
  assert.strictEqual(v[0].history_partial, undefined);
  assert.strictEqual(v[2].history_partial, undefined, 'a zero cash leg beside the M-Pesa is not a split');
});

await ok('a split sale shows only its allowed part — that amount, never the bill', () => {
  const split = H.cashierHistoryView(ORDERS, ['mpesa']).find((o) => o.id === 'split');
  assert.strictEqual(split.history_partial, true);
  assert.strictEqual(split.history_shown_total, 700);
  assert.deepStrictEqual(split.payments, [{ method: 'mpesa', amount: 700 }]);
  assert.strictEqual(ORDERS[2].payments.length, 2, 'the original is not changed');
});

await ok('cash + card: a sale with no payment rows counts as cash; the split shows its cash part', () => {
  const v = H.cashierHistoryView(ORDERS, ['cash', 'card']);
  assert.deepStrictEqual(v.map((o) => o.id), ['cash-only', 'split', 'card-only', 'no-rows']);
  assert.strictEqual(v.find((o) => o.id === 'split').history_shown_total, 300);
});

await ok('A627: the methods a cashier sees in History are the sales.history_all_payments right (cash only without it)', () => {
  const o = read('apps/server/src/routes/orders.ts');
  assert.match(o, /const historyMethods = \(manager \|\| can\(req, 'sales\.history_all_payments'\)\) \? \[\] : \['cash'\];/);
  assert.match(o, /if \(historyMethods\.length\) orders = cashierHistoryView\(orders, historyMethods\);/);
});

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
