/**
 * transfer-received-qty.test.mjs — A221 source guards (rule 24), mutation-checkable.
 * Server: the transfer receive books the RECEIVED quantity (0..sent), persists it,
 *         and stores a receipt note — it no longer blind-applies the sent lines.
 * UI: (the manager portal's receive form — retired with the web manager portal, A608 2026-10-29). A608 part 3 (owner,
 *     2026-10-30): the same receive step is back on the dashboard — Stock › Transfers' "Mark received" opens it: each line
 *     sent and received (received starts at sent, 0..sent), a note, received_items + receipt_note sent, a printed note.
 *     The rule is RUN (apps/dashboard/src/lib/transferReceipt.ts); the page's wiring pinned by source.
 * Mutation (made, failed, put back): receiptLines accepting more than sent → "0..sent, line by line" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = fs.readFileSync(path.join(root, 'apps/server/src/routes/stock.ts'), 'utf8');

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

// A608 (2026-10-29): the web manager portal is retired — its checks are gone; 
// the UI half pinned the manager receive form (ManagerReceivingTab.tsx). The server half above still holds.

// ── A608 part 3: the receive step on the dashboard (Stock › Transfers) ─────────────────────────────────────────────
const RX = await import(pathToFileURL(path.join(root, 'apps/dashboard/src/lib/transferReceipt.ts')).href);
const page = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/StockTransfersPage.tsx'), 'utf8');
const ITEMS = [{ product_id: 'p1', quantity: 10, name: 'Rice 1kg' }, { product_id: 'p2', quantity: '4', name: 'Oil 1L' }];
ok('A608 UI: received starts at what was sent', () => {
  assert.deepEqual(RX.receiptSeed(ITEMS), { p1: '10', p2: '4' });
});
ok('A608 UI: 0..sent, line by line — less is recorded, more / below 0 / a word / empty refused with the line named', () => {
  assert.deepEqual(RX.receiptLines(ITEMS, { p1: '8', p2: '0' }), { ok: true, received_items: [{ product_id: 'p1', quantity_received: 8 }, { product_id: 'p2', quantity_received: 0 }] });
  assert.deepEqual(RX.receiptLines(ITEMS, { p1: '10', p2: '4' }).ok, true, 'all of it');
  assert.deepEqual(RX.receiptLines(ITEMS, { p1: '2.5', p2: '4' }).ok, true, 'a weighed item');
  for (const bad of [{ p1: '11', p2: '4' }, { p1: '-1', p2: '4' }, { p1: 'ten', p2: '4' }, { p1: '', p2: '4' }, { p2: '4' }]) {
    const r = RX.receiptLines(ITEMS, bad);
    assert.equal(r.ok, false, JSON.stringify(bad)); assert.match(r.error, /^Rice 1kg: received must be between 0 and 10 \(sent\)\.$/);
  }
  assert.match(RX.receiptLines(ITEMS, { p1: '1', p2: '5' }).error, /^Oil 1L: .* 0 and 4/);
});
ok('A608 UI: "Mark received" opens the step (no longer receives everything sent in one go)', () => {
  assert.match(page, /const markReceived = \(t: Transfer\) => \{\s*setRxLines\(receiptSeed\(/);
  assert.doesNotMatch(page, /void advance\(t, 'received'\)/);
  assert.match(page, /onClick=\{\(\) => markReceived\(t\)\}/);
});
ok('A608 UI: the step validates, then sends status received + received_items + receipt_note', () => {
  assert.match(page, /const lines = receiptLines\(/);
  assert.match(page, /if \(lines\.ok === false\) \{ setRxError\(lines\.error\); return; \}/);
  assert.match(page, /status: 'received', received_items: lines\.received_items, receipt_note: note \|\| undefined,/);
  assert.match(page, /data-testid="transfer-received-qty"/); assert.match(page, /min=\{0\} max=\{it\.quantity\}/);
  assert.match(page, /data-testid="transfer-receipt-note"/);
});
ok('A608 UI: Confirm & print — the printed received note with what arrived; the despatcher override as before (A203)', () => {
  assert.match(page, /if \(alsoPrint\) \{[\s\S]*?printReceivedNote\(t, byId, note\);/);
  assert.match(page, /status: 'received', received: true,/);
  assert.match(page, /\.\.\.\(rxSameUser \? \{ allow_same_user: true \} : \{\}\)/);
  assert.match(page, /if \(e\?\.code === 'same_user_receipt' && !rxSameUser\)/);
  assert.match(page, /<span>\{words\.product\}<\/span>/, 'the business\'s word for an item');
  assert.doesNotMatch(page, /\btill\b/i);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
