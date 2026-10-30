/**
 * grn-note-and-date.test.mjs — A229 + A230 source guards (rule 24), mutation-checkable.
 * A229: the GRN receive carries a note (sent to the server) and can print (A608: pinned on the Purchase orders page —
 *       the manager portal's receive tab is retired).
 * A230: fmtDate handles full ISO timestamps and never renders "Invalid Date" (A471: now lib/format's dateShort).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const po = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// ── A229 ──────────────────────────────────────────────────────────────────
// A608 (2026-10-29): the web manager portal is retired — its checks are gone; 
// A229 pinned the manager's GRN receive (ManagerReceivingTab.tsx). The same three properties are pinned below on the
// dashboard's Stock › Purchase orders page, where a delivery is received now.
ok('A229: the GRN receive has a note field (Purchase orders page)', () => {
  assert.match(po, /const \[grnNotes, setGrnNotes\]/);
  assert.match(po, /value=\{grnNotes\} onChange=\{e => setGrnNotes/);
});
ok('A229: the note is sent to the server on receipt (Purchase orders page)', () => {
  assert.match(po, /api\.post<\{ grn_number: string \}>\('\/api\/stock\/grn', \{[\s\S]*?notes: grnNotes \|\| undefined/);
});
ok('A229: Confirm & print the GRN (Purchase orders page)', () => {
  assert.match(po, /submitGRN\(true\)/);
  assert.match(po, /const printGRN = /);
  assert.match(po, /printDocument\(grnDocSpec\(/);
});

// ── A230 ──────────────────────────────────────────────────────────────────
// A471: the page's own fmtDate moved to lib/format's dateShort — same meaning, pinned there (and run in tests/format.test.mjs).
const fmtLib = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/format.ts'), 'utf8');
ok('A230: the PO page dates go through dateShort (lib/format), no local fmtDate', () => {
  assert.match(po, /import \{[^}]*\bdateShort\b[^}]*\} from '\.\.\/\.\.\/lib\/format';/);
  assert.match(po, /dateShort\(po\.order_date\)/);
  assert.match(po, /dateShort\(g\.created_at\)/);   // a full GRN timestamp
  assert.ok(!/function fmtDate\(/.test(po), 'no local fmtDate left');
});
ok('A230: dateShort handles full timestamps (not just date-only)', () => {
  assert.match(fmtLib, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(v\) \? new Date\(`\$\{v\}T00:00:00`\)\s*: new Date\(v\)/);
});
ok('A230: dateShort never renders Invalid Date', () => {
  assert.match(fmtLib, /return Number\.isNaN\(d\.getTime\(\)\) \? null : d;/);
  assert.match(fmtLib, /return d \? d\.toLocaleDateString\(LOCALE, \{ day: 'numeric', month: 'short', year: 'numeric' \}\) : empty;/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
