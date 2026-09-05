/**
 * manager-initiate-transfer.test.mjs — A218 source guards (rule 24), mutation-checkable.
 * Server: POST /transfers requires SOURCE access + a valid in-business DESTINATION
 *         (no longer access to both), so a branch manager can send from their own
 *         branch to another; owners keep any→any via assertBranchAccess.
 * UI: manager create form posts from_branch_id = their own branch (source locked),
 *     picks a destination from the other branches, and can despatch (in_transit).
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

// isolate the create handler (POST /transfers), not the /status one
const create = /router\.post\('\/transfers', requirePermission\('inventory\.transfer'\)[\s\S]*?res\.status\(201\)/.exec(srv);
ok('found the POST /transfers create handler', () => assert.ok(create));
const C = create ? create[0] : '';

// ── Server ──────────────────────────────────────────────────────────────────
ok('A218 server: source-branch access is still required', () => {
  assert.match(C, /if \(!assertBranchAccess\(req, from_branch_id\)\)/);
});
ok('A218 server: destination no longer requires assertBranchAccess (managers can send out)', () => {
  assert.doesNotMatch(C, /assertBranchAccess\(req, to_branch_id\)/);
});
ok('A218 server: destination is validated as a real in-business branch', () => {
  assert.match(C, /\.eq\('id', to_branch_id\)\.eq\('business_id', req\.businessId\)\.maybeSingle\(\)/);
  assert.match(C, /Destination branch not found in this business/);
});

// ── UI ──────────────────────────────────────────────────────────────────────
ok('A218 UI: create posts from the manager\'s OWN branch (source locked)', () => {
  assert.match(ui, /posApi\.post\('\/api\/stock\/transfers', \{ from_branch_id: branchId, to_branch_id: destId, items \}\)/);
});
ok('A218 UI: destination list excludes the manager\'s own branch', () => {
  assert.match(ui, /br\.filter\(b => b\.id !== branchId\)/);
});
ok('A218 UI: only quantities > 0 are sent as items', () => {
  assert.match(ui, /\.filter\(i => i\.quantity > 0\)/);
});
ok('A218 UI: a pending outgoing transfer can be despatched (in_transit)', () => {
  assert.match(ui, /status: 'in_transit'/);
  assert.match(ui, /despatchTransfer/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
