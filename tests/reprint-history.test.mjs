/**
 * reprint-history.test.mjs — A225 source guards (rule 24), mutation-checkable.
 * Past documents can be re-printed after creation: any transfer prints a
 * despatch/received note; a selected PO lists its GRNs with a Reprint button.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tp = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/StockTransfersPage.tsx'), 'utf8');
const po = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// ── Transfers ────────────────────────────────────────────────────────────────
ok('transfers: printTransferDoc picks received vs despatch note by status', () => {
  assert.match(tp, /import \{ printDocument/);
  assert.match(tp, /const printTransferDoc = /);
  assert.match(tp, /printDocument\(transferDocSpec\(/);
});
ok('transfers: a Print button on each row (does not toggle the row)', () => {
  assert.match(tp, /e\.stopPropagation\(\); printTransferDoc\(t\)/);
});

// ── PO / GRN reprint ─────────────────────────────────────────────────────────
ok('PO page fetches a selected PO\'s GRNs', () => {
  assert.match(po, /\/api\/stock\/grn\?purchase_order_id=\$\{selected\.id\}/);
});
ok('PO page can reprint a stored GRN', () => {
  assert.match(po, /const printStoredGRN = \(grn: StoredGRN\)/);
  assert.match(po, /printDocument\(grnDocSpec\(/);
});
ok('PO detail lists GRNs with a Reprint button', () => {
  assert.match(po, /Goods received notes/);
  assert.match(po, /onClick=\{\(\) => printStoredGRN\(g\)\}/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
