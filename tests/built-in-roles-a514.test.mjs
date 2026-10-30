// A514 — the built-in roles. Owner, 2026-10-16: "Supervisor, Waiter, Kitchen, Storekeeper and any other that a good system
// should have" — with Accountant (reads the books) and Fuel attendant (fuel businesses only). One place defines them
// (packages/core/src/permissions.ts BUILT_IN_ROLES); a NEW business gets them with exactly those keys (both sign-up paths seed
// lib/defaultRolePermissions.ts seededRoleRows + seedDefaultRolePermissions); migration 142 adds them to existing businesses
// (scripts/test-migration-142.mjs).
//
//   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/built-in-roles-a514.test.mjs
//
// RUNS the shared catalogue and the COMPILED seeder over the in-memory database (tests/lib-memdb.mjs) — the exact rows a
// new business is created with.
//
// MUTATIONS TO CONFIRM BITE: Fuel attendant without `types` → "a restaurant gets no Fuel attendant" fails; staff.view or
// customers.credit added to the Waiter → "Waiter" fails; orders.create given to the Kitchen → "Kitchen" fails; a route
// back to ['owner', 'manager', 'cashier'] → "both sign-up paths" fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/defaultRolePermissions.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= 'test-only-secret-test-only-secret';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const P = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const seeder = require(path.join(DIST, 'lib/defaultRolePermissions.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const keysOf = (name) => [...new Set(P.BUILT_IN_ROLES.find((r) => r.name === name).keys)];
const sorted = (a) => [...a].sort();

console.log('\nA514 — built-in roles\n');

await ok('every built-in role is made of catalogue keys only (never a broad / legacy key)', () => {
  for (const r of P.BUILT_IN_ROLES) for (const k of r.keys) assert.ok(P.isPermissionKey(k) && !P.isLegacyKey(k), `${r.name}: ${k}`);
  assert.deepEqual(P.BUILT_IN_ROLES.map((r) => r.name),
    ['Manager', 'Cashier', 'Supervisor', 'Waiter', 'Kitchen', 'Storekeeper', 'Accountant', 'Fuel attendant',
      // A550: added by migration 159 (tests/partner-roles-a550.test.mjs)
      'General Manager', 'Operations Manager', 'Finance Manager', 'Auditor', 'Kitchen Manager']);
});
await ok('Manager and Cashier are the catalogue\'s own manager / cashier defaults (as before A514)', () => {
  assert.deepEqual(sorted(keysOf('Manager')), sorted(P.defaultKeysFor('manager')));
  assert.deepEqual(sorted(keysOf('Cashier')), sorted(P.defaultKeysFor('cashier')));
});
await ok('Supervisor: sells like a cashier, approves voids / refunds / credit / drawers, sales and shift reports — no settings, staff, roles, costs, stock', () => {
  const k = keysOf('Supervisor');
  for (const x of [...P.defaultKeysFor('cashier'), 'sales.void', 'sales.refund', 'customers.credit', 'shifts.confirm', 'shifts.cash_movements',
    'sales.history_all', 'reports.sales', 'reports.shifts']) assert.ok(k.includes(x), x);
  assert.ok(!k.some((x) => /^(settings|staff)\./.test(x) || ['menu.costs', 'reports.costs', 'inventory.adjust', 'menu.edit', 'menu.prices'].includes(x)), k.join(' '));
});
await ok('Waiter: sells, sends to the kitchen, discounts — NO staff list, NO customer credit, no refunds, no reports, nothing back office', () => {
  const k = keysOf('Waiter');
  for (const x of ['orders.create', 'sales.discount']) assert.ok(k.includes(x), x);
  for (const x of ['staff.view', 'customers.credit', 'sales.refund', 'sales.void']) assert.ok(!k.includes(x), x);
  assert.ok(!k.some((x) => x.startsWith('reports.')));
  assert.equal(P.isBackOffice(k), false, 'a Waiter lands on the POS');
});
await ok('Kitchen: the menu only — no selling, no money, no customers; lands on the POS side, never the manager screens', () => {
  assert.deepEqual(keysOf('Kitchen'), ['products.view']);
  assert.equal(P.isBackOffice(keysOf('Kitchen')), false);
});
await ok('Storekeeper: stock, deliveries, transfers, counts, wastage, costs — not adjust, no selling', () => {
  const k = keysOf('Storekeeper');
  for (const x of ['inventory.view', 'inventory.receive', 'inventory.transfer', 'inventory.count', 'inventory.waste', 'menu.costs']) assert.ok(k.includes(x), x);
  for (const x of ['inventory.adjust', 'orders.create', 'payables.manage']) assert.ok(!k.includes(x), x);
});
await ok('Accountant: every read-only report (costs, tax, exports), orders, expenses list — no selling, no edits, no settings, no staff', () => {
  const k = keysOf('Accountant');
  const reports = P.PERMISSIONS.filter((p) => p.group === 'reports').map((p) => p.key);
  for (const x of [...reports, 'expenses.view', 'orders.view_all']) assert.ok(k.includes(x), x);
  // A518: and the supplier bills read-only (payables.view) — never payables.manage (paying them).
  for (const x of k) assert.ok(x.startsWith('reports.') || ['expenses.view', 'orders.view_all', 'payables.view'].includes(x), `not read-only: ${x}`);
  assert.ok(k.includes('payables.view') && !k.includes('payables.manage'));
});
await ok('Fuel attendant: pump sales and the pumps — only at a fuel business; no refunds, no reports', () => {
  assert.deepEqual(sorted(keysOf('Fuel attendant')), ['fuel.manage', 'orders.create', 'products.view']);
  assert.equal(P.isBackOffice(keysOf('Fuel attendant')), false);
  assert.ok(P.builtInRolesFor('petrol_station').some((r) => r.name === 'Fuel attendant'));
  for (const t of ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'other', null]) {
    assert.ok(!P.builtInRolesFor(t).some((r) => r.name === 'Fuel attendant'), String(t));
  }
});
await ok('the till / web routing (A499 isBackOffice): Waiter, Kitchen, Fuel attendant on the POS; Supervisor, Storekeeper, Accountant back office', () => {
  for (const n of ['Waiter', 'Kitchen', 'Fuel attendant', 'Cashier']) assert.equal(P.isBackOffice(keysOf(n)), false, n);
  for (const n of ['Supervisor', 'Storekeeper', 'Accountant', 'Manager']) assert.equal(P.isBackOffice(keysOf(n)), true, n);
});
await ok('defaultKeysForRoleName: the owner\'s role everything, a built-in its keys (any case / spaces), anything else nothing', () => {
  assert.deepEqual(sorted(P.defaultKeysForRoleName('Admin')), sorted(P.PERMISSION_KEYS));
  assert.deepEqual(sorted(P.defaultKeysForRoleName('owner')), sorted(P.PERMISSION_KEYS));
  assert.deepEqual(sorted(P.defaultKeysForRoleName(' fuel_attendant ')), sorted(keysOf('Fuel attendant')));
  assert.deepEqual(sorted(P.defaultKeysForRoleName('WAITER')), sorted(keysOf('Waiter')));
  assert.deepEqual(sorted(P.defaultKeysForRoleName('Branch Manager')), sorted(keysOf('Manager')));
  assert.deepEqual(P.defaultKeysForRoleName('Head chef'), []);
});

