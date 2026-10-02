/**
 * transfer-received-qty.test.mjs — A221 source guards (rule 24), mutation-checkable.
 * Server: the transfer receive books the RECEIVED quantity (0..sent), persists it,
 *         and stores a receipt note — it no longer blind-applies the sent lines.
 * UI: the manager receive form sends received_items + receipt_note, caps each input
 *     at the sent quantity, and shows sent as a read-only figure.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = fs.readFileSync(path.join(root, 'apps/server/src/routes/stock.ts'), 'utf8');
const ui  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// isolate the transfer /status handler
const handler = /router\.patch\('\/transfers\/:id\/status'[\s\S]*?\n\}\);/.exec(srv);
ok('found the transfer /status handler', () => assert.ok(handler));
const H = handler ? handler[0] : '';

// ── Server ──────────────────────────────────────────────────────────────────
ok('A221 server: reads received_items + receipt_note from the body', () => {
  assert.match(srv, /const \{ status, reason, allow_same_user, received_items, receipt_note \} = req\.body;/);
});
ok('A221 server: validates received is 0..sent (rejects invalid_received_qty)', () => {
  assert.match(H, /invalid_received_qty/);
  assert.match(H, /rl\.quantity < 0 \|\| rl\.quantity > sent/);
});
ok('A221 server: books the RECEIVED lines (toBook), not the raw sent lines', () => {
  assert.match(H, /const toBook = receivedLines\.filter\(l => l\.quantity > 0\);/);
  assert.match(H, /applyProductStockIn\(toBook,/);
  assert.doesNotMatch(H, /applyProductStockIn\(lines,\s*transfer\.to_branch_id/);
});
ok('A221 server: persists quantity_received per line + receipt_note', () => {
  assert.match(H, /\.update\(\{ quantity_received: rl\.quantity \}\)/);
  assert.match(H, /patch\.receipt_note = String\(receipt_note\)\.trim\(\);/);
});

// ── UI ──────────────────────────────────────────────────────────────────────
ok('A221 UI: receive sends received_items + receipt_note', () => {
  assert.match(ui, /status: 'received', received_items, receipt_note:/);
  assert.match(ui, /quantity_received: Number\(rxLines\[it\.product_id\] \|\| 0\)/);
});
ok('A221 UI: each received input is capped at the sent quantity', () => {
  assert.match(ui, /max=\{it\.quantity\}/);
});
ok('A221 UI: sent quantity is shown read-only (no input bound to it)', () => {
  // the sent figure renders as text; the editable input is bound to rxLines, not quantity
  assert.match(ui, /\{it\.quantity\}<\/span>/);
  assert.doesNotMatch(ui, /value=\{[^}]*it\.quantity[^}]*\}[^/]*onChange/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
