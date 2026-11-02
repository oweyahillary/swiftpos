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
 *
 * A608 follow-up (owner, 2026-10-29: managers sell on the web POS from the dashboard — "is there a reason of two sign
 * ins?" — no): POST /api/auth/pos-session exchanges a web DASHBOARD session for the web POS session /pos-login issues;
 * the hourly rate typed when adding someone is stored. Mutations (each made, a test failed, put back):
 *   - dashboardSessionKind taking any session as a partner's    → "only a dashboard session" fails
 *   - /pos-session without checkPartner()                       → "a revoked grant opens nothing" fails
 *   - /pos-session without the sell check                       → "no right to sell" fails
 *   - /pos-session without the branch check                     → "a branch not theirs" fails
 *   - POST /api/staff not storing hourly_rate                   → "the hourly rate typed when adding" fails
 *
 * A608 part 3 (owner, 2026-10-29, "yes to all"): the web manager portal is retired (its parking bays overview moved to the
 * Overview, its shift report print to Open drawers, /manager redirects to the dashboard); web dashboard access is given,
 * resent and taken away by a partner who edits staff too — within their keys and branches, never their own, never a
 * General Manager (a partner stays the owner's to make). Mutations (each made, a test failed, put back):
 *   - webAccessTargetRefusal without the ceiling (BEYOND_YOU)     → "never someone holding more" fails
 *   - webAccessTargetRefusal without the branch check            → "never at a branch not theirs" fails
 *   - webAccessGiverKind taking any session                      → "who gives it" fails
 *   - makesPartnerRefusal always null (the indirect partner)      → "never moved onto General Manager" and the rename fail
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
const G = require(path.join(DIST, 'lib/webAccessGivers.js'));   // A608 part 3
const permState = require(path.join(DIST, 'lib/permissionsState.js'));
const P = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/staffSignIn.ts')).href);
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const express = require('express');

// ── The business and its people ──────────────────────────────────────────────────────────────────────────────────────
const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = u(900), BR = u(901), BR2 = u(902);
const OWNER = u(1), MGR = u(3), CASH = u(5), SUP = u(6), ACC = u(7);
const R_OWNER = u(800), R_GM = u(801), R_MGR = u(803), R_CASH = u(804), R_SUP = u(805), R_ACC = u(806);
const keysOf = (name) => [...P.BUILT_IN_ROLES.find((r) => r.name === name).keys];
const roles = {
  [R_OWNER]: { id: R_OWNER, business_id: B, name: 'Admin', keys: [] },
  [R_GM]: { id: R_GM, business_id: B, name: 'General Manager', is_default: true, keys: keysOf('General Manager') },
  [R_MGR]: { id: R_MGR, business_id: B, name: 'Manager', keys: keysOf('Manager') },
  [R_CASH]: { id: R_CASH, business_id: B, name: 'Cashier', keys: keysOf('Cashier') },
  [R_SUP]: { id: R_SUP, business_id: B, name: 'Supervisor', keys: keysOf('Supervisor') },
  [R_ACC]: { id: R_ACC, business_id: B, name: 'Accountant', keys: keysOf('Accountant') },
};
const PIN_HASH = await bcrypt.hash('2468', 4);
const BRANCH = { id: BR, business_id: B, name: 'Westlands', status: 'active', is_main: true, desktop_licensed: true };
const BRANCH2 = { id: BR2, business_id: B, name: 'Kilimani', status: 'active', is_main: false, desktop_licensed: true };
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
    branches: [BRANCH, BRANCH2],
    roles: Object.values(roles).map(({ keys, ...r }) => r),
    role_permissions: [], permissions: P.PERMISSION_KEYS.map((k, i) => ({ id: `perm-${i}`, key: k })),
    users: [person(OWNER, 'Owner', 'owner@pollo.test', R_OWNER), person(MGR, 'Mary', MARY, R_MGR),
      person(CASH, 'Joe', JOE, R_CASH), person(SUP, 'Sue', SUE, R_SUP), person(ACC, 'Ann', 'ann@pollo.test', R_ACC)],
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
    assert.equal(mem.db.users.length, 5);
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
  // ── 6. Open POS from the dashboard: POST /api/auth/pos-session ─────────────────────────────────────────────────
  console.log('\nA608 follow-up — Open POS from the dashboard\n');
  const grant = (ids) => (mem.db.business_settings = mem.db.business_settings.filter((r) => r.key !== 'web_partners')).push({ id: 'bs-1', business_id: B, key: 'web_partners',
    value: Object.fromEntries(ids.map((id) => [id, { auth_user_id: `auth-${id}`, status: 'active', granted_at: '2026-10-29T08:00:00Z', granted_by: OWNER }])) });
  const partnerToken = (id, roleName) => jwt.sign({ userId: id, businessId: B, branchId: BR, roleId: null, isOwner: false, webPartner: true,
    partnerBranches: [BR], allBranches: false, permissionKeys: keysOf(roleName), permissionsVersion: 1, sessionId: `s-${id}`, surface: 'web' },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  const openPos = (token, body = {}) => call('POST', '/api/auth/pos-session', token, body);
  const CLAIMS = ['userId', 'businessId', 'branchId', 'roleId', 'roleName', 'isOwner', 'permissionKeys', 'permissionsVersion', 'surface'];
  const claimsOf = (t) => { const c = jwt.decode(t); return Object.fromEntries(Object.keys(c).filter((k) => !['jti', 'iat', 'exp', 'sessionId'].includes(k)).map((k) => [k, c[k]])); };

  reset();
  await ok('no session → 401; nothing issued', async () => {
    const r = await openPos(null, { branch_id: BR });
    assert.equal(r.status, 401); assert.equal(r.body?.accessToken, undefined);
  });
  await ok('only a dashboard session: a web POS session, a till PIN sign-in, a plain staff token → 403 DASHBOARD_SESSION_ONLY', async () => {
    const pos = await webPos(JOE);
    assert.equal(pos.status, 200);
    const a = await openPos(pos.body.accessToken, { branch_id: BR });
    assert.equal(a.status, 403, JSON.stringify(a.body)); assert.equal(a.body.code, 'DASHBOARD_SESSION_ONLY');
    const b = await openPos(managerToken(), { branch_id: BR });
    assert.equal(b.status, 403); assert.equal(b.body.code, 'DASHBOARD_SESSION_ONLY');
    const pinOnTill = jwt.sign({ userId: MGR, businessId: B, branchId: BR, isOwner: false, permissionKeys: keysOf('Manager'), permissionsVersion: 1,
      sessionId: 's-t', surface: 'desktop', pinSignIn: true }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const c = await openPos(pinOnTill, { branch_id: BR });
    assert.ok(c.status === 403, JSON.stringify(c.body));
    assert.equal(W.dashboardSessionKind({ isOwner: true, ownerLogin: true }, () => true), 'owner');
    assert.equal(W.dashboardSessionKind({ isOwner: true, surface: 'web', roleId: 'r' }, () => false), null, 'the owner\'s PIN on the web POS');
    assert.equal(W.dashboardSessionKind({ webPartner: true, isOwner: false, surface: 'web' }, () => false), 'partner');
    assert.equal(W.dashboardSessionKind({ webPartner: true, pinSignIn: true }, () => false), null);
    assert.equal(W.dashboardSessionKind({ till: true, deviceId: 'd' }, () => true), null);
  });
  reset();
  await ok('a manager with web access opens the POS at their branch, as themselves — no PIN, no code; their dashboard session untouched', async () => {
    grant([MGR]);
    const before = mem.db.refresh_tokens.length;
    const r = await openPos(partnerToken(MGR, 'Manager'), { branch_id: BR });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = jwt.decode(r.body.accessToken);
    assert.equal(c.userId, MGR); assert.equal(c.branchId, BR); assert.equal(c.isOwner, false); assert.equal(c.surface, 'web');
    assert.equal(c.webPartner, undefined, 'a POS session, not a dashboard one'); assert.equal(c.pinSignIn, undefined);
    assert.equal(r.body.fromDashboard, true); assert.equal(r.body.staff.id, MGR); assert.equal(r.body.permissions['orders.create'], true);
    assert.equal(mem.db.refresh_tokens.length, before + 1, 'its refresh token stored');
    assert.ok(mem.db.refresh_tokens.every((t) => !t.revoked_at), 'nothing revoked');
  });
  await ok('one branch of theirs and none named → that branch; a branch not theirs → 403 NOT_YOUR_BRANCH', async () => {
    const r = await openPos(partnerToken(MGR, 'Manager'), {});
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(jwt.decode(r.body.accessToken).branchId, BR);
    const x = await openPos(partnerToken(MGR, 'Manager'), { branch_id: BR2 });
    assert.equal(x.status, 403, JSON.stringify(x.body)); assert.equal(x.body.code, 'NOT_YOUR_BRANCH'); assert.equal(x.body.accessToken, undefined);
  });
  await ok('the token\'s claims are exactly /pos-login\'s (a cashier given web access, both ways)', async () => {
    grant([MGR, CASH]);
    const viaPin = await webPos(JOE);
    const viaDash = await openPos(partnerToken(CASH, 'Cashier'), { branch_id: BR });
    assert.equal(viaPin.status, 200); assert.equal(viaDash.status, 200, JSON.stringify(viaDash.body));
    const a = claimsOf(viaPin.body.accessToken), b = claimsOf(viaDash.body.accessToken);
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), 'the same claims');
    for (const k of CLAIMS) assert.deepEqual(b[k], a[k], k);
    assert.deepEqual(viaDash.body.permissions, viaPin.body.permissions);
  });
  reset();
  await ok('a revoked grant opens nothing: 401 SIGN_IN_AGAIN (PARTNER_ENDED)', async () => {
    mem.db.business_settings.push({ id: 'bs-1', business_id: B, key: 'web_partners',
      value: { [MGR]: { auth_user_id: 'auth-m', status: 'revoked', granted_at: '2026-10-29T08:00:00Z', granted_by: OWNER, revoked_at: '2026-10-29T09:00:00Z' } } });
    const r = await openPos(partnerToken(MGR, 'Manager'), { branch_id: BR });
    assert.equal(r.status, 401, JSON.stringify(r.body)); assert.equal(r.body.code, 'SIGN_IN_AGAIN'); assert.equal(r.body.reason, 'PARTNER_ENDED');
  });
  reset();
  await ok('an inactive person opens nothing (401)', async () => {
    grant([MGR]);
    mem.db.users.find((x) => x.id === MGR).status = 'inactive';
    const r = await openPos(partnerToken(MGR, 'Manager'), { branch_id: BR });
    assert.equal(r.status, 401, JSON.stringify(r.body)); assert.equal(r.body.accessToken, undefined);
  });
  reset();
  await ok('no right to sell (an Accountant with web access) → 403 NO_SELL_RIGHT', async () => {
    grant([ACC]);
    assert.equal(keysOf('Accountant').includes('orders.create'), false);
    const r = await openPos(partnerToken(ACC, 'Accountant'), { branch_id: BR });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'NO_SELL_RIGHT');
  });
  reset();
  await ok('the owner opens the POS: every branch to choose from, then the one picked — the owner\'s claims as /pos-login gives them', async () => {
    const pick = await openPos(ownerToken(), {});
    assert.equal(pick.status, 200, JSON.stringify(pick.body)); assert.equal(pick.body.needsBranchSelection, true);
    assert.deepEqual(pick.body.branches.map((b) => b.id).sort(), [BR, BR2].sort()); assert.equal(pick.body.accessToken, undefined);
    const r = await openPos(ownerToken(), { branch_id: BR2 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.branchId, BR2);
    const c = jwt.decode(r.body.accessToken);
    assert.equal(c.isOwner, true); assert.equal(c.branchId, null, 'the owner names the branch per request (X-Branch-Id)');
    assert.deepEqual(c.permissionKeys, ['*']); assert.equal(c.ownerLogin, undefined, 'never the owner\'s password session');
  });

  // ── 7. The hourly rate typed when adding someone ─────────────────────────────────────────────────────────────────
  reset();
  await ok('the hourly rate typed when adding someone is stored; not a number → 400; without staff.pay → 403', async () => {
    const r = await call('POST', '/api/staff', ownerToken(), { name: 'Sam', email: SAM, role_id: R_CASH, pin: '1357', hourly_rate: 250 });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(byEmail(SAM).hourly_rate, 250);
    const bad = await call('POST', '/api/staff', ownerToken(), { name: 'Al', email: 'al@pollo.test', role_id: R_CASH, pin: '1357', hourly_rate: 'lots' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body)); assert.equal(bad.body.code, 'BAD_HOURLY_RATE'); assert.equal(byEmail('al@pollo.test'), undefined);
    const neg = await call('POST', '/api/staff', ownerToken(), { name: 'Al', email: 'al@pollo.test', role_id: R_CASH, pin: '1357', hourly_rate: -5 });
    assert.equal(neg.status, 400);
    assert.equal(keysOf('Manager').includes('staff.pay'), false);
    // A595: a token with the split rights (`parts`) — an older one's staff.edit still brings staff.pay while it renews.
    const { iat, exp, ...mp } = jwt.decode(managerToken());
    const managerParts = jwt.sign({ ...mp, parts: true }, process.env.JWT_SECRET, { expiresIn: '5m' });
    permState._setPermissionsMigrated(true); permState._setSplitsMigrated(true);   // migrations 134 and 176 recorded
    const noPay = await call('POST', '/api/staff', managerParts, { name: 'Al', email: 'al@pollo.test', role_id: R_CASH, pin: '1357', hourly_rate: 250 });
    assert.equal(noPay.status, 403, JSON.stringify(noPay.body)); assert.match(noPay.body.detail, /staff\.pay/);
    const none = await call('POST', '/api/staff', managerToken(), { name: 'Al', email: 'al@pollo.test', role_id: R_CASH, pin: '1357', hourly_rate: null });
    assert.equal(none.status, 201, 'no rate is no pay right needed');
    const patchBad = await call('PATCH', `/api/staff/${CASH}`, ownerToken(), { hourly_rate: 'lots' });
    assert.equal(patchBad.status, 400); assert.equal(patchBad.body.code, 'BAD_HOURLY_RATE');
    const patch = await call('PATCH', `/api/staff/${CASH}`, ownerToken(), { hourly_rate: '300' });
    assert.equal(patch.status, 200, JSON.stringify(patch.body)); assert.equal(mem.db.users.find((x) => x.id === CASH).hourly_rate, 300);
  });
  await ok('…and the card sends it when adding (only with staff.pay, as an edit does)', () => {
    assert.match(tab, /const payField: \{ hourly_rate\?: number \| null \} = rights\.pay \? \{ hourly_rate: hourlyRate \? Number\(hourlyRate\) : null \} : \{\};/);
    assert.match(tab, /role_id: roleId, \.\.\.pinField, \.\.\.branchField, \.\.\.keysField, \.\.\.overrideField, \.\.\.payField \}\);/);
    assert.match(tab, /\.\.\.\(webOnly \? \{\} : \{ \.\.\.overrideField, \.\.\.payField \}\)/);
  });

  // ── 8. The web wiring ────────────────────────────────────────────────────────────────────────────────────────────
  await ok('"Open POS" in the dashboard menu, for people who may sell; it exchanges the session and opens the POS for the branch in view', () => {
    const layout = read('apps/dashboard/src/components/DashboardLayout.tsx');
    assert.match(layout, /\{ to: '\/dashboard\/pos',\s+label: 'Open POS'/);
    assert.match(layout, /'\/dashboard\/pos':\s+\['orders\.create'\]/);
    const page = read('apps/dashboard/src/pages/pos/POSPage.tsx');
    assert.match(page, /api\.post<PosSessionAnswer>\('\/api\/auth\/pos-session'/);
    assert.match(page, /useEffect\(\(\) => \{ void open\(activeBranchId\); \}/);
    assert.match(page, /fromDashboard: true,/);
    assert.match(page, /if \(r\.needsBranchSelection \|\| !r\.branchId\) \{ setChoices/);
    assert.match(page, /const held = dashboardPosSession\(branchId\);\s*if \(held\) \{ navigate\('\/pos\/cashier'\)/, 'a POS already open goes straight back');
    assert.doesNotMatch(page, /<Navigate to="\/pos"/);
  });
  await ok('inside the POS: signing out, locking or closing the drawer returns them to the dashboard; "← Dashboard" (the manager portal is gone)', () => {
    const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    assert.match(cs, /const exitTo = fromDashboard \? '\/dashboard' : '\/pos';/);
    assert.doesNotMatch(cs, /clearCashierSession\(\);\s*navigate\('\/pos'\)/);
    assert.equal((cs.match(/navigate\(exitTo\)/g) ?? []).length, 3);
    assert.doesNotMatch(cs, /hasManagerPortal|navigate\('\/manager'\)|Manager portal/, 'A608 part 3: the web manager portal is retired');
    assert.match(cs, /← Dashboard/);
    assert.match(cs, /if \(dest === '\/' && !session\.fromDashboard\) navigate/);
    const ctx = read('apps/dashboard/src/context/POSAuthContext.tsx');
    assert.match(ctx, /if \(session\?\.fromDashboard && session\.branchId\) headers\['X-Branch-Id'\] = session\.branchId;/);
    const login = read('apps/dashboard/src/pages/pos/POSLoginScreen.tsx');
    assert.match(login, /then use Open POS/);
    assert.match(login, /if \(session\.fromDashboard\) \{ navigate\('\/pos\/cashier'/);
    assert.match(W.webPosPinRefusal(true).error, /then use Open POS/);
  });
  await ok('the desktop is untouched: /verify-pin and the branch server never call /pos-session', () => {
    const desktop = ['apps/desktop/src/main/ipc/signIn.ts', 'apps/desktop/src/main/ipc/shared.ts'].map(read).join('\n');
    assert.doesNotMatch(desktop, /pos-session/);
  });
  // ── 9. A608 part 3: web dashboard access given by a partner who edits staff ─────────────────────────────────────────
  console.log('\nA608 part 3 — who gives web dashboard access; the manager portal retired\n');
  const KIM = u(9), BEA = u(10), GAIL = u(11), NOBR = u(12);
  const beyond = P.PERMISSION_KEYS.find((k) => !keysOf('Manager').includes(k));
  const addPeople = () => {
    const kim = person(KIM, 'Kim', 'kim@pollo.test', R_CASH); kim.user_branches = [{ branch_id: BR2, branches: BRANCH2 }];
    const bea = person(BEA, 'Bea', 'bea@pollo.test', R_CASH); bea.user_permissions = [{ granted: true, permissions: { key: beyond } }];
    const nobr = person(NOBR, 'Nia', 'nia@pollo.test', R_CASH); nobr.user_branches = [];
    mem.db.users.push(kim, bea, person(GAIL, 'Gail', 'gail@pollo.test', R_GM), nobr);
    mem.db.user_branches.push({ user_id: KIM, branch_id: BR2 }, { user_id: BEA, branch_id: BR }, { user_id: GAIL, branch_id: BR });
  };
  const gmToken = (id = GAIL) => jwt.sign({ userId: id, businessId: B, branchId: null, isOwner: false, webPartner: true, partnerBranches: [BR, BR2],
    allBranches: true, permissionKeys: keysOf('General Manager'), permissionsVersion: 1, sessionId: `s-${id}`, surface: 'web', parts: true },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  const give = (t, id) => call('POST', `/api/staff/${id}/web-access`, t, {});
  const take = (t, id) => call('DELETE', `/api/staff/${id}/web-access`, t);

  await ok('who gives it: the owner, and a partner who edits staff — never a till, a PIN sign-in, a POS or a plain staff session', () => {
    assert.equal(G.webAccessGiverKind({ isOwner: true }, false), 'owner');
    assert.equal(G.webAccessGiverKind({ webPartner: true }, true), 'staff');
    assert.equal(G.webAccessGiverKind({ webPartner: true }, false), null, 'a partner without staff.edit');
    assert.equal(G.webAccessGiverKind({ isOwner: true, pinSignIn: true }, true), null);
    assert.equal(G.webAccessGiverKind({ isTill: true, isOwner: true }, true), null);
    assert.equal(G.webAccessGiverKind({ isOwner: false }, true), null, 'a web POS or a plain staff session');
  });
  reset(); addPeople();
  await ok('a manager with web access (staff.edit, their branch) gives, lists, resends and takes away a cashier\'s web access', async () => {
    assert.ok(keysOf('Manager').includes('staff.edit'));
    const t = partnerToken(MGR, 'Manager');
    const g = await give(t, CASH);
    assert.equal(g.status, 200, JSON.stringify(g.body)); assert.equal(partnersOf()[CASH].status, 'invited');
    assert.ok(mails.some((m) => m.to === JOE), 'the invitation sent');
    const again = await give(t, CASH);
    assert.equal(again.status, 200, 'resend');
    const list = await call('GET', '/api/staff/web-access', t);
    assert.equal(list.status, 200); assert.equal(list.body[CASH].status, 'invited');
    const off = await take(t, CASH);
    assert.equal(off.status, 200, JSON.stringify(off.body)); assert.equal(partnersOf()[CASH].status, 'revoked');
    assert.equal(partnersOf()[CASH].revoked_reason, 'revoked_by_staff');
  });
  await ok('never someone holding more than them (BEYOND_YOU), never the owner\'s role, never their own', async () => {
    const t = partnerToken(MGR, 'Manager');
    const b = await give(t, BEA);
    assert.equal(b.status, 403, JSON.stringify(b.body)); assert.equal(b.body.code, 'BEYOND_YOU'); assert.equal(partnersOf()[BEA], undefined);
    const o = await give(t, OWNER);
    assert.equal(o.status, 403); assert.equal(o.body.code, 'OWNER_ROLE');
    const me = await give(t, MGR);
    assert.equal(me.status, 403); assert.equal(me.body.code, 'OWN_WEB_ACCESS');
  });
  await ok('never at a branch not theirs (OTHER_BRANCH) — a person of every branch needs a giver of every branch', async () => {
    const t = partnerToken(MGR, 'Manager');
    const k = await give(t, KIM);
    assert.equal(k.status, 403, JSON.stringify(k.body)); assert.equal(k.body.code, 'OTHER_BRANCH'); assert.equal(partnersOf()[KIM], undefined);
    const n = await give(t, NOBR);
    assert.equal(n.status, 403); assert.equal(n.body.code, 'OTHER_BRANCH');
    const all = await give(gmToken(), KIM);
    assert.equal(all.status, 200, JSON.stringify(all.body), 'a partner of every branch');
    const kTake = await take(t, KIM);
    assert.equal(kTake.status, 403); assert.equal(kTake.body.code, 'OTHER_BRANCH'); assert.equal(partnersOf()[KIM].status, 'invited', 'not taken away');
  });
  await ok('a partner never makes a partner: a General Manager\'s web access is the owner\'s (PARTNER_OWNER_ONLY); the owner gives it', async () => {
    const r = await give(gmToken(SUP), GAIL);
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'PARTNER_OWNER_ONLY');
    const owner = await give(ownerToken(), GAIL);
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    const off = await take(gmToken(SUP), GAIL);
    assert.equal(off.status, 403); assert.equal(off.body.code, 'PARTNER_OWNER_ONLY'); assert.equal(partnersOf()[GAIL].status, 'invited');
  });
  await ok('no staff.edit (an Accountant with web access), a plain staff token, a web POS session → 403 OWNER_ONLY', async () => {
    assert.equal(keysOf('Accountant').includes('staff.edit'), false);
    for (const t of [partnerToken(ACC, 'Accountant'), managerToken()]) {
      const r = await give(t, CASH);
      assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWNER_ONLY');
      const l = await call('GET', '/api/staff/web-access', t);
      assert.equal(l.status, 403);
    }
  });
  reset();
  await ok('adding someone with web_access: a manager with web access may (a cashier at their branch), never a General Manager, never a Partner', async () => {
    const t = partnerToken(MGR, 'Manager');
    const r = await call('POST', '/api/staff', t, { name: 'Sam', email: SAM, role_id: R_CASH, pin: '1357', web_access: true });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(partnersOf()[byEmail(SAM).id]?.status, 'invited');
    assert.deepEqual(mem.db.user_branches.filter((b) => b.user_id === byEmail(SAM).id).map((b) => b.branch_id), [BR], 'their own branch');
    const gm = await call('POST', '/api/staff', gmToken(SUP), { name: 'Gus', email: 'gus@pollo.test', role_id: R_GM, web_access: true });
    assert.equal(gm.status, 403, JSON.stringify(gm.body)); assert.equal(gm.body.code, 'PARTNER_OWNER_ONLY'); assert.equal(byEmail('gus@pollo.test'), undefined);
    const p = await call('POST', '/api/staff', gmToken(SUP), { name: 'Pia', email: 'pia@pollo.test', partner: true });
    assert.equal(p.status, 403); assert.equal(p.body.error, 'Only the owner can add a partner.');
    const over = await call('POST', '/api/staff', t, { name: 'Ola', email: 'ola@pollo.test', role_id: R_GM, pin: '1357', web_access: true });
    assert.equal(over.status, 403, 'a manager never gives a General Manager');
  });

  // ── 9b. The indirect partner: someone with web access moved onto General Manager is a partner — the owner's ──────
  const liveFor = (ids) => (mem.db.business_settings = mem.db.business_settings.filter((r) => r.key !== 'web_partners')).push({ id: 'bs-1',
    business_id: B, key: 'web_partners', value: Object.fromEntries(ids.map((id) => [id, { auth_user_id: `auth-${id}`, status: 'active', granted_at: '2026-10-29T08:00:00Z', granted_by: OWNER }])) });
  const roleOf = (id) => mem.db.users.find((x) => x.id === id).role_id;
  reset(); addPeople();
  await ok('a General Manager partner never moves someone with web access onto General Manager (PARTNER_OWNER_ONLY); the owner may', async () => {
    liveFor([CASH]);
    const r = await call('PATCH', `/api/staff/${CASH}`, gmToken(SUP), { role_id: R_GM });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'PARTNER_OWNER_ONLY'); assert.equal(roleOf(CASH), R_CASH);
    const own = await call('PATCH', `/api/staff/${CASH}`, ownerToken(), { role_id: R_GM });
    assert.equal(own.status, 200, JSON.stringify(own.body)); assert.equal(roleOf(CASH), R_GM);
    assert.equal(G.makesPartnerRefusal({ owner: false, newRoleName: 'general_manager', oldRoleName: 'Cashier', liveWebAccess: true })?.code, 'PARTNER_OWNER_ONLY');
    assert.equal(G.makesPartnerRefusal({ owner: true, newRoleName: 'General Manager', liveWebAccess: true }), null);
    assert.equal(G.makesPartnerRefusal({ owner: false, newRoleName: 'General Manager', liveWebAccess: false }), null);
    assert.equal(G.makesPartnerRefusal({ owner: false, newRoleName: 'Manager', liveWebAccess: true }), null);
  });
  reset(); addPeople();
  await ok('…someone WITHOUT web access moved onto General Manager follows the ordinary ceiling (no partner is made)', async () => {
    const r = await call('PATCH', `/api/staff/${KIM}`, gmToken(SUP), { role_id: R_GM });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(roleOf(KIM), R_GM);
    const m = await call('PATCH', `/api/staff/${CASH}`, partnerToken(MGR, 'Manager'), { role_id: R_GM });
    assert.equal(m.status, 403, JSON.stringify(m.body)); assert.equal(m.body.error, 'You are not allowed to assign this role', 'the ceiling, as before');
    assert.equal(roleOf(CASH), R_CASH);
  });
  reset(); addPeople();
  await ok('nor by renaming the role they hold to General Manager; a role with no web-access members may be renamed; the owner may', async () => {
    liveFor([CASH]);
    const r = await call('PATCH', `/api/staff/roles/${R_CASH}`, gmToken(SUP), { name: 'General Manager' });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'PARTNER_OWNER_ONLY');
    assert.equal(mem.db.roles.find((x) => x.id === R_CASH).name, 'Cashier');
    const other = await call('PATCH', `/api/staff/roles/${R_ACC}`, gmToken(SUP), { name: 'General  manager' });
    assert.equal(other.status, 200, JSON.stringify(other.body), 'its members have no web access');
    const own = await call('PATCH', `/api/staff/roles/${R_CASH}`, ownerToken(), { name: 'General Manager' });
    assert.equal(own.status, 200, JSON.stringify(own.body));
  });

  // ── 10. The dashboard: who sees the controls; the manager portal retired ─────────────────────────────────────────
  await ok('the dashboard: web access controls for the owner and a partner who edits staff; Partner in the list the owner\'s alone', () => {
    const page = read('apps/dashboard/src/pages/settings/UsersAccessPage.tsx');
    assert.match(page, /webAccess=\{isOwner \|\| \(isPartner && can\('staff\.edit'\)\)\} partners=\{isOwner\}/);
    assert.match(tab, /partnerOption=\{partners && !editing\}/);
    assert.match(tab, /const mayGiveWeb = \(p: StaffMember\): boolean => partners\s*\|\| \(!p\.is_self && !isGeneralManagerRole\(p\.roles\?\.name\) && roles\.some\(r => r\.id === p\.roles\?\.id\)\);/);
    assert.match(tab, /\{webAccess && s\.status === 'active' && s\.email && !role\?\.is_owner_role && mayGiveWeb\(s\) && /);
    assert.match(tab, /web=\{webAccess && editing && mayGiveWeb\(editing\) \?/);
    assert.match(tab, /const invites = invitesProp && \(ownerView \|\| signIn !== 'web'\);/, 'never a General Manager\'s invitation but the owner\'s');
  });
  await ok('the manager portal is retired: /manager redirects to the dashboard (its sign-in when signed out); its pages are gone', () => {
    const app = read('apps/dashboard/src/App.tsx');
    assert.match(app, /<Route path="\/manager\/\*" element=\{<Navigate to="\/dashboard" replace \/>\} \/>/);
    assert.doesNotMatch(app, /ManagerDashboard/);
    assert.ok(!fs.existsSync(path.join(ROOT, 'apps/dashboard/src/pages/manager')), 'pages/manager deleted');
    assert.ok(!fs.existsSync(path.join(ROOT, 'apps/dashboard/src/components/SupplierBills.tsx')), 'its Supplier bills (Stock › Suppliers has them)');
    const login = read('apps/dashboard/src/pages/pos/POSLoginScreen.tsx');
    assert.match(login, /navigate\(dest === '\/manager' \? '\/dashboard' : dest, \{ replace: true \}\)/, 'an old manager PIN session to the dashboard');
  });
  await ok('what only the portal had moved: the parking bays on a parking business\'s Overview, the shift report on Open drawers', () => {
    const ov = read('apps/dashboard/src/pages/OverviewPage.tsx');
    assert.match(ov, /\{businessTerms\(business\?\.type\)\.type === 'parking' && \(\s*<ParkingLivePanel /, 'parking only — every other type never renders it');
    const panel = read('apps/dashboard/src/components/ParkingLivePanel.tsx');
    assert.match(panel, /\/api\/parking-sessions\?branch_id=\$\{branchId\}&status=open/);
    assert.match(panel, /\/api\/tables\?branch_id=\$\{branchId\}&slot_type=parking_bay/);
    assert.match(panel, /if \(!branchId\) \{/, '"All branches": pick one');
    assert.match(panel, /setInterval\(whenVisible\(/);
    const ts = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('typescript');
    const fn = panel.slice(panel.indexOf('export function bayOccupancy'), panel.indexOf('export default function'));
    const js = ts.transpileModule(`${fn.replace('export ', '')}\nmodule.exports = { bayOccupancy };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const m = { exports: {} }; new Function('module', 'exports', js)(m, m.exports);
    assert.deepEqual(m.exports.bayOccupancy(20, 5), { free: 15, pct: 25 });
    assert.deepEqual(m.exports.bayOccupancy(0, 0), { free: 0, pct: 0 });
    assert.deepEqual(m.exports.bayOccupancy(3, 4), { free: 0, pct: 133 });
    const os = read('apps/dashboard/src/pages/OpenShiftsPage.tsx');
    assert.match(os, /printShiftReport\(s\.id\)/); assert.match(os, /'Shift report'/);
    assert.doesNotMatch(panel + ov, /\btill\b/i);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
