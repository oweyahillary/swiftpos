// A494 — access-control hardening before more clients are onboarded (internal audit): limiter keys, one PIN limiter,
// clock-in names nobody, set-pin's oracle, the renewal re-reads the person, the owner's role checked like anyone's,
// sessions end with a deactivation, no branchless non-owner token, verify-pin for tills only, logout verifies, the
// staff routes' ceilings, override-PIN approvers, PATCH /auth/me.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/auth-hardening.test.mjs
//
// RUNS the COMPILED auth and staff routers behind the REAL auth middleware over HTTP; the database in memory
// (tests/lib-memdb.mjs). Pure rules (limiter keys, branch scope, approver) run from the compiled libs.
//
// MUTATIONS TO CONFIRM BITE (A494): the verify() in limiterKeys.authLimiterKeyFor bypassed → "a made-up token" fails;
// pinLocked() check removed from verify-pin → "the right PIN is refused while paused" fails; the refresh's status check
// removed → "a deactivated person cannot renew" fails; resultingKeys' keysBeyond in PATCH removed → "taking away a deny
// row" fails; the may() filter on override-PIN holders removed in approver.ts → "an override PIN alone" fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/pinAttempts.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.SUPABASE_ANON_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.LOGIN_OTP_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase, authClient } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
// The owner's password check (Supabase Auth): every password is wrong here — the per-account counter is what is tested.
authClient.auth.signInWithPassword = async () => ({ data: { user: null }, error: { message: 'Invalid login credentials' } });
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const attempts = require(path.join(DIST, 'lib/pinAttempts.js'));
const LK = require(path.join(DIST, 'lib/limiterKeys.js'));
const rbac = require(path.join(DIST, 'middleware/rbac.js'));
const AP = require(path.join(DIST, 'lib/approver.js'));
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const express = require('express');

const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = u(900), BR = u(901), BR2 = u(902);
const OWNER = u(1), MGR = u(2), CASH = u(3), PEER = u(4), FAR = u(5), ADMINP = u(6), MULTI = u(7);
const R_OWNER = u(800), R_MGR = u(801), R_CASH = u(802), R_BIG = u(803);
const PERM = (k) => `bbbbbbbb-0000-4000-8000-${createHash('md5').update(k).digest('hex').slice(0, 12)}`;
const MGR_KEYS = ['orders.create', 'staff.view', 'staff.edit', 'sales.void', 'reports.sales'];
const CASH_KEYS = ['orders.create'];
const BIG_KEYS = [...MGR_KEYS, 'reports.costs'];
const PINS = { [OWNER]: '1111', [MGR]: '2222', [CASH]: '3333', [PEER]: '4444', [FAR]: '5555', [ADMINP]: '6666', [MULTI]: '7777' };
const hashes = {};
for (const [id, p] of Object.entries(PINS)) hashes[id] = await bcrypt.hash(p, 4);
const ALL_KEYS = [...new Set([...BIG_KEYS, 'sales.refund', 'shifts.confirm'])];

const BRANCH_ROWS = () => [{ id: BR, business_id: B, name: 'Westlands', status: 'active', desktop_licensed: true },
  { id: BR2, business_id: B, name: 'Kilimani', status: 'active', desktop_licensed: false }];
