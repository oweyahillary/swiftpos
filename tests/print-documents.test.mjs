/**
 * print-documents.test.mjs — A223 source guards (rule 24), mutation-checkable.
 * A generic A4 print engine, wired to Purchase Orders (PO + GRN) and stock
 * transfers (despatch note). User data is HTML-escaped in the engine.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pd = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/printDocument.ts'), 'utf8');
const po = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx'), 'utf8');
const tp = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/StockTransfersPage.tsx'), 'utf8');
// A234 extracted the doc-spec builders (docType strings + columns) into a shared
// module; the page files keep the print WIRING. The docType/column assertions read
// documentSpecs.ts; the wiring assertions still read the page files.
const ds = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/documentSpecs.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// ── Engine ────────────────────────────────────────────────────────────────
ok('engine: printDocument is exported', () => assert.match(pd, /export function printDocument\(/));
ok('engine: escapes user-supplied text (no HTML injection)', () => {
  assert.match(pd, /replace\(\/&\/g, '&amp;'\)/);
  assert.match(pd, /replace\(\/</);
});
ok('engine: opens a window and prints', () => {
  assert.match(pd, /window\.open\(/);
  assert.match(pd, /\.print\(\)/);
});

// ── Purchase Orders: PO + GRN ───────────────────────────────────────────────
ok('PO page imports the engine', () => assert.match(po, /import \{ printDocument \} from '\.\.\/\.\.\/lib\/printDocument'/));
ok('PO page prints a PURCHASE ORDER', () => {
  assert.match(ds, /docType: 'PURCHASE ORDER'/);     // A234: literal lives in the shared spec builder
  assert.match(po, /onClick=\{\(\) => printPO\(selected\)\}/);
});
ok('PO page prints a GOODS RECEIVED NOTE after receiving', () => {
  assert.match(ds, /docType: 'GOODS RECEIVED NOTE'/);
  assert.match(po, /submitGRN\(true\)/);           // "Confirm & Print GRN"
  assert.match(po, /if \(alsoPrint && grn\?\.grn_number\) printGRN\(/);
});

// ── Transfers: despatch note ────────────────────────────────────────────────
// A608 (2026-10-29): the web manager portal is retired — its checks are gone; 
// the manager tab's print wiring (printTransferNote / printReceivedNote / submitTransfer(true)) lived in
// ManagerReceivingTab.tsx. The shared spec and the dashboard's Stock › Transfers page wiring are still pinned.
ok('Transfers page prints a STOCK TRANSFER NOTE / TRANSFER RECEIVED NOTE through the shared spec', () => {
  assert.match(tp, /import \{ printDocument \} from '\.\.\/\.\.\/lib\/printDocument'/);
  assert.match(tp, /printDocument\(transferDocSpec\(/);
  assert.match(ds, /docType: i\.received \? 'TRANSFER RECEIVED NOTE' : 'STOCK TRANSFER NOTE'/);
  assert.match(ds, /\{ label: 'Variance', align: 'right' \}/);   // A234: column in the shared spec
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
