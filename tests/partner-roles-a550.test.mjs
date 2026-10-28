/**
 * partner-roles-a550.test.mjs — A550: the five built-in roles added with partner login (owner, 2026-10-21: "add general
 * manager, ops manager, accountant and any user you feel will be needed"): General Manager, Operations Manager, Finance
 * Manager, Auditor, Kitchen Manager (shared/permissions.ts BUILT_IN_ROLES; migration 159 gives them to every business,
 * scripts/test-migration-159.mjs).
 *
 *   node tests/partner-roles-a550.test.mjs          (build apps/server first — the ceiling and the seeding run from dist/)
 *
 * Write vs view is decided by the CATALOGUE (each key's `view` flag, VIEW_KEYS), never by guessing from a key's name.
 *
 * MUTATIONS TO CONFIRM BITE: a write key added to the Auditor → "holds no write key" fails; payables.manage (or
 * shifts.confirm, reports.costs) added to the Operations Manager → "none of the finance keys" fails; '*' given to the
 * General Manager → "holds no owner-only capability" fails; canAssignRole letting a full-key holder give the owner's role →
 * "can't assign the owner's role" fails; a `view: true` put on menu.edit → "the view keys only show" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/roleCeiling.js'))) {
  console.log('\nCannot load apps/server/dist/lib/roleCeiling.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const P = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
const ceiling = require(path.join(DIST, 'lib/roleCeiling.js'));
const seed = require(path.join(DIST, 'lib/defaultRolePermissions.js'));
const ownerRole = require(path.join(DIST, 'lib/ownerRole.js'));

const NAMES = ['General Manager', 'Operations Manager', 'Finance Manager', 'Auditor', 'Kitchen Manager'];
const role = (n) => P.BUILT_IN_ROLES.find((r) => r.name === n);
const keys = (n) => new Set(role(n).keys);
const WRITE = P.PERMISSION_KEYS.filter((k) => !P.VIEW_KEYS.includes(k));
/** What the owner-only "finance side" is for an Operations Manager (A550). */
const FINANCE = ['reports.tax', 'reports.costs', 'reports.labour', 'reports.monthly_pack', 'reports.payments', 'reports.export',
  'payables.manage', 'payables.view', 'expenses.manage', 'expenses.view', 'shifts.confirm', 'customers.credit', 'staff.roles',
  'settings.payments', 'settings.business', 'settings.mpesa', 'receipt.manage', 'settings.integrations'];

console.log('\nA550 — the built-in roles for partners\n');

