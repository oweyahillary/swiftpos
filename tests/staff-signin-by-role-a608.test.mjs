/**
 * staff-signin-by-role-a608.test.mjs — A608: how each person signs in, by who they are (owner, 2026-10-29: "For partners
 * we don't need some fields — can the form populate based on the user? For top management let it be email only, they
 * access the dashboard. Change the shop manager to use email on web — they don't key in a PIN on the web POS; PIN on the
 * web strictly remains for cashiers. On the desktop app the PIN remains for managers.")
 *
 *   node tests/staff-signin-by-role-a608.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the real cloud: the COMPILED auth and staff routers on a real Express server, over HTTP with real signed tokens.
 * Only the database (tests/lib-memdb.mjs), Supabase Auth and the mailer are stand-ins. The card's rule
 * (apps/dashboard/src/lib/staffSignIn.ts) is RUN; how the card and the web POS sign-in use it is pinned by source.
 *
 * MUTATIONS TO CONFIRM BITE (each was made, a test failed, and it was put back):
 *   - the web_access path without ownerOnly()                  → "a manager may not send the web invitation" fails
 *   - the web_access path without undoNewStaff()               → "the sign-in link failing leaves nobody half made" fails
 *   - refusesWebPosPin returning false                         → "a manager's PIN does not open the web POS" fails
 *   - the /pos-login refusal moved before the PIN check        → "a wrong PIN says nothing about who is a manager" fails
 *   - staffSignIn ignoring the General Manager name            → "the card's rule, role by role" fails
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

if (!fs.existsSync(path.join(DIST, 'lib/webPosSignIn.js'))) {
  console.log('\nCannot load apps/server/dist/lib/webPosSignIn.js — build the server first:\n  cd apps/server && npm run build\n');
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
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const mails = [];
mailer.sendEmailChecked = async (o) => { mails.push(o); return { ok: true, provider: 'resend' }; };
mailer.sendEmail = async (o) => { mails.push(o); return true; };
const authCache = require(path.join(DIST, 'lib/authCache.js'));
const attempts = require(path.join(DIST, 'lib/pinAttempts.js'));
const W = require(path.join(DIST, 'lib/webPosSignIn.js'));
const P = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/staffSignIn.ts')).href);
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const express = require('express');

// ── The business and its people ──────────────────────────────────────────────────────────────────────────────────────
const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = u(900), BR = u(901);
const OWNER = u(1), MGR = u(3), CASH = u(5), SUP = u(6);
const R_OWNER = u(800), R_GM = u(801), R_MGR = u(803), R_CASH = u(804), R_SUP = u(805);
const keysOf = (name) => [...P.BUILT_IN_ROLES.find((r) => r.name === name).keys];
const roles = {
  [R_OWNER]: { id: R_OWNER, business_id: B, name: 'Admin', keys: [] },
  [R_GM]: { id: R_GM, business_id: B, name: 'General Manager', is_default: true, keys: keysOf('General Manager') },
  [R_MGR]: { id: R_MGR, business_id: B, name: 'Manager', keys: keysOf('Manager') },
  [R_CASH]: { id: R_CASH, business_id: B, name: 'Cashier', keys: keysOf('Cashier') },
  [R_SUP]: { id: R_SUP, business_id: B, name: 'Supervisor', keys: keysOf('Supervisor') },
};
const PIN_HASH = await bcrypt.hash('2468', 4);
const BRANCH = { id: BR, business_id: B, name: 'Westlands', status: 'active', is_main: true, desktop_licensed: true };
const grantsOf = (keys) => keys.map((k) => ({ permissions: { key: k } }));
const person = (id, name, email, roleId) => ({
  id, business_id: B, name, email, status: 'active', permissions_version: 1, role_id: roleId, must_change_password: false,
  pin_hash: PIN_HASH, override_pin_hash: null,
  roles: { id: roleId, name: roles[roleId].name, role_permissions: grantsOf(roles[roleId].keys) },
  user_permissions: [], user_branches: [{ branch_id: BR, branches: BRANCH }],
});
const MARY = 'mary@pollo.test', JOE = 'joe@pollo.test', SAM = 'sam@pollo.test', GIL = 'gil@pollo.test', SUE = 'sue@pollo.test';
let accounts, linkFails = false;
const reset = () => {
  attempts._resetAttempts();
  authCache._resetAuthCache();
  mails.length = 0; linkFails = false;
  mem.fail = () => null; mem.calls = [];
  accounts = { 'auth-owner': { id: 'auth-owner', email: 'owner@pollo.test', app_metadata: {} } };
  mem.db = {
    businesses: [{ id: B, owner_id: 'auth-owner', name: 'Pollo', status: 'active', type: 'retail', subdomain: 'pollo', currency: 'KES' }],
    branches: [BRANCH],
    roles: Object.values(roles).map(({ keys, ...r }) => r),
    role_permissions: [], permissions: P.PERMISSION_KEYS.map((k, i) => ({ id: `perm-${i}`, key: k })),
    users: [person(OWNER, 'Owner', 'owner@pollo.test', R_OWNER), person(MGR, 'Mary', MARY, R_MGR),
      person(CASH, 'Joe', JOE, R_CASH), person(SUP, 'Sue', SUE, R_SUP)],
    user_branches: [], user_permissions: [], refresh_tokens: [], login_otp_codes: [], notifications: [], user_devices: [],
    business_settings: [], feature_flags: [{ business_id: B, key: 'web_hosting', enabled: true }],
  };
  for (const p of mem.db.users) for (const b of p.user_branches) mem.db.user_branches.push({ user_id: p.id, branch_id: b.branch_id });
  for (const r of Object.values(roles)) for (const k of r.keys) mem.db.role_permissions.push({ role_id: r.id, permission_id: mem.db.permissions.find((p) => p.key === k).id, permissions: { key: k } });
};
const partnersOf = () => mem.db.business_settings.find((r) => r.business_id === B && r.key === 'web_partners')?.value ?? {};
const byEmail = (e) => mem.db.users.find((x) => x.email === e);
const userView = (a) => ({ id: a.id, email: a.email, app_metadata: JSON.parse(JSON.stringify(a.app_metadata)) });
supabase.auth = { admin: {
  getUserById: async (id) => ({ data: { user: accounts[id] ? userView(accounts[id]) : null }, error: null }),
  updateUserById: async (id, attrs) => {
    if (linkFails && attrs.app_metadata && Object.values(attrs.app_metadata.zaptill_partner ?? {}).length) return { data: null, error: { message: 'auth is down' } };
    if (!accounts[id]) return { data: null, error: { message: 'not found' } };
    if (attrs.app_metadata) accounts[id].app_metadata = JSON.parse(JSON.stringify(attrs.app_metadata));
    return { data: { user: userView(accounts[id]) }, error: null };
  },
  createUser: async ({ email }) => {
    if (Object.values(accounts).some((a) => a.email === email)) return { data: { user: null }, error: { message: 'already registered' } };
    const id = `auth-${email.split('@')[0]}`;
    accounts[id] = { id, email, app_metadata: {} };
    return { data: { user: userView(accounts[id]) }, error: null };
  },
  generateLink: async ({ email }) => {
    const a = Object.values(accounts).find((x) => x.email === email);
    return a ? { data: { user: userView(a), properties: {} }, error: null } : { data: null, error: { message: 'User not found' } };
  },
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
const ownerToken = () => jwt.sign({ userId: OWNER, businessId: B, branchId: null, isOwner: true, ownerLogin: true, permissionKeys: ['*'],
  permissionsVersion: 1, sessionId: 's-owner' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const managerToken = () => jwt.sign({ userId: MGR, businessId: B, branchId: BR, isOwner: false, permissionKeys: keysOf('Manager'),
  permissionsVersion: 1, sessionId: 's-mgr', surface: 'dashboard' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const webPos = (email, pin = '2468') => call('POST', '/api/auth/pos-login', null, { email, pin, surface: 'web', subdomain: 'pollo' });

try {
  console.log('\nA608 — staff sign-in by role\n');

  // ── 1. The card's rule ───────────────────────────────────────────────────────────────────────────────────────────
  const backOffice = (name) => P.isBackOffice(new Set(keysOf(name)));
  await ok('the card\'s rule, role by role: Partner and General Manager email only; Manager email and a desktop PIN; Cashier a PIN', () => {
    assert.equal(S.staffSignIn({ partner: true, backOffice: true }), 'web');
    assert.equal(S.staffSignIn({ roleName: 'General Manager', backOffice: true }), 'web');
    assert.equal(S.staffSignIn({ roleName: ' general_manager ', backOffice: true }), 'web', 'by name, case and spaces aside');
    assert.equal(S.staffSignIn({ roleName: 'Manager', backOffice: backOffice('Manager') }), 'web_pin');
    for (const r of ['Operations Manager', 'Accountant', 'Storekeeper']) assert.equal(S.staffSignIn({ roleName: r, backOffice: backOffice(r) }), 'web_pin', r);
    assert.equal(S.staffSignIn({ roleName: 'Cashier', backOffice: backOffice('Cashier') }), 'pin');
    assert.equal(S.staffSignIn({ roleName: 'Waiter', backOffice: backOffice('Waiter') }), 'pin');
    assert.equal(S.staffSignIn({ roleName: 'Admin', ownerRole: true, backOffice: true }), 'web_pin', 'the owner\'s role keeps its PIN');
    assert.equal(S.pinLabel('web_pin', false), 'PIN for the desktop POS (4–6 digits)');
    assert.equal(S.pinLabel('pin', true), 'PIN (leave blank to keep)');
    assert.match(S.emailHint('pin', true), /email and PIN to sign in to the POS/);
    assert.match(S.emailHint('web', false), /the owner gives them web dashboard access/);
    assert.doesNotMatch(read('apps/dashboard/src/lib/staffSignIn.ts'), /\btill\b/i, 'POS, never till');
  });
  await ok('the web POS refuses a PIN exactly where the web used to send people to its manager portal (never the owner)', () => {
    for (const r of P.BUILT_IN_ROLES) {
      const keys = new Set(r.keys);
      assert.equal(W.refusesWebPosPin(keys, false), P.isBackOffice(keys), r.name);
    }
    assert.equal(W.refusesWebPosPin(new Set(['*']), true), false, 'the owner');
    assert.equal(W.refusesWebPosPin(new Set(keysOf('Cashier')), false), false);
    assert.equal(W.refusesWebPosPin(new Set(keysOf('Manager')), false), true);
  });

  // ── 2. Adding a General Manager or Manager sends the web invitation in the same step ───────────────────────────────
  reset();
  await ok('the owner adds a General Manager: email only — no PIN, web access given, the invitation sent', async () => {
    const r = await call('POST', '/api/staff', ownerToken(), { name: 'Gil', email: GIL, role_id: R_GM, web_access: true, branch_ids: [BR] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = byEmail(GIL);
    assert.equal(row.role_id, R_GM); assert.equal(row.pin_hash, null, 'no PIN');
    assert.equal(partnersOf()[row.id]?.status, 'invited');
    assert.deepEqual(r.body.web_access, { status: 'invited', emailed: true });
    assert.ok(mails.some((m) => m.to === GIL && /Forgot password\?/.test(m.html)), 'the same invitation as "Give web access"');
  });
  reset();
  await ok('the owner adds a Manager: email and a PIN (for the desktop POS), web access given', async () => {
    const r = await call('POST', '/api/staff', ownerToken(), { name: 'Sam', email: SAM, role_id: R_MGR, pin: '1357', web_access: true, branch_ids: [BR] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = byEmail(SAM);
    assert.ok(row.pin_hash, 'the PIN stored (hashed)'); assert.equal(partnersOf()[row.id]?.status, 'invited');
  });
  reset();
  await ok('an email is required for web access: none → 400 NO_EMAIL, nobody added', async () => {
    const r = await call('POST', '/api/staff', ownerToken(), { name: 'Sam', role_id: R_MGR, pin: '1357', web_access: true });
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'NO_EMAIL');
    assert.equal(mem.db.users.length, 4);
  });
  await ok('a manager may not send the web invitation (403 OWNER_ONLY), nobody added; without it they add staff as before', async () => {
    const r = await call('POST', '/api/staff', managerToken(), { name: 'Sam', email: SAM, role_id: R_CASH, pin: '1357', web_access: true });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWNER_ONLY');
    assert.equal(byEmail(SAM), undefined);
    const noPin = await call('POST', '/api/staff', managerToken(), { name: 'Sam', email: SAM, role_id: R_CASH });
    assert.equal(noPin.status, 400, 'a PIN still required without web access');
    const plain = await call('POST', '/api/staff', managerToken(), { name: 'Sam', email: SAM, role_id: R_CASH, pin: '1357' });
    assert.equal(plain.status, 201, JSON.stringify(plain.body)); assert.equal(plain.body.web_access, undefined);
  });
  reset();
  await ok('the sign-in link failing leaves nobody half made: "Gil was not added.", no grant', async () => {
    linkFails = true;
    const r = await call('POST', '/api/staff', ownerToken(), { name: 'Gil', email: GIL, role_id: R_GM, web_access: true, branch_ids: [BR] });
    assert.equal(r.status, 502, JSON.stringify(r.body)); assert.equal(r.body.not_added, true);
    assert.match(r.body.error, /^Gil was not added\./);
    assert.equal(byEmail(GIL), undefined); assert.deepEqual(partnersOf(), {});
  });
  reset();
  await ok('…and when they cannot be taken off again: STAFF_HALF_MADE, said plainly', async () => {
    linkFails = true;
    mem.fail = (table, op) => (table === 'users' && op === 'delete' ? { message: 'timeout', code: '57014' } : null);
    const r = await call('POST', '/api/staff', ownerToken(), { name: 'Gil', email: GIL, role_id: R_GM, web_access: true });
    assert.equal(r.status, 500, JSON.stringify(r.body)); assert.equal(r.body.code, 'STAFF_HALF_MADE');
    assert.match(r.body.error, /added as General Manager but without web dashboard access/);
  });

  // ── 3. The web POS: PIN for cashiers only ──────────────────────────────────────────────────────────────────────────
  reset();
  await ok('a cashier signs in to the web POS with their PIN, as before', async () => {
    const r = await webPos(JOE);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.accessToken);
  });
  await ok('a manager\'s PIN does not open the web POS: 403 USE_WEB_DASHBOARD, no token, "ask the owner" without web access', async () => {
    const r = await webPos(MARY);
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'USE_WEB_DASHBOARD');
    assert.equal(r.body.accessToken, undefined); assert.equal(r.body.web_access, false); assert.equal(r.body.login, '/login');
    assert.match(r.body.error, /email and password/); assert.match(r.body.error, /ask the owner/i); assert.match(r.body.error, /desktop POS/);
    assert.equal(mem.db.refresh_tokens.length, 1, 'only the cashier\'s session above');
  });
  await ok('…with web access given, they are told to sign in to the dashboard (no "ask the owner")', async () => {
    mem.db.business_settings.push({ id: 'bs-1', business_id: B, key: 'web_partners',
      value: { [MGR]: { auth_user_id: 'auth-mary', status: 'active', granted_at: '2026-10-29T08:00:00Z', granted_by: OWNER } } });
    const r = await webPos(MARY);
    assert.equal(r.status, 403); assert.equal(r.body.web_access, true); assert.doesNotMatch(r.body.error, /ask the owner/i);
  });
  await ok('whatever surface is claimed — /pos-login is the web POS\'s own sign-in', async () => {
    const r = await call('POST', '/api/auth/pos-login', null, { email: MARY, pin: '2468', surface: 'desktop', branch_id: BR });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'USE_WEB_DASHBOARD');
  });
  await ok('a wrong PIN says nothing about who is a manager (the same 401 as anyone)', async () => {
    const r = await webPos(MARY, '9999');
    assert.equal(r.status, 401); assert.deepEqual(r.body, { error: 'Invalid email or PIN' });
  });
  await ok('the Supervisor lands where their keys say (the same signal as the web\'s routing)', async () => {
    const r = await webPos(SUE);
    assert.equal(r.status === 403, P.isBackOffice(new Set(keysOf('Supervisor'))), JSON.stringify(r.body));
  });

  // ── 4. The desktop POS keeps PIN sign-in for managers ──────────────────────────────────────────────────────────────
  await ok('the desktop signs in with /verify-pin (never /pos-login), and /verify-pin has no such refusal', () => {
    const auth = read('apps/server/src/routes/auth.ts');
    const at = auth.indexOf("router.post('/pos-login'");
    const verify = auth.indexOf("router.post('/verify-pin'");
    assert.ok(at > 0 && verify > 0);
    const refusal = auth.indexOf('refusesWebPosPin(effectiveKeysForRow');
    assert.ok(refusal > at, 'inside /pos-login');
    const nextRoute = auth.indexOf('router.post(', at + 10);
    assert.ok(refusal < nextRoute, 'and only there');
    assert.equal(auth.split('refusesWebPosPin(').length - 1, 1, 'one use');
    const desktop = ['apps/desktop/src/main/ipc/signIn.ts', 'apps/desktop/src/main/ipc/shared.ts'].map(read).join('\n');
    assert.match(desktop, /\/api\/auth\/verify-pin/); assert.doesNotMatch(desktop, /pos-login/);
    assert.ok(auth.indexOf('const { valid, needsUpgrade } = await verifyPin(', at) < refusal, 'after the PIN check');
  });

  // ── 5. The dashboard ───────────────────────────────────────────────────────────────────────────────────────────────
  const tab = read('apps/dashboard/src/pages/settings/StaffTab.tsx');
  await ok('the card: no PIN / invite tabs; the role decides; the invitation goes in the same call', () => {
    assert.doesNotMatch(tab, /PIN Login|Email Invite|\/api\/staff\/invite/);
    assert.match(tab, /const signIn = staffSignIn\(\{ partner: isPartner, roleName: roleById\(roleId\)\?\.name/);
    assert.match(tab, /const webOnly = signIn === 'web' && \(!!editing \|\| invites\);/);
    assert.match(tab, /const sendsInvite = !editing && invites && signIn !== 'pin';/);
    assert.match(tab, /web_access: true,/);
    assert.match(tab, /invites=\{webAccess\}/, 'the owner\'s dashboard only');
    assert.doesNotMatch(tab, /\btill\b/i);
  });
  await ok('email only for Partner / General Manager: no PIN, approval PIN, hourly rate or rights on adding; an old approval PIN may be removed', () => {
    assert.match(tab, /\{!webOnly && \(!editing \|\| rights\.pins\) && \(\s*<div className="grid[^"]*" data-testid="staff-pin">/);
    assert.match(tab, /\{approvalPin && rights\.pins && !webOnly && \(/);
    assert.match(tab, /\{rights\.pay && !webOnly && \(/);
    assert.match(tab, /\{rights\.access && !isPartner && !\(webOnly && !editing\) && \(/);
    assert.match(tab, /\{\(!approvalPin \|\| webOnly\) && editing && hasApprovalPin && rights\.pins && \(/);
    assert.match(tab, /if \(!editing && signIn !== 'pin' && !email\.trim\(\)\.includes\('@'\)\)/);
    assert.match(tab, /if \(!editing && !webOnly && !pin\) \{ setError\('PIN is required'\); return; \}/);
  });
  await ok('the web POS sign-in: a manager is told to use the web dashboard (link to /login), never sent to /manager', () => {
    const login = read('apps/dashboard/src/pages/pos/POSLoginScreen.tsx');
    assert.match(login, /if \(data\.code === 'USE_WEB_DASHBOARD'\)/);
    assert.match(login, /<a href="\/login"/);
    assert.match(login, /if \(dest === '\/manager'\) \{/);
    assert.doesNotMatch(login.slice(login.indexOf('function finishLogin')), /navigate\('\/manager'/);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
