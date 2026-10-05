/**
 * password-reset.test.mjs — A402: an owner resets their own password (emailed code) or changes it when signed in.
 *
 * Owner, 2026-10-05: "add, reset password feature". The REAL compiled routes (/api/auth/password/forgot, /reset) and
 * lib/passwordReset run against an in-memory database; Supabase Auth and the mailer are stand-ins.
 *
 * MUTATIONS TO CONFIRM BITE: forgot answering differently for an unknown email → "the same answer" fails; checkResetCode
 * accepting a used code → "a code works once" fails; setOwnerPassword not revoking sessions → "signed out everywhere"
 * fails; the tills' sessions revoked too (A406) → "the business's tills stay signed in" fails; a staff member's email accepted → "only an owner's sign-in" fails; resetHash = hashCode (shared with sign-in
 * codes) → "a sign-in code cannot reset a password" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/passwordReset.js'))) { console.log('\nBuild the server first: cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.SUPABASE_ANON_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const PR = require(path.join(DIST, 'lib/passwordReset.js'));
const O = require(path.join(DIST, 'lib/loginOtp.js'));

// ── The database, in memory ─────────────────────────────────────────────────
const OWNER = '11111111-1111-4111-8111-111111111111', STAFFBIZ = '22222222-2222-4222-8222-222222222222';
const db = {
  businesses: [{ id: 'b1', owner_id: OWNER, email: 'shop@africanfries.co.ke' }, { id: STAFFBIZ, owner_id: '99999999-9999-4999-8999-999999999999', email: null }],
  users: [{ id: 'u-owner', business_id: 'b1', email: 'Owner@AfricanFries.co.ke', name: 'Wanjiku', must_change_password: true },
          { id: 'u-mgr', business_id: STAFFBIZ, email: 'manager@x.co.ke', name: 'Otieno', must_change_password: false }],
  refresh_tokens: [{ id: 'r1', user_id: 'u-owner', session_id: 's1', revoked_at: null }, { id: 'r2', user_id: OWNER, session_id: 's2', revoked_at: null },
                   { id: 'r3', user_id: 'u-mgr', session_id: 's3', revoked_at: null },
                   // A406: a till signs in AS the owner — its session names its device
                   { id: 'r4', user_id: 'u-owner', session_id: 's4', device_hint: 'dev-T1', revoked_at: null },
                   // A407: marked as the till's own session (migration 125)
                   { id: 'r5', user_id: 'u-owner', session_id: 's5', device_hint: 'dev-unlisted', session_kind: 'device', revoked_at: null }],
  user_devices: [{ id: 'd1', business_id: 'b1', device_id: 'dev-T1' }],
  password_reset_codes: [],
};
const auth = { [OWNER]: { email: 'owner@africanfries.co.ke', password: 'old-password' }, '99999999-9999-4999-8999-999999999999': { email: 'boss@x.co.ke', password: 'x' } };
let seq = 0;
const like = (v, p) => String(v ?? '').toLowerCase() === String(p).toLowerCase();
supabase.from = (table) => {
  const filters = []; let op = 'select', payload = null, desc = false, limit = Infinity;
  const matching = () => (db[table] ??= []).filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === 'insert') return { data: payload, error: null };
    if (op === 'update') { matching().forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
    let rows = matching().slice(); if (desc) rows.reverse();
    return { data: rows.slice(0, limit), error: null };
  };
  const q = new Proxy({}, { get(_t, p) {
    if (p === 'select') return () => q;
    if (p === 'eq') return (k, v) => { filters.push((r) => r[k] === v); return q; };
    if (p === 'neq') return (k, v) => { filters.push((r) => r[k] !== v); return q; };
    if (p === 'ilike') return (k, v) => { filters.push((r) => like(r[k], v)); return q; };
    if (p === 'in') return (k, v) => { filters.push((r) => v.includes(r[k])); return q; };
    if (p === 'not') return (k, _o, v) => { filters.push((r) => (v === null ? r[k] != null : r[k] !== v)); return q; };
    if (p === 'is') return (k, v) => { filters.push((r) => (r[k] ?? null) === v); return q; };
    if (p === 'gte') return (k, v) => { filters.push((r) => String(r[k]) >= String(v)); return q; };
    if (p === 'order') return (_k, o) => { desc = o?.ascending === false; return q; };
    if (p === 'limit') return (n) => { limit = n; return q; };
    if (p === 'insert') return (row) => { op = 'insert'; const r = { id: `c${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), attempts: 0, consumed_at: null, ...row }; (db[table] ??= []).push(r); payload = r; return q; };
    if (p === 'update') return (patch) => { op = 'update'; payload = patch; return q; };
    if (p === 'single' || p === 'maybeSingle') return () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }); };
    if (p === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
    return () => q;
  } });
  return q;
};
supabase.auth = { admin: {
  getUserById: async (id) => ({ data: { user: auth[id] ? { id, email: auth[id].email } : null }, error: null }),
  updateUserById: async (id, { password }) => { auth[id].password = password; return { data: {}, error: null }; },
} };
const mail = [];
mailer.sendEmailChecked = async (m) => { mail.push(m); return { ok: true, provider: 'test' }; };
const lastCode = () => (mail[mail.length - 1]?.subject.match(/(\d{6})$/) ?? [])[1];

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
const { requireAuth } = require(path.join(DIST, 'middleware/auth.js'));
app.get('/api/probe', requireAuth, (_req, res) => res.json({ ok: true }));
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const post = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  await ok('a new password: 8 characters at least', () => {
    assert.match(PR.passwordProblem('short'), /at least 8/); assert.match(PR.passwordProblem('        '), /at least 8/);
    assert.equal(PR.passwordProblem('long enough'), null); assert.match(PR.passwordProblem('x'.repeat(129)), /too long/);
  });
  await ok('forgot: the same answer for an owner, a stranger and a staff member — only the owner is emailed', async () => {
    const a = await post('/password/forgot', { email: ' OWNER@africanfries.co.ke ' });
    const b = await post('/password/forgot', { email: 'nobody@nowhere.co.ke' });
    const c = await post('/password/forgot', { email: 'manager@x.co.ke' });
    assert.equal(a.status, 200); assert.deepEqual(a.body, b.body); assert.deepEqual(a.body, c.body);
    assert.equal(mail.length, 1); assert.equal(mail[0].to, 'owner@africanfries.co.ke');
    assert.equal(db.password_reset_codes.length, 1); assert.notEqual(db.password_reset_codes[0].code_hash, lastCode(), 'stored hashed');
  });
  await ok('asking again within a minute sends no second email', async () => {
    await post('/password/forgot', { email: 'owner@africanfries.co.ke' }); assert.equal(mail.length, 1);
  });
  await ok('a sign-in code cannot reset a password (the hashes differ)', () => {
    assert.notEqual(PR.resetHash('123456', OWNER), O.hashCode('123456', OWNER));
  });
  await ok('a wrong code, a weak password, a mismatched email: refused, nothing changed', async () => {
    const code = lastCode();
    assert.equal((await post('/password/reset', { email: 'owner@africanfries.co.ke', code: code === '000000' ? '111111' : '000000', new_password: 'new-password-1' })).body.code, 'RESET_INVALID');
    assert.equal((await post('/password/reset', { email: 'owner@africanfries.co.ke', code, new_password: 'short' })).body.code, 'WEAK_PASSWORD');
    assert.equal((await post('/password/reset', { email: 'nobody@nowhere.co.ke', code, new_password: 'new-password-1' })).body.code, 'RESET_EXPIRED');
    assert.equal(auth[OWNER].password, 'old-password');
  });
  await ok('the right code: the password is set, signed out everywhere, "must change" cleared', async () => {
    const r = await post('/password/reset', { email: 'owner@africanfries.co.ke', code: lastCode(), new_password: 'new-password-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(auth[OWNER].password, 'new-password-1');
    assert.ok(db.refresh_tokens.find((t) => t.id === 'r1').revoked_at && db.refresh_tokens.find((t) => t.id === 'r2').revoked_at);
    assert.equal(db.refresh_tokens.find((t) => t.id === 'r3').revoked_at, null, 'nobody else is signed out');
    assert.equal(db.refresh_tokens.find((t) => t.id === 'r4').revoked_at, null, 'A406: the business\'s tills stay signed in');
    assert.equal(db.refresh_tokens.find((t) => t.id === 'r5').revoked_at, null, 'A407: a session marked as a till\'s own stays');
    assert.equal(db.users.find((u) => u.id === 'u-owner').must_change_password, false);
  });
  await ok('a code works once', async () => {
    const again = await post('/password/reset', { email: 'owner@africanfries.co.ke', code: lastCode(), new_password: 'another-pass-2' });
    assert.equal(again.body.code, 'RESET_EXPIRED'); assert.equal(auth[OWNER].password, 'new-password-1');
  });
  await ok('five wrong tries and the code is dead — even the right one', async () => {
    db.password_reset_codes.forEach((c) => { c.created_at = '2000-01-01T00:00:00Z'; });
    await post('/password/forgot', { email: 'owner@africanfries.co.ke' });
    const code = lastCode(); const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await post('/password/reset', { email: 'owner@africanfries.co.ke', code: wrong, new_password: 'another-pass-2' });
    assert.equal((await post('/password/reset', { email: 'owner@africanfries.co.ke', code, new_password: 'another-pass-2' })).body.code, 'RESET_EXPIRED');
  });
  await ok('A406: an expired ZapTill token is called expired (renewed), not "Please sign in again."', async () => {
    const jwt = require('jsonwebtoken');
    const expired = jwt.sign({ userId: 'u-owner', businessId: 'b1', isOwner: true, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/probe`, { headers: { Authorization: `Bearer ${expired}` } });
    const body = await res.json();
    assert.equal(res.status, 401); assert.equal(body.code, 'TOKEN_EXPIRED'); assert.equal(body.error, 'Invalid or expired token');
    const foreign = jwt.sign({ sub: 'x' }, 'some-other-secret');
    assert.equal((await (await fetch(`http://127.0.0.1:${server.address().port}/api/probe`, { headers: { Authorization: `Bearer ${foreign}` } })).json()).code, 'SIGN_IN_AGAIN', 'a non-ZapTill token still meets the A391 rule');
  });
  await ok('signed in: the change needs the current password; other browsers signed out, this one kept (source)', () => {
    const a = read('apps/server/src/routes/auth.ts');
    assert.match(a, /router\.post\('\/password\/change', requireAuth,/);
    assert.match(a, /if \(!req\.isOwner\) \{ res\.status\(403\)/);
    assert.match(a, /authClient\.auth\.signInWithPassword\(\{ email, password: String\(req\.body\?\.current_password \?\? ''\) \}\)/);
    assert.match(a, /setOwnerPassword\(authId, String\(req\.body\.new_password\), req\.sessionId \?\? null\)/);
  });
  await ok('the screens: "Forgot password?" on the sign-in page; Change password in My sign-in', () => {
    assert.match(read('apps/dashboard/src/pages/LoginPage.tsx'), /data-testid="forgot-link"/);
    assert.match(read('apps/dashboard/src/components/ForgotPassword.tsx'), /'\/api\/auth\/password\/forgot'/);
    assert.match(read('apps/dashboard/src/components/ForgotPassword.tsx'), /'\/api\/auth\/password\/reset'/);
    assert.match(read('apps/dashboard/src/pages/settings/UsersAccessPage.tsx'), /<SignInSecurity \/>\s*\{\/\* A402: the owner's password \*\/\}\s*<ChangePassword \/>/);
  });
  await ok('migration 124: the code table, hashed, under RLS, recorded', () => {
    const m = read('migrations/124_password_reset.sql');
    assert.match(m, /CREATE TABLE IF NOT EXISTS public\.password_reset_codes/);
    assert.match(m, /ALTER TABLE public\.password_reset_codes ENABLE ROW LEVEL SECURITY;/);
    assert.match(m, /VALUES \('124_password_reset'/);
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
