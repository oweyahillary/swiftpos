/**
 * grn-note-and-date.test.mjs — A229 + A230 source guards (rule 24), mutation-checkable.
 * A229: the manager GRN receive carries a note (sent to the server) and can print.
 * A230: fmtDate handles full ISO timestamps and never renders "Invalid Date".
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rx = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx'), 'utf8');
const po = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// ── A229 ──────────────────────────────────────────────────────────────────
ok('A229: manager GRN receive has a note field', () => {
  assert.match(rx, /const \[grnNote, setGrnNote\]/);
  assert.match(rx, /value=\{grnNote\} onChange=\{e => setGrnNote/);
});
ok('A229: the note is sent to the server on receipt', () => {
  assert.match(rx, /posApi\.post<\{ grn_number: string \}>\('\/api\/stock\/grn', \{[\s\S]*?notes: note \|\| undefined/);
});
ok('A229: manager can Confirm & print the GRN', () => {
  assert.match(rx, /submitDelivery\(true\)/);
  assert.match(rx, /const printReceivedGRN = /);
  assert.match(rx, /docType: 'GOODS RECEIVED NOTE'/);
});

// ── A230 ──────────────────────────────────────────────────────────────────
ok('A230: fmtDate handles full timestamps (not just date-only)', () => {
  assert.match(po, /d\.length <= 10 \? d \+ 'T00:00:00' : d/);
});
ok('A230: fmtDate never renders Invalid Date', () => {
  assert.match(po, /isNaN\(dt\.getTime\(\)\) \? '—'/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
