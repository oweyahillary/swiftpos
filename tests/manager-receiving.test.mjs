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
// A490: a new business's manager defaults are the shared catalogue's (`manager: true` per key; defaultKeysFor('manager')),
// seeded by apps/server/src/lib/defaultRolePermissions.ts — MANAGER_DENY is gone.
const catalogue = fs.readFileSync(path.join(root, 'packages/core/src/permissions.ts'), 'utf8');
const seeder = fs.readFileSync(path.join(root, 'apps/server/src/lib/defaultRolePermissions.ts'), 'utf8');
const managerGets = (key) => new RegExp(`key: '${key.replace('.', '\.')}',[^\n]*manager: true`).test(catalogue);

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

ok('permission model: managers are denied adjust/edit, keep receive', () => {
  // A514: the built-in roles' defaults (shared BUILT_IN_ROLES — the Manager's are the catalogue's manager flags).
  assert.match(seeder, /defaultKeysForRoleName\(r\.name\)/, 'the seeder grants the catalogue defaults');
  assert.match(catalogue, /\{ name: 'Manager', description: '[^']*', keys: MANAGER_DEFAULT_KEYS \}/, 'the Manager is the catalogue manager defaults');
  assert.ok(!managerGets('inventory.adjust'), 'a new manager must not get inventory.adjust');
  assert.ok(!managerGets('ingredients.manage'), 'a new manager must not get ingredients.manage');
  assert.ok(managerGets('inventory.receive') && managerGets('inventory.transfer'), 'receive/transfer must remain granted to managers');
});

// A608 (2026-10-29): the web manager portal is retired — its checks are gone; 
// the Receiving tab (ManagerReceivingTab.tsx) and its nav item are gone. The permission model above still holds;
// receiving now happens on the dashboard's Stock pages (purchase orders / transfers).
// A608 part 3 (owner, 2026-10-30): the transfer's line-by-line receive step is back, on Stock › Transfers, shown to whoever
// sees Transfers (inventory.transfer — the dashboard menu); the cloud keeps receiving to the receiving branch.
const transfersPage = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/stock/StockTransfersPage.tsx'), 'utf8');
const layout = fs.readFileSync(path.join(root, 'apps/dashboard/src/components/DashboardLayout.tsx'), 'utf8');
const stock = fs.readFileSync(path.join(root, 'apps/server/src/routes/stock.ts'), 'utf8');
ok('A608: a manager receives a transfer on the dashboard, line by line', () => {
  assert.match(layout, /'\/dashboard\/stock\/transfers':\s+\['inventory\.transfer'\]/);
  assert.match(transfersPage, /data-testid="transfer-receive"/);
  assert.match(transfersPage, /\{t\.status === 'in_transit' && \(/, 'only a transfer on its way');
  assert.ok(managerGets('inventory.transfer'));
  const h = /router\.patch\('\/transfers\/:id\/status'[\s\S]*?\n\}\);/.exec(stock)?.[0] ?? '';
  assert.match(h, /status === 'received' && !assertBranchAccess\(req, transfer\.to_branch_id\)/, 'only the receiving branch (NOT_DESTINATION)');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
