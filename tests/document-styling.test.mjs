/**
 * document-styling.test.mjs — A226 source guards (rule 24), mutation-checkable.
 * The print engine renders a semantic accent bar + status pill; every caller
 * passes the right accent. Status also stays as text (pill title-cased), so B&W
 * copies lose nothing.
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

// ── Engine ────────────────────────────────────────────────────────────────
ok('engine: DOC_ACCENT palette exported (po/grn/despatch/received/cancelled)', () => {
  assert.match(pd, /export const DOC_ACCENT = \{/);
  for (const k of ['po', 'grn', 'despatch', 'received', 'cancelled']) {
    assert.match(pd, new RegExp(`${k}:\\s*'#[0-9a-fA-F]{6}'`), `DOC_ACCENT.${k} missing`);
  }
});
ok('engine: renders a top accent bar in the accent colour', () => {
  assert.match(pd, /class="accentbar"/);
  assert.match(pd, /\.accentbar \{ height:6px; background:\$\{esc\(accent\)\}/);
});
ok('engine: renders a status pill (title-cased) when statusLabel is set', () => {
  assert.match(pd, /const pillHtml = statusLabel/);
  assert.match(pd, /titleCase\(statusLabel\)/);
  assert.match(pd, /class="pill"/);
});
ok('engine: forces the bar colour to print (print-color-adjust)', () => {
  assert.match(pd, /print-color-adjust:exact/);
});

// ── Callers pass the right accent ──────────────────────────────────────────
ok('PO uses the PO accent (red when cancelled) + status pill', () => {
  assert.match(po, /accent: po\.status === 'cancelled' \? DOC_ACCENT\.cancelled : DOC_ACCENT\.po, statusLabel: po\.status/);
});
ok('GRN docs use the green accent', () => {
  assert.strictEqual((po.match(/DOC_ACCENT\.grn, statusLabel: 'Received'/g) || []).length, 2);
});
ok('transfer notes use despatch (amber) and received (teal) accents', () => {
  assert.match(rx, /DOC_ACCENT\.despatch, statusLabel: 'Despatch'/);
  assert.match(rx, /DOC_ACCENT\.received, statusLabel: 'Received'/);
});
ok('owner transfers page accents by status', () => {
  assert.match(tp, /accent: received \? DOC_ACCENT\.received : \(t\.status === 'cancelled' \? DOC_ACCENT\.cancelled : DOC_ACCENT\.despatch\)/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