for (const [path_, owner, type] of [['routes/admin.ts', 'owner', 'petrol_station'], ['routes/onboarding.ts', 'Admin', 'restaurant']]) {
  await ok(`a NEW business (${path_}, ${type}) is created with its built-in roles and exactly their default keys`, async () => {
    // The live catalogue (registered at boot, lib/permissionCatalogue.ts) — every key has its row and id.
    mem.db = { roles: [], role_permissions: [], permissions: P.PERMISSION_KEYS.map((key, i) => ({ id: `perm-${i}`, key })) };
    const B = 'b-new';
    const rows = seeder.seededRoleRows(B, owner, type);
    const roles = rows.map((r, i) => ({ id: `role-${i}`, ...r }));
    mem.db.roles.push(...roles);
    await seeder.seedDefaultRolePermissions(roles);
    const want = [owner, ...P.builtInRolesFor(type).map((r) => r.name)];
    assert.deepEqual(roles.map((r) => r.name), want);
    assert.ok(roles.every((r) => r.is_default === true && r.business_id === B));
    const keyOf = new Map(mem.db.permissions.map((p) => [p.id, p.key]));
    for (const r of roles) {
      const got = sorted(mem.db.role_permissions.filter((x) => x.role_id === r.id).map((x) => keyOf.get(x.permission_id)));
      const exp = r.name === owner ? sorted(P.PERMISSION_KEYS) : sorted(keysOf(r.name));
      assert.deepEqual(got, exp, r.name);
      if (r.name !== owner) assert.equal(r.description, P.BUILT_IN_ROLES.find((b) => b.name === r.name).description);
    }
    assert.equal(roles.some((r) => r.name === 'Fuel attendant'), type === 'petrol_station');
  });
}
await ok('both sign-up paths seed seededRoleRows(business, owner role, type) — never a hand-kept list', () => {
  const a = read('apps/server/src/routes/admin.ts'), o = read('apps/server/src/routes/onboarding.ts');
  assert.match(a, /\.insert\(seededRoleRows\(business\.id, 'owner', normalizedType\)\)/);
  assert.match(o, /\.insert\(seededRoleRows\(business\.id, 'Admin', normalizedType\)\)/);
  for (const s of [a, o]) assert.doesNotMatch(s, /\['(owner|Admin)', '(manager|Manager)', '(cashier|Cashier)'\]/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
