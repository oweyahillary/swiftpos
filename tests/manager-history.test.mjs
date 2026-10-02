/**
 * manager-history.test.mjs — A227 source guards (rule 24), mutation-checkable.
 * A branch manager has a read-only history of deliveries received (GRNs) and
 * transfers (in/out, scoped to their branch), each re-printable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const h  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerHistoryTab.tsx'), 'utf8');
const md = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

ok('history fetches deliveries (GRNs, branch-scoped) and transfers', () => {
  assert.match(h, /\/api\/stock\/grn\$\{branchId \? `\?branch_id=\$\{branchId\}` : ''\}/);
  assert.match(h, /posApi\.get<TRow\[\]>\('\/api\/stock\/transfers'\)/);
});
ok('transfers are scoped to the manager\'s own branch (in or out)', () => {
  assert.match(h, /x\.from_branch_id === branchId \|\| x\.to_branch_id === branchId/);
});
ok('both document types are re-printable from history', () => {
  assert.match(h, /const printGRN = /);
  assert.match(h, /const printTransfer = /);
  assert.match(h, /import \{ grnDocSpec, transferDocSpec \}/);
});
ok('a History nav item exists, gated on inventory.receive', () => {
  assert.match(md, /key: 'history',[\s\S]*?permission: 'inventory\.receive'/);
});
ok('the History tab renders ManagerHistoryTab', () => {
  assert.match(md, /case 'history':\s*return <ManagerHistoryTab currency=\{currency\} \/>;/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
