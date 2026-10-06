/**
 * till-own-signin.test.mjs — A415: a till signs in as itself, never as the owner.
 *
 * Owner, 2026-10-06 (Pollo's till on the PIN screen, "This branch server has no staff roster yet." and "Sign out /
 * switch account"): "remove any linkage with the desktop app using owners credetials, we find a way to use some key or
 * something that links the till to the business id and branch id never the owners session at all remove it totally
 * … add a way a technician can rejoin the app back to the bussiness rather than reseting it". And: "i was getting
 * errors that too many log in attempts on the web yet it was only one attempt".
 *
 *   node tests/till-own-signin.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED /api/auth routes and the real auth middleware over HTTP (database in memory; JWTs signed with a
 * per-run random secret):
 *   - joining with a code gives the till its OWN session: the till, the business, the branch — no person, no owner;
 *   - a technician's rejoin approves the same till again, keeps its id, and refuses a code for another branch unspent;
 *   - the cloud checks the TILL on every request (retired / revoked → refused), never the owner's account;
 *   - a till session from before A415 (the owner on the till) is refused for requests and replaced on renewal — and a
 *     till that may no longer renew keeps its token unspent;
 *   - the sign-in limit counts only failed attempts, and a till's renewals never use up a person's attempts.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - buildDeviceTokenPayload given the owner's id again           → "no person in the session" fails
 *   - the middleware's till check removed                           → "a retired till is refused at once" fails
 *   - isOwnerEraTillPayload not checked in the middleware          → "an owner-era till token is refused" fails
 *   - the refresh revoking BEFORE the till check                   → "a blocked till keeps its token unspent" fails
 *   - the rejoin branch check after the burn                        → "a code for another branch is refused unspent" fails
 *   - isRenewalPath dropping '/refresh'                             → "renewals are not counted" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'routes/auth.js'))) {
  console.log('\nCannot load apps/server/dist/routes/auth.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const L = require(path.join(DIST, 'lib/authLimits.js'));
const jwt = require('jsonwebtoken');

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const future = new Date(Date.now() + 86_400_000).toISOString();

let db;
const reset = () => {
  db = {
    businesses: [{ id: BZ, name: 'Pollo', currency: 'KES', type: 'restaurant', status: 'active' }],
    branches: [{ id: BR, business_id: BZ, name: 'Town' }, { id: BR2, business_id: BZ, name: 'Mall' }],
    users: [{ id: OWNER, business_id: BZ, status: 'active', permissions_version: 1 }],
    device_enrolment_codes: [
      { id: 'c1', business_id: BZ, branch_id: BR, code_hash: sha('JOIN-AAAA'), status: 'active', expires_at: future },
      { id: 'c2', business_id: BZ, branch_id: BR, code_hash: sha('JOIN-BBBB'), status: 'active', expires_at: future },
      { id: 'c3', business_id: BZ, branch_id: BR2, code_hash: sha('JOIN-CCCC'), status: 'active', expires_at: future },
    ],
    user_devices: [],
    refresh_tokens: [],
  };
};

// In-memory stand-in: eq / in / is / gt filters, select / insert / update / maybeSingle / single.
let nextId = 1;
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const run = () => {
    if (inserted) return inserted;
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    return rows();
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'is') return (k, v) => { f.push([k, (x) => (x ?? null) === v]); return q; };
      if (prop === 'gt') return (k, v) => { f.push([k, (x) => String(x) > String(v)]); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'insert') return (r) => {
        const list = (db[table] ??= []);
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `row-${nextId++}`, ...x }));
        list.push(...inserted); return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej);
      return () => q;   // select, order, limit …
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express');
const { requireAuth } = require(path.join(DIST, 'middleware/auth.js'));
const app = express(); app.use(express.json());
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
app.get('/api/who', requireAuth, (req, res) => res.json({ userId: req.userId, isTill: req.isTill, deviceId: req.deviceId, isOwner: req.isOwner, branchId: req.branchId }));
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (p, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const who = async (token, headers = {}) => {
  const r = await fetch(`${base}/api/who`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const join = (code, extra = {}) => post('/api/auth/enrol/redeem', { business_id: BZ, code, device_id: 'dev-T1', ...extra });

try {
  console.log('\nJoining the business with a code\n');
  await ok('the till gets its OWN session: the till, the business, the branch — no person, no owner', async () => {
    reset();
    const r = await join('JOIN-AAAA');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = jwt.decode(r.body.accessToken);
    assert.equal(p.userId, null); assert.equal(p.till, true); assert.equal(p.deviceId, 'dev-T1');
    assert.equal(p.businessId, BZ); assert.equal(p.branchId, BR); assert.equal(p.isOwner, false); assert.equal(p.surface, 'desktop');
    assert.ok(!('user' in r.body), 'no person handed to the till'); assert.deepEqual(r.body.till, { device_id: 'dev-T1', branch_id: BR });
    assert.ok(!JSON.stringify(r.body).includes(OWNER), 'the owner\'s id appears nowhere in the answer');
  });
  await ok('…and no person on its records: its device row and its session row name no one', async () => {
    const dev = db.user_devices.find((d) => d.device_id === 'dev-T1');
    assert.ok(dev && !dev.user_id, JSON.stringify(dev)); assert.equal(dev.status, 'approved'); assert.equal(dev.branch_id, BR);
    assert.ok(dev.device_secret_hash, 'a device secret is kept (hashed) to renew with');
    assert.ok(db.refresh_tokens.length === 1 && db.refresh_tokens[0].user_id === null, JSON.stringify(db.refresh_tokens));
  });
  await ok('the cloud accepts the till\'s session for its requests — as the till, with no person behind it', async () => {
    reset();
    const r = await join('JOIN-AAAA');
    const w = await who(r.body.accessToken);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.deepEqual(w.body, { userId: null, isTill: true, deviceId: 'dev-T1', isOwner: false, branchId: BR });
  });

  console.log('\nThe cloud checks the till itself, every request\n');
  await ok('a retired till is refused at once (the owner retiring it in Devices cuts it off)', async () => {
    reset();
    const r = await join('JOIN-AAAA');
    db.user_devices[0].retired_at = new Date().toISOString();
    const w = await who(r.body.accessToken);
    assert.equal(w.status, 401); assert.equal(w.body.code, 'DEVICE_BLOCKED');
  });
  await ok('a till removed from the business (row gone) or rejected is refused', async () => {
    reset();
    const r = await join('JOIN-AAAA');
    db.user_devices[0].status = 'rejected';
    assert.equal((await who(r.body.accessToken)).body.code, 'DEVICE_BLOCKED');
    db.user_devices = [];
    assert.equal((await who(r.body.accessToken)).body.code, 'DEVICE_BLOCKED');
  });
  await ok('the owner\'s account does not matter to the till: owner suspended as a user → the till still works', async () => {
    reset();
    const r = await join('JOIN-AAAA');
    db.users[0].status = 'inactive'; db.users[0].permissions_version = 99;
    assert.equal((await who(r.body.accessToken)).status, 200);
  });

  console.log('\nA till session from before A415 (the owner on the till)\n');
  const ownerEra = { userId: OWNER, businessId: BZ, branchId: null, isOwner: true, permissionKeys: ['*'], permissionsVersion: 1, sessionId: 'old-s', surface: 'desktop' };
  await ok('an owner-era till token is refused for requests — the till renews', async () => {
    reset();
    const t = jwt.sign({ ...ownerEra, tokenType: 'access' }, process.env.JWT_SECRET, { expiresIn: '15m' });
    const w = await who(t);
    assert.equal(w.status, 401); assert.equal(w.body.code, 'TOKEN_REPLACED');
  });
  const seedOwnerEra = (deviceRow) => {
    reset();
    db.user_devices.push({ id: 'd1', business_id: BZ, device_id: 'dev-T1', user_id: OWNER, status: 'approved', retired_at: null, branch_id: BR, device_secret_hash: null, ...deviceRow });
    const jti = 'old-jti';
    db.refresh_tokens.push({ id: 'rt1', jti: sha(jti), user_id: OWNER, business_id: BZ, session_id: 'old-s', device_hint: 'dev-T1', revoked_at: null, expires_at: future });
    return jwt.sign({ ...ownerEra, jti, tokenType: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  };
  await ok('renewing replaces it with the till\'s own session — no person, the till\'s bound branch', async () => {
    const old = seedOwnerEra();
    const r = await post('/api/auth/refresh', { refreshToken: old }, { 'X-Device-Id': 'dev-T1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = jwt.decode(r.body.accessToken);
    assert.equal(p.userId, null); assert.equal(p.till, true); assert.equal(p.deviceId, 'dev-T1'); assert.equal(p.branchId, BR); assert.equal(p.isOwner, false);
    assert.ok(r.body.deviceSecret, 'a till that never kept a secret is given one');
    const fresh = db.refresh_tokens.find((t) => t.id !== 'rt1');
    assert.equal(fresh.user_id, null); assert.equal(fresh.device_hint, 'dev-T1');
    assert.equal((await who(r.body.accessToken)).status, 200);
  });
  await ok('a blocked till may not renew — and its token is NOT spent (nothing half-done)', async () => {
    const old = seedOwnerEra({ retired_at: new Date().toISOString() });
    const r = await post('/api/auth/refresh', { refreshToken: old }, { 'X-Device-Id': 'dev-T1' });
    assert.equal(r.status, 401); assert.equal(r.body.code, 'DEVICE_BLOCKED');
    assert.equal(db.refresh_tokens.find((t) => t.id === 'rt1').revoked_at, null);
  });

  console.log('\nThe technician rejoins the till (keeps everything on it)\n');
  await ok('a fresh code joins the SAME till again: approved, not retired, its id kept, a new secret', async () => {
    reset();
    const first = await join('JOIN-AAAA');
    db.user_devices[0].retired_at = new Date().toISOString(); db.user_devices[0].status = 'rejected';
    const oldHash = db.user_devices[0].device_secret_hash;
    const r = await join('JOIN-BBBB', { rejoin: true, branch_id: BR });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(db.user_devices.length, 1, 'the same till, not a new one');
    assert.equal(db.user_devices[0].status, 'approved'); assert.equal(db.user_devices[0].retired_at, null);
    assert.notEqual(db.user_devices[0].device_secret_hash, oldHash);
    assert.equal((await who(r.body.accessToken)).status, 200);
    assert.equal((await who(first.body.accessToken)).status, 200, 'its earlier session is the same till — fine again');
  });
  await ok('a code for another branch is refused — and NOT spent, so it can go to the right till', async () => {
    reset();
    await join('JOIN-AAAA');
    const r = await join('JOIN-CCCC', { rejoin: true, branch_id: BR });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'REJOIN_OTHER_BRANCH');
    assert.equal(db.device_enrolment_codes.find((c) => c.id === 'c3').status, 'active');
  });
  await ok('a wrong or used code is the same single refusal as before', async () => {
    reset();
    assert.equal((await join('NOPE')).body.code, 'ENROL_INVALID');
    await join('JOIN-AAAA');
    assert.equal((await join('JOIN-AAAA', { rejoin: true })).body.code, 'ENROL_INVALID');
  });

  console.log('\nThe sign-in limit ("too many attempts" after one try)\n');
  await ok('renewals are not a person\'s attempts: /refresh, /device-token, /logout', () => {
    assert.ok(L.isRenewalPath('/refresh') && L.isRenewalPath('/device-token') && L.isRenewalPath('/logout') && L.isRenewalPath('/refresh/'));
    assert.ok(!L.isRenewalPath('/login') && !L.isRenewalPath('/verify-pin') && !L.isRenewalPath('/enrol/redeem') && !L.isRenewalPath('/pos-login'));
  });
  await ok('each till renews on its own counter (its id), else the address', () => {
    assert.equal(L.renewalKey('dev-T1', '1.2.3.4'), 'renew:d:dev-T1');
    assert.equal(L.renewalKey('dev-T1, dev-T1', '1.2.3.4'), 'renew:d:dev-T1');
    assert.equal(L.renewalKey('', '1.2.3.4'), 'renew:ip:1.2.3.4');
  });
  await ok('the wiring: only FAILED attempts count, renewals skipped there and counted on their own', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'apps/server/src/index.ts'), 'utf8');
    const auth = idx.slice(idx.indexOf('const authLimiter = rateLimit({'), idx.indexOf('const renewLimiter'));
    assert.match(auth, /skipSuccessfulRequests: true,/);
    assert.match(auth, /skip: \(req\) => isRenewalPath\(req\.path\),/);
    assert.match(idx, /skip: \(req\) => !isRenewalPath\(req\.path\),/);
    assert.match(idx, /app\.use\('\/api\/auth',\s+authLimiter\);\napp\.use\('\/api\/auth',\s+renewLimiter\);/);
  });

  console.log('\nNothing of the owner left on the till\'s path (source)\n');
  await ok('no owner login route; the admin\'s enrolment code names no owner; the device row names no person', () => {
    const a = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/auth.ts'), 'utf8');
    assert.ok(!/router\.post\('\/desktop-login'/.test(a));
    const adm = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/admin.ts'), 'utf8');
    const issue = adm.split("/branches/:branchId/enrol-code'")[1].split('router.get(')[0];
    assert.ok(!/created_by|resolveOwnerUserId/.test(issue));
    const reg = fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/deviceRegistry.ts'), 'utf8');
    assert.ok(!/user_id:\s*userId/.test(reg) && /export async function registerDesktopTerminal\(\s*businessId: string,\s*identity:\s*TerminalIdentity,/.test(reg));
  });
  await ok('a step that needs a person (approving, confirming) never counts the till as one', () => {
    const c = fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/shiftConfirm.ts'), 'utf8');
    assert.match(c, /if \(req\.isTill\) return false;/);
    const s = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/shifts.ts'), 'utf8');
    assert.equal((s.match(/const openedByRequester = !!req\.userId && \(/g) || []).length, 3);
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
