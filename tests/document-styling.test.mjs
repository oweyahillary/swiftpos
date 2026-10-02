/**
 * document-styling.test.mjs — A226 (engine styling) + A234 (delegation).
 * The engine renders the accent bar + status pill; the accent PALETTE per doc type
 * now lives in documentSpecs (guarded by document-specs.test.mjs), and every caller
 * delegates to those builders.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pd = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/printDocument.ts'), 'utf8');
const po = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx'), 'utf8');
const rx = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx'), 'utf8');
const tp = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/StockTransfersPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

ok('engine: DOC_ACCENT palette exported (po/grn/despatch/received/cancelled)', () => {
  assert.match(pd, /export const DOC_ACCENT = \{/);
  for (const k of ['po', 'grn', 'despatch', 'received', 'cancelled']) {
    assert.match(pd, new RegExp(`${k}:\\s*'#[0-9a-fA-F]{6}'`), `DOC_ACCENT.${k} missing`);
  }
});
ok('engine: top accent bar + status pill (title-cased), forced to print', () => {
  assert.match(pd, /\.accentbar \{ height:6px; background:\$\{esc\(accent\)\}/);
  assert.match(pd, /const pillHtml = statusLabel/);
  assert.match(pd, /titleCase\(statusLabel\)/);
  assert.match(pd, /print-color-adjust:exact/);
});
ok('PO page delegates to purchaseOrderDocSpec + grnDocSpec', () => {
  assert.match(po, /printDocument\(purchaseOrderDocSpec\(/);
  assert.match(po, /printDocument\(grnDocSpec\(/);
});
ok('Manager receive delegates to transferDocSpec + grnDocSpec', () => {
  assert.match(rx, /printDocument\(transferDocSpec\(/);
  assert.match(rx, /printDocument\(grnDocSpec\(/);
});
ok('Owner transfers page delegates to transferDocSpec', () => {
  assert.match(tp, /printDocument\(transferDocSpec\(/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
