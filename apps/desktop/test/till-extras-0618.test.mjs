/**
 * till-extras-0618.test.mjs — desktop 0.6.18: A279 (the POS says which filter it shows), A341 (a manager adds an
 * expense type from the till), A357 (VAT once on the Overview).
 *
 *   node test/till-extras-0618.test.mjs
 *
 * RUNS the real src/renderer/lib/posFilter.ts and lib/expenseTypes.ts (type-stripped), then pins the screens and the
 * IPC channel that use them (React is not run here).
 *
 * MUTATIONS TO CONFIRM BITE: filterSummary returning a line for "All, no search" → its check fails; checkTypeName
 * comparing case-sensitively → "an existing type in other capitals" fails; the ShiftPanel button not gated on
 * canAddExpenseType → its pin fails; `hideVat` dropped from a layout → the Overview pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.TILL_0618_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, TILL_0618_TS: '1' } });
  process.exit(r.status ?? 1);
}
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = await import(pathToFileURL(path.join(DESKTOP, 'src/renderer/lib/posFilter.ts')).href);
const X = await import(pathToFileURL(path.join(DESKTOP, 'src/renderer/lib/expenseTypes.ts')).href);
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

// ── A279 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('A279: no line while the grid shows everything (All, no search)', () => {
  assert.equal(F.filterSummary({ categoryName: null, search: '', count: 68 }), null);
  assert.equal(F.filterSummary({ categoryName: null, search: '   ', count: 68 }), null);
});
ok('A279: a category, a search, or both are named, with the count', () => {
  assert.equal(F.filterSummary({ categoryName: 'Soft Drinks', search: '', count: 6 }), 'Showing Soft Drinks — 6 items');
  assert.equal(F.filterSummary({ categoryName: null, search: ' coke ', count: 1 }), 'Showing "coke" — 1 item');
  assert.equal(F.filterSummary({ categoryName: 'Soft Drinks', search: 'coke', count: 0 }), 'Showing Soft Drinks · "coke" — 0 items');
});
ok('A279: an empty grid says a filter is hiding things, so Clear is the fix', () => {
  assert.equal(F.emptyGridMessage({ categoryName: 'Burgers', search: 'xyz', count: 0 }), 'Nothing matches this filter.');
  assert.equal(F.emptyGridMessage({ categoryName: null, search: '', count: 0 }), 'No products found');
});
const pos = read('src/renderer/pages/POSPage.tsx');
ok('A279: POSPage shows the line and one Clear that restores All and empties the search', () => {
  assert.match(pos, /const gridFilterSummary = filterSummary\(gridFilter\);/);
  assert.match(pos, /const clearGridFilter = \(\) => \{ setActiveCategory\('all'\); setSearch\(''\); \};/);
  assert.match(pos, /\{gridFilterSummary && \(\s*<div data-testid="grid-filter"/);
  assert.match(pos, /\{emptyGridMessage\(gridFilter\)\}/);
});

// ── A341 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('A341: only expenses.manage (managers, owner) may add a type — never a cashier', () => {
  assert.equal(X.mayAddExpenseType({ permissions: { '*': true } }), true);
  assert.equal(X.mayAddExpenseType({ permissions: { 'expenses.manage': true } }), true);
  assert.equal(X.mayAddExpenseType({ permissions: { 'orders.create': true, 'expenses.view': true } }), false);
  assert.equal(X.mayAddExpenseType(null), false);
});
ok('A341: a name is tidied; empty or too long is refused', () => {
  assert.deepEqual(X.checkTypeName('  Gas   refill ', []), { ok: true, name: 'Gas refill' });
  assert.equal(X.checkTypeName('   ', []).ok, false);
  assert.equal(X.checkTypeName('x'.repeat(61), []).ok, false);
});
ok('A341: an existing type in other capitals is selected, never duplicated', () => {
  assert.deepEqual(X.checkTypeName('gas REFILL', [{ id: 'c1', name: 'Gas Refill' }]), { ok: 'exists', id: 'c1', name: 'Gas Refill' });
});
ok('A341: the till saves it on the cloud through manageFetch (offline / role messages), validated IPC', () => {
  const h = fs.readFileSync(path.join(DESKTOP, 'src/main/ipcHandlers.ts'), 'utf8');
  assert.match(h, /handle\('expense:addCategory', async \(_e, \{ name \}: \{ name: string \}\) =>\s+manageFetch\('\/api\/expenses\/categories', 'POST', \{ name: String\(name \?\? ''\)\.trim\(\) \}\)\);/);
  assert.match(fs.readFileSync(path.join(DESKTOP, 'src/main/ipcSchemas.ts'), 'utf8'), /'expense:addCategory': \{ name: \{ t: 'string', min: 1 \} \}/);
  assert.match(fs.readFileSync(path.join(DESKTOP, 'src/main/preload.ts'), 'utf8'), /addCategory: \(name: string\) => ipcRenderer\.invoke\('expense:addCategory', \{ name \}\)/);
});
ok('A341: the Shift panel shows "+ Add type" only to those who may, and selects the new type', () => {
  const sp = read('src/renderer/pages/ShiftPanel.tsx');
  assert.match(sp, /\{canAddExpenseType && !addingType && \(/);
  assert.match(sp, /\{canAddExpenseType && addingType && \(/);
  assert.match(sp, /const created = await posApi\.expense\.addCategory\(check\.name\);/);
  assert.match(sp, /setExpCatId\(created\.id\);/);
  assert.match(read('src/renderer/App.tsx'), /canAddExpenseType=\{mayAddExpenseType\(staff\)\}/);
  assert.match(pos, /canAddExpenseType=\{canAddExpenseType\}/);
});

// ── A357 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
ok('A357: VAT shown once — the strip hides VAT where a "VAT collected" box sits above, and hides itself when empty', () => {
  const mp = read('src/renderer/pages/ManagerPage.tsx');
  assert.equal((mp.match(/<MoneyStrip s=\{s\} currency=\{currency\} hideVat \/>/g) || []).length, 2);
  assert.equal((mp.match(/KpiCard label="VAT collected"/g) || []).length, 2);
  assert.match(mp, /\{!hideVat && item\('VAT', s\.totalVat \?\? 0\)\}/);
  assert.match(mp, /if \(hideVat && !extras\) return null;/);
  assert.match(mp, /<MoneyStrip s=\{sales\?\.summary\} currency=\{currency\} \/>/, 'the layout without a VAT box keeps VAT in its strip');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
