// A427 — the branch server asks the cloud for one enrolment code for a till someone at the server allowed to join.
// Owner, 2026-10-09: "when installing the app should be scanning from a local server and pick configs from it … it
// should only ask if i allow it to join the server or not".
//
//   cd apps/server && npm run build && cd ../.. && node tests/till-join-code.test.mjs
//
// Drives the REAL compiled route (routes/pos.js POST /join-code) behind the REAL requireAuth and terminal-write guard,
// with an in-memory database, and then redeems the code it gave at the REAL /api/auth/enrol/redeem.
//
// MUTATIONS TO CONFIRM BITE:
//   - drop the isConfirmedBranchServer check            → "a plain till may not ask" / "an unconfirmed server" fail
//   - drop the desktop_licensed check                    → "an unlicensed branch" fails
//   - mayIssueJoinCode always true                       → "a few an hour" fails
//   - /api/pos/join-code missing from TILL_WRITES         → "the server's own sign-in may call it" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/pos.js'))) {
  console.log('\nBuild the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const { buildDeviceTokenPayload } = require(path.join(DIST, 'lib/deviceGrant.js'));
const { _resetJoinLimits, JOIN_CODES_PER_HOUR } = require(path.join(DIST, 'lib/tillJoin.js'));
const { terminalWriteVerdict } = require(path.join(DIST, 'lib/terminalWrites.js'));
const jwt = require('jsonwebtoken');

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
let db;
const reset = (over = {}) => {
  _resetJoinLimits();
  db = {
    businesses: [{ id: BZ, name: 'Albaik', currency: 'KES', type: 'restaurant', status: 'active' }],
    branches: [{ id: BR, business_id: BZ, name: 'Town', desktop_licensed: true, status: 'active' }],
    users: [],
    user_devices: [
      { id: 'd-srv', business_id: BZ, device_id: 'dev-SRV', branch_id: BR, status: 'approved', retired_at: null,
        device_role: 'node', role_confirmed_at: '2026-10-01T00:00:00Z', terminal_code: 'T1' },
      { id: 'd-t2', business_id: BZ, device_id: 'dev-T2', branch_id: BR, status: 'approved', retired_at: null,
        device_role: 'till', role_confirmed_at: null, terminal_code: 'T2' },
    ],
    device_enrolment_codes: [],
    refresh_tokens: [],
    ...over,
  };
};

let nextId = 1;
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const run = () => { if (inserted) return inserted; if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; } return rows(); };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'is') return (k, v) => { f.push([k, (x) => (x ?? null) === v]); return q; };
      if (prop === 'not') return (k, op, v) => { f.push([k, (x) => !(op === 'is' ? (x ?? null) === v : x === v)]); return q; };
      if (prop === 'gt') return (k, v) => { f.push([k, (x) => String(x) > String(v)]); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'insert') return (r) => {
        const list = (db[table] ??= []);
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `row-${nextId++}`, status: 'active', ...x }));
        list.push(...inserted); return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/pos', require(path.join(DIST, 'routes/pos.js')).default);
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const tokenFor = (deviceId) => jwt.sign({ ...buildDeviceTokenPayload({ deviceId, businessId: BZ, branchId: BR, sessionId: 's-' + deviceId }), tokenType: 'access' },
  process.env.JWT_SECRET, { expiresIn: '15m' });
const ask = async (deviceId) => {
  const r = await fetch(`${base}/api/pos/join-code`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenFor(deviceId)}` }, body: '{}' });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  console.log('\nThe branch server adds a till\n');
  await ok('the confirmed branch server gets ONE ordinary code: single-use, for its own branch, short-lived', async () => {
    reset();
    const r = await ask('dev-SRV');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.code, /^[A-Z2-9]{10}$/);
    assert.equal(r.body.businessId, BZ); assert.equal(r.body.branchId, BR); assert.equal(r.body.branchName, 'Town');
    assert.equal(db.device_enrolment_codes.length, 1);
    const c = db.device_enrolment_codes[0];
    assert.equal(c.branch_id, BR); assert.ok(!('code' in c) && c.code_hash && c.code_hash !== r.body.code, 'only the hash is stored');
    assert.ok(new Date(c.expires_at) - Date.now() <= 15 * 60_000 + 1000);
    assert.ok(!('terminalCode' in r.body), 'till codes are not touched — the technician sets them as before');
  });
  await ok('…and the new till redeems it itself, getting its OWN session for that branch (A415)', async () => {
    reset();
    const { body } = await ask('dev-SRV');
    const r = await fetch(`${base}/api/auth/enrol/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ business_id: BZ, code: body.code, device_id: 'dev-NEW' }) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    const p = jwt.decode(j.accessToken);
    assert.equal(p.till, true); assert.equal(p.deviceId, 'dev-NEW'); assert.equal(p.branchId, BR); assert.equal(p.userId, null);
    const again = await fetch(`${base}/api/auth/enrol/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ business_id: BZ, code: body.code, device_id: 'dev-OTHER' }) });
    assert.notEqual(again.status, 200, 'single-use: the same code cannot join a second till');
  });
  await ok('the server\'s own sign-in may call it (the till-write guard lets this one route through)', async () => {
    assert.equal(terminalWriteVerdict('desktop', 'POST', '/api/pos/join-code'), 'till');
  });

  console.log('\nOnly the branch server, only for its own branch\n');
  await ok('a plain till may not ask', async () => {
    reset();
    const r = await ask('dev-T2');
    assert.equal(r.status, 403); assert.equal(r.body.code, 'not_confirmed_server');
    assert.equal(db.device_enrolment_codes.length, 0);
  });
  await ok('a machine that only SAYS it is the server (role not confirmed) may not ask', async () => {
    reset(); db.user_devices[0].role_confirmed_at = null;
    assert.equal((await ask('dev-SRV')).body.code, 'not_confirmed_server');
  });
  await ok('a retired or rejected server is refused before the route', async () => {
    reset(); db.user_devices[0].retired_at = new Date().toISOString();
    assert.equal((await ask('dev-SRV')).status, 401);
    reset(); db.user_devices[0].status = 'rejected';
    assert.equal((await ask('dev-SRV')).status, 401);
  });
  await ok('an unlicensed branch gets no code', async () => {
    reset(); db.branches[0].desktop_licensed = false;
    const r = await ask('dev-SRV');
    assert.equal(r.status, 409); assert.equal(r.body.code, 'BRANCH_NOT_LICENSED');
    assert.equal(db.device_enrolment_codes.length, 0);
  });
  await ok('a person\'s sign-in (not the till\'s own) is refused', async () => {
    reset();
    const t = jwt.sign({ userId: 'u-1', businessId: BZ, branchId: BR, isOwner: false, permissionKeys: ['*'], permissionsVersion: 1, sessionId: 's', surface: 'web', tokenType: 'access' },
      process.env.JWT_SECRET, { expiresIn: '15m' });
    const r = await fetch(`${base}/api/pos/join-code`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${t}` }, body: '{}' });
    assert.ok(r.status === 403 || r.status === 401, String(r.status));
    assert.equal(db.device_enrolment_codes.length, 0);
  });
  await ok(`a few an hour at most (${JOIN_CODES_PER_HOUR}) — a stuck or abused server cannot mint codes in a loop`, async () => {
    reset();
    for (let i = 0; i < JOIN_CODES_PER_HOUR; i++) assert.equal((await ask('dev-SRV')).status, 200);
    const r = await ask('dev-SRV');
    assert.equal(r.status, 429); assert.equal(r.body.code, 'join_rate');
    assert.equal(db.device_enrolment_codes.length, JOIN_CODES_PER_HOUR);
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
