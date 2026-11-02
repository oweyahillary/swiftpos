/**
 * partner-login-a550.test.mjs — A550: partner login. Someone on the staff the OWNER lets into the full web dashboard with
 * an e-mail and a password, at the owner's own address — "full rights like an owner but not the owner".
 *
 *   node tests/partner-login-a550.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the real cloud: the COMPILED auth, staff, branches, business, controls and kitchen routers behind the REAL auth
 * middleware, on a real Express server, over HTTP with real signed tokens. Only the database (an in-memory PostgREST,
 * tests/lib-memdb.mjs), Supabase Auth (the password check and the admin API) and the mailer are stand-ins.
 *
 * MUTATIONS TO CONFIRM BITE (each was made, a test failed, and it was put back):
 *   - checkPartner without the grant check (partnerLive)           → "a revoked partner gets the wrong-password answer" fails
 *   - resolvePartnerSignIn without the business narrowing         → "on the other client's address … wrong business" fails
 *   - partnerSignIn without the one-time code (otpGate)            → "the partner is asked for the code" fails
 *   - the middleware setting isOwner for a partner                 → "a partner is never the owner" fails
 *   - partnerRequestBranch taking any X-Branch-Id                  → "a branch not theirs is never taken" fails
 *   - ownerOnly() letting a non-owner through                      → "only the owner gives web access" fails
 *   - endPartnerAccess not moving permissions_version on           → "revoking signs them out at once" fails
 *   - the refresh partner path without checkPartner               → "a revoked partner cannot renew" fails
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
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'lib/webPartners.js'))) {
  console.log('\nCannot load apps/server/dist/lib/webPartners.js — build the server first:\n  cd apps/server && npm run build\n');
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
mailer.sendEmailChecked = async (o) => { mails.push(o); return { ok: true, provider: 'resend' }; };
mailer.sendEmail = async (o) => { mails.push(o); return true; };
const authCache = require(path.join(DIST, 'lib/authCache.js'));
const attempts = require(path.join(DIST, 'lib/pinAttempts.js'));
const rbac = require(path.join(DIST, 'middleware/rbac.js'));
const { requireAuth } = require(path.join(DIST, 'middleware/auth.js'));
const WP = require(path.join(DIST, 'lib/webPartners.js'));
const P = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
const jwt = require('jsonwebtoken');
const express = require('express');

// ── The businesses, people and sign-in accounts ──────────────────────────────────────────────────────────────────────
const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = u(900), BR = u(901), BR2 = u(902), B2 = u(910), BR3 = u(911), FOREIGN = u(999);
const OWNER = u(1), GM = u(2), OPS = u(3), ACC = u(4), CASH = u(5), GM2 = u(6), OWNER2 = u(7);
const R_OWNER = u(800), R_GM = u(801), R_OPS = u(802), R_ACC = u(803), R_CASH = u(804), R_GM2 = u(805);
const keysOf = (name) => [...P.BUILT_IN_ROLES.find((r) => r.name === name).keys];
const roles = {
  [R_OWNER]: { id: R_OWNER, business_id: B, name: 'Admin', keys: [] },
  [R_GM]: { id: R_GM, business_id: B, name: 'General Manager', keys: keysOf('General Manager') },
  [R_OPS]: { id: R_OPS, business_id: B, name: 'Operations Manager', keys: keysOf('Operations Manager') },
  [R_ACC]: { id: R_ACC, business_id: B, name: 'Accountant', keys: keysOf('Accountant') },
  [R_CASH]: { id: R_CASH, business_id: B, name: 'Cashier', keys: keysOf('Cashier') },
  [R_GM2]: { id: R_GM2, business_id: B2, name: 'General Manager', keys: keysOf('General Manager') },
};
const grantsOf = (keys) => keys.map((k) => ({ permissions: { key: k } }));
const person = (id, biz, name, email, roleId, branches) => ({
  id, business_id: biz, name, email, status: 'active', permissions_version: 1, role_id: roleId, must_change_password: false,
  roles: { id: roleId, name: roles[roleId].name, role_permissions: grantsOf(roles[roleId].keys) },
  user_permissions: [], user_branches: branches.map((b) => ({ branch_id: b })),
});
const GINA = 'gina@pollo.test', OTTO = 'otto@pollo.test', ABBY = 'abby@pollo.test', JOE = 'joe@pollo.test', OWNER_MAIL = 'owner@pollo.test';
let accounts;
const record = (auth, status = 'active') => ({ auth_user_id: auth, status, granted_at: '2026-10-21T08:00:00Z', granted_by: OWNER });
const reset = () => {
  attempts._resetAttempts();
  authCache._resetAuthCache();
  mails.length = 0;
  mem.fail = () => null; mem.calls = [];
  accounts = {
    'auth-owner': { id: 'auth-owner', email: OWNER_MAIL, password: 'owner-pass-1', app_metadata: {} },
    'auth-gina': { id: 'auth-gina', email: GINA, password: 'gina-pass-12', app_metadata: { zaptill_partner: { [B]: GM, [B2]: GM2 } } },
    'auth-otto': { id: 'auth-otto', email: OTTO, password: 'otto-pass-12', app_metadata: { zaptill_partner: { [B]: OPS } } },
    'auth-abby': { id: 'auth-abby', email: ABBY, password: 'abby-pass-12', app_metadata: { zaptill_partner: { [B]: ACC } } },
  };
  mem.db = {
    businesses: [
      { id: B, owner_id: 'auth-owner', name: 'Pollo', status: 'active', type: 'restaurant', subdomain: 'pollo', currency: 'KES' },
      { id: B2, owner_id: 'auth-owner2', name: 'Kuku', status: 'active', type: 'restaurant', subdomain: 'kuku', currency: 'KES' },
    ],
    branches: [{ id: BR, business_id: B, name: 'Westlands', status: 'active', is_main: true },
      { id: BR2, business_id: B, name: 'Kilimani', status: 'active', is_main: false },
      { id: BR3, business_id: B2, name: 'CBD', status: 'active', is_main: true }],
    roles: Object.values(roles).map(({ keys, ...r }) => r),
    role_permissions: [], permissions: P.PERMISSION_KEYS.map((k, i) => ({ id: `perm-${i}`, key: k })),
    users: [
      person(OWNER, B, 'Owner', OWNER_MAIL, R_OWNER, [BR]),
      person(GM, B, 'Gina', GINA, R_GM, []),
      person(OPS, B, 'Otto', OTTO, R_OPS, [BR]),
      person(ACC, B, 'Abby', ABBY, R_ACC, []),
      person(CASH, B, 'Joe', JOE, R_CASH, [BR]),
      person(GM2, B2, 'Gina', GINA, R_GM2, []),
      { ...person(OWNER2, B2, 'Kuku owner', 'owner@kuku.test', R_GM2, []), roles: { id: R_GM2, name: 'owner', role_permissions: [] } },
    ],
    user_branches: [], user_permissions: [], refresh_tokens: [], login_otp_codes: [], password_reset_codes: [],
    notifications: [], user_devices: [],
    business_settings: [
      { id: 'bs-1', business_id: B, key: 'web_partners', value: { [GM]: record('auth-gina'), [OPS]: record('auth-otto'), [ACC]: record('auth-abby') } },
      { id: 'bs-2', business_id: B2, key: 'web_partners', value: { [GM2]: record('auth-gina') } },
    ],
    feature_flags: [{ business_id: B, key: 'web_hosting', enabled: true }, { business_id: B2, key: 'web_hosting', enabled: true }],
  };
  for (const p of mem.db.users) for (const b of p.user_branches) mem.db.user_branches.push({ user_id: p.id, branch_id: b.branch_id });
};
const userRow = (id) => mem.db.users.find((x) => x.id === id);
const partnersOf = (biz) => mem.db.business_settings.find((r) => r.business_id === biz && r.key === 'web_partners')?.value ?? {};
const userView = (a) => ({ id: a.id, email: a.email, app_metadata: JSON.parse(JSON.stringify(a.app_metadata)),
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });

// Supabase Auth — the password check (authClient) and the admin API (service role).
const adminCalls = [];
authClient.auth.signInWithPassword = async ({ email, password }) => {
  const a = Object.values(accounts).find((x) => x.email === String(email).toLowerCase());
  if (!a || a.password !== password) return { data: { user: null }, error: { message: 'Invalid login credentials' } };
  return { data: { user: userView(a) }, error: null };
};
supabase.auth = { admin: {
  getUserById: async (id) => ({ data: { user: accounts[id] ? userView(accounts[id]) : null }, error: null }),
  updateUserById: async (id, attrs) => {
    adminCalls.push({ op: 'update', id, attrs });
    if (!accounts[id]) return { data: null, error: { message: 'not found' } };
    if (attrs.app_metadata) accounts[id].app_metadata = JSON.parse(JSON.stringify(attrs.app_metadata));
    if (attrs.password) accounts[id].password = attrs.password;
    return { data: { user: userView(accounts[id]) }, error: null };
  },
  createUser: async ({ email, password }) => {
    adminCalls.push({ op: 'create', email });
    if (Object.values(accounts).some((a) => a.email === email)) return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
    const id = `auth-${email.split('@')[0]}`;
    accounts[id] = { id, email, password, app_metadata: {} };
    return { data: { user: userView(accounts[id]) }, error: null };
  },
  generateLink: async ({ email }) => {
    adminCalls.push({ op: 'link', email });
    const a = Object.values(accounts).find((x) => x.email === email);
    return a ? { data: { user: userView(a), properties: {} }, error: null } : { data: null, error: { message: 'User not found' } };
  },
  inviteUserByEmail: async () => ({ data: {}, error: null }),
} };

// ── The real routers on a real server ────────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
app.use('/api/staff', require(path.join(DIST, 'routes/staff.js')).default);
app.use('/api/branches', require(path.join(DIST, 'routes/branches.js')).default);
app.use('/api/business', require(path.join(DIST, 'routes/business.js')).default);
app.use('/api/controls', require(path.join(DIST, 'routes/controls.js')).default);
app.use('/api/kitchen', require(path.join(DIST, 'routes/kitchen.js')).default);
const probe = express.Router();
probe.get('/who', requireAuth, (req, res) => res.json({
  isOwner: req.isOwner, webPartner: req.webPartner, userId: req.userId, branchId: req.branchId, allBranches: req.allBranches,
  scope: rbac.branchScope(req), atBR: rbac.assertBranchAccess(req, BR), atBR2: rbac.assertBranchAccess(req, BR2),
  atForeign: rbac.assertBranchAccess(req, FOREIGN), full: rbac.allBranchAccess(req),
}));
probe.get('/tax', requireAuth, rbac.requirePermission('reports.tax'), (_req, res) => res.json({ ok: true }));
probe.get('/staff-edit', requireAuth, rbac.requirePermission('staff.edit'), (_req, res) => res.json({ ok: true }));
probe.get('/payables', requireAuth, rbac.requirePermission('payables.manage'), (_req, res) => res.json({ ok: true }));
app.use('/api/probe', probe);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = (body) => call('POST', '/api/auth/login', null, body);
const codeFrom = (to) => {
  const m = [...mails].reverse().find((x) => String(x.to) === to && /sign-in code: (\d{6})/.test(x.subject));
  return m ? m.subject.match(/(\d{6})/)[1] : null;
};
/** Password, then the emailed code — as the sign-in page does. */
const partnerLogin = async (body) => {
  const first = await login(body);
  if (first.status !== 403 || first.body?.code !== 'OTP_REQUIRED') return first;
  return login({ ...body, otp_code: codeFrom(body.email) });
};
const ownerToken = () => jwt.sign({ userId: OWNER, businessId: B, branchId: null, isOwner: true, ownerLogin: true, permissionKeys: ['*'],
  permissionsVersion: 1, sessionId: 's-owner' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const GENERIC = { error: 'Invalid email or password' };

try {
  console.log('\nA550 — partner login\n');

  // ── 1. Sign-in ───────────────────────────────────────────────────────────────────────────────────────────────────
  reset();
  await ok('the owner\'s sign-in is unchanged: no code (sign-in codes off), the owner\'s token, every key', async () => {
    const r = await login({ email: OWNER_MAIL, password: 'owner-pass-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = jwt.decode(r.body.accessToken);
    assert.equal(t.isOwner, true); assert.equal(t.ownerLogin, true); assert.deepEqual(t.permissionKeys, ['*']);
    assert.equal(t.webPartner, undefined); assert.equal(r.body.partner, undefined);
    assert.equal((await login({ email: OWNER_MAIL, password: 'owner-pass-1', subdomain: 'pollo' })).status, 200, 'on their own address too');
  });
  await ok('…and the owner on ANOTHER client\'s address is still NOT_THIS_BUSINESS (A378, unchanged)', async () => {
    const r = await login({ email: OWNER_MAIL, password: 'owner-pass-1', subdomain: 'kuku' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'NOT_THIS_BUSINESS');
  });
  await ok('the partner is asked for the one-time code (always — sign-in codes are off for this client), then signed in', async () => {
    const first = await login({ email: GINA, password: 'gina-pass-12', subdomain: 'pollo' });
    assert.equal(first.status, 403, JSON.stringify(first.body)); assert.equal(first.body.code, 'OTP_REQUIRED');
    assert.ok(codeFrom(GINA), 'the code went to the partner\'s own address');
    const r = await login({ email: GINA, password: 'gina-pass-12', subdomain: 'pollo', otp_code: codeFrom(GINA) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.partner, true); assert.equal(r.body.business.id, B);
  });
  reset();
  await ok('a partner is never the owner: their own users row, their own keys (never \'*\'), every branch', async () => {
    const r = await partnerLogin({ email: GINA, password: 'gina-pass-12', subdomain: 'pollo' });
    const t = jwt.decode(r.body.accessToken);
    assert.equal(t.isOwner, false); assert.equal(t.webPartner, true); assert.equal(t.userId, GM); assert.equal(t.businessId, B);
    assert.ok(!t.permissionKeys.includes('*')); assert.deepEqual([...t.permissionKeys].sort(), P.PERMISSION_KEYS.filter((k) => k !== 'attendance.devices').sort());   // A599: the GM sees and corrects attendance, devices are the owner's / partners' by rule
    assert.equal(t.allBranches, true); assert.deepEqual([...t.partnerBranches].sort(), [BR, BR2].sort()); assert.equal(t.branchId, null);
    assert.equal(t.surface, 'web'); assert.equal(t.ownerLogin, undefined);
    const who = await call('GET', '/api/probe/who', r.body.accessToken);
    assert.equal(who.body.isOwner, false); assert.equal(who.body.webPartner, true); assert.equal(who.body.userId, GM);
  });
  reset();
  await ok('the same e-mail in two businesses: refused as ambiguous with no address — the choice, never a guess', async () => {
    const r = await partnerLogin({ email: GINA, password: 'gina-pass-12' });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'MULTIPLE_BUSINESSES');
    assert.deepEqual(r.body.businesses.map((b) => b.id).sort(), [B, B2].sort());
    assert.equal(mem.db.refresh_tokens.length, 0, 'no session');
  });
  await ok('…the business picked, or the client\'s own address, opens the right one (its own users row)', async () => {
    const picked = await partnerLogin({ email: GINA, password: 'gina-pass-12', business_id: B2 });
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    assert.equal(jwt.decode(picked.body.accessToken).userId, GM2); assert.equal(jwt.decode(picked.body.accessToken).businessId, B2);
    reset();
    const there = await partnerLogin({ email: GINA, password: 'gina-pass-12', subdomain: 'kuku' });
    assert.equal(there.status, 200); assert.equal(jwt.decode(there.body.accessToken).businessId, B2);
  });
  reset();
  await ok('on the other client\'s address (wrong business), a wrong address, a wrong password: refused', async () => {
    const wrongBiz = await login({ email: OTTO, password: 'otto-pass-12', subdomain: 'kuku' });
    assert.equal(wrongBiz.status, 401); assert.deepEqual(wrongBiz.body, GENERIC);
    const picked = await login({ email: OTTO, password: 'otto-pass-12', business_id: B2 });
    assert.equal(picked.status, 401); assert.deepEqual(picked.body, GENERIC);
    const unknown = await login({ email: OTTO, password: 'otto-pass-12', subdomain: 'nowhere' });
    assert.equal(unknown.status, 404); assert.equal(unknown.body.code, 'UNKNOWN_SUBDOMAIN');
    const wrongPw = await login({ email: OTTO, password: 'not-it-at-all', subdomain: 'pollo' });
    assert.equal(wrongPw.status, 401); assert.deepEqual(wrongPw.body, GENERIC);
    assert.equal(mem.db.refresh_tokens.length, 0);
  });
  const refused = async (name, prepare) => {
    reset(); prepare();
    const r = await login({ email: OTTO, password: 'otto-pass-12', subdomain: 'pollo' });
    assert.equal(r.status, 401, `${name}: ${JSON.stringify(r.body)}`); assert.deepEqual(r.body, GENERIC, name);
    assert.equal(mails.length, 0, `${name}: no code is sent`);
  };
  await ok('a revoked partner gets the wrong-password answer, word for word (no code sent, no session)', () =>
    refused('revoked', () => { partnersOf(B)[OPS].status = 'revoked'; }));
  await ok('so do an inactive staff member, a deleted one, and one moved to the owner\'s role', async () => {
    await refused('inactive', () => { userRow(OPS).status = 'inactive'; });
    await refused('deleted', () => { mem.db.users = mem.db.users.filter((x) => x.id !== OPS); });
    await refused('owner role', () => { userRow(OPS).roles = { id: R_OWNER, name: 'Admin', role_permissions: [] }; userRow(OPS).role_id = R_OWNER; });
  });
  await ok('BOTH records are required: the account\'s link without the grant, the grant without the link, a grant naming another account', async () => {
    await refused('no grant', () => { delete partnersOf(B)[OPS]; });
    await refused('no link', () => { accounts['auth-otto'].app_metadata = {}; });
    await refused('another account', () => { partnersOf(B)[OPS].auth_user_id = 'auth-abby'; });
    await refused('link to another person', () => { accounts['auth-otto'].app_metadata = { zaptill_partner: { [B]: CASH } }; });
  });
  reset();
  await ok('A494: ten wrong passwords pause the account (per account, from anywhere)', async () => {
    for (let i = 0; i < 10; i++) await login({ email: OTTO, password: `wrong-${i}-xx`, subdomain: 'pollo' });
    const r = await login({ email: OTTO, password: 'otto-pass-12', subdomain: 'pollo' });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'ACCOUNT_LOCKED');
  });

  // ── 2. Branches ──────────────────────────────────────────────────────────────────────────────────────────────────
  reset();
  const gina = (await partnerLogin({ email: GINA, password: 'gina-pass-12', subdomain: 'pollo' })).body;
  const otto = (await partnerLogin({ email: OTTO, password: 'otto-pass-12', subdomain: 'pollo' })).body;
  await ok('a partner of every branch: the owner\'s picker — every branch, or the one picked; a branch not theirs is never taken', async () => {
    const all = (await call('GET', '/api/probe/who', gina.accessToken)).body;
    assert.equal(all.scope, null); assert.equal(all.full, true); assert.equal(all.atBR, true); assert.equal(all.atBR2, true); assert.equal(all.atForeign, false);
    const picked = (await call('GET', '/api/probe/who', gina.accessToken, undefined, { 'x-branch-id': BR2 })).body;
    assert.equal(picked.branchId, BR2); assert.equal(picked.scope, BR2);
    const foreign = (await call('GET', '/api/probe/who', gina.accessToken, undefined, { 'x-branch-id': FOREIGN })).body;
    assert.equal(foreign.branchId, null); assert.equal(foreign.scope, null, 'another business\'s branch is ignored');
    assert.equal((await call('GET', `/api/probe/who?branch_id=${FOREIGN}`, gina.accessToken)).body.scope, null);
  });
  await ok('a partner of some branches: like a manager at the one picked — never "all", never another branch', async () => {
    const t = jwt.decode(otto.accessToken);
    assert.equal(t.allBranches, false); assert.deepEqual(t.partnerBranches, [BR]); assert.equal(t.branchId, BR);
    const w = (await call('GET', '/api/probe/who', otto.accessToken, undefined, { 'x-branch-id': BR2 })).body;
    assert.equal(w.branchId, BR); assert.equal(w.scope, BR); assert.equal(w.full, false); assert.equal(w.atBR2, false);
    const list = await call('GET', '/api/branches', otto.accessToken);
    assert.deepEqual(list.body.map((b) => b.id), [BR], 'the picker offers only theirs');
    const s = (await call('GET', '/api/auth/session', otto.accessToken)).body;
    assert.equal(s.partner, true); assert.equal(s.owner, false); assert.equal(s.allBranches, false); assert.deepEqual(s.branchIds, [BR]);
    assert.equal((await call('GET', '/api/auth/session', gina.accessToken)).body.allBranches, true);
    assert.equal((await call('GET', '/api/auth/session', ownerToken())).body.owner, true);
  });

  // ── 3. What is the owner's alone — refused to a partner holding EVERY key ────────────────────────────────────────
  // A608 part 3 (owner, 2026-10-29, "yes to all"): web dashboard access is no longer the owner's alone — a partner who
  // edits staff gives, re-sends, lists and takes it away for someone within their keys and branches (never their own,
  // never a General Manager). The full rules: tests/staff-signin-by-role-a608.test.mjs section 9.
  await ok('a partner who edits staff gives, lists and takes away web dashboard access (A608) — never their own', async () => {
    const list = await call('GET', '/api/staff/web-access', gina.accessToken);
    assert.equal(list.status, 200, JSON.stringify(list.body)); assert.equal(list.body[OPS].status, 'active');
    const give = await call('POST', `/api/staff/${CASH}/web-access`, gina.accessToken, {});
    assert.equal(give.status, 200, JSON.stringify(give.body)); assert.equal(partnersOf(B)[CASH].status, 'invited');
    const own = await call('DELETE', `/api/staff/${GM}/web-access`, gina.accessToken);
    assert.equal(own.status, 403, JSON.stringify(own.body)); assert.equal(own.body.code, 'OWN_WEB_ACCESS');
    const off = await call('DELETE', `/api/staff/${CASH}/web-access`, gina.accessToken);
    assert.equal(off.status, 200, JSON.stringify(off.body)); assert.equal(partnersOf(B)[CASH].status, 'revoked');
    assert.equal(partnersOf(B)[OPS].status, 'active'); assert.equal(partnersOf(B)[GM].status, 'active');
  });
  await ok('owner-only: the owner\'s staff record, the owner\'s role, the owner\'s sign-in code reset', async () => {
    const own = await call('PATCH', `/api/staff/${OWNER}`, gina.accessToken, { name: 'Not the owner' });
    assert.equal(own.status, 403, JSON.stringify(own.body)); assert.equal(userRow(OWNER).name, 'Owner');
    const promote = await call('PATCH', `/api/staff/${CASH}`, gina.accessToken, { role_id: R_OWNER });
    assert.equal(promote.status, 403, JSON.stringify(promote.body)); assert.equal(userRow(CASH).role_id, R_CASH);
    const make = await call('POST', '/api/staff', gina.accessToken, { name: 'Ollie', role_id: R_OWNER, pin: '4321' });
    assert.equal(make.status, 403); assert.ok(!mem.db.users.some((x) => x.name === 'Ollie'));
    const otp = await call('POST', `/api/staff/${OPS}/reset-otp`, gina.accessToken, {});
    assert.equal(otp.status, 403);
  });
  await ok('owner-only: a partner never changes their own role, keys or branches (A494 OWN_ACCESS)', async () => {
    const r = await call('PATCH', `/api/staff/${GM}`, gina.accessToken, { role_id: R_CASH });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'OWN_ACCESS');
    const k = await call('PATCH', `/api/staff/${GM}`, gina.accessToken, { override_keys: { 'staff.roles': false } });
    assert.equal(k.status, 403); assert.equal(k.body.code, 'OWN_ACCESS');
  });
  await ok('owner-only: the sign-in-code switch, the M-Pesa credentials, the kitchen display key', async () => {
    const codes = await call('PUT', '/api/controls/pos/login_codes', gina.accessToken, { enabled: false });
    assert.equal(codes.status, 403); assert.equal(codes.body.code, 'OWNER_ONLY');
    const mpesa = await call('POST', '/api/business/settings', gina.accessToken, { key: 'mpesa_passkey', value: 'x' });
    assert.equal(mpesa.status, 403, JSON.stringify(mpesa.body)); assert.equal(mpesa.body.code, 'OWNER_ONLY');
    const kds = await call('POST', '/api/kitchen/kds-token', gina.accessToken, { branch_id: BR });
    assert.equal(kds.status, 403);
  });
  await ok('the grants are never written through the settings route — not even by the owner', async () => {
    const r = await call('POST', '/api/business/settings', ownerToken(), { key: 'web_partners', value: { x: 1 } });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'READ_ONLY_KEY');
  });
  await ok('owner-only: a partner\'s password change is THEIR OWN account\'s, never the owner\'s', async () => {
    adminCalls.length = 0;
    const r = await call('POST', '/api/auth/password/change', gina.accessToken, { current_password: 'gina-pass-12', new_password: 'gina-new-pass-34' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(adminCalls.filter((c) => c.op === 'update' && c.attrs.password).map((c) => c.id), ['auth-gina']);
    assert.equal(accounts['auth-owner'].password, 'owner-pass-1');
    accounts['auth-gina'].password = 'gina-pass-12';
  });

  // ── 4. What their keys allow ─────────────────────────────────────────────────────────────────────────────────────
  reset();
  const gm = (await partnerLogin({ email: GINA, password: 'gina-pass-12', subdomain: 'pollo' })).body.accessToken;
  const ops = (await partnerLogin({ email: OTTO, password: 'otto-pass-12', subdomain: 'pollo' })).body.accessToken;
  const acc = (await partnerLogin({ email: ABBY, password: 'abby-pass-12', subdomain: 'pollo' })).body.accessToken;
  await ok('allowed by permission: a General Manager partner lists every branch\'s staff (never the owner) and manages them', async () => {
    const list = await call('GET', '/api/staff', gm);
    assert.equal(list.status, 200);
    const ids = list.body.map((s) => s.id);
    assert.ok(ids.includes(CASH) && ids.includes(OPS), 'every branch'); assert.ok(!ids.includes(OWNER), 'never the owner');
    const edit = await call('PATCH', `/api/staff/${CASH}`, gm, { name: 'Joseph' });
    assert.equal(edit.status, 200, JSON.stringify(edit.body)); assert.equal(userRow(CASH).name, 'Joseph');
    const add = await call('POST', '/api/staff', gm, { name: 'Wanjiru', role_id: R_CASH, pin: '2468', branch_ids: [BR2] });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const away = await call('POST', '/api/staff', gm, { name: 'Far', role_id: R_CASH, pin: '1357', branch_ids: [BR3] });
    assert.equal(away.status, 403, 'never a branch that is not theirs');
  });
  await ok('allowed by permission: an Accountant partner reads the tax report and may not edit staff', async () => {
    assert.equal((await call('GET', '/api/probe/tax', acc)).status, 200);
    assert.equal((await call('GET', '/api/probe/staff-edit', acc)).status, 403);
    assert.equal((await call('GET', '/api/probe/tax', ops)).status, 403, 'an Operations Manager has no tax report');
  });
  await ok('the ceiling: an Operations Manager partner cannot grant what they do not hold, nor manage a General Manager', async () => {
    const r = await call('PATCH', `/api/staff/${CASH}`, ops, { override_keys: { 'payables.manage': true } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    const gmEdit = await call('PATCH', `/api/staff/${GM}`, ops, { name: 'Gee' });
    assert.equal(gmEdit.status, 403);
  });
  await ok('attribution: every action is recorded as the partner — their own users row, never the owner', async () => {
    assert.equal(jwt.decode(gm).userId, GM);
    const rec = require(path.join(DIST, 'lib/expenseRecorder.js'));
    assert.equal(await rec.recorderId({ userId: GM, isOwner: false, businessId: B }), GM);
    const add = mem.db.users.find((x) => x.name === 'Wanjiru');
    assert.ok(add, 'made by the partner');
  });

  // ── 5. Renewal ───────────────────────────────────────────────────────────────────────────────────────────────────
  reset();
  const s1 = (await partnerLogin({ email: OTTO, password: 'otto-pass-12', subdomain: 'pollo' })).body;
  await ok('a partner renews as a partner — keys and branches read again, never the owner', async () => {
    userRow(OPS).user_branches = [{ branch_id: BR }, { branch_id: BR2 }];
    const r = await call('POST', '/api/auth/refresh', null, { refreshToken: s1.refreshToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = jwt.decode(r.body.accessToken);
    assert.equal(t.webPartner, true); assert.equal(t.isOwner, false); assert.equal(t.allBranches, true);
    assert.ok(!t.permissionKeys.includes('*'));
    s1.refreshToken = r.body.refreshToken;
  });
  await ok('a revoked partner cannot renew', async () => {
    partnersOf(B)[OPS].status = 'revoked';
    const r = await call('POST', '/api/auth/refresh', null, { refreshToken: s1.refreshToken });
    assert.equal(r.status, 401); assert.equal(r.body.code, 'SIGN_IN_AGAIN');
  });

  // ── 6. Giving and taking away — the owner ────────────────────────────────────────────────────────────────────────
  reset();
  await ok('only the owner gives web access: a partner holding staff.edit cannot', async () => {
    const opsTok = (await partnerLogin({ email: OTTO, password: 'otto-pass-12', subdomain: 'pollo' })).body.accessToken;
    const r = await call('POST', `/api/staff/${CASH}/web-access`, opsTok, {});
    assert.equal(r.status, 403); assert.equal(partnersOf(B)[CASH], undefined);
  });
  await ok('the owner gives it: a sign-in account, the link, the grant (invited), and the invitation to the person', async () => {
    mails.length = 0; adminCalls.length = 0;
    const r = await call('POST', `/api/staff/${CASH}/web-access`, ownerToken(), {});
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'invited');
    const acct = Object.values(accounts).find((a) => a.email === JOE);
    assert.ok(acct, 'a sign-in account for the address');
    assert.deepEqual(acct.app_metadata.zaptill_partner, { [B]: CASH });
    assert.equal(partnersOf(B)[CASH].auth_user_id, acct.id); assert.equal(partnersOf(B)[CASH].status, 'invited');
    const invite = mails.find((m) => m.to === JOE);
    assert.ok(invite && /Forgot password\?/.test(invite.html) && /set_password=1/.test(invite.html), 'the invitation says how');
    assert.match(invite.html, /\/login#set_password=1&amp;email=/, 'the email rides in the fragment, never sent to a server');
    assert.doesNotMatch(invite.html, /\/login\?[^"]*email=/, 'never in the query string');
    const list = await call('GET', '/api/staff/web-access', ownerToken());
    assert.equal(list.body[CASH].status, 'invited'); assert.equal(list.body[CASH].auth_user_id, undefined, 'no account ids leave the cloud');
  });
  await ok('…they set a password with the emailed code, sign in, and the grant is active', async () => {
    mails.length = 0;
    const f = await call('POST', '/api/auth/password/forgot', null, { email: JOE });
    assert.equal(f.status, 200);
    const m = mails.find((x) => x.to === JOE && /password reset code: (\d{6})/.test(x.subject));
    assert.ok(m, 'a reset code for a partner\'s account');
    const code = m.subject.match(/(\d{6})/)[1];
    const r = await call('POST', '/api/auth/password/reset', null, { email: JOE, code, new_password: 'joe-pass-5678' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await partnerLogin({ email: JOE, password: 'joe-pass-5678', subdomain: 'pollo' });
    assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(jwt.decode(s.body.accessToken).userId, CASH);
    assert.equal(partnersOf(B)[CASH].status, 'active');
  });
  await ok('never someone on the owner\'s role (give them another role first)', async () => {
    const r = await call('POST', `/api/staff/${OWNER}/web-access`, ownerToken(), {});
    assert.equal(r.status, 400); assert.equal(r.body.code, 'OWNER_ROLE');
  });
  reset();
  const live = (await partnerLogin({ email: GINA, password: 'gina-pass-12', subdomain: 'pollo' })).body;
  await ok('revoking signs them out at once: the session cannot renew, the access token already out is refused', async () => {
    assert.equal((await call('GET', '/api/probe/who', live.accessToken)).status, 200);
    const r = await call('DELETE', `/api/staff/${GM}/web-access`, ownerToken());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(partnersOf(B)[GM].status, 'revoked');
    assert.ok(mem.db.refresh_tokens.filter((t) => t.user_id === GM).every((t) => t.revoked_at), 'every session revoked');
    const now = await call('GET', '/api/probe/who', live.accessToken);
    assert.equal(now.status, 401); assert.equal(now.body.code, 'PERMISSIONS_CHANGED');
    assert.equal((await call('POST', '/api/auth/refresh', null, { refreshToken: live.refreshToken })).status, 401);
    const again = await login({ email: GINA, password: 'gina-pass-12', subdomain: 'pollo' });
    assert.equal(again.status, 401); assert.deepEqual(again.body, GENERIC);
    assert.deepEqual(accounts['auth-gina'].app_metadata.zaptill_partner, { [B2]: GM2 }, 'the link to this business removed, the other kept');
  });
  await ok('a new e-mail address ends web access (the grant named the old address\'s account)', async () => {
    const r = await call('PATCH', `/api/staff/${OPS}`, ownerToken(), { email: 'otto.new@pollo.test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(partnersOf(B)[OPS].status, 'revoked'); assert.equal(partnersOf(B)[OPS].revoked_reason, 'email_changed');
  });

  // ── 7. The pure rules ────────────────────────────────────────────────────────────────────────────────────────────
  await ok('partnerBranchAccess: none assigned = every open branch; all of them = every branch; some = those', () => {
    assert.deepEqual(WP.partnerBranchAccess([], [BR, BR2]), { branchIds: [BR, BR2], allBranches: true });
    assert.deepEqual(WP.partnerBranchAccess([{ branch_id: BR }, { branch_id: BR2 }], [BR, BR2]), { branchIds: [BR, BR2], allBranches: true });
    assert.deepEqual(WP.partnerBranchAccess([{ branch_id: BR }, { branch_id: FOREIGN }], [BR, BR2]), { branchIds: [BR], allBranches: false });
    assert.deepEqual(WP.partnerBranchAccess([{ branch_id: FOREIGN }], [BR]), { branchIds: [], allBranches: false });
  });
  await ok('cleanPartnerMap keeps only well-formed grants; metaLinks only well-formed links', () => {
    assert.deepEqual(WP.cleanPartnerMap({ [GM]: { auth_user_id: 'a', status: 'bogus' }, nope: { auth_user_id: 'a', status: 'active' } }), {});
    assert.deepEqual(WP.metaLinks({ zaptill_partner: { [B]: GM, x: 'y', [B2]: 7 } }), [{ businessId: B, userId: GM }]);
    assert.deepEqual(WP.withMetaLink({ other: 1, zaptill_partner: { [B]: GM, [B2]: GM2 } }, B, null), { other: 1, zaptill_partner: { [B2]: GM2 } });
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