const grantsOf = (keys) => keys.map((k) => ({ permissions: { key: k } }));
const roles = {
  [R_OWNER]: { id: R_OWNER, business_id: B, name: 'Admin', keys: [] },
  [R_MGR]: { id: R_MGR, business_id: B, name: 'Manager', keys: MGR_KEYS },
  [R_CASH]: { id: R_CASH, business_id: B, name: 'Cashier', keys: CASH_KEYS },
  [R_BIG]: { id: R_BIG, business_id: B, name: 'Area manager', keys: BIG_KEYS },
};
const person = (id, name, roleId, branches, extra = {}) => ({
  id, name, email: `${name.toLowerCase()}@pollo.test`, status: 'active', business_id: B, permissions_version: 1,
  role_id: roleId, pin_hash: hashes[id], override_pin_hash: null, must_change_password: false, ...extra,
  roles: { id: roleId, name: roles[roleId].name, role_permissions: grantsOf(roles[roleId].keys) },
  user_branches: branches.map((b) => ({ branch_id: b, branches: BRANCH_ROWS().find((x) => x.id === b) })), user_permissions: extra.user_permissions ?? [],
});
// A528: requireAuth remembers the rows 30 s (lib/authCache.ts). The rows below are changed in the database directly (as
// SQL would) — forgotten here by hand; through the API it is forgotten at once (tests/polling-cost-a528.test.mjs).
const authCache = require(path.join(DIST, 'lib/authCache.js'));
const reset = () => {
  attempts._resetAttempts();
  authCache._resetAuthCache();
  mem.fail = () => null; mem.calls = [];
  mem.db = {
    businesses: [{ id: B, owner_id: 'auth-owner', name: 'Pollo', status: 'active', type: 'restaurant' }],
    branches: BRANCH_ROWS(),
    roles: Object.values(roles).map(({ keys, ...r }) => r),
    role_permissions: Object.values(roles).flatMap((r) => r.keys.map((k) => ({ role_id: r.id, permission_id: PERM(k), permissions: { key: k } }))),
    permissions: ALL_KEYS.map((k) => ({ id: PERM(k), key: k })),
    users: [
      person(OWNER, 'Owner', R_OWNER, [BR], { must_change_password: true }),
      person(MGR, 'Mary', R_MGR, [BR]),
      person(CASH, 'Joe', R_CASH, [BR]),
      person(PEER, 'Pat', R_MGR, [BR]),
      person(FAR, 'Kim', R_CASH, [BR2]),
      person(ADMINP, 'Ada', R_OWNER, [BR]),
      person(MULTI, 'Max', R_CASH, [BR, BR2]),
    ],
    user_branches: [], user_permissions: [], refresh_tokens: [], clock_events: [], notifications: [],
    business_settings: [], feature_flags: [{ business_id: B, key: 'web_hosting', enabled: true }],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, user_id: null }],
  };
  // user_branches / user_permissions as tables too (the staff routes read and write them directly)
  for (const p of mem.db.users) for (const b of p.user_branches) mem.db.user_branches.push({ user_id: p.id, branch_id: b.branch_id });
};
const userRow = (id) => mem.db.users.find((x) => x.id === id);

