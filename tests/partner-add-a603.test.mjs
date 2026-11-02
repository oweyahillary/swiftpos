/**
 * partner-add-a603.test.mjs — A603: "Partner" in the Role list of + Add Staff (owner, 2026-10-28: "We are missing partners
 * here on this list"). Not a role of its own: POST /api/staff with partner: true gives the business's General Manager role
 * (every permission) and web dashboard access in the same step — the SAME grant as "Give web access" (A550,
 * routes/staff.ts giveWebAccess) — with the branches ticked. The owner's alone; all or nothing.
 *
 *   node tests/partner-add-a603.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the real cloud: the COMPILED auth and staff routers behind the REAL auth middleware, on a real Express server, over
 * HTTP with real signed tokens. Only the database (tests/lib-memdb.mjs), Supabase Auth and the mailer are stand-ins. The
 * dashboard's Role list is RUN from StaffTab.tsx's source (transpiled); who sees it is pinned by source.
 *
 * MUTATIONS TO CONFIRM BITE (each was made, a test failed, and it was put back):
 *   - the partner path without ownerOnly()                          → "a manager is refused" and "a partner is refused" fail
 *   - the partner path without the e-mail check                    → "an e-mail is required" fails
 *   - the grant failure without undoNewStaff()                     → "the sign-in link failing leaves nobody half made" fails
 *   - partnerRole() taking the role_id the client sent             → "the owner adds a partner" fails (Cashier, not GM)
 *   - withPartnerOption ignoring `show`                            → "the Role list shows Partner only when asked" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'routes/staff.js'))) {
  console.log('\nCannot load apps/server/dist/routes/staff.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.SUPABASE_ANON_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.LOGIN_OTP_SECRET ??= randomBytes(24).toString('hex');
delete process.env.LOGIN_OTP;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase, authClient } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const mails = [];
let mailOk = true;
mailer.sendEmailChecked = async (o) => { mails.push(o); return mailOk ? { ok: true, provider: 'resend' } : { ok: false, error: 'down' }; };
mailer.sendEmail = async (o) => { mails.push(o); return true; };
const authCache = require(path.join(DIST, 'lib/authCache.js'));
const attempts = require(path.join(DIST, 'lib/pinAttempts.js'));
const P = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
const jwt = require('jsonwebtoken');
const express = require('express');

// ── The business, its people and sign-in accounts ────────────────────────────────────────────────────────────────────
const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = u(900), BR = u(901), BR2 = u(902);
const OWNER = u(1), GM = u(2), MGR = u(3), CASH = u(5);
const R_OWNER = u(800), R_GM = u(801), R_OPS = u(802), R_CASH = u(804);
const keysOf = (name) => [...P.BUILT_IN_ROLES.find((r) => r.name === name).keys];
const roles = {
  [R_OWNER]: { id: R_OWNER, business_id: B, name: 'Admin', keys: [] },
  [R_GM]: { id: R_GM, business_id: B, name: 'General Manager', is_default: true, keys: keysOf('General Manager') },
  [R_OPS]: { id: R_OPS, business_id: B, name: 'Operations Manager', keys: keysOf('Operations Manager') },
  [R_CASH]: { id: R_CASH, business_id: B, name: 'Cashier', keys: keysOf('Cashier') },
};
const grantsOf = (keys) => keys.map((k) => ({ permissions: { key: k } }));
const person = (id, name, email, roleId, branches) => ({
  id, business_id: B, name, email, status: 'active', permissions_version: 1, role_id: roleId, must_change_password: false,
  roles: { id: roleId, name: roles[roleId].name, role_permissions: grantsOf(roles[roleId].keys) },
  user_permissions: [], user_branches: branches.map((b) => ({ branch_id: b })),
});
const GINA = 'gina@pollo.test', MARY = 'mary@pollo.test', OWNER_MAIL = 'owner@pollo.test', PAT = 'pat@pollo.test';
let accounts;
const reset = () => {
  attempts._resetAttempts();
  authCache._resetAuthCache();
  mails.length = 0; mailOk = true;
  mem.fail = () => null; mem.calls = [];
  accounts = {
    'auth-owner': { id: 'auth-owner', email: OWNER_MAIL, password: 'owner-pass-1', app_metadata: {} },
    'auth-gina': { id: 'auth-gina', email: GINA, password: 'gina-pass-12', app_metadata: { zaptill_partner: { [B]: GM } } },
  };
  mem.db = {
    businesses: [{ id: B, owner_id: 'auth-owner', name: 'Pollo', status: 'active', type: 'restaurant', subdomain: 'pollo', currency: 'KES' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', status: 'active', is_main: true },
      { id: BR2, business_id: B, name: 'Kilimani', status: 'active', is_main: false }],
    roles: Object.values(roles).map(({ keys, ...r }) => r),
    role_permissions: [], permissions: P.PERMISSION_KEYS.map((k, i) => ({ id: `perm-${i}`, key: k })),
    users: [
      person(OWNER, 'Owner', OWNER_MAIL, R_OWNER, [BR]),
      person(GM, 'Gina', GINA, R_GM, []),
      person(MGR, 'Mary', MARY, R_OPS, [BR]),
      person(CASH, 'Joe', 'joe@pollo.test', R_CASH, [BR]),
    ],
    user_branches: [], user_permissions: [], refresh_tokens: [], login_otp_codes: [], password_reset_codes: [],
    notifications: [], user_devices: [],
    business_settings: [{ id: 'bs-1', business_id: B, key: 'web_partners', value: { [GM]: { auth_user_id: 'auth-gina', status: 'active', granted_at: '2026-10-21T08:00:00Z', granted_by: OWNER } } }],
    feature_flags: [{ business_id: B, key: 'web_hosting', enabled: true }],
  };
  for (const p of mem.db.users) for (const b of p.user_branches) mem.db.user_branches.push({ user_id: p.id, branch_id: b.branch_id });
  for (const r of Object.values(roles)) for (const k of r.keys) mem.db.role_permissions.push({ role_id: r.id, permission_id: mem.db.permissions.find((p) => p.key === k).id, permissions: { key: k } });
};
const partnersOf = () => mem.db.business_settings.find((r) => r.business_id === B && r.key === 'web_partners')?.value ?? {};
const byEmail = (e) => mem.db.users.find((x) => x.email === e);
const userView = (a) => ({ id: a.id, email: a.email, app_metadata: JSON.parse(JSON.stringify(a.app_metadata)),
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });

let linkFails = false;
authClient.auth.signInWithPassword = async ({ email, password }) => {
  const a = Object.values(accounts).find((x) => x.email === String(email).toLowerCase());
  if (!a || a.password !== password) return { data: { user: null }, error: { message: 'Invalid login credentials' } };
  return { data: { user: userView(a) }, error: null };
};
supabase.auth = { admin: {
  getUserById: async (id) => ({ data: { user: accounts[id] ? userView(accounts[id]) : null }, error: null }),
  updateUserById: async (id, attrs) => {
    if (linkFails && attrs.app_metadata && Object.values(attrs.app_metadata.zaptill_partner ?? {}).length) return { data: null, error: { message: 'auth is down' } };
    if (!accounts[id]) return { data: null, error: { message: 'not found' } };
    if (attrs.app_metadata) accounts[id].app_metadata = JSON.parse(JSON.stringify(attrs.app_metadata));
    if (attrs.password) accounts[id].password = attrs.password;
    return { data: { user: userView(accounts[id]) }, error: null };
  },
  createUser: async ({ email, password }) => {
    if (Object.values(accounts).some((a) => a.email === email)) return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
    const id = `auth-${email.split('@')[0]}`;
    accounts[id] = { id, email, password, app_metadata: {} };
    return { data: { user: userView(accounts[id]) }, error: null };
  },
  generateLink: async ({ email }) => {
    const a = Object.values(accounts).find((x) => x.email === email);
    return a ? { data: { user: userView(a), properties: {} }, error: null } : { data: null, error: { message: 'User not found' } };
  },
  inviteUserByEmail: async () => ({ data: {}, error: null }),
} };

const app = express();
app.use(express.json());
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
app.use('/api/staff', require(path.join(DIST, 'routes/staff.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = (body) => call('POST', '/api/auth/login', null, body);
const codeFrom = (to) => {
  const m = [...mails].reverse().find((x) => String(x.to) === to && /sign-in code: (\d{6})/.test(x.subject));
  return m ? m.subject.match(/(\d{6})/)[1] : null;
};
const partnerLogin = async (body) => {
  const first = await login(body);
  if (first.status !== 403 || first.body?.code !== 'OTP_REQUIRED') return first;
  return login({ ...body, otp_code: codeFrom(body.email) });
};
const ownerToken = () => jwt.sign({ userId: OWNER, businessId: B, branchId: null, isOwner: true, ownerLogin: true, permissionKeys: ['*'],
  permissionsVersion: 1, sessionId: 's-owner' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const managerToken = () => jwt.sign({ userId: MGR, businessId: B, branchId: BR, isOwner: false, permissionKeys: keysOf('Operations Manager'),
  permissionsVersion: 1, sessionId: 's-mgr', surface: 'dashboard' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const NEW_PARTNER = { name: 'Pat', email: PAT, partner: true, branch_ids: [BR2] };

try {
  console.log('\nA603 — Partner in the Role list\n');

  // ── 1. The owner adds a partner ──────────────────────────────────────────────────────────────────────────────────
  reset();
  await ok('the owner adds a partner: the General Manager role (not the role sent), the branches ticked, web access given, invited', async () => {
    const r = await call('POST', '/api/staff', ownerToken(), { ...NEW_PARTNER, role_id: R_CASH });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = byEmail(PAT);
    assert.ok(row, 'on the staff list'); assert.equal(row.status, 'active');
    assert.equal(row.role_id, R_GM, 'the General Manager role — every permission');
    assert.equal(row.pin_hash, null, 'no POS PIN needed');
    assert.deepEqual(mem.db.user_branches.filter((b) => b.user_id === row.id).map((b) => b.branch_id), [BR2], 'the branch ticked');
    assert.equal(partnersOf()[row.id]?.status, 'invited', 'the grant, as "Give web access" makes it');
    assert.equal(accounts['auth-pat']?.app_metadata.zaptill_partner?.[B], row.id, 'the sign-in account names this person');
    assert.deepEqual(r.body.web_access, { status: 'invited', emailed: true });
    const invite = mails.find((m) => m.to === PAT);
    assert.ok(invite && /Forgot password\?/.test(invite.html), 'the same invitation as "Give web access"');
    assert.equal(partnersOf()[GM].status, 'active', 'the existing partner is untouched');
  });
  await ok('…the new partner sets a password and signs in: a partner of the branch ticked, never the owner', async () => {
    // lib-memdb has no joins and makes 'row-N' ids — the new row is given the uuid and the embedded role and branches the
    // real database would answer with (the grant and the account's link renamed with it).
    const row = byEmail(PAT);
    const NEW_ID = u(77), old = row.id;
    row.id = NEW_ID;
    for (const b of mem.db.user_branches) if (b.user_id === old) b.user_id = NEW_ID;
    const grants = partnersOf(); grants[NEW_ID] = grants[old]; delete grants[old];
    accounts['auth-pat'].app_metadata.zaptill_partner[B] = NEW_ID;
    Object.assign(row, { permissions_version: 1, roles: { id: R_GM, name: 'General Manager', role_permissions: grantsOf(roles[R_GM].keys) },
      user_permissions: [], user_branches: [{ branch_id: BR2 }] });
    accounts['auth-pat'].password = 'pat-pass-1234';
    const s = await partnerLogin({ email: PAT, password: 'pat-pass-1234', subdomain: 'pollo' });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const t = jwt.decode(s.body.accessToken);
    assert.equal(t.webPartner, true); assert.equal(t.isOwner, false); assert.equal(t.userId, row.id);
    assert.deepEqual(t.partnerBranches, [BR2]); assert.equal(t.allBranches, false);
    assert.equal(partnersOf()[row.id].status, 'active');
  });
  reset();
  await ok('a POS PIN may be given too (checked as for anyone)', async () => {
    const bad = await call('POST', '/api/staff', ownerToken(), { ...NEW_PARTNER, pin: '12' });
    assert.equal(bad.status, 400); assert.equal(byEmail(PAT), undefined);
    const r = await call('POST', '/api/staff', ownerToken(), { ...NEW_PARTNER, pin: '4321' });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.ok(byEmail(PAT).pin_hash, 'the PIN stored (hashed)');
  });
  reset();
  await ok('the invitation e-mail failing: the partner is added with access, and the owner is told to resend (207)', async () => {
    mailOk = false;
    const r = await call('POST', '/api/staff', ownerToken(), NEW_PARTNER);
    assert.equal(r.status, 207, JSON.stringify(r.body)); assert.match(r.body.warning, /Resend invite/);
    assert.equal(partnersOf()[byEmail(PAT).id].status, 'invited');
  });

  // ── 2. The owner's alone ─────────────────────────────────────────────────────────────────────────────────────────
  reset();
  await ok('a manager (holding staff.edit) is refused: 403 "Only the owner can add a partner.", nobody added', async () => {
    const r = await call('POST', '/api/staff', managerToken(), { ...NEW_PARTNER, branch_ids: [BR] });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWNER_ONLY');
    assert.equal(r.body.error, 'Only the owner can add a partner.');
    assert.equal(byEmail(PAT), undefined); assert.equal(accounts['auth-pat'], undefined);
  });
  await ok('a partner (every permission) is refused: a partner never makes another partner', async () => {
    const gina = await partnerLogin({ email: GINA, password: 'gina-pass-12', subdomain: 'pollo' });
    assert.equal(gina.status, 200, JSON.stringify(gina.body));
    const r = await call('POST', '/api/staff', gina.body.accessToken, NEW_PARTNER);
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWNER_ONLY');
    assert.equal(byEmail(PAT), undefined); assert.equal(partnersOf()[GM].status, 'active');
    assert.equal(Object.keys(partnersOf()).length, 1);
  });
  await ok('…without the partner flag, a manager adds staff exactly as before (a PIN still required)', async () => {
    const noPin = await call('POST', '/api/staff', managerToken(), { name: 'Sam', role_id: R_OPS });
    assert.equal(noPin.status, 400);
    const r = await call('POST', '/api/staff', managerToken(), { name: 'Sam', role_id: R_OPS, pin: '1234' });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.web_access, undefined);
  });

  // ── 3. An e-mail is required ─────────────────────────────────────────────────────────────────────────────────────
  reset();
  await ok('an e-mail is required: none, or not an address → 400, nobody added', async () => {
    const none = await call('POST', '/api/staff', ownerToken(), { ...NEW_PARTNER, email: undefined });
    assert.equal(none.status, 400, JSON.stringify(none.body)); assert.equal(none.body.code, 'NO_EMAIL');
    assert.match(none.body.error, /needs an email address/);
    const bad = await call('POST', '/api/staff', ownerToken(), { ...NEW_PARTNER, email: 'pat' });
    assert.equal(bad.status, 400);
    assert.equal(mem.db.users.length, 4, 'nobody added');
  });
  await ok('the owner\'s own e-mail is refused, and nobody is left on the list', async () => {
    const r = await call('POST', '/api/staff', ownerToken(), { ...NEW_PARTNER, email: OWNER_MAIL });
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWNER_ACCOUNT');
    assert.match(r.body.error, /^The partner was not added\. That email is the owner's own sign-in\./);
    assert.equal(mem.db.users.filter((x) => x.name === 'Pat').length, 0, 'taken off again');
    assert.deepEqual(accounts['auth-owner'].app_metadata, {}, 'the owner\'s account is not linked to anyone');
  });
  await ok('no General Manager role (the owner deleted it): a plain refusal, nobody added', async () => {
    mem.db.roles = mem.db.roles.filter((r) => r.id !== R_GM);
    const r = await call('POST', '/api/staff', ownerToken(), NEW_PARTNER);
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'NO_PARTNER_ROLE');
    assert.match(r.body.error, /General Manager/);
    assert.equal(byEmail(PAT), undefined);
  });

  // ── 4. All or nothing ────────────────────────────────────────────────────────────────────────────────────────────
  reset();
  await ok('the sign-in link failing leaves nobody half made: refused, not on the list, no branches, no grant', async () => {
    linkFails = true;
    try {
      const r = await call('POST', '/api/staff', ownerToken(), NEW_PARTNER);
      assert.equal(r.status, 502, JSON.stringify(r.body)); assert.equal(r.body.not_added, true);
      assert.match(r.body.error, /^The partner was not added\./);
    } finally { linkFails = false; }
    assert.equal(byEmail(PAT), undefined, 'not on the staff list');
    assert.equal(mem.db.users.length, 4);
    assert.equal(mem.db.user_branches.filter((b) => b.branch_id === BR2).length, 0, 'no branch rows left');
    assert.equal(Object.keys(partnersOf()).length, 1, 'no grant');
  });
  reset();
  await ok('the grant failing to save: nobody left, and the sign-in account names nobody', async () => {
    mem.fail = (table, op) => (table === 'business_settings' && op !== 'select' ? { message: 'timeout', code: '57014' } : null);
    const r = await call('POST', '/api/staff', ownerToken(), NEW_PARTNER);
    assert.equal(r.status, 500, JSON.stringify(r.body)); assert.equal(r.body.not_added, true);
    assert.equal(byEmail(PAT), undefined);
    assert.deepEqual(accounts['auth-pat']?.app_metadata.zaptill_partner ?? {}, {}, 'the link taken off again');
  });
  reset();
  await ok('…and when they cannot be taken off again, the owner is told plainly what state they are in', async () => {
    linkFails = true;
    mem.fail = (table, op) => (table === 'users' && op === 'delete' ? { message: 'timeout', code: '57014' } : null);
    try {
      const r = await call('POST', '/api/staff', ownerToken(), NEW_PARTNER);
      assert.equal(r.status, 500, JSON.stringify(r.body)); assert.equal(r.body.code, 'PARTNER_HALF_MADE');
      assert.match(r.body.error, /without web dashboard access/); assert.match(r.body.error, /Give web access/);
    } finally { linkFails = false; }
    assert.ok(byEmail(PAT), 'still on the list, as the message says');
    assert.equal(Object.keys(partnersOf()).length, 1, 'no grant');
  });

  // ── 5. "Give web access" is unchanged (the same function) ────────────────────────────────────────────────────────
  reset();
  await ok('"Give web access" answers exactly as before: 200 invited; the owner\'s role refused; a manager refused', async () => {
    const r = await call('POST', `/api/staff/${CASH}/web-access`, ownerToken(), {});
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body, { status: 'invited', emailed: true });
    const own = await call('POST', `/api/staff/${OWNER}/web-access`, ownerToken(), {});
    assert.equal(own.status, 400); assert.equal(own.body.code, 'OWNER_ROLE');
    const mgr = await call('POST', `/api/staff/${CASH}/web-access`, managerToken(), {});
    assert.equal(mgr.status, 403); assert.equal(mgr.body.code, 'OWNER_ONLY');
  });

  // ── 6. The dashboard ─────────────────────────────────────────────────────────────────────────────────────────────
  const tab = read('apps/dashboard/src/pages/settings/StaffTab.tsx');
  const ts = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('typescript');
  const src = tab.slice(tab.indexOf('export const PARTNER_VALUE'), tab.indexOf('// A423:'));
  const js = ts.transpileModule(`${src.replace(/export /g, '')}\nmodule.exports = { PARTNER_VALUE, PARTNER_HINT, withPartnerOption, isPartnerAccess };`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const D = (() => { const m = { exports: {} }; new Function('module', 'exports', js)(m, m.exports); return m.exports; })();
  const LIST = ['Accountant', 'Auditor', 'Cashier', 'Finance Manager', 'General Manager', 'Kitchen', 'Kitchen Manager', 'Manager',
    'Operations Manager', 'Storekeeper', 'Supervisor', 'Waiter'].map((name, i) => ({ id: `r${i}`, name }));

  await ok('the Role list shows Partner only when asked (the owner adding someone), in its place by name', () => {
    assert.deepEqual(D.withPartnerOption(LIST, false).map((r) => r.name), LIST.map((r) => r.name), 'nobody else sees it');
    const names = D.withPartnerOption(LIST, true).map((r) => r.name);
    assert.equal(names.length, LIST.length + 1);
    assert.equal(names[names.indexOf('Partner') - 1], 'Operations Manager'); assert.equal(names[names.indexOf('Partner') + 1], 'Storekeeper');
    assert.equal(D.withPartnerOption(LIST, true).find((r) => r.name === 'Partner').id, D.PARTNER_VALUE);
    assert.deepEqual(D.withPartnerOption([], true).map((r) => r.name), ['Partner']);
  });
  // A608 part 3 (owner, 2026-10-29, "yes to all"): a partner who edits staff gives web access too (webAccess), but adding a
  // Partner stays the owner's — its own prop, `partners={isOwner}`. The web manager portal is retired (no StaffTab there).
  await ok('only the owner\'s dashboard asks: partnerOption is `partners` (isOwner) and adding', () => {
    assert.match(tab, /partnerOption=\{partners && !editing\}/);
    assert.match(read('apps/dashboard/src/pages/settings/UsersAccessPage.tsx'), /<StaffTab[^>]*partners=\{isOwner\}/);
    assert.ok(!fs.existsSync(path.join(ROOT, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx')), 'the manager portal is gone');
    assert.match(tab, /const isPartner = partnerOption && !editing && roleId === PARTNER_VALUE;/);
    assert.match(tab, /options: withPartnerOption\(basePicker\.options, partnerOption && !editing\)/);
    assert.match(tab, /\{picker\.options\.map\(r => <option/);
  });
  await ok('the hint under the field, word for word, and the e-mail required for a partner', () => {
    assert.equal(D.PARTNER_HINT, 'Full rights like the owner at the branches you tick, and a password sign-in to this web dashboard. Never the owner\'s own settings.');
    assert.match(tab, /\{isPartner && <p [^>]*data-testid="staff-partner-hint">\{PARTNER_HINT\}<\/p>\}/);
    assert.match(tab, /if \(isPartner && !email\.trim\(\)\.includes\('@'\)\)/);
    assert.match(tab, /partner: true,/);
    assert.doesNotMatch(tab, /\btill\b/i, 'POS, never till');
  });
  await ok('the staff list labels the partners: web access invited or active, never revoked', () => {
    assert.equal(D.isPartnerAccess({ status: 'invited' }), true); assert.equal(D.isPartnerAccess({ status: 'active' }), true);
    assert.equal(D.isPartnerAccess({ status: 'revoked' }), false); assert.equal(D.isPartnerAccess(undefined), false);
    assert.match(tab, /\{webAccess && isPartnerAccess\(web\[s\.id\]\) && \(/);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
