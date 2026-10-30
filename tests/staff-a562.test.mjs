// A562 — the Staff page's edit form shows the person's real role; the approval PIN is a per-client feature (admin portal).
//
// Owner, 2026-10-22 (with two screenshots — the edit form of "fnicksawa" showing Role = Accountant, and the list showing
// "fnicksawa" and "Mr Daniel Mc'Coy" both as Owner): "then streamline this section we remove approval pin and add it as a
// feature we can turn on or off in the admin panel, the user role should reflect the exact role the user is assigned when
// editing, make sure the page and feature works properly".
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/staff-a562.test.mjs
//
// RUNS the COMPILED staff and orders routers behind the REAL auth middleware over HTTP, the till-change applier
// (lib/changeApply.js) and the admin portal's owner-email helper, on the in-memory database (tests/lib-memdb.mjs); the
// edit form's role picker is RUN from StaffTab.tsx's source (transpiled); the screens are pinned by source.
//
//   1 the role: the owner's role is given to nobody (the owner included) — create, invite, edit, a till's change; the
//     owner's own role, sign-in e-mail and status stay; nobody deactivates themselves; a second owner account may be
//     moved to another role; the owner's row follows a change of the owner's sign-in e-mail (no second owner row)
//   2 the edit form shows the person's own role — locked for the owner's own account and for a role this user may not
//     give; a new person starts on Cashier, never the owner's role; an unchanged role is never sent
//   3 the approval PIN switch: off (the default) — the cloud refuses a new one (APPROVAL_PIN_OFF), removing one is
//     allowed, one already set still approves (cloud), the till's offline chain never used them; on — set as before
//   4 the screens: the web form and the till's add form show the approval PIN only while the switch is on; the admin
//     portal switches it; the shared switch reads only a real true
//
// MUTATIONS TO CONFIRM BITE:
//   - canAssignRole lets '*' give the owner's role (drop the first line)         → 1 "the owner cannot give the owner's role" fails
//   - the OWN_ROLE / SELF_DEACTIVATE checks removed from PATCH and DELETE       → 1 "the owner's own account" fails
//   - approvalPinAllowed always true                                             → 3 "switch off: a new approval PIN is refused" fails
//   - findApprover skipping override PINs when the switch is off                 → 3 "one already set still approves" fails
//   - rolePicker listing only the givable roles (the old picker)                 → 2 "the owner's own role is shown" fails
//   - moveOwnerRowEmail returning before the update                              → 1 "the owner's row follows" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/staff.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const pinAttempts = require(path.join(DIST, 'lib/pinAttempts.js'));
const ceiling = require(path.join(DIST, 'lib/roleCeiling.js'));
const { applyChange } = require(path.join(DIST, 'lib/changeApply.js'));
const { moveOwnerRowEmail } = require(path.join(DIST, 'routes/admin.js'));
const F = require('@zaptill/core/posFeatures');
const bcrypt = require('bcrypt');

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', DAN = 'aaaaaaaa-0000-4000-8000-000000000002',
  MGR = 'aaaaaaaa-0000-4000-8000-000000000003', CASH = 'aaaaaaaa-0000-4000-8000-000000000004', BOSS = 'aaaaaaaa-0000-4000-8000-000000000005';
const R = { owner: 'bbbbbbbb-0000-4000-8000-000000000001', mgr: 'bbbbbbbb-0000-4000-8000-000000000002', cash: 'bbbbbbbb-0000-4000-8000-000000000003',
  acct: 'bbbbbbbb-0000-4000-8000-000000000004', boss: 'bbbbbbbb-0000-4000-8000-000000000005' };
const KEYS = {
  mgr: ['orders.create', 'sales.void', 'sales.refund', 'shifts.confirm', 'customers.credit', 'staff.view', 'staff.edit'],
  cash: ['orders.create'],
  acct: ['reports.view'],
  boss: ['orders.create', 'sales.void', 'sales.refund', 'shifts.confirm', 'customers.credit'],
};
const PIN = { mgr: '4321', boss: '8765', cash: '1111', bossApproval: '7070' };
const roleOf = (name, keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });
const H = { mgr: bcrypt.hashSync(PIN.mgr, 4), boss: bcrypt.hashSync(PIN.boss, 4), cash: bcrypt.hashSync(PIN.cash, 4), bossApproval: bcrypt.hashSync(PIN.bossApproval, 4) };
const person = (id, name, roleId, roleName, keys, extra = {}) => ({ id, name, status: 'active', business_id: B, permissions_version: 0,
  role_id: roleId, roles: roleOf(roleName, keys), user_permissions: [], user_branches: [{ branch_id: BR }], ...extra });
