/**
 * owner-password-a568.test.mjs — A568: the owner's forced password change on first sign-in is ENFORCED.
 *
 * Owner, 2026-10-22: "the password change on first log in is not enforced please check".
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/owner-password-a568.test.mjs
 *
 * ROOT CAUSE: POST /api/auth/login cleared users.must_change_password whenever the sign-in account's updated_at was later
 * than its created_at ("the password was updated"). GoTrue moves auth.users.updated_at on EVERY password sign-in (the
 * grant runs UpdateOnly(user, "last_sign_in_at"), and pop stamps updated_at on every update), so the server's own
 * signInWithPassword a few lines earlier made the test true on the very first sign-in: the flag was wiped and the owner
 * was never sent to /change-password. The admin portal's "Reset password" moved updated_at too (updateUserById), so its
 * "must choose a new password" never held either. And PATCH /api/auth/me cleared the flag with no password set at all.
 *
 * RUNS the COMPILED auth and admin routers behind the REAL middleware, over HTTP, against an in-memory database
 * (tests/lib-memdb.mjs). Supabase Auth is a stand-in that behaves as GoTrue does: every sign-in and every admin password
 * update moves updated_at.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, put back):
 *   - the updated_at > created_at inference put back in the login            → "forced at the first sign-in" fails
 *   - PATCH /api/auth/me clearing the flag again                              → "saying so is not changing it" fails
 *   - GET /api/auth/session without mustChangePassword                        → "the dashboard is told" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/auth.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.SUPABASE_ANON_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.LOGIN_OTP_SECRET ??= randomBytes(24).toString('hex');
process.env.APP_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
delete process.env.LOGIN_OTP;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const express = require('express');
const { supabase, authClient } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const mails = [];
mailer.sendEmailChecked = async (o) => { mails.push(o); return { ok: true, provider: 'resend' }; };
mailer.sendEmail = async (o) => { mails.push(o); return true; };
const authCache = require(path.join(DIST, 'lib/authCache.js'));
const attempts = require(path.join(DIST, 'lib/pinAttempts.js'));

// ── One business, its owner (made by the admin portal: must_change_password), a partner ────────────────────────────
const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = u(900), BR = u(901), OWNER = u(1), GM = u(2), R_OWNER = u(800), R_GM = u(801), SUPER = u(700);
const OWNER_MAIL = 'owner@pollo.test', GINA = 'gina@pollo.test';
let accounts; let clock = Date.parse('2026-10-22T08:00:00Z');
const tick = () => new Date(clock += 60_000).toISOString();
const person = (id, name, email, roleId, roleName, extra = {}) => ({
  id, business_id: B, name, email, status: 'active', permissions_version: 1, role_id: roleId, must_change_password: false,
  roles: { id: roleId, name: roleName, role_permissions: [] }, user_permissions: [], user_branches: [{ branch_id: BR }], ...extra,
});
const reset = () => {
  attempts._resetAttempts(); authCache._resetAuthCache(); mails.length = 0;
  mem.fail = () => null; mem.calls = [];
  const born = '2026-10-22T07:00:00Z';
  accounts = {
    'auth-owner': { id: 'auth-owner', email: OWNER_MAIL, password: 'given-by-agent', app_metadata: {}, created_at: born, updated_at: born },
    'auth-gina': { id: 'auth-gina', email: GINA, password: 'gina-pass-12', app_metadata: { zaptill_partner: { [B]: GM } }, created_at: born, updated_at: born },
  };
  mem.db = {
    businesses: [{ id: B, owner_id: 'auth-owner', name: 'Pollo', email: OWNER_MAIL, status: 'active', type: 'restaurant', subdomain: 'pollo', currency: 'KES' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', status: 'active', is_main: true }],
    roles: [{ id: R_OWNER, business_id: B, name: 'Admin' }, { id: R_GM, business_id: B, name: 'General Manager' }],
    role_permissions: [], permissions: [],
    users: [
      // admin create-client (routes/admin.ts): the owner's row is born with must_change_password: true
      person(OWNER, 'Owner', OWNER_MAIL, R_OWNER, 'Admin', { must_change_password: true }),
      // a partner whose row happens to carry the flag — a partner set their own password through the invite: never forced
      person(GM, 'Gina', GINA, R_GM, 'General Manager', { must_change_password: true }),
    ],
    user_branches: [{ user_id: OWNER, branch_id: BR }, { user_id: GM, branch_id: BR }],
    user_permissions: [], refresh_tokens: [], login_otp_codes: [], password_reset_codes: [], notifications: [], user_devices: [],
    business_settings: [{ id: 'bs-1', business_id: B, key: 'web_partners',
      value: { [GM]: { auth_user_id: 'auth-gina', status: 'active', granted_at: '2026-10-21T08:00:00Z', granted_by: OWNER } } }],
    feature_flags: [{ business_id: B, key: 'web_hosting', enabled: true }],
    admin_users: [{ id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true }],
    admin_audit_log: [],
  };
};
const ownerRow = () => mem.db.users.find((x) => x.id === OWNER);
const view = (a) => ({ id: a.id, email: a.email, app_metadata: JSON.parse(JSON.stringify(a.app_metadata)),
  created_at: a.created_at, updated_at: a.updated_at, last_sign_in_at: a.last_sign_in_at ?? null });

// Supabase Auth, as GoTrue behaves: a password sign-in records last_sign_in_at — and pop stamps updated_at with it.
authClient.auth.signInWithPassword = async ({ email, password }) => {
  const a = Object.values(accounts).find((x) => x.email === String(email).toLowerCase());
  if (!a || a.password !== password) return { data: { user: null }, error: { message: 'Invalid login credentials' } };
  a.last_sign_in_at = a.updated_at = tick();
  return { data: { user: view(a) }, error: null };
};
supabase.auth = { admin: {
  getUserById: async (id) => ({ data: { user: accounts[id] ? view(accounts[id]) : null }, error: null }),
  updateUserById: async (id, attrs) => {
    if (!accounts[id]) return { data: null, error: { message: 'not found' } };
    if (attrs.password) accounts[id].password = attrs.password;
    if (attrs.app_metadata) accounts[id].app_metadata = JSON.parse(JSON.stringify(attrs.app_metadata));
    accounts[id].updated_at = tick();
    return { data: { user: view(accounts[id]) }, error: null };
  },
} };

const app = express(); app.use(express.json());
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = (password, extra = {}) => call('POST', '/api/auth/login', null, { email: OWNER_MAIL, password, ...extra });
const codeFrom = (to, re) => {
  const m = [...mails].reverse().find((x) => String(x.to) === to && re.test(x.subject));
  return m ? m.subject.match(/(\d{6})/)[1] : null;
};
const SUPER_T = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });

try {
  console.log('\nA568 — the owner\'s forced password change\n');
  reset();
  let token;
  await ok('a fresh owner (made by the admin portal) is forced at the FIRST sign-in — though GoTrue moved updated_at', async () => {
    const r = await login('given-by-agent');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Date.parse(accounts['auth-owner'].updated_at) > Date.parse(accounts['auth-owner'].created_at), 'the stand-in moved updated_at, as GoTrue does');
    assert.equal(r.body.mustChangePassword, true);
    assert.equal(ownerRow().must_change_password, true, 'the sign-in leaves the flag alone');
    token = r.body.accessToken;
  });
  await ok('…and again at the second sign-in when they did not change it', async () => {
    const r = await login('given-by-agent');
    assert.equal(r.body.mustChangePassword, true); assert.equal(ownerRow().must_change_password, true);
    token = r.body.accessToken;
  });
  await ok('the dashboard is told (GET /api/auth/session) — ProtectedRoute keeps them on /change-password', async () => {
    const s = await call('GET', '/api/auth/session', token);
    assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.owner, true); assert.equal(s.body.mustChangePassword, true);
  });
  await ok('saying so is not changing it: PATCH /api/auth/me no longer clears the flag', async () => {
    const r = await call('PATCH', '/api/auth/me', token, { must_change_password: false });
    assert.equal(r.status, 200); assert.equal(ownerRow().must_change_password, true);
    assert.equal((await login('given-by-agent')).body.mustChangePassword, true);
  });
  await ok('a wrong current password or the same password: refused, still forced', async () => {
    token = (await login('given-by-agent')).body.accessToken;
    const wrong = await call('POST', '/api/auth/password/change', token, { current_password: 'nope-nope', new_password: 'my-own-pass-1' });
    assert.equal(wrong.body?.code, 'WRONG_PASSWORD', JSON.stringify(wrong.body));
    const same = await call('POST', '/api/auth/password/change', token, { current_password: 'given-by-agent', new_password: 'given-by-agent' });
    assert.equal(same.status, 400);
    assert.equal(ownerRow().must_change_password, true);
  });
  await ok('after they set their own password (the forced page: /password/change) they are not forced', async () => {
    const r = await call('POST', '/api/auth/password/change', token, { current_password: 'given-by-agent', new_password: 'my-own-pass-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(ownerRow().must_change_password, false);
    const again = await login('my-own-pass-1');
    assert.equal(again.status, 200); assert.equal(again.body.mustChangePassword, false);
    assert.equal((await call('GET', '/api/auth/session', again.body.accessToken)).body.mustChangePassword, false);
    assert.equal((await login('given-by-agent')).status, 401, 'the old password is gone');
  });
  await ok('the admin portal\'s "Reset password" forces a change at the next sign-in (updateUserById moved updated_at too)', async () => {
    const r = await call('POST', `/api/admin/clients/${B}/reset-owner-password`, SUPER_T, { new_password: 'reset-by-zaptill' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(ownerRow().must_change_password, true);
    const first = await login('reset-by-zaptill');
    assert.equal(first.status, 200); assert.equal(first.body.mustChangePassword, true);
    assert.equal((await login('reset-by-zaptill')).body.mustChangePassword, true, 'still at the second');
  });
  await ok('a "Forgot password" reset (emailed code) clears it — they chose that password themselves', async () => {
    assert.equal((await call('POST', '/api/auth/password/forgot', null, { email: OWNER_MAIL })).status, 200);
    const code = codeFrom(OWNER_MAIL, /password reset code/i);
    assert.ok(code, 'a reset code was emailed');
    const r = await call('POST', '/api/auth/password/reset', null, { email: OWNER_MAIL, code, new_password: 'forgot-new-pass' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(ownerRow().must_change_password, false);
    assert.equal((await login('forgot-new-pass')).body.mustChangePassword, false);
  });
  await ok('a partner (A550) set their own password through the invite: never forced, whatever their row says', async () => {
    let r = await call('POST', '/api/auth/login', null, { email: GINA, password: 'gina-pass-12', subdomain: 'pollo' });
    if (r.status === 403 && r.body?.code === 'OTP_REQUIRED') {
      r = await call('POST', '/api/auth/login', null, { email: GINA, password: 'gina-pass-12', subdomain: 'pollo', otp_code: codeFrom(GINA, /sign-in code/i) });
    }
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.partner, true);
    assert.equal(r.body.mustChangePassword, false);
    assert.equal((await call('GET', '/api/auth/session', r.body.accessToken)).body.mustChangePassword, false);
  });

  console.log('\nThe source: no timestamp inference; the dashboard enforces it\n');
  await ok('the sign-in never infers a password change from timestamps', () => {
    const a = read('apps/server/src/routes/auth.ts');
    assert.doesNotMatch(a, /passwordWasUpdated/);
    assert.doesNotMatch(a, /data\.user\.updated_at/);
    assert.match(a, /const mustChangePassword = \(ownerUser as any\)\?\.must_change_password === true;/);
  });
  await ok('ProtectedRoute sends a flagged owner to /change-password from every dashboard page', () => {
    const p = read('apps/dashboard/src/components/ProtectedRoute.tsx');
    assert.match(p, /if \(mustChangePassword && pathname !== '\/change-password'\) return <Navigate to="\/change-password" replace \/>;/);
    assert.match(read('apps/dashboard/src/context/PermissionsContext.tsx'), /setMustChange\(!partner && s\?\.mustChangePassword === true\)/);
    assert.match(read('apps/dashboard/src/pages/LoginPage.tsx'), /if \(loginResponse\.mustChangePassword\) \{ navigate\('\/change-password'\); return; \}/);
  });
  await ok('the forced page sets the password through the cloud (/password/change), never PATCH /me or the browser alone', () => {
    const f = read('apps/dashboard/src/pages/ForcePasswordChangePage.tsx');
    assert.match(f, /api\.post\('\/api\/auth\/password\/change', \{ current_password: current, new_password: newPassword \}\)/);
    assert.doesNotMatch(f, /api\.patch\('\/api\/auth\/me'/);
    assert.doesNotMatch(f, /supabase\.auth\.updateUser/);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
