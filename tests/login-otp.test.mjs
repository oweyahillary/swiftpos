/**
 * login-otp.test.mjs — A391: a one-time code at sign-in for admins, owners and managers (email, or an authenticator app).
 *
 * Owner, 2026-10-04: "OTP enabling both admin portal and dashboard" — "Both, user picks" — "Portal admin is mandatory,
 * owner should be mandatory also managers".
 *
 *   node tests/login-otp.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED admin router's sign-in over HTTP (database in memory, the email captured), the RFC 6238 test vectors
 * against the authenticator maths, and source pins on the owner / web POS sign-in, the Supabase-session refusal and the
 * three screens.
 *
 * MUTATIONS TO CONFIRM BITE: otpGate returning ok without a code → "no code → asked for one" fails; checkEmailCode not
 * marking the code used → "a code works once" fails; trustValid ignoring the version → "a reset voids remembered
 * browsers" fails; verifyTotp with a ±2 window → "two steps away is refused" fails; the pos-login gate without the
 * surface test → "a till never asks" fails; the Supabase-session branch without the refusal → its pin fails.
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

if (!fs.existsSync(path.join(DIST, 'lib/loginOtp.js'))) {
  console.log('\nCannot load apps/server/dist/lib/loginOtp.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
delete process.env.LOGIN_OTP;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const O = require(path.join(DIST, 'lib/loginOtp.js'));
const { encryptSecret } = require(path.join(DIST, 'lib/crypto.js'));
const bcrypt = require('bcrypt');

// ── The database, in memory ─────────────────────────────────────────────────
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const db = {
  admin_users: [{ id: ADMIN, email: 'hillary@zaptill.co.ke', name: 'Hillary', role: 'super_admin', is_active: true,
    password_hash: bcrypt.hashSync('correct horse', 4), otp_method: 'email', otp_totp_secret: null, otp_version: 1 }],
  login_otp_codes: [], admin_audit_log: [],
};
let seq = 0, missingTable = false;
supabase.from = (table) => {
  const filters = []; let op = 'select', payload = null, desc = false, limit = Infinity;
  const matching = () => (db[table] ??= []).filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === 'insert') {
      if (missingTable && table === 'login_otp_codes') return { data: null, error: { code: '42P01', message: 'relation "login_otp_codes" does not exist' } };
      return { data: payload, error: null };
    }
    if (op === 'update') { matching().forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
    let rows = matching().slice();
    if (desc) rows.reverse();
    return { data: rows.slice(0, limit), error: null };
  };
  const q = new Proxy({}, {
    get(_t, p) {
      if (p === 'select') return () => q;
      if (p === 'eq') return (k, v) => { filters.push((r) => r[k] === v); return q; };
      if (p === 'is') return (k, v) => { filters.push((r) => (r[k] ?? null) === v); return q; };
      if (p === 'gte') return (k, v) => { filters.push((r) => String(r[k]) >= String(v)); return q; };
      if (p === 'order') return (_k, o) => { desc = o?.ascending === false; return q; };
      if (p === 'limit') return (n) => { limit = n; return q; };
      if (p === 'insert') return (row) => {
        op = 'insert';
        const rows = (Array.isArray(row) ? row : [row]).map((r) => ({ id: `id-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), attempts: 0, consumed_at: null, ...r }));
        if (!(missingTable && table === 'login_otp_codes')) (db[table] ??= []).push(...rows);
        payload = rows[0];
        return q;
      };
      if (p === 'update') return (patch) => { op = 'update'; payload = patch; return q; };
      if (p === 'single' || p === 'maybeSingle') return () => {
        const r = run(); const d = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
        return Promise.resolve({ data: d, error: r.error });
      };
      if (p === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      return () => q;
    },
  });
  return q;
};

const mail = [];
mailer.sendEmailChecked = async (m) => { mail.push(m); return { ok: true, provider: 'test' }; };
const lastCode = () => (mail[mail.length - 1]?.subject.match(/(\d{6})$/) ?? [])[1];

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const login = async (extra = {}) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'hillary@zaptill.co.ke', password: 'correct horse', ...extra }) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  console.log('\nThe authenticator maths (RFC 6238 test vectors, SHA-1)\n');
  const RFC = O.base32Encode(Buffer.from('12345678901234567890'));
  await ok('base32 round-trips; the RFC secret encodes as the apps expect', () => {
    assert.equal(RFC, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(O.base32Decode(RFC).toString(), '12345678901234567890');
  });
  await ok('the codes match RFC 6238 (59 s → 287082, 1111111109 s → 081804, 1234567890 s → 005924)', () => {
    assert.equal(O.totpAt(RFC, Math.floor(59 / 30)), '287082');
    assert.equal(O.totpAt(RFC, Math.floor(1111111109 / 30)), '081804');
    assert.equal(O.totpAt(RFC, Math.floor(1234567890 / 30)), '005924');
  });
  await ok('one step either side is accepted (a phone clock slightly off); two steps away is refused', () => {
    const t = 1234567890 * 1000;
    assert.ok(O.verifyTotp(RFC, '005924', t));
    assert.ok(O.verifyTotp(RFC, O.totpAt(RFC, 41152263 - 1), t));
    assert.ok(O.verifyTotp(RFC, O.totpAt(RFC, 41152263 + 1), t));
    assert.ok(!O.verifyTotp(RFC, O.totpAt(RFC, 41152263 + 2), t));
    assert.ok(!O.verifyTotp(RFC, 'abcdef', t));
  });
  await ok('a code is typed with spaces or a dash; anything but 6 digits is no code', () => {
    assert.equal(O.cleanCode('123 456'), '123456'); assert.equal(O.cleanCode('123-456'), '123456');
    assert.equal(O.cleanCode('12345'), null); assert.equal(O.cleanCode(undefined), null);
  });
  await ok('the email is shown masked; the QR code is an <svg> of the otpauth address', () => {
    assert.equal(O.maskEmail('owner@africanfries.co.ke'), 'o•••r@africanfries.co.ke');
    assert.equal(O.maskEmail('a.person.long@x.co'), 'a•••••g@x.co');
    const s = O.startTotpSetup('admin', ADMIN, 'hillary@zaptill.co.ke');
    assert.match(s.uri, /^otpauth:\/\/totp\/ZapTill%3Ahillary%40zaptill\.co\.ke\?secret=[A-Z2-7]{32}&issuer=ZapTill/);
    assert.match(s.qr_svg, /^<svg[\s\S]*<\/svg>$/);
    assert.equal(O.readSetup(s.setup_token, 'admin', ADMIN), s.secret);
    assert.equal(O.readSetup(s.setup_token, 'user', ADMIN), null);
  });
  await ok('owners and the manager tier need a code; cashiers do not', () => {
    assert.ok(O.roleNeedsOtp('Cashier', true));
    for (const r of ['owner', 'Admin', 'manager', 'Supervisor', 'Branch Manager']) assert.ok(O.roleNeedsOtp(r), r);
    for (const r of ['cashier', 'waiter', '', null]) assert.ok(!O.roleNeedsOtp(r), String(r));
  });

  console.log('\nThe admin portal sign-in (compiled router, over HTTP)\n');
  await ok('a wrong password is refused before any code is sent', async () => {
    const r = await login({ password: 'nope' });
    assert.equal(r.status, 401); assert.equal(mail.length, 0);
  });
  await ok('the right password, no code → asked for one, and it is emailed (no token yet)', async () => {
    const r = await login();
    assert.equal(r.status, 403); assert.equal(r.body.code, 'OTP_REQUIRED'); assert.equal(r.body.method, 'email');
    assert.equal(r.body.sent_to, 'h•••••y@zaptill.co.ke'); assert.equal(r.body.token, undefined);
    assert.equal(mail.length, 1); assert.equal(mail[0].to, 'hillary@zaptill.co.ke'); assert.match(lastCode(), /^\d{6}$/);
    assert.notEqual(db.login_otp_codes[0].code_hash, lastCode(), 'stored hashed, never as typed');
  });
  await ok('asking again within 45 s does not send a second email', async () => {
    await login(); assert.equal(mail.length, 1);
  });
  await ok('a wrong code is a 401 (counted as a failed sign-in); the right one signs in', async () => {
    const code = lastCode();
    const bad = await login({ otp_code: code === '000000' ? '111111' : '000000' });
    assert.equal(bad.status, 401); assert.equal(bad.body.code, 'OTP_INVALID');
    const good = await login({ otp_code: code });
    assert.equal(good.status, 200); assert.ok(good.body.token); assert.equal(good.body.otp_trust, undefined, 'not remembered unless asked');
  });
  await ok('a code works once', async () => {
    const again = await login({ otp_code: lastCode() });
    assert.equal(again.status, 401); assert.equal(again.body.code, 'OTP_EXPIRED');
  });
  let trust = '';
  await ok('"remember this browser" → a token that signs in without a code next time', async () => {
    db.login_otp_codes.forEach((c) => { c.created_at = '2000-01-01T00:00:00Z'; });   // past the 45 s
    await login(); const r = await login({ otp_code: lastCode(), otp_remember: true });
    assert.equal(r.status, 200); trust = r.body.otp_trust; assert.ok(trust);
    const next = await login({ otp_trust: trust });
    assert.equal(next.status, 200); assert.ok(next.body.token);
  });
  await ok('five wrong tries and the code is dead — even the right one', async () => {
    db.login_otp_codes.forEach((c) => { c.created_at = '2000-01-01T00:00:00Z'; });
    await login(); const code = lastCode();
    for (let i = 0; i < 5; i++) await login({ otp_code: code === '000000' ? '111111' : '000000' });
    const r = await login({ otp_code: code });
    assert.equal(r.status, 401); assert.equal(r.body.code, 'OTP_EXPIRED');
  });
  await ok('switching to an authenticator app: its code signs in; an emailed-style guess does not', async () => {
    const secret = O.newTotpSecret();
    Object.assign(db.admin_users[0], { otp_method: 'totp', otp_totp_secret: encryptSecret(secret) });
    const n = mail.length;
    const ask = await login();
    assert.equal(ask.status, 403); assert.equal(ask.body.method, 'totp');
    assert.equal(mail.length, n, 'no email for an authenticator user');
    assert.equal((await login({ otp_code: '000000' === O.totpAt(secret, Math.floor(Date.now() / 30000)) ? '111111' : '000000' })).status, 401);
    const r = await login({ otp_code: O.totpAt(secret, Math.floor(Date.now() / 30000)) });
    assert.equal(r.status, 200);
  });
  // A403 (owner, 2026-10-05: "can someone have both authenticator and email?")
  await ok('an authenticator user may ask for an emailed code instead; it signs in only when asked for that way', async () => {
    assert.equal(db.admin_users[0].otp_method, 'totp');
    const ask = await login();
    assert.equal(ask.body.can_email, true, 'the screen is told it may offer email');
    db.login_otp_codes.forEach((c) => { c.consumed_at ??= new Date().toISOString(); });   // earlier tests' codes: used up
    const n = mail.length;
    const sent = await login({ otp_resend: true, otp_use_email: true });
    assert.equal(sent.status, 403); assert.equal(sent.body.method, 'email'); assert.equal(mail.length, n + 1, 'emailed');
    assert.equal(mail[mail.length - 1].to, 'hillary@zaptill.co.ke', 'only to the email on the account');
    const code = lastCode();
    assert.equal((await login({ otp_code: code })).status, 401, 'without otp_use_email the code is checked as an authenticator code');
    assert.equal((await login({ otp_code: code, otp_use_email: true })).status, 200);
    assert.equal(db.admin_users[0].otp_method, 'totp', 'the authenticator stays their method');
    const screens = [read('apps/dashboard/src/components/OtpCodeStep.tsx'), read('apps/admin/src/AdminPortal.tsx')];
    assert.match(screens[0], /\{prompt\.method === 'totp' \? 'Email me a code instead' : 'Send a new code'\}/);
    assert.match(screens[1], /\{otp\.method === "totp" \? "Email me a code instead" : "Send a new code"\}/);
    for (const f of ['apps/dashboard/src/pages/LoginPage.tsx', 'apps/dashboard/src/pages/pos/POSLoginScreen.tsx']) {
      assert.match(read(f), /\{ otp_resend: true, otp_use_email: true \}/, f);
      assert.match(read(f), /otp_use_email: otp\?\.method === 'email' \}/, f);
    }
  });
  await ok('a reset (lost phone) voids every remembered browser — and goes back to email codes', async () => {
    db.admin_users[0].otp_version = 1;
    assert.equal(await O.useEmailCodes('admin', ADMIN), null);
    assert.equal(db.admin_users[0].otp_method, 'email'); assert.equal(db.admin_users[0].otp_totp_secret, null);
    assert.equal(db.admin_users[0].otp_version, 2);
    const r = await login({ otp_trust: trust });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'OTP_REQUIRED'); assert.equal(r.body.method, 'email');
  });
  await ok('LOGIN_OTP=off (the emergency switch) signs in without a code', async () => {
    process.env.LOGIN_OTP = 'off';
    try { assert.equal((await login()).status, 200); } finally { delete process.env.LOGIN_OTP; }
  });
  await ok('before migration 119 (no code table) an admin is never locked out', async () => {
    missingTable = true; db.login_otp_codes = [];
    try { assert.equal((await login()).status, 200); } finally { missingTable = false; }
  });

  console.log('\nThe owner and the web POS, the session check, the screens (source)\n');
  // A398: only for a client whose 'Sign-in codes' switch the admin portal has turned on (off unless set).
  await ok('the owner\'s /login asks (switch on); the web POS asks owners and managers only (switch on), and a till never', () => {
    const a = read('apps/server/src/routes/auth.ts');
    assert.match(a, /const ownerGate = !\(await businessPosFeatures\(business\.id\)\)\.login_codes \? \{ ok: true as const \} : await otpGate\(\s*await otpSubjectFor\(/);
    assert.match(a, /if \(ownerGate\.ok === false\) \{ res\.status\(ownerGate\.status\)\.json\(ownerGate\.body\); return; \}/);
    assert.match(a, /if \(effectiveSurface === 'web' && \(roleNeedsOtp\(role\?\.name, isOwner\) \|\| effectivePerms\['settings\.manage'\] === true\)\n\s+&& \(await businessPosFeatures\(\(user as any\)\.business_id\)\)\.login_codes\) \{/);
    assert.match(a, /const enabled = \(await businessPosFeatures\(req\.businessId\)\)\.login_codes;/);
    const F = read('shared/posFeatures.ts');
    assert.match(F, /key: 'login_codes',\n\s+label: 'Sign-in codes \(OTP\)',/);
    // the admin portal's own sign-in is not behind the switch
    assert.doesNotMatch(read('apps/server/src/routes/admin.ts'), /login_codes|businessPosFeatures/);
    assert.ok(a.indexOf("roleNeedsOtp(role?.name, isOwner)") < a.indexOf('issueTokenPair(tokenPayload)'), 'asked before any token is issued');
  });
  await ok('a bare Supabase session (password only) is refused while codes are on', () => {
    const m = read('apps/server/src/middleware/auth.ts');
    assert.match(m, /if \(!otpDisabled\(\)\) \{\s*res\.status\(401\)\.json\(\{ error: 'Please sign in again\.', code: 'SIGN_IN_AGAIN' \}\);/);
  });
  await ok('the resets: super admin → an admin, admin → a client\'s owner, the owner → a manager', () => {
    const a = read('apps/server/src/routes/admin.ts');
    assert.match(a, /router\.post\('\/team\/:id\/reset-otp', requireAdmin, requireSuperAdmin,/);
    assert.match(a, /router\.post\('\/clients\/:id\/reset-owner-otp', requireAdmin,/);
    const s = read('apps/server/src/routes/staff.ts');
    assert.match(s, /if \(!req\.isOwner\) \{ res\.status\(403\)\.json\(\{ error: 'Only the owner can reset a sign-in code\.' \}\); return; \}/);
  });
  await ok('the three sign-in screens ask for the code and can remember the browser', () => {
    const ad = read('apps/admin/src/AdminPortal.tsx');
    assert.match(ad, /if \(err\.code === "OTP_REQUIRED"\) \{/);
    assert.match(ad, /signIn\(\{ otp_code: code, otp_remember: remember(, otp_use_email: otp\.method === "email")? \}\)/);
    const lp = read('apps/dashboard/src/pages/LoginPage.tsx');
    assert.match(lp, /if \(code === 'OTP_REQUIRED'\) \{/);
    assert.match(lp, /<OtpCodeStep/);
    const pl = read('apps/dashboard/src/pages/pos/POSLoginScreen.tsx');
    assert.match(pl, /if \(data\.code === 'OTP_REQUIRED'\) \{/);
    assert.match(pl, /otp_trust: otpPass \|\| readOtpTrust\(email\)/, 'the branch choice after the code needs no second code');
  });
  await ok('each person picks email or an authenticator app (admin portal, dashboard, manager screens)', () => {
    assert.match(read('apps/admin/src/SignInCodeCard.tsx'), /"\/auth\/otp\/totp\/confirm"/);
    assert.match(read('apps/dashboard/src/components/SignInSecurity.tsx'), /'\/api\/auth\/otp\/totp\/confirm'/);
    assert.match(read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), /case 'security':\s*return <SignInSecurity \/>;/);
    assert.match(read('apps/dashboard/src/App.tsx'), /<Route path="security" element=\{<SignInSecurityRoute \/>\} \/>/);
  });
  await ok('migration 119: the settings on both account tables, the code table under RLS, recorded', () => {
    const m = read('migrations/119_login_otp.sql');
    assert.match(m, /ALTER TABLE public\.admin_users\s+ADD COLUMN IF NOT EXISTS otp_method\s+text\s+NOT NULL DEFAULT 'email'/);
    assert.match(m, /ALTER TABLE public\.users\s+ADD COLUMN IF NOT EXISTS otp_method/);
    assert.match(m, /ALTER TABLE public\.login_otp_codes ENABLE ROW LEVEL SECURITY;/);
    assert.match(m, /'119_login_otp'/);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