const O1 = 'cccccccc-0000-4000-8000-000000000001';

const reset = ({ approvalPin = false } = {}) => {
  mem.fail = () => null; mem.calls = [];
  pinAttempts._resetAttempts();
  const allKeys = [...new Set(Object.values(KEYS).flat())];
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Magas', currency: 'KES', email: 'fnicksawa@example.com' }],
    branches: [{ id: BR, business_id: B, name: 'Main', is_main: true, desktop_licensed: true }],
    permissions: allKeys.map((key, i) => ({ id: `perm-${i}`, key })),
    roles: [{ id: R.owner, business_id: B, name: 'owner' }, { id: R.mgr, business_id: B, name: 'Manager' }, { id: R.cash, business_id: B, name: 'Cashier' },
      { id: R.acct, business_id: B, name: 'Accountant' }, { id: R.boss, business_id: B, name: 'Supervisor' }],
    role_permissions: [],
    users: [
      person(OWNER, 'fnicksawa', R.owner, 'owner', [], { email: 'fnicksawa@example.com', pin_hash: null }),
      person(DAN, 'Mr Daniel Mc\'Coy', R.owner, 'owner', [], { email: 'daniel@example.com', pin_hash: null }),
      person(MGR, 'Mary', R.mgr, 'Manager', KEYS.mgr, { email: 'mary@example.com', pin_hash: H.mgr }),
      person(CASH, 'Joe', R.cash, 'Cashier', KEYS.cash, { pin_hash: H.cash }),
      // An approver who was given an approval PIN before A562 (the switch did not exist yet).
      person(BOSS, 'Boss', R.boss, 'Supervisor', KEYS.boss, { pin_hash: H.boss, override_pin_hash: H.bossApproval }),
    ],
    user_branches: [{ user_id: OWNER, branch_id: BR }, { user_id: DAN, branch_id: BR }, { user_id: MGR, branch_id: BR }, { user_id: CASH, branch_id: BR }, { user_id: BOSS, branch_id: BR }],
    business_settings: [], branch_settings: [], notifications: [], refresh_tokens: [], user_permissions: [], change_requests: [],
    feature_flags: approvalPin ? [{ business_id: B, key: 'approval_pin', enabled: true }] : [],
    orders: [{ id: O1, business_id: B, branch_id: BR, order_number: 'T1-1', status: 'completed', total: 500, created_at: new Date().toISOString(),
      device_id: 'dev-T1', cashier_id: CASH, order_items: [], payments: [{ id: 'pay1', status: 'completed', amount: 500, method: 'cash' }] }],
    shifts: [], customers: [], payments: [], kitchen_tickets: [], expenses: [], float_transactions: [], user_devices: [],
  };
  for (const [rid, k] of [[R.mgr, KEYS.mgr], [R.cash, KEYS.cash], [R.acct, KEYS.acct], [R.boss, KEYS.boss]]) {
    for (const key of k) mem.db.role_permissions.push({ role_id: rid, permission_id: mem.db.permissions.find((p) => p.key === key).id, permissions: { key } });
  }
};
const user = (id) => mem.db.users.find((u) => u.id === id);

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
for (const [mount, file] of [['orders', 'orders'], ['staff', 'staff']]) app.use(`/api/${mount}`, require(path.join(DIST, `routes/${file}.js`)).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  mgr: sign({ userId: MGR, permissionKeys: KEYS.mgr, surface: 'dashboard' }),
};
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The edit form's role picker, RUN: StaffTab.tsx's defaultRoleId and rolePicker, transpiled as they are.
const ts = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('typescript');
const tab = read('apps/dashboard/src/pages/settings/StaffTab.tsx');
const pickerSrc = tab.slice(tab.indexOf('export function defaultRoleId'), tab.indexOf('const field = '));
const js = ts.transpileModule(`type Role = any; type StaffMember = any;\n${pickerSrc.replace(/export /g, '')}\nmodule.exports = { defaultRoleId, rolePicker };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const P = (() => { const m = { exports: {} }; new Function('module', 'exports', js)(m, m.exports); return m.exports; })();

try {
  console.log('\n1. The owner\'s role belongs to the owner alone\n');
  reset();
  await ok('the owner cannot give the owner\'s role — not on create, invite or edit; the role list says so (assignable: false)', async () => {
    assert.equal(ceiling.canAssignRole(new Set(['*']), { name: 'owner', keys: [] }), false);
    assert.equal(ceiling.canAssignRole(new Set(['*']), { name: 'Admin', keys: [] }), false);
    let r = await call('POST', '/api/staff', T.owner, { name: 'Olga', role_id: R.owner, pin: '1357', branch_ids: [BR] });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.match(r.body.error, /belongs to the owner alone/);
    r = await call('POST', '/api/staff/invite', T.owner, { name: 'Olga', email: 'olga@example.com', role_id: R.owner });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    r = await call('PATCH', `/api/staff/${CASH}`, T.owner, { role_id: R.owner });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(user(CASH).role_id, R.cash);
    assert.ok(!mem.db.users.some((u) => u.name === 'Olga'));
    const roles = await call('GET', '/api/staff/roles', T.owner);
    assert.equal(roles.body.find((x) => x.id === R.owner).assignable, false);
    assert.equal(roles.body.find((x) => x.id === R.acct).assignable, true);
  });
  reset();
  await ok('the owner\'s own account: role, sign-in e-mail and status stay (OWN_ROLE, OWNER_SIGNIN_EMAIL, SELF_DEACTIVATE); the name may change', async () => {
    let r = await call('PATCH', `/api/staff/${OWNER}`, T.owner, { role_id: R.mgr });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWN_ROLE');
    r = await call('PATCH', `/api/staff/${OWNER}`, T.owner, { email: 'new@example.com' });
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWNER_SIGNIN_EMAIL');
    r = await call('PATCH', `/api/staff/${OWNER}`, T.owner, { status: 'inactive' });
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'SELF_DEACTIVATE');
    r = await call('DELETE', `/api/staff/${OWNER}`, T.owner);
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'SELF_DEACTIVATE');
    assert.equal(user(OWNER).status, 'active'); assert.equal(user(OWNER).role_id, R.owner); assert.equal(user(OWNER).email, 'fnicksawa@example.com');
    r = await call('PATCH', `/api/staff/${OWNER}`, T.owner, { name: 'Felix N' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(user(OWNER).name, 'Felix N');
  });
  reset();
  await ok('nobody deactivates themselves — a manager neither', async () => {
    const r = await call('DELETE', `/api/staff/${MGR}`, T.mgr);
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'SELF_DEACTIVATE');
    assert.equal(user(MGR).status, 'active');
  });
  reset();
  await ok('a second account on the owner\'s role: the list says whose row is yours (is_self); the owner may move it to another role, or deactivate it', async () => {
    const list = await call('GET', '/api/staff', T.owner);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.filter((u) => u.is_self).map((u) => u.id), [OWNER]);
    assert.equal(list.body.find((u) => u.id === DAN).is_self, false);
    assert.ok(list.body.every((u) => !('override_pin_hash' in u) && !('pin_hash' in u)), 'no hash leaves');
    assert.equal(list.body.find((u) => u.id === BOSS).can_authorize, true);
    const r = await call('PATCH', `/api/staff/${DAN}`, T.owner, { role_id: R.mgr });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(user(DAN).role_id, R.mgr);
    const d = await call('DELETE', `/api/staff/${DAN}`, T.owner);
    assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(user(DAN).status, 'inactive');
  });
  reset();
  await ok('a till\'s change: a new person on the owner\'s role is refused (the owner as maker too); nobody deactivates themselves from a till', async () => {
    const ctx = { businessId: B, branchId: BR, deviceId: 'dev-T1', callerIsOwner: true, callerUserId: OWNER, callerKeys: ['*'] };
    let r = await applyChange(ctx, { id: 'ch-1', entity: 'staff', op: 'create', entity_id: 'aaaaaaaa-0000-4000-8000-0000000000aa',
      data: { name: 'Olga', role_id: R.owner, pin: '2468' }, made_by: OWNER, made_by_name: 'Felix' });
    assert.equal(r.status, 'refused', JSON.stringify(r)); assert.match(r.message, /owner's role is given to nobody/);
    assert.ok(!mem.db.users.some((u) => u.name === 'Olga'));
    r = await applyChange(ctx, { id: 'ch-2', entity: 'staff', op: 'update', entity_id: OWNER, data: { status: 'inactive' }, base: { status: 'active' }, made_by: OWNER, made_by_name: 'Felix' });
    assert.equal(r.status, 'refused', JSON.stringify(r)); assert.equal(user(OWNER).status, 'active');
    r = await applyChange(ctx, { id: 'ch-3', entity: 'staff', op: 'update', entity_id: CASH, data: { role_id: R.owner }, base: { role_id: R.cash }, made_by: OWNER, made_by_name: 'Felix' });
    assert.equal(r.status, 'refused', JSON.stringify(r)); assert.equal(user(CASH).role_id, R.cash);
  });
  reset();
  await ok('the owner\'s row follows a change of the owner\'s sign-in e-mail (no second owner row at the next sign-in) — never onto a taken address, never a guess', async () => {
    assert.equal(await moveOwnerRowEmail(B, 'fnicksawa@example.com', 'felix@example.com'), true);
    assert.equal(user(OWNER).email, 'felix@example.com');
    reset();
    assert.equal(await moveOwnerRowEmail(B, 'fnicksawa@example.com', 'mary@example.com'), false, 'the new address is someone else\'s');
    assert.equal(user(OWNER).email, 'fnicksawa@example.com');
    user(DAN).email = 'fnicksawa@example.com';
    assert.equal(await moveOwnerRowEmail(B, 'fnicksawa@example.com', 'felix@example.com'), false, 'two rows — whose?');
    assert.equal(user(OWNER).email, 'fnicksawa@example.com');
    const admin = read('apps/server/src/routes/admin.ts');
    assert.match(admin, /const ownerRowMoved = await moveOwnerRowEmail\(String\(req\.params\.id\), oldEmail, newEmail\);/);
  });

  console.log('\n2. The edit form shows the person\'s own role\n');
  const ROLES = [
    { id: R.acct, name: 'Accountant', assignable: true }, { id: R.cash, name: 'Cashier', assignable: true },
    { id: R.mgr, name: 'Manager', assignable: true }, { id: R.boss, name: 'Supervisor', assignable: false },
  ];
  const ALL = [{ id: R.owner, name: 'owner', is_owner_role: true, assignable: false }, ...ROLES];
  const givable = ROLES.filter((r) => r.assignable);
  await ok('the owner\'s own account: its own role is shown (never "Accountant"), locked, with the reason', () => {
    const p = P.rolePicker({ roles: { id: R.owner, name: 'owner' }, is_self: true }, givable, ALL);
    assert.deepEqual(p.options.map((r) => r.id), [R.owner]);
    assert.equal(p.locked, true); assert.match(p.note, /^Owner — the owner's role can't be changed here/);
  });
  await ok('another account on the owner\'s role: shown first, and the owner may choose another role', () => {
    const p = P.rolePicker({ roles: { id: R.owner, name: 'owner' }, is_self: false }, givable, ALL);
    assert.equal(p.options[0].id, R.owner); assert.equal(p.locked, false);
    assert.deepEqual(p.options.slice(1).map((r) => r.id), givable.map((r) => r.id));
    assert.match(p.note, /If they are not the owner, choose another role/);
  });
  await ok('a role this user may not give: shown, locked — "You can\'t change this person\'s role"', () => {
    const p = P.rolePicker({ roles: { id: R.boss, name: 'Supervisor' }, is_self: false }, givable, ALL);
    assert.deepEqual(p.options.map((r) => r.id), [R.boss]); assert.equal(p.locked, true);
    assert.match(p.note, /You can't change this person's role/);
  });
  await ok('a role this user may give: the usual list, the person\'s own role among them; a new person — the givable list', () => {
    const p = P.rolePicker({ roles: { id: R.cash, name: 'Cashier' }, is_self: false }, givable, ALL);
    assert.equal(p.locked, false); assert.ok(p.options.some((r) => r.id === R.cash)); assert.equal(p.note, '');
    assert.deepEqual(P.rolePicker(null, givable, ALL).options.map((r) => r.id), givable.map((r) => r.id));
  });
  await ok('a new person starts on Cashier — never the owner\'s role, even listed first', () => {
    assert.equal(P.defaultRoleId(givable), R.cash);
    assert.equal(P.defaultRoleId([ALL[0], ...givable]), R.cash);
    assert.equal(P.defaultRoleId([ALL[0], { id: R.mgr, name: 'Manager', assignable: true }]), R.mgr);
    assert.equal(P.defaultRoleId([ALL[0]]), '');
  });
  await ok('the form: the select is the picker\'s (locked when it says), an edit starts on the person\'s role, an unchanged role is never sent', () => {
    assert.match(tab, /const \[roleId, setRoleId\] = useState\(editing\?\.roles\?\.id \?\? defaultRoleId\(roles\)\);/);
    assert.match(tab, /<select value=\{roleId\} onChange=\{e => handleRoleChange\(e\.target\.value\)\} disabled=\{picker\.locked\}/);
    assert.match(tab, /\{picker\.options\.map\(r => <option key=\{r\.id\} value=\{r\.id\}>\{r\.name\}<\/option>\)\}/);
    assert.match(tab, /\.\.\.\(roleChanged \? \{ role_id: roleId \} : \{\}\)/);
    assert.match(tab, /const roleChanged = !editing \|\| roleId !== \(editing\.roles\?\.id \?\? ''\);/);
  });
  await ok('the list: Deactivate is not offered on your own row (with why); the reset is never on your own row; a second owner account is said', () => {
    assert.match(tab, /disabled=\{!!s\.is_self\} data-testid="staff-deactivate"\s+title=\{s\.is_self \? 'You cannot deactivate yourself' : undefined\}/);
    assert.match(tab, /needsSignInCode\(role, s\.override_keys\) && !s\.is_self/);
    assert.match(tab, /\{role\?\.is_owner_role && !s\.is_self && \(\s*<span data-testid="second-owner"/);
  });
  await ok('the till: the add form offers no owner\'s role; the edit shows the person\'s own role, locked for the owner\'s or one not theirs to give', () => {
    const mt = read('apps/desktop/src/renderer/pages/ManageTabs.tsx');
    assert.match(mt, /roles\.filter\(r => r\.assignable !== false && !r\.is_owner_role\)\.map\(r => <option/);
    assert.match(mt, /const locked = !!cur && \(cur\.is_owner_role \|\| cur\.assignable === false\);/);
    assert.match(mt, /roles\.filter\(\(r: any\) => r\.id === editRole \|\| \(!locked && r\.assignable !== false && !r\.is_owner_role\)\)/);
    const ipc = read('apps/desktop/src/main/ipc/staff.ts');
    assert.match(ipc, /if \(typeof p\.status === 'string' && p\.status !== 'active' && signedIn\(\)\?\.staffId === String\(id\)\) throw new Error\('You cannot deactivate yourself\.'\);/);
  });

  console.log('\n3. The approval PIN switch\n');
  reset();
  await ok('switch off (the default): a new approval PIN is refused — APPROVAL_PIN_OFF — on edit and on create; nothing stored', async () => {
    assert.equal(F.approvalPinOn(F.parsePosFeatures(mem.db.feature_flags)), false);
    let r = await call('PATCH', `/api/staff/${MGR}`, T.owner, { override_pin: '1357' });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'APPROVAL_PIN_OFF');
    assert.match(r.body.error, /managers approve with their sign-in PIN/);
    assert.ok(!user(MGR).override_pin_hash);
    r = await call('POST', '/api/staff', T.owner, { name: 'Ann', role_id: R.mgr, pin: '2244', branch_ids: [BR], override_pin: '1357' });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'APPROVAL_PIN_OFF');
    assert.ok(!mem.db.users.some((u) => u.name === 'Ann'));
    r = await call('POST', '/api/staff', T.owner, { name: 'Ann', role_id: R.mgr, pin: '2244', branch_ids: [BR] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
  reset();
  await ok('switch off: one already set still approves a void (recorded as its holder) — no manager\'s approval breaks', async () => {
    const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: PIN.bossApproval });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mem.db.orders[0].status, 'voided'); assert.equal(mem.db.orders[0].authorized_by, BOSS);
  });
  reset();
  await ok('switch off: a sign-in PIN approves as before (A518)', async () => {
    const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: PIN.boss });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(mem.db.orders[0].authorized_by, BOSS);
  });
  reset();
  await ok('switch off: removing one is always allowed', async () => {
    const r = await call('PATCH', `/api/staff/${BOSS}`, T.owner, { override_pin: '' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(user(BOSS).override_pin_hash, null);
  });
  reset({ approvalPin: true });
  await ok('switch on: the owner sets an approval PIN as before (and it approves)', async () => {
    assert.equal(F.approvalPinOn(F.parsePosFeatures(mem.db.feature_flags)), true);
    const r = await call('PATCH', `/api/staff/${MGR}`, T.owner, { override_pin: '1357' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(await bcrypt.compare('1357', user(MGR).override_pin_hash));
    const c = await call('POST', '/api/staff', T.owner, { name: 'Ann', role_id: R.mgr, pin: '2244', branch_ids: [BR], override_pin: '9753' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.ok(await bcrypt.compare('9753', mem.db.users.find((u) => u.name === 'Ann').override_pin_hash));
  });
  await ok('the till\'s offline chain never used approval PINs (A496: never served to a till) — it is not changed by the switch', () => {
    const bs = read('apps/desktop/src/main/branchStaff.ts');
    assert.match(bs, /pin_hash: pin, override_pin_hash: null, status: r\.status \?\? 'active',   \/\/ A496: never served/);
    const ap = read('apps/server/src/lib/approver.ts');
    assert.doesNotMatch(ap, /approval_pin|posFeatures/, 'the approver reads no switch — a PIN already set keeps approving');
  });

  console.log('\n4. The screens\n');
  await ok('the shared switch: approval_pin, off unless a real true; set in the admin portal (never the owner — not an owner POS option)', () => {
    assert.ok(F.POS_FEATURE_KEYS.includes('approval_pin'));
    assert.deepEqual([...F.STAFF_OPTION_KEYS], ['approval_pin']);
    assert.equal(F.parsePosFeatures(null).approval_pin, false);
    assert.equal(F.approvalPinOn({ approval_pin: 'yes' }), false);
    assert.equal(F.approvalPinOn({ approval_pin: true }), true);
    assert.match(F.POS_FEATURES.find((f) => f.key === 'approval_pin').description, /^A separate approval PIN for managers \(instead of their sign-in PIN\)\./);
    const controls = read('apps/server/src/routes/controls.ts');
    assert.doesNotMatch(controls.match(/export const OWNER_POS_KEYS = \[[^\]]*\]/)[0], /approval_pin/);
  });
  await ok('the admin portal switches it (Staff options, a toggle — not the read-only POS list)', () => {
    const ap = read('apps/admin/src/AdminPortal.tsx');
    assert.match(ap, /if \(\(STAFF_OPTION_KEYS as readonly string\[\]\)\.includes\(pf\.key\)\) return null;   \/\/ A562: switched below/);
    assert.match(ap, /\{STAFF_OPTION_KEYS\.map\(key => \{[\s\S]*?data-testid=\{`staff-feature-\$\{key\}`\}[\s\S]*?\{toggle\(on, \(\) => toggleFeature\(key, !on\), sf\?\.label \?\? key\)\}/);
  });
  await ok('the web form: the approval PIN only while the switch is on; switched off, a PIN set before may be removed; a new one is never sent then', () => {
    assert.match(tab, /api\.get<Record<string, boolean>>\('\/api\/flags'\)/);
    assert.match(tab, /setApprovalPin\(approvalPinOn\(flags\)\);/);
    assert.match(tab, /\{approvalPin && \(\s*<div data-testid="approval-pin">/);
    assert.match(tab, /\{!approvalPin && editing && hasApprovalPin && \(\s*<p className="text-xs text-gray-500" data-testid="approval-pin-left">/);
    assert.match(tab, /clearOverride \? \{ override_pin: '' \}\s*: approvalPin && overridePin && mayApprove \? \{ override_pin: overridePin \}\s*: \{\};/);
  });
  await ok('the till\'s add form: the approval PIN only while the switch is on, and never sent otherwise', () => {
    const mt = read('apps/desktop/src/renderer/pages/ManageTabs.tsx');
    assert.match(mt, /posApi\.pos\.features\(\)\.then\(\(f\) => setApprovalPin\(approvalPinOn\(f\)\)\)/);
    assert.match(mt, /\{approvalPin && <div>\s*<label className=\{label\}>Approval PIN — optional<\/label>/);
    assert.match(mt, /\.\.\.\(approvalPin && form\.override_pin \? \{ override_pin: form\.override_pin \} : \{\}\),/);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
