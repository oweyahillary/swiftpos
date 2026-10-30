// A518 — three A514 gaps on the cloud:
//   (2) payables.view: the Accountant reads the supplier bills, payments and returns without recording or paying them;
//   (3) a business whose type changes to petrol_station gets the built-in Fuel attendant role (migration 142's rule);
//   (4) a pay-out / expense / drawer confirmation at a branch where NOBODY may approve with a PIN answers
//       NO_OVERRIDE_CONFIGURED (400, never counted by the PIN limiter); a wrong PIN stays INVALID_CONFIRMER_PIN (counted).
//
//   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/a518-cloud-gaps.test.mjs
//
// RUNS the shared catalogue, the compiled rbac gate, lib/defaultRolePermissions (addTypeRoles), lib/payoutApproval and
// lib/confirmerLookup over the in-memory database (tests/lib-memdb.mjs); reads the routes' gates.
//
// MUTATIONS TO CONFIRM BITE: GET /summary back to requirePermission('payables.manage') → "the read routes" fails;
// payables.view left off the Accountant → its pin fails; addTypeRoles not called from PATCH /clients/:id → "wired" fails;
// the name check dropped from typeRolesMissing → "an existing fuel attendant (any case) is kept" fails; the 'none' branch
// removed from payoutApprover → "nobody can approve" fails; 'none' counted with notePinFailure → "never counted" fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/payoutApproval.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= 'test-only-secret-test-only-secret';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const P = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const rbac = require(path.join(DIST, 'middleware/rbac.js'));
const seeder = require(path.join(DIST, 'lib/defaultRolePermissions.js'));
const { payoutApprover } = require(path.join(DIST, 'lib/payoutApproval.js'));
const { confirmerByPin } = require(path.join(DIST, 'lib/confirmerLookup.js'));
const attempts = require(path.join(DIST, 'lib/pinAttempts.js'));
const bcrypt = require('bcrypt');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

console.log('\nA518 — cloud gaps (supplier bills read-only, fuel attendant on a type change, nobody can approve)\n');