await ok('all five are built in, made of catalogue keys only, for every business type (A580: Kitchen Manager only at a restaurant or café)', () => {
  for (const n of NAMES) {
    const r = role(n);
    assert.ok(r, n);
    if (n === 'Kitchen Manager') assert.deepEqual([...(r.types ?? [])], ['restaurant', 'cafe'], n);   // A580 (owner, 2026-10-23)
    else assert.ok(!r.types, `${n} is for every business`);
    for (const k of r.keys) assert.ok(P.isPermissionKey(k) && !P.isLegacyKey(k), `${n}: ${k}`);
  }
});
await ok('the names never collide with the owner\'s role, or with each other or an older built-in role (case and spaces aside)', () => {
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_]+/g, ' ');
  for (const n of NAMES) assert.equal(ownerRole.isOwnerRoleName(n), false, n);
  const all = P.BUILT_IN_ROLES.map((r) => norm(r.name));
  assert.equal(new Set(all).size, all.length, 'no two built-in roles share a name');
  for (const n of NAMES) assert.ok(!['owner', 'admin'].includes(norm(n)));
});
await ok('the view keys only show: every report, list and figure; nothing that adds, changes, approves or closes', () => {
  assert.ok(P.VIEW_KEYS.length > 0);
  for (const k of P.VIEW_KEYS) {
    const d = P.PERMISSIONS.find((p) => p.key === k);
    assert.ok(d.group === 'reports' || /^(See|Orders, shifts and turnover)/.test(d.label), `${k}: "${d.label}" reads like a change`);
  }
  for (const k of ['menu.edit', 'menu.prices', 'inventory.adjust', 'staff.edit', 'expenses.manage', 'payables.manage', 'orders.create',
    'sales.void', 'shifts.close_day', 'settings.business', 'customers.credit']) assert.ok(!P.VIEW_KEYS.includes(k), k);
});
await ok('Auditor: exactly the view keys — holds no write key', () => {
  assert.deepEqual([...keys('Auditor')].sort(), [...P.VIEW_KEYS].sort());
  for (const k of keys('Auditor')) assert.ok(!WRITE.includes(k), `a write key: ${k}`);
  assert.equal(P.isBackOffice(keys('Auditor')), true, 'back office: a sign-in code, the manager screens');
});
await ok('General Manager: every catalogue key — and no owner-only capability (no \'*\'; the owner\'s role is never theirs)', () => {
  const gm = keys('General Manager');
  // A595 D3 (owner, 2026-10-27): every key but webhooks and report e-mails (the owner's — report e-mails the partners' too).
  assert.deepEqual([...gm].sort(), P.PERMISSION_KEYS.filter((k) => k !== 'settings.webhooks' && k !== 'settings.report_emails' && k !== 'attendance.devices').sort());   // A599: attendance devices the owner's / partners'
  assert.ok(!gm.has('*'), 'never the owner\'s wildcard');
  const held = ceiling.callerHeld({ isOwner: false, permissionKeys: [...gm] });
  assert.equal(ceiling.isOwnerHeld(held), false);
  for (const n of ['owner', 'Owner', 'ADMIN', ' admin ']) assert.equal(ceiling.canAssignRole(held, { name: n, keys: [] }), false, n);
  assert.ok(ceiling.roleEditRefusal(held, { name: 'Admin', keys: ['*'] }), 'never edits the owner\'s role');
  assert.equal(ceiling.canAssignRole(held, { name: 'Cashier', keys: [...keys('Cashier')] }), true, 'gives roles within their keys');
});
await ok('the ceiling holds for a General Manager: nothing beyond their keys (a key added to the catalogue later is beyond)', () => {
  const held = ceiling.callerHeld({ isOwner: false, permissionKeys: [...keys('General Manager')].filter((k) => k !== 'staff.roles') });
  assert.deepEqual(ceiling.overridesBeyondCaller(held, ['staff.roles']), ['staff.roles']);
  assert.equal(ceiling.canAssignRole(held, { name: 'General Manager', keys: [...keys('General Manager')] }), false);
});
await ok('Operations Manager: menu, stock (adjust and the count review), kitchen, shifts and the day — none of the finance keys', () => {
  const k = keys('Operations Manager');
  for (const x of ['menu.edit', 'menu.prices', 'inventory.receive', 'inventory.count', 'inventory.adjust', 'inventory.waste',
    'stations.manage', 'shifts.close_day', 'shifts.close_branch', 'staff.view', 'staff.edit', 'reports.sales', 'reports.items',
    'reports.inventory', 'reports.shifts', 'reports.voids']) assert.ok(k.has(x), `missing ${x}`);
  for (const x of FINANCE) assert.ok(!k.has(x), `finance key ${x}`);
  assert.ok(!k.has('orders.create'), 'no selling');
});
await ok('Finance Manager: every Accountant key, plus paying suppliers, expenses, customer credit and drawers — no selling, menu, stock edits or staff', () => {
  const k = keys('Finance Manager');
  for (const x of keys('Accountant')) assert.ok(k.has(x), `Accountant's ${x}`);
  for (const x of ['payables.manage', 'expenses.manage', 'customers.credit', 'shifts.confirm']) assert.ok(k.has(x), x);
  for (const x of ['orders.create', 'menu.edit', 'menu.prices', 'inventory.adjust', 'inventory.receive', 'staff.edit', 'staff.roles'])
    assert.ok(!k.has(x), x);
});
await ok('Kitchen Manager: the menu, recipes, ingredients, receiving, counts, wastage, the stock report — no money, selling or staff', () => {
  const k = keys('Kitchen Manager');
  for (const x of ['menu.edit', 'menu.recipes', 'ingredients.manage', 'inventory.receive', 'inventory.count', 'inventory.waste',
    'reports.inventory']) assert.ok(k.has(x), x);
  for (const x of ['menu.prices', 'orders.create', 'sales.void', 'expenses.manage', 'payables.manage', 'staff.view', 'staff.edit',
    'shifts.cash_movements', 'customers.credit']) assert.ok(!k.has(x), x);
});
await ok('the Accountant is unchanged (A514/A518) — and is not on the owner\'s role, so it can be given web access', () => {
  assert.deepEqual([...keys('Accountant')].sort(), ['expenses.view', 'orders.view_all', 'payables.view', 'reports.costs',
    'reports.export', 'reports.fuel', 'reports.inventory', 'reports.items', 'reports.labour', 'reports.monthly_pack',
    'reports.overview', 'reports.payments', 'reports.sales', 'reports.shifts', 'reports.staff', 'reports.tax', 'reports.voids',
    'reports.analytics', 'reports.audit'].sort());   // A595: the parts of reports.sales / reports.voids an accountant reads
  assert.equal(ownerRole.isOwnerRoleName('Accountant'), false);
});
await ok('a NEW business is seeded with all five, each with its keys (lib/defaultRolePermissions.ts)', () => {
  for (const type of ['restaurant', 'retail', 'petrol_station']) {
    const names = seed.seededRoleRows('b1', 'Admin', type).map((r) => r.name);
    // A580: Kitchen Manager is a restaurant's or café's only (owner, 2026-10-23: no kitchen roles at a shop)
    for (const n of NAMES) assert.equal(names.includes(n), n !== 'Kitchen Manager' || type === 'restaurant', `${type}: ${n}`);
  }
  for (const n of NAMES) assert.deepEqual([...P.defaultKeysForRoleName(n)].sort(), [...keys(n)].sort(), n);
  assert.deepEqual([...P.defaultKeysForRoleName(' general_manager ')].sort(), [...keys('General Manager')].sort(), 'case and spaces aside');
});
await ok('the copies of the catalogue carry the same roles (the till\'s and the web\'s — check-shared-sync keeps them identical)', () => {
  const canonical = fs.readFileSync(path.join(ROOT, 'shared/permissions.ts'), 'utf8');
  for (const c of ['apps/server/src/lib/permissions.ts', 'apps/dashboard/src/lib/permissions.ts', 'apps/admin/src/lib/permissions.ts',
    'apps/desktop/src/shared/permissions.ts', 'apps/desktop/src/main/permissions.ts']) {
    assert.equal(fs.readFileSync(path.join(ROOT, c), 'utf8'), canonical, c);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
