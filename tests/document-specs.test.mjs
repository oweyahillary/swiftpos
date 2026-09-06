/**
 * document-specs.test.mjs — A234. The shared builders are the single home for the
 * PO/GRN/transfer doc shape. These guards (moved here from the callers) pin the
 * doc types, accents, columns, signatures and money format.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ds = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/documentSpecs.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

ok('exports the three builders', () => {
  assert.match(ds, /export function purchaseOrderDocSpec\(/);
  assert.match(ds, /export function grnDocSpec\(/);
  assert.match(ds, /export function transferDocSpec\(/);
});
ok('PO spec: indigo (red when cancelled), correct doc type + signatures', () => {
  assert.match(ds, /docType: 'PURCHASE ORDER'/);
  assert.match(ds, /i\.status === 'cancelled' \? DOC_ACCENT\.cancelled : DOC_ACCENT\.po/);
  assert.match(ds, /signatures: \['Prepared by', 'Approved by'\]/);
});
ok('GRN spec: green accent, Received pill, supports a custom 2nd meta (History branch)', () => {
  assert.match(ds, /docType: 'GOODS RECEIVED NOTE'/);
  assert.match(ds, /accent: DOC_ACCENT\.grn, statusLabel: 'Received'/);
  assert.match(ds, /i\.secondMeta \?\? \{ label: 'Supplier'/);
});
ok('transfer spec: despatch vs received, teal/amber/red accents, variance column', () => {
  assert.match(ds, /i\.received \? 'TRANSFER RECEIVED NOTE' : 'STOCK TRANSFER NOTE'/);
  assert.match(ds, /i\.received \? DOC_ACCENT\.received : \(i\.status === 'cancelled' \? DOC_ACCENT\.cancelled : DOC_ACCENT\.despatch\)/);
  assert.match(ds, /\{ label: 'Variance', align: 'right' \}/);
});
ok('money uses Intl currency style (matches the verified "Ksh" output)', () => {
  assert.match(ds, /new Intl\.NumberFormat\('en-KE', \{ style: 'currency', currency/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