const app = express();
app.use(express.json());
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
app.use('/api/staff', require(path.join(DIST, 'routes/staff.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const tok = (p) => jwt.sign({ sessionId: `s-${Math.random()}`, permissionsVersion: 0, surface: 'web', businessId: B, branchId: BR, isOwner: false, ...p },
  process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: () => tok({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, surface: undefined, permissionKeys: ['*'] }),
  mgr: () => tok({ userId: MGR, roleId: R_MGR, permissionKeys: MGR_KEYS }),
  mgrNoBranch: () => tok({ userId: MGR, roleId: R_MGR, branchId: null, permissionKeys: MGR_KEYS }),
  cash: () => tok({ userId: CASH, roleId: R_CASH, permissionKeys: CASH_KEYS }),
  till: () => tok({ userId: null, deviceId: 'dev-T1', till: true, surface: 'desktop', permissionKeys: ['*'] }),
  tillPin: () => tok({ userId: MGR, roleId: R_MGR, surface: 'desktop', pinSignIn: true, permissionKeys: MGR_KEYS }),
  adminPin: () => tok({ userId: ADMINP, roleId: R_OWNER, roleName: 'Admin', isOwner: true, branchId: null, surface: 'desktop', pinSignIn: true, permissionKeys: ['*'] }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  state._setPermissionsMigrated(true);

  // ── 1. limiter keys ─────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n1. Limiter keys: a made-up header never picks the bucket\n');
  const verify = (t) => jwt.verify(t, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  const good = T.mgr();
  await ok('a made-up token on an authenticated path counts as the address (was its last 24 characters)', async () => {
    const forged = jwt.sign({ userId: MGR, sessionId: 'x' }, 'not-our-secret');
    assert.equal(LK.authLimiterKeyFor({ url: '/api/auth/verify-pin', authorization: `Bearer ${forged}`, ipKey: 'ip1' }, verify), 'ip1');
    assert.equal(LK.authLimiterKeyFor({ url: '/api/auth/verify-pin', authorization: `Bearer ${randomBytes(30).toString('hex')}`, ipKey: 'ip1' }, verify), 'ip1');
  });
  await ok('the anonymous sign-in paths are keyed on the address even with a valid token', async () => {
    for (const p of ['/api/auth/login', '/api/auth/pos-login', '/api/auth/password/forgot', '/api/auth/password/reset?x=1', '/api/admin/auth/login', '/api/auth/enrol/redeem', '/api/auth/device-token']) {
      assert.equal(LK.authLimiterKeyFor({ url: p, authorization: `Bearer ${good}`, ipKey: 'ip9' }, verify), 'ip9', p);
    }
  });
  await ok('a VERIFIED token picks its own bucket (a person by session, a till by device)', async () => {
    const sid = jwt.decode(good).sessionId;
    assert.equal(LK.authLimiterKeyFor({ url: '/api/auth/verify-pin', authorization: `Bearer ${good}`, ipKey: 'ip1' }, verify), `t:s:${sid}`);
    assert.match(LK.apiLimiterKeyFor({ url: '/api/orders', authorization: `Bearer ${T.till()}`, ipKey: 'ip1' }, verify), /^t:d:.*dev-T1$/);
  });
  await ok('index.ts wires both limiters through limiterKeys and no longer reads x-device-id for a bucket', async () => {
    const ix = read('apps/server/src/index.ts');
    assert.match(ix, /authLimiterKeyFor\(limiterInput\(req\), verifyOurs\)/);
    assert.match(ix, /apiLimiterKeyFor\(limiterInput\(req\), verifyOurs\)/);
    assert.doesNotMatch(ix, /if \(device\) return `d:\$\{device\}`/);
    assert.doesNotMatch(ix, /auth\.slice\(-24\)/);
  });

  reset();
  await ok('pos-login: 10 failed sign-ins for one e-mail → 429, the right PIN too, from any address', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await call('POST', '/api/auth/pos-login', null, { email: 'joe@pollo.test', pin: '9990' });
      assert.equal(r.status, 401, `try ${i}: ${JSON.stringify(r.body)}`);
    }
    const r = await call('POST', '/api/auth/pos-login', null, { email: 'JOE@pollo.test', pin: '3333', surface: 'web' });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'ACCOUNT_LOCKED');
    const other = await call('POST', '/api/auth/pos-login', null, { email: 'mary@pollo.test', pin: '9990' });
    assert.equal(other.status, 401, 'another account is not paused');
  });
  await ok('login (password): the same per-account counter', async () => {
    for (let i = 0; i < 10; i++) await call('POST', '/api/auth/login', null, { email: 'owner@pollo.test', password: 'wrong-password' });
    const r = await call('POST', '/api/auth/login', null, { email: 'owner@pollo.test', password: 'wrong-password' });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'ACCOUNT_LOCKED');
  });

  // ── 2/9. verify-pin: tills only, one PIN limiter ───────────────────────────────────────────────────────────────────
  console.log('\n2 / 9. verify-pin: a till\'s PIN pad only, with the PIN limiter\n');
  reset();
  await ok('a web session may not try PINs at verify-pin (403 TILL_ONLY); the till and a PIN sign-in on a till may', async () => {
    const web = await call('POST', '/api/auth/verify-pin', T.mgr(), { pin: '3333', branch_id: BR });
    assert.equal(web.status, 403); assert.equal(web.body.code, 'TILL_ONLY');
    const till = await call('POST', '/api/auth/verify-pin', T.till(), { pin: '3333', branch_id: BR });
    assert.equal(till.status, 200, JSON.stringify(till.body)); assert.equal(till.body.staff.id, CASH);
    const pinTok = await call('POST', '/api/auth/verify-pin', T.tillPin(), { pin: '3333', branch_id: BR });
    assert.equal(pinTok.status, 200, JSON.stringify(pinTok.body));
  });
  await ok('10 wrong PINs from one till → 429 PIN_LOCKED, and the right PIN is refused while paused', async () => {
    attempts._resetAttempts();
    const till = T.till();
    for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/auth/verify-pin', till, { pin: String(8000 + i), branch_id: BR })).status, 401);
    const r = await call('POST', '/api/auth/verify-pin', till, { pin: '3333', branch_id: BR });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'PIN_LOCKED');
    const fresh = await call('POST', '/api/auth/verify-pin', till, { pin: '3333', branch_id: BR });
    assert.equal(fresh.status, 429, 'a new session of the same till is the same till');
  });
  await ok('pinAttempts: a failure window, a lock, then free again', async () => {
    const c = attempts.createFailureCounter({ max: 3, windowMs: 1000, lockMs: 5000 });
    c.fail('k', 0); c.fail('k', 10);
    assert.equal(c.locked('k', 20), false);
    c.fail('k', 2000); assert.equal(c.locked('k', 2001), false, 'old failures fall out of the window');
    c.fail('k', 2002); assert.equal(c.fail('k', 2003), true); assert.equal(c.locked('k', 2004), true);
    assert.equal(c.locked('k', 7004), false);
    assert.equal(attempts.pinKey({ businessId: 'b', userId: null, isTill: true, deviceId: 'd', ip: '1' }), 'b|d:d');
    assert.equal(attempts.pinKey({ businessId: 'b', userId: 'p', ip: '1' }), 'b|u:p');
    assert.equal(attempts.pinKey({ businessId: 'b', userId: null, ip: '1' }), 'b|ip:1');
  });

  // ── 3. clock ────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Clock in/out names the signed-in person only\n');
  reset();
  await ok('the caller\'s own PIN clocks the caller', async () => {
    const r = await call('POST', '/api/staff/clock', T.cash(), { pin: '3333', type: 'in', branch_id: BR });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.staff_id, CASH);
    assert.equal(mem.db.clock_events.length, 1); assert.equal(mem.db.clock_events[0].branch_id, BR);
  });
  await ok('another person\'s PIN with my session: the same 401 as a PIN nobody has — nobody named, nobody clocked', async () => {
    const theirs = await call('POST', '/api/staff/clock', T.cash(), { pin: '2222', type: 'in' });
    const nobody = await call('POST', '/api/staff/clock', T.cash(), { pin: '9876', type: 'in' });
    assert.equal(theirs.status, 401); assert.deepEqual(theirs.body, nobody.body);
    assert.equal(mem.db.clock_events.length, 1);
  });
  await ok('staff_id + that person\'s PIN clocks them; a person of another branch is refused the same way', async () => {
    const r = await call('POST', '/api/staff/clock', T.till(), { pin: '2222', type: 'out', staff_id: MGR, branch_id: BR });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.staff_id, MGR);
    const far = await call('POST', '/api/staff/clock', T.till(), { pin: '5555', type: 'in', staff_id: FAR });
    assert.equal(far.status, 401);
    const none = await call('POST', '/api/staff/clock', T.till(), { pin: '5555', type: 'in' });
    assert.equal(none.status, 400, 'a till names who');
  });
  await ok('clock failures count: the 11th try is 429', async () => {
    attempts._resetAttempts();
    const t = T.cash();
    for (let i = 0; i < 10; i++) await call('POST', '/api/staff/clock', t, { pin: String(7000 + i), type: 'in' });
    assert.equal((await call('POST', '/api/staff/clock', t, { pin: '3333', type: 'in' })).status, 429);
  });

  // ── 4. set-pin ──────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n4. set-pin: no "someone else has that PIN" oracle without a limit\n');
  reset();
  await ok('a taken PIN: a refusal that names nobody, counted — the 11th is 429', async () => {
    const r = await call('POST', '/api/auth/set-pin', T.cash(), { pin: '2222' });
    assert.equal(r.status, 409); assert.doesNotMatch(r.body.error, /another|staff member|in use/i);
    for (let i = 0; i < 9; i++) await call('POST', '/api/auth/set-pin', T.cash(), { pin: '2222' });
    const locked = await call('POST', '/api/auth/set-pin', T.cash(), { pin: '4321' });
    assert.equal(locked.status, 429); assert.equal(locked.body.code, 'PIN_LOCKED');
  });
  await ok('a free PIN is set (bcrypt)', async () => {
    attempts._resetAttempts();
    const r = await call('POST', '/api/auth/set-pin', T.cash(), { pin: '4321' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(userRow(CASH).pin_hash, /^\$2/);
  });

  // ── 5. refresh re-reads the person ─────────────────────────────────────────────────────────────────────────────
  console.log('\n5. A renewal re-reads who the person is\n');
  const signIn = async (email, pin, extra = {}) => {
    const r = await call('POST', '/api/auth/pos-login', null, { email, pin, surface: 'web', branch_id: BR, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  reset();
  await ok('a deactivated person cannot renew (401 SIGN_IN_AGAIN)', async () => {
    const s = await signIn('joe@pollo.test', '3333');
    userRow(CASH).status = 'inactive';
    const r = await call('POST', '/api/auth/refresh', null, { refreshToken: s.refreshToken });
    assert.equal(r.status, 401); assert.equal(r.body.code, 'SIGN_IN_AGAIN');
  });
  await ok('a deleted person cannot renew', async () => {
    const s = await signIn('mary@pollo.test', '2222');
    mem.db.users = mem.db.users.filter((x) => x.id !== MGR);
    const r = await call('POST', '/api/auth/refresh', null, { refreshToken: s.refreshToken });
    assert.equal(r.status, 401); assert.equal(r.body.code, 'SIGN_IN_AGAIN');
  });
  reset();
  await ok('moved off the token\'s branch → refused; a role change → the new role\'s keys, not the old token\'s', async () => {
    const s = await signIn('joe@pollo.test', '3333');
    const p = userRow(CASH);
    p.role_id = R_MGR; p.roles = { id: R_MGR, name: 'Manager', role_permissions: grantsOf(MGR_KEYS) };
    const r = await call('POST', '/api/auth/refresh', null, { refreshToken: s.refreshToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const claims = jwt.decode(r.body.accessToken);
    assert.equal(claims.roleId, R_MGR); assert.equal(claims.roleName, 'Manager'); assert.equal(claims.isOwner, false);
    assert.ok(claims.permissionKeys.includes('staff.edit'));
    p.user_branches = [{ branch_id: BR2 }];
    const moved = await call('POST', '/api/auth/refresh', null, { refreshToken: r.body.refreshToken });
    assert.equal(moved.status, 401); assert.equal(moved.body.code, 'SIGN_IN_AGAIN'); assert.equal(moved.body.reason, 'BRANCH_REMOVED');
  });
  reset();
  await ok('an "Admin" PIN sign-in whose role is taken away renews as what they are now (not the owner)', async () => {
    const s = await signIn('ada@pollo.test', '6666');
    assert.equal(jwt.decode(s.accessToken).isOwner, true);
    const p = userRow(ADMINP);
    p.role_id = R_CASH; p.roles = { id: R_CASH, name: 'Cashier', role_permissions: grantsOf(CASH_KEYS) };
    const r = await call('POST', '/api/auth/refresh', null, { refreshToken: s.refreshToken });
    // The owner's token carried no branch: as a cashier it may not renew branchless.
    assert.equal(r.status, 401); assert.equal(r.body.reason, 'NO_BRANCH');
  });

  // ── 6/13. middleware ────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n6 / 13. requireAuth: the owner\'s ROLE is checked like anyone; only the real owner skips\n');
  reset();
  await ok('an owner-role PIN token of a deactivated person is refused', async () => {
    const t = T.adminPin();
    assert.equal((await call('GET', '/api/staff/roles', t)).status, 200);
    userRow(ADMINP).status = 'inactive';
    authCache._resetAuthCache();   // A528: changed in the database directly
    const r = await call('GET', '/api/staff/roles', t);
    assert.equal(r.status, 401); assert.equal(r.body.code, 'ACCOUNT_INACTIVE');
  });
  await ok('an owner-role PIN token after a permissions change is told to renew (PERMISSIONS_CHANGED)', async () => {
    reset();
    const t = tok({ userId: ADMINP, roleId: R_OWNER, isOwner: true, branchId: null, surface: 'desktop', pinSignIn: true, permissionKeys: ['*'], permissionsVersion: 1 });
    assert.equal((await call('GET', '/api/staff/roles', t)).status, 200);
    userRow(ADMINP).permissions_version = 2;
    authCache._resetAuthCache();   // A528: changed in the database directly
    assert.equal((await call('GET', '/api/staff/roles', t)).body.code, 'PERMISSIONS_CHANGED');
  });
  await ok('a token naming nobody (no users row) → 401; the real owner (businesses.owner_id) and the password session skip', async () => {
    reset();
    const ghost = tok({ userId: u(999), roleId: R_MGR, permissionKeys: MGR_KEYS });
    assert.equal((await call('GET', '/api/staff/roles', ghost)).status, 401);
    mem.db.businesses[0].owner_id = u(998);
    authCache._resetAuthCache();   // A528: changed in the database directly
    const realOwner = tok({ userId: u(998), isOwner: true, branchId: null, surface: 'desktop', pinSignIn: true, roleId: R_OWNER, permissionKeys: ['*'] });
    assert.equal((await call('GET', '/api/staff/roles', realOwner)).status, 200);
    userRow(OWNER).status = 'inactive';   // the password session does not read the row (as before)
    assert.equal((await call('GET', '/api/staff/roles', T.owner())).status, 200);
  });
  await ok('the Supabase owner path finds the owner\'s role by isOwnerRoleName (onboarding names it Admin)', async () => {
    const src = read('apps/server/src/middleware/auth.ts');
    assert.doesNotMatch(src, /\.eq\('name', 'owner'\)/);
    assert.match(src, /find\(\(r\) => isOwnerRoleName\(r\.name\)\)/);
  });

  // ── 7. sessions end ─────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n7. Deactivate, delete, role or branch change: every session of theirs ends (never a till\'s)\n');
  const seedSessions = () => {
    mem.db.refresh_tokens.push(
      { id: 'rt-web', jti: 'a', user_id: CASH, business_id: B, session_kind: 'web', revoked_at: null },
      { id: 'rt-pin', jti: 'b', user_id: CASH, business_id: B, session_kind: 'pin', device_hint: 'dev-T1', revoked_at: null },
      { id: 'rt-till', jti: 'c', user_id: null, business_id: B, session_kind: 'device', device_hint: 'dev-T1', revoked_at: null },
      { id: 'rt-mary', jti: 'd', user_id: MGR, business_id: B, session_kind: 'web', revoked_at: null });
  };
  const live = () => mem.db.refresh_tokens.filter((t) => !t.revoked_at).map((t) => t.id).sort();
  for (const [label, act] of [
    ['deactivated (PATCH status)', () => call('PATCH', `/api/staff/${CASH}`, T.owner(), { status: 'inactive' })],
    ['deleted (DELETE)', () => call('DELETE', `/api/staff/${CASH}`, T.owner())],
    ['given another role', () => call('PATCH', `/api/staff/${CASH}`, T.owner(), { role_id: R_MGR })],
    ['moved to another branch', () => call('PATCH', `/api/staff/${CASH}`, T.owner(), { branch_ids: [BR2] })],
  ]) {
    await ok(`${label}: their web and PIN sessions are revoked; the till's own session and others' stay`, async () => {
      reset(); seedSessions();
      const r = await act();
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(live(), ['rt-mary', 'rt-till']);
    });
  }
  await ok('a rename that sends the same branches ends nothing', async () => {
    reset(); seedSessions();
    const r = await call('PATCH', `/api/staff/${CASH}`, T.owner(), { name: 'Joseph', branch_ids: [BR] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(live().length, 4);
  });
  await ok('migration 136 bumps permissions_version on branch and status changes (test-migration-136.mjs runs it)', async () => {
    const sql = read('migrations/136_branch_status_bump_pv.sql');
    assert.match(sql, /AFTER INSERT OR UPDATE OR DELETE ON public\.user_branches/);
    assert.match(sql, /BEFORE UPDATE OF status ON public\.users/);
  });

  // ── 8. pos-login and branch scope ───────────────────────────────────────────────────────────────────────────────
  console.log('\n8. pos-login: never a non-owner token without a branch; the code and the licence on what is resolved\n');
  reset();
  await ok('more than one branch and none chosen: the branch list only — no token', async () => {
    const r = await call('POST', '/api/auth/pos-login', null, { email: 'max@pollo.test', pin: '7777', surface: 'web' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.needsBranchSelection, true);
    assert.equal(r.body.accessToken, undefined); assert.equal(r.body.refreshToken, undefined);
    assert.deepEqual(r.body.branches.map((b) => b.id).sort(), [BR, BR2].sort());
    assert.equal(r.body.staff.name, 'Max');
    assert.equal(mem.db.refresh_tokens.length, 0);
  });
  await ok('the licence is checked on the RESOLVED branch (one branch, picked for them)', async () => {
    const r = await call('POST', '/api/auth/pos-login', null, { email: 'kim@pollo.test', pin: '5555', surface: 'desktop' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'BRANCH_NOT_LICENSED');
  });
  await ok('a non-owner with no open branch gets no token', async () => {
    mem.db.branches.forEach((b) => { b.status = 'closed'; });
    userRow(CASH).user_branches = [];
    const r = await call('POST', '/api/auth/pos-login', null, { email: 'joe@pollo.test', pin: '3333', surface: 'desktop' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'NO_BRANCH');
  });
  reset();
  await ok('the sign-in code applies whatever surface is claimed (a manager claiming "desktop")', async () => {
    mem.db.feature_flags.push({ business_id: B, key: 'login_codes', enabled: true });
    userRow(MGR).otp_method = 'totp'; userRow(MGR).otp_totp_secret = 'JBSWY3DPEHPK3PXP';
    const r = await call('POST', '/api/auth/pos-login', null, { email: 'mary@pollo.test', pin: '2222', surface: 'desktop', branch_id: BR });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OTP_REQUIRED');
    const cashier = await call('POST', '/api/auth/pos-login', null, { email: 'joe@pollo.test', pin: '3333', surface: 'desktop', branch_id: BR });
    assert.equal(cashier.status, 200, 'a cashier enters no code');
    assert.equal(jwt.decode(cashier.body.accessToken).branchId, BR);
  });
  await ok('branchScope: a branchless non-owner matches nothing (was every branch); assertBranchAccess agrees', async () => {
    const req = (o) => ({ isOwner: false, branchId: null, headers: {}, query: { branch_id: BR }, ...o });
    assert.equal(rbac.branchScope(req()), rbac.NO_BRANCH);
    assert.equal(rbac.branchScope(req({ branchId: BR2 })), BR2);
    assert.equal(rbac.branchScope(req({ isOwner: true, query: {} })), null, 'the owner\'s "all branches" stays');
    assert.equal(rbac.assertBranchAccess(req(), BR), false);
    assert.equal(rbac.assertBranchAccess(req(), null), false, 'null === null used to pass');
    assert.equal(rbac.assertBranchAccess(req({ branchId: BR }), BR), true);
    assert.equal(rbac.assertBranchAccess(req({ branchId: BR }), rbac.NO_BRANCH), false);
  });

  // ── 10. logout ──────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n10. Log out everywhere believes only a token that verifies\n');
  reset();
  await ok('a made-up token naming someone signs nobody out; a real one does', async () => {
    mem.db.refresh_tokens.push({ id: 'rt-m', jti: 'm', user_id: MGR, business_id: B, session_kind: 'web', revoked_at: null });
    const forged = jwt.sign({ userId: MGR, businessId: B }, 'not-our-secret');
    await call('POST', '/api/auth/logout', forged, { logoutAll: true });
    assert.equal(mem.db.refresh_tokens[0].revoked_at, null);
    await call('POST', '/api/auth/logout', T.mgr(), { logoutAll: true });
    assert.ok(mem.db.refresh_tokens[0].revoked_at);
  });

  // ── 11. staff routes ────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n11. Staff routes: branches, self, resulting keys, peers, bcrypt, override PINs\n');
  reset();
  await ok('(a) a non-owner may not send branch_ids [] (every branch) or another branch; [own] is fine', async () => {
    assert.equal((await call('PATCH', `/api/staff/${CASH}`, T.mgr(), { branch_ids: [] })).status, 403);
    assert.equal((await call('PATCH', `/api/staff/${CASH}`, T.mgr(), { branch_ids: [BR, BR2] })).status, 403);
    const r = await call('PATCH', `/api/staff/${CASH}`, T.mgr(), { branch_ids: [BR] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  await ok('(a) a non-owner with no branch adds and invites nobody', async () => {
    const add = await call('POST', '/api/staff', T.mgrNoBranch(), { name: 'New', role_id: R_CASH, pin: '1357' });
    assert.equal(add.status, 403); assert.equal(add.body.code, 'NO_BRANCH');
    const inv = await call('POST', '/api/staff/invite', T.mgrNoBranch(), { name: 'New', email: 'n@x.co', role_id: R_CASH });
    assert.equal(inv.status, 403); assert.equal(inv.body.code, 'NO_BRANCH');
  });
  await ok('(b) a non-owner may not change their own role, permissions or branches', async () => {
    for (const body of [{ role_id: R_CASH }, { override_keys: {} }, { branch_ids: [BR] }]) {
      const r = await call('PATCH', `/api/staff/${MGR}`, T.mgr(), body);
      assert.equal(r.status, 403, JSON.stringify(body)); assert.equal(r.body.code, 'OWN_ACCESS');
    }
    assert.equal((await call('PATCH', `/api/staff/${MGR}`, T.mgr(), { name: 'Mary W' })).status, 200, 'their name is fine');
  });
  await ok('(b) taking away someone\'s "not allowed" row for a key the caller lacks is refused (it gives the key back)', async () => {
    reset();
    // Kim (moved to BR for this) holds the big role minus reports.costs — within Mary's keys today.
    const k = userRow(FAR); k.user_branches = [{ branch_id: BR }]; mem.db.user_branches.push({ user_id: FAR, branch_id: BR });
    k.role_id = R_BIG; k.roles = { id: R_BIG, name: 'Area manager', role_permissions: grantsOf(BIG_KEYS) };
    k.user_permissions = [{ permission_id: PERM('reports.costs'), granted: false, permissions: { key: 'reports.costs' } }];
    const r = await call('PATCH', `/api/staff/${FAR}`, T.mgr(), { override_keys: {} });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.deepEqual(r.body.missing, ['reports.costs']);
    const keep = await call('PATCH', `/api/staff/${FAR}`, T.mgr(), { override_keys: { 'reports.costs': false } });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
  });
  reset();
  await ok('(c) a peer with the same keys keeps their PIN and e-mail; someone holding less may be changed', async () => {
    const peer = await call('PATCH', `/api/staff/${PEER}`, T.mgr(), { pin: '2468' });
    assert.equal(peer.status, 403); assert.equal(peer.body.code, 'PEER_CREDENTIALS');
    assert.equal((await call('PATCH', `/api/staff/${PEER}`, T.mgr(), { email: 'me@evil.co' })).status, 403);
    const lesser = await call('PATCH', `/api/staff/${CASH}`, T.mgr(), { pin: '2468' });
    assert.equal(lesser.status, 200, JSON.stringify(lesser.body));
  });
  await ok('(d) PATCH and POST store the PIN with bcrypt', async () => {
    assert.match(userRow(CASH).pin_hash, /^\$2/);
    const r = await call('POST', '/api/staff', T.owner(), { name: 'Zed', role_id: R_CASH, pin: '1593', branch_ids: [BR] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(mem.db.users.find((x) => x.name === 'Zed').pin_hash, /^\$2/);
  });
  await ok('(e) an override PIN: only from someone who may void/refund, only for someone who may', async () => {
    const forCashier = await call('PATCH', `/api/staff/${CASH}`, T.owner(), { override_pin: '8642' });
    assert.equal(forCashier.status, 403); assert.equal(forCashier.body.code, 'OVERRIDE_PIN_NO_AUTHORITY');
    const byNonApprover = await call('PATCH', `/api/staff/${CASH}`, tok({ userId: PEER, roleId: R_MGR, permissionKeys: ['staff.edit', 'staff.view', 'orders.create'] }), { override_pin: '8642' });
    assert.equal(byNonApprover.status, 403);
    const ok2 = await call('PATCH', `/api/staff/${PEER}`, T.owner(), { override_pin: '8642' });
    assert.equal(ok2.status, 200, JSON.stringify(ok2.body)); assert.match(userRow(PEER).override_pin_hash, /^\$2/);
    assert.equal((await call('PATCH', `/api/staff/${CASH}`, T.owner(), { override_pin: '' })).status, 200, 'clearing is always allowed');
  });

  // ── 12. approver ────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n12. Approvers: an override PIN needs the key, the branch, and is not the actor\n');
  const row = (id, name, keys, branches, extra = {}) => ({ id, pin_hash: `login-${id}`, override_pin_hash: null,
    roles: { name, role_permissions: grantsOf(keys) }, user_permissions: [], user_branches: branches.map((b) => ({ branch_id: b })), ...extra });
  const checks = { loginPin: async (p, h) => h === `login-${p}`, overridePin: async (p, h) => h === `ovr-${p}` };
  await ok('an override PIN alone no longer approves — its holder must hold the action\'s key', async () => {
    const rows = [row('cash', 'Cashier', CASH_KEYS, [BR], { override_pin_hash: 'ovr-9' })];
    assert.equal((await AP.findApprover(rows, { pin: '9', action: 'void' }, checks)).result, 'none');
    rows[0].roles.role_permissions = grantsOf(['sales.void']);
    assert.equal((await AP.findApprover(rows, { pin: '9' }, checks)).result, 'ok');
  });
  await ok('with a branch: an approver of another branch is not one; the owner is everywhere; rows without branches fail closed', async () => {
    const rows = [row('far', 'Manager', ['sales.void'], [BR2]), row('own', 'Admin', [], [BR2])];
    assert.equal((await AP.findApprover(rows, { pin: 'far', branchId: BR }, checks)).result, 'invalid');
    assert.equal((await AP.findApprover(rows, { pin: 'own', branchId: BR }, checks)).result, 'ok');
    assert.equal((await AP.findApprover(rows, { pin: 'far', branchId: BR2 }, checks)).result, 'ok');
    const noBranches = [{ ...row('m', 'Manager', ['sales.void'], []), user_branches: undefined }];
    assert.equal((await AP.findApprover(noBranches, { pin: 'm', branchId: BR }, checks)).result, 'none');
  });
  await ok('the actor may not approve their own void — unless they are the owner', async () => {
    const rows = [row('m', 'Manager', ['sales.void'], [BR]), row('o', 'Cashier', [], [BR])];
    // A505: their own PIN is answered 'self' (SELF_APPROVAL, no strike) — it was 'none', read as a wrong PIN.
    assert.equal((await AP.findApprover(rows, { pin: 'm', actorId: 'm' }, checks)).result, 'self');
    assert.equal((await AP.findApprover(rows, { pin: 'o', actorId: 'o', ownerId: 'o' }, checks)).result, 'ok');
  });

  // ── 14. PATCH /auth/me ──────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n14. PATCH /auth/me clears the caller\'s own flag only\n');
  reset();
  await ok('a cashier cannot clear the owner\'s forced password change', async () => {
    userRow(CASH).must_change_password = true;
    assert.equal((await call('PATCH', '/api/auth/me', T.cash(), { must_change_password: false })).status, 200);
    assert.equal(userRow(OWNER).must_change_password, true);
    assert.equal(userRow(CASH).must_change_password, false);
    await call('PATCH', '/api/auth/me', T.owner(), { must_change_password: false });
    assert.equal(userRow(OWNER).must_change_password, false);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
