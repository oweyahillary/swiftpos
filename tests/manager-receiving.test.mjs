/**
 * manager-receiving.test.mjs — manager web-POS stock receiving (A205, slice 1: transfers).
 *
 * Managers RECEIVE stock but never adjust/edit it (defaultRolePermissions denies
 * inventory.adjust/ingredients.manage). The manager dashboard had no receive UI at
 * all — the Overview even pointed to a non-existent "receive it in Inventory". This
 * adds a Receiving tab that marks incoming (in-transit, to-this-branch) transfers as
 * received, gated on the inventory.transfer permission managers already hold.
 *
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tab = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx'), 'utf8');
const mgr = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), 'utf8');
const perms = fs.readFileSync(path.join(root, 'apps/server/src/lib/defaultRolePermissions.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

ok('permission model: managers are denied adjust/edit, keep receive', () => {
  assert.match(perms, /inventory\.adjust/, 'MANAGER_DENY must list inventory.adjust');
  assert.match(perms, /ingredients\.manage/, 'MANAGER_DENY must list ingredients.manage');
  // receive/transfer are NOT in the deny set (granted to managers) — assert they aren't added to MANAGER_DENY
  const denyBlock = perms.slice(perms.indexOf('MANAGER_DENY'), perms.indexOf('MANAGER_DENY') + 400);
  assert.doesNotMatch(denyBlock, /inventory\.receive|inventory\.transfer/, 'receive/transfer must remain granted to managers');
});

ok('tab: receives only IN-TRANSIT transfers heading to this branch', () => {
  assert.match(tab, /t\.to_branch_id === branchId && t\.status === 'in_transit'/,
    'incoming = to this branch AND in transit');
  assert.match(tab, /posApi\.patch\(`\/api\/stock\/transfers\/\$\{t\.id\}\/status`, \{ status: 'received' \}\)/,
    'Mark received must PATCH status=received');
});

ok('tab: gated on inventory.transfer (receive, not edit — no adjust anywhere)', () => {
  assert.match(tab, /hasPermission\('inventory\.transfer'\)/, 'must gate on inventory.transfer');
  const muts = tab.match(/posApi\.(post|patch|put|delete)\(/g) || [];
  assert.strictEqual(muts.length, 1, `the receive tab must make exactly ONE mutating call (the receive); found ${muts.length} — no adjust/edit`);
});

ok('dashboard: Receiving nav item + group + render, gated on inventory.receive', () => {
  assert.match(mgr, /key: 'receiving',[\s\S]*?permission: 'inventory\.receive'[\s\S]*?group: 'Inventory'/,
    'a Receiving nav item, gated on inventory.receive, in the Inventory group');
  assert.match(mgr, /case 'receiving': return <ManagerReceivingTab/, 'the switch must render the receiving tab');
  assert.match(mgr, /receive it in Receiving/, 'the Overview must point to Receiving (broken promise fixed)');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