// ── (2) payables.view ────────────────────────────────────────────────────────
await ok('the catalogue: payables.view in the payables.manage group, with the owner\'s words; the Accountant holds it, the Manager does not gain it', () => {
  const v = P.PERMISSIONS.find((p) => p.key === 'payables.view');
  assert.ok(v);
  assert.equal(v.group, P.PERMISSIONS.find((p) => p.key === 'payables.manage').group);
  assert.equal(v.label, 'See supplier bills');
  assert.equal(v.description, 'See supplier bills, payments and returns, without recording or paying them');
  assert.ok(!v.manager && !v.cashier);
  const acct = P.BUILT_IN_ROLES.find((r) => r.name === 'Accountant').keys;
  assert.ok(acct.includes('payables.view') && !acct.includes('payables.manage'));
  assert.ok(!P.BUILT_IN_ROLES.find((r) => r.name === 'Manager').keys.includes('payables.manage'), 'Manager has no payables.manage');
  assert.ok(!P.BUILT_IN_ROLES.find((r) => r.name === 'Manager').keys.includes('payables.view'));
  assert.equal(P.isBackOffice(['payables.view']), true, 'a holder goes to the manager portal');
});
await ok('the gate: payables.view OR payables.manage passes a read; payables.view alone never passes a write', () => {
  const run = (mw, keys) => { let passed = false; let status = 200; mw({ permissionKeys: keys, isOwner: false }, { status(s) { status = s; return this; }, json() { return this; } }, () => { passed = true; }); return passed ? 'next' : status; };
  const readGate = rbac.requireAnyPermission('payables.view', 'payables.manage');
  assert.equal(run(readGate, ['payables.view']), 'next');
  assert.equal(run(readGate, ['payables.manage']), 'next');
  assert.equal(run(readGate, ['reports.sales']), 403);
  assert.equal(run(rbac.requirePermission('payables.manage'), ['payables.view']), 403);
});
await ok('the read routes take either key; every write stays payables.manage', () => {
  const src = read('apps/server/src/routes/payables.ts');
  assert.match(src, /router\.get\('\/summary', requireAnyPermission\('payables\.view', 'payables\.manage'\)/);
  assert.match(src, /router\.get\('\/suppliers\/:id', requireAnyPermission\('payables\.view', 'payables\.manage'\)/);
  assert.match(src, /router\.get\('\/returns', requireAnyPermission\('inventory\.receive', 'payables\.manage', 'payables\.view'\)/);
  for (const w of ["'/bills'", "'/bills/:id/void'", "'/payments'", "'/payments/:id/void'"]) {
    assert.ok(src.includes(`router.post(${w}, requirePermission('payables.manage')`), w);
  }
  assert.match(src, /router\.post\('\/returns', requireAnyPermission\('inventory\.receive', 'payables\.manage'\)/, 'sending goods back is not payables.view');
});
await ok('the web: the manager portal lists the bills for either key, read-only without payables.manage; the owner\'s Suppliers page too', () => {
  const m = read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx');
  assert.match(m, /key: 'bills',.*permission: \['payables\.view', 'payables\.manage'\]/);
  assert.match(m, /canPay=\{hasPermission\('payables\.manage'\)\}/);
  const acc = read('apps/dashboard/src/components/SupplierAccount.tsx');
  for (const form of ["{ kind: 'bill' }", "{ kind: 'pay' }", "{ kind: 'bill', grn: d }"]) {
    assert.ok(acc.includes(`{canPay && <button onClick={() => setForm(${form})}`), form);   // Add bill, Record payment, Bill it
  }
  assert.ok(acc.includes("{canReturn && <button onClick={() => setForm({ kind: 'return' })}"), 'Return goods');
  assert.match(acc, /\{canPay && b\.due > 0 && <button/);
  assert.match(acc, /\{canPay && !x\.voided_at && <button/);
  const s = read('apps/dashboard/src/pages/stock/SuppliersPage.tsx');
  assert.match(s, /const seesBills = canPay \|\| can\('payables\.view'\)/);
  assert.match(s, /canPay=\{canPay\}/);
});
await ok('migration 143 registers it and gives it to payables.manage holders, the built-in Accountant and the owner roles, once', () => {
  const sql = read('migrations/143_payables_view.sql');
  assert.match(sql, /\('payables\.view', 'See supplier bills', 'stock', 'See supplier bills, payments and returns, without recording or paying them'\)/);
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM public\.schema_migrations WHERE version = '143_payables_view'\)/);
  assert.match(sql, /m\.key = 'payables\.manage'/);
  assert.match(sql, /r\.is_default AND .* = 'accountant'/);
  assert.ok(!/CREATE TEMP TABLE/i.test(sql));
});

// ── (3) Fuel attendant on a type change ─────────────────────────────────────
const BZ = '11111111-1111-4111-8111-111111111111';
const seedPerms = () => P.PERMISSION_KEYS.map((k, i) => ({ id: `p-${i}`, key: k }));
await ok('a business that becomes a petrol station gets Fuel attendant — is_default, the shared defaults, nobody on it', async () => {
  mem.db = { permissions: seedPerms(), roles: [{ id: 'r-own', business_id: BZ, name: 'owner' }, { id: 'r-cash', business_id: BZ, name: 'Cashier' }], role_permissions: [], users: [] };
  const added = await seeder.addTypeRoles(BZ, 'petrol_station');
  assert.deepEqual(added, ['Fuel attendant']);
  const f = mem.db.roles.find((r) => r.name === 'Fuel attendant');
  assert.ok(f); assert.equal(f.is_default, true); assert.equal(f.business_id, BZ);
  assert.equal(f.description, P.BUILT_IN_ROLES.find((r) => r.name === 'Fuel attendant').description);
  const keyOf = new Map(mem.db.permissions.map((p) => [p.id, p.key]));
  const keys = mem.db.role_permissions.filter((rp) => rp.role_id === f.id).map((rp) => keyOf.get(rp.permission_id)).sort();
  assert.deepEqual(keys, [...P.BUILT_IN_ROLES.find((r) => r.name === 'Fuel attendant').keys].sort());
  assert.equal(mem.db.roles.length, 3, 'nothing else added');
});
await ok('an existing fuel attendant (any case and spaces) is kept; a change away or to another type adds and removes nothing', async () => {
  mem.db = { permissions: seedPerms(), roles: [{ id: 'r1', business_id: BZ, name: ' FUEL_attendant ' }], role_permissions: [] };
  assert.deepEqual(await seeder.addTypeRoles(BZ, 'petrol_station'), []);
  assert.equal(mem.db.roles.length, 1);
  mem.db = { permissions: seedPerms(), roles: [{ id: 'r1', business_id: BZ, name: 'Fuel attendant' }], role_permissions: [] };
  // A580: a business that becomes a restaurant now gets the food-only built-in roles (Waiter, Kitchen, Kitchen Manager)
  assert.deepEqual(await seeder.addTypeRoles(BZ, 'restaurant'), ['Waiter', 'Kitchen', 'Kitchen Manager']);
  assert.ok(mem.db.roles.some((r) => r.name === 'Fuel attendant'), 'never removed on a change away');
  mem.db = { permissions: seedPerms(), roles: [{ id: 'r1', business_id: BZ, name: 'Fuel attendant' }], role_permissions: [] };
  assert.deepEqual(await seeder.addTypeRoles(BZ, 'minimart'), []);
  assert.equal(mem.db.roles.length, 1, 'a change to a shop adds nothing, removes nothing');
  assert.deepEqual(seeder.typeRolesMissing('retail', []), []);
  assert.deepEqual(seeder.typeRolesMissing('Petrol_Station', ['Owner']).map((r) => r.name), ['Fuel attendant']);
});
await ok('wired: PATCH /api/admin/clients/:id adds the type\'s roles when the type changes (the only place a type changes)', () => {
  const a = read('apps/server/src/routes/admin.ts');
  assert.match(a, /String\(before\.type \?\? ''\) !== String\(updates\.type\)\s*\n?\s*\? await addTypeRoles\(id, String\(updates\.type\)\)/);
  assert.match(a, /const \{ data: before \} = await supabase\.from\('businesses'\)\.select\('name, status, type,/);
  const b = read('apps/server/src/routes/business.ts');
  assert.ok(!/EDITABLE = \[[^\]]*'type'/.test(b), 'the owner cannot change the type');
});

// ── (4) nobody can approve ───────────────────────────────────────────────────
const B1 = 'b1111111-1111-4111-8111-111111111111', B2 = 'b2222222-2222-4222-8222-222222222222';
const MGR = 'u0000000-0000-4000-8000-000000000001', CASH = 'u0000000-0000-4000-8000-000000000002';
const confirmRole = { name: 'Manager', role_permissions: [{ permissions: { key: 'shifts.confirm' } }] };
const req = (pin) => ({ businessId: BZ, userId: CASH, isOwner: false, permissionKeys: ['orders.create'], ip: '10.0.0.9', body: { pin } });
const hash = await bcrypt.hash('4321', 4);
await ok('nobody at the branch who may approve has a PIN → 400 NO_OVERRIDE_CONFIGURED, in orders.ts\'s words, never counted', async () => {
  attempts._resetAttempts();
  mem.db = { businesses: [{ id: BZ, owner_id: null }], users: [
    { id: MGR, business_id: BZ, status: 'active', name: 'Mo', pin_hash: hash, roles: confirmRole, user_branches: [{ branch_id: B2 }] },
    { id: CASH, business_id: BZ, status: 'active', name: 'Ann', pin_hash: hash, roles: { name: 'Cashier', role_permissions: [] }, user_branches: [{ branch_id: B1 }] },
  ] };
  for (let i = 0; i < attempts.PIN_MAX_FAILS + 2; i++) {
    const a = await payoutApprover(req('9999'), B1);
    assert.equal(a.ok, false); assert.equal(a.status, 400); assert.equal(a.code, 'NO_OVERRIDE_CONFIGURED');
    assert.equal(a.error, 'Nobody at this branch can approve this yet. The owner or a manager gives someone who may approve a PIN in Staff.');
  }
  assert.equal(attempts.pinLocked(attempts.pinKey(req('9999'))), false, 'never counted by the PIN limiter');
  assert.equal(await confirmerByPin(BZ, '9999', undefined, { branchId: B1, actorId: CASH }), 'none');
  assert.match(read('apps/server/src/routes/orders.ts'), new RegExp(a518Text()));
});
await ok('someone at the branch can approve: a wrong PIN stays INVALID_CONFIRMER_PIN (403, counted); the right one approves', async () => {
  attempts._resetAttempts();
  mem.db.users[0].user_branches = [{ branch_id: B1 }];
  const a = await payoutApprover(req('9999'), B1);
  assert.equal(a.status, 403); assert.equal(a.code, 'INVALID_CONFIRMER_PIN');
  for (let i = 1; i < attempts.PIN_MAX_FAILS; i++) await payoutApprover(req('9999'), B1);
  assert.equal(attempts.pinLocked(attempts.pinKey(req('9999'))), true, 'wrong PINs are counted');
  attempts._resetAttempts();
  const good = await payoutApprover(req('4321'), B1);
  assert.equal(good.ok, true); assert.equal(good.approver.id, MGR);
});
await ok('a person picked by id who may not approve stays a wrong PIN (not "nobody")', async () => {
  mem.db.users[0].user_branches = [{ branch_id: B2 }];
  assert.equal(await confirmerByPin(BZ, '9999', CASH, { branchId: B1, actorId: CASH }), null);
});
await ok('wired: the till\'s /shifts/confirmer, a web drawer confirmation and a kitchen void answer it (400, before any strike)', () => {
  const s = read('apps/server/src/routes/shifts.ts');
  assert.match(s, /if \(who === 'none'\) \{ res\.status\(400\)\.json\(NO_CONFIRMER_BODY\); return; \}/);
  assert.match(s, /if \(found === 'none'\) \{ res\.status\(400\)\.json\(NO_CONFIRMER_BODY\); return; \}/);
  assert.match(read('apps/server/src/routes/orders.ts'), /if \(found === 'none'\) \{ res\.status\(400\)\.json\(NO_CONFIRMER_BODY\); return; \}/);
});

// A518 (owner, 2026-10-16: "rather than them having to remember 2 pins"): "a PIN" — their sign-in PIN already approves.
function a518Text() { return 'Nobody at this branch can approve this yet\\. The owner or a manager gives someone who may approve a PIN in Staff\\.'; }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
