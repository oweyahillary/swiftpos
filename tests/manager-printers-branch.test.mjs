/**
 * manager-printers-branch.test.mjs — A238 source guards (rule 24), mutation-checkable.
 * A manager (no branch selector) can open Printer Setup: PrintersPage takes a
 * branchId prop and the manager passes its session branch, so it no longer sticks
 * on "Select a branch".
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pp = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/settings/PrintersPage.tsx'), 'utf8');
const md = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

ok('PrintersPage accepts a branchId prop', () => {
  assert.match(pp, /function PrintersPage\(\{ branchId: propBranchId/);
});
ok('the passed branchId is preferred over the (owner-only) BranchContext', () => {
  assert.match(pp, /const branchId = propBranchId \?\? activeBranchId/);
});
ok('the manager passes its session branch', () => {
  assert.match(md, /<PrintersPage branchId=\{session\.branchId\} branchName=\{session\.branchName\} \/>/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
