/**
 * transfer-received-visibility.test.mjs — A224 source guards (rule 24), mutation-checkable.
 * The received quantity and the receipt note (stored by A221) are now surfaced to a
 * human: the /transfers list returns quantity_received, and the owner Transfers page
 * shows Sent vs Received per line (short receipts flagged) plus the receipt note.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = fs.readFileSync(path.join(root, 'apps/server/src/routes/stock.ts'), 'utf8');
const pg  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/StockTransfersPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

ok('A224 server: /transfers returns quantity_received', () => {
  assert.match(srv, /stock_transfer_items \( id, product_id, quantity, quantity_received, products/);
});
ok('A224 UI: TransferItem carries quantity_received, Transfer carries receipt_note', () => {
  assert.match(pg, /quantity_received\?: number \| null/);
  assert.match(pg, /receipt_note\?: string \| null/);
});
ok('A224 UI: the owner transfers table shows a Received column', () => {
  assert.match(pg, /<th className="text-right pb-2">Received<\/th>/);
  assert.match(pg, /rec == null \? '—' : rec/);
});
ok('A224 UI: a short receipt is visually flagged', () => {
  assert.match(pg, /const short = rec != null && Number\(rec\) < Number\(item\.quantity\)/);
});
ok('A224 UI: the receipt note is shown (distinct from the despatch note)', () => {
  assert.match(pg, /Receipt note: \{t\.receipt_note\}/);
  assert.match(pg, /Despatch note: \{t\.notes\}/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
