/**
 * manager-portal-2026-09-05.test.mjs — three manager-portal fixes found in the
 * 2026-09-05 owner-run browser reverify. Source-level (rule 24: pins the code
 * shape, not the browser behaviour), mutation-checkable.
 *
 *   A214 — Staff/Printers hung on "Syncing branch…": the branch-sync effect must
 *          set branchSynced from the SESSION, not gate it behind the branches list.
 *   A216 — Reports required clicking Apply: DateBar must debounce-auto-apply.
 *   A217 — Reports > Shifts showed "Unknown": the client read `staff_name` but the
 *          server sends `cashier_name` (cashier_id resolves fine — proven by query).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), 'utf8');
const rep = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerReportsPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

// ── A214 ────────────────────────────────────────────────────────────────────
ok('A214: branch-sync no longer early-returns on an empty branches list', () => {
  const effect = /Sync BranchContext[\s\S]*?\}, \[session\?\.branchId, branches\]\); \/\/ eslint-disable-line/.exec(md);
  assert.ok(effect, 'branch-sync effect not found');
  assert.doesNotMatch(effect[0], /!branches\.length/,
    'the effect must not bail when the branches list is empty (that is the hang)');
});
ok('A214: setActiveBranch stays conditional, but branchSynced is set unconditionally', () => {
  assert.match(md, /if \(myBranch\) setActiveBranch\(myBranch\);/,
    'activeBranch should still sync only when the full branch object is found');
  const effect = /Sync BranchContext[\s\S]*?\}, \[session\?\.branchId, branches\]\)/.exec(md)[0];
  // setBranchSynced(true) must NOT be trapped inside the `if (myBranch)` block.
  assert.doesNotMatch(effect, /if \(myBranch\) \{[^}]*setBranchSynced/,
    'branchSynced must not depend on the branch being present in the list');
  assert.match(effect, /\n\s*setBranchSynced\(true\);/, 'branchSynced(true) must be set in the effect');
});

// ── A216 ────────────────────────────────────────────────────────────────────
ok('A216: DateBar debounce-auto-applies (no need to click Apply)', () => {
  assert.match(rep, /import \{[^}]*useRef[^}]*\} from 'react';/, 'useRef must be imported');
  const bar = /function DateBar\([\s\S]*?const presets = \[/.exec(rep);
  assert.ok(bar, 'DateBar head not found');
  assert.match(bar[0], /firstRun\.current/, 'must skip the initial mount');
  assert.match(bar[0], /setTimeout\(\(\) => onApply\(\), \d+\)/, 'must debounce-call onApply');
  assert.match(bar[0], /if \(!from \|\| !to\) return;/, 'must guard against empty/partial dates');
});

// ── A217 ────────────────────────────────────────────────────────────────────
ok('A217: ShiftRow reads cashier_name (the field the server sends), not staff_name', () => {
  const iface = /interface ShiftRow \{[\s\S]*?\}/.exec(rep)[0];
  assert.match(iface, /cashier_name: string \| null;/, 'ShiftRow must declare cashier_name');
  assert.doesNotMatch(iface, /staff_name/, 'ShiftRow must not declare staff_name (server sends cashier_name)');
  assert.match(rep, /\{r\.cashier_name \?\? 'Unknown'\}/, 'the shift row must render cashier_name');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
