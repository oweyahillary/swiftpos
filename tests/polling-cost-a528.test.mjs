// A528 — the cloud's polling cost: what every till asks every 20 s is answered from memory, from one row, or not at all.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/polling-cost-a528.test.mjs
//
// Render suspended production (2026-10-19): 5 GB of its bandwidth was the server's own requests to Supabase; Supabase was
// over its egress and log quotas. Every till asked /api/pos/catalogue-version every 20 s (16 queries each) and every
// request read the till's or the person's row. Owner, 2026-10-19: "can we do it such that only a change can trigger data
// sync … we need a solution and a quick one".
//
// RUNS the COMPILED server (routes/index.js — every router, with the A528 write hooks — behind the real requireAuth, the
// real helmet set-up and the traffic counter) over HTTP; the database in memory (tests/lib-memdb.mjs), every query counted.
//
//   C  catalogue-version: ONE query (sync_versions) and "cv:<version>"; within 15 s none; after 15 s one again; a write
//      through a catalogue route (a category added) drops the business's entry at once; before migration 150 (the table
//      missing) the 16 reads, remembered 60 s; a failed fallback never wedges the till.
//   S  branch-staff: a till holding the current list (?v=) is told "unchanged" with no staff read while the staff version
//      stands; a staff version change (or a staff write here) reads the list again; before 150 it reads every time.
//   A  requireAuth: a second request makes no user_devices / users query; retiring a till or deactivating a person
//      through the API refuses the very next request; a failed read is never kept (503, then read again); a refused till
//      is never kept (rejoined: let in at once); a token newer than the remembered row is read again, not refused.
//   H  helmet: the document headers dropped (CSP, COOP, origin-agent-cluster, …), the API ones kept (HSTS, nosniff, CORP,
//      referrer-policy, x-frame-options).
//   T  GET /api/admin/ops/summary carries `traffic` (route families, the hit rates) — for a super admin only.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-19):
//   - syncVersions.ts readTopicVersion without the cache hit return             → C "within 15 s: no query" fails
//   - routes/index.ts without the catalogue forgetOnWrite                         → C "a category added … at once" fails
//   - pos.ts catalogue-version without the readTopicVersion answer                → C "ONE query" fails
//   - pos.ts branch-staff without the unchanged-from-memory return                → S "no staff read" fails
//   - authCache.ts through() without the hit return                               → A "no user_devices query" fails
//   - routes/index.ts without the devices forgetOnWrite                           → A "retired … very next request" fails
//   - authCache.ts through() keeping a failed read                                → A "a failed read is never kept" fails
//   - apiHeaders.ts contentSecurityPolicy left on                                 → H fails
//   - auth.ts without the newer-token re-read                                     → A "a token newer … read again" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/syncVersions.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const SV = require(path.join(DIST, 'lib/syncVersions.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const TR = require(path.join(DIST, 'lib/trafficStats.js'));
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
const warn = console.warn; console.warn = () => {};   // the fallback's "sync_versions not readable" line

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', CASH = 'aaaaaaaa-0000-4000-8000-000000000003', MGR = 'aaaaaaaa-0000-4000-8000-000000000004';
const SA = 'eeeeeeee-0000-4000-8000-000000000002', AG = 'eeeeeeee-0000-4000-8000-000000000001';
const perms = (...keys) => ({ name: 'Role', role_permissions: keys.map((key) => ({ permissions: { key } })) });
const person = (id, name, extra = {}) => ({ id, name, status: 'active', business_id: B, permissions_version: 1, pin_hash: `$2b$10$${name}`,
  user_permissions: [], user_branches: [], roles: perms('orders.create'), ...extra });
const CATALOGUE_TABLES = ['products', 'categories', 'business_settings', 'business_branding', 'feature_flags', 'users', 'tables', 'branches',
  'branch_printers', 'branch_prices', 'stock_takes', 'offers', 'promotions', 'print_stations', 'businesses', 'branch_settings'];

let realNow = Date.now;
const reset = () => {
  Date.now = realNow;
  mem.fail = () => null; mem.calls = [];
  SV._resetSyncVersions(); AC._resetAuthCache(); TR._resetTraffic();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Krunch & Co', updated_at: '2026-10-19T08:00:00.000Z' }, { id: B2, owner_id: 'x', name: 'Other' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true, updated_at: '2026-10-19T07:00:00.000Z' }],
    users: [person(OWNER, 'Owner', { roles: { name: 'Admin' } }), person(CASH, 'Joe'), person(MGR, 'Mary', { roles: perms('staff.edit') })],
    user_branches: [],
    user_devices: [
      { id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER },
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER },
    ],
    sync_versions: [
      { business_id: B, topic: 'catalogue', version: 7 }, { business_id: B, topic: 'staff', version: 3 },
      { business_id: B2, topic: 'catalogue', version: 40 },
    ],
    products: [{ id: 'p1', business_id: B, name: 'Chips', updated_at: '2026-10-19T09:30:00.000Z' }],
    categories: [], business_settings: [], refresh_tokens: [], audit_log: [], notifications: [],
    admin_users: [
      { id: AG, email: 'agent@zaptill.test', role: 'agent', is_active: true },
      { id: SA, email: 'boss@zaptill.test', role: 'super_admin', is_active: true },
    ],
    ops_events: [],
  };
  adminAuth.forgetAdmin();
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(require(path.join(DIST, 'lib/apiHeaders.js')).apiHelmet());
app.use(TR.countTraffic);
app.use(express.json());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create'], surface: 'pos', permissionsVersion: 1 }),
  till1: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  till2: sign({ userId: null, deviceId: 'dev-T2', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const ADM = {
  sa: adminAuth.signAdminToken({ adminId: SA, email: 'boss@zaptill.test', role: 'super_admin' }),
  agent: adminAuth.signAdminToken({ adminId: AG, email: 'agent@zaptill.test', role: 'agent' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};
const tillGet = (p, tok = T.till1, dev = 'dev-T1') => call('GET', p, tok, undefined, { 'x-device-id': dev });
const reads = (table) => mem.calls.filter((c) => c.table === table && c.op === 'select').length;
const tick = () => new Promise((r) => setTimeout(r, 20));
const later = (ms) => { const base = realNow(); Date.now = () => base + ms; };

try {
  state._setPermissionsMigrated(true);

  console.log('\nC. catalogue-version — one row, remembered 15 s\n');
  await ok('answers "cv:<version>" from sync_versions with ONE query — none of the 16 tables', async () => {
    reset();
    // A612: a POS's reads pass the per-branch cloud gate too; its billing facts are kept up to 10 minutes (lib/cloudPlan.ts),
    // so a running server has them — read them once here, then count only what the route itself asks.
    await require(path.join(DIST, 'lib/cloudPlan.js')).branchPauseFor(B);
    mem.calls = [];
    const r = await tillGet('/api/pos/catalogue-version?branch_id=' + BR);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { version: 'cv:7' });
    assert.equal(reads('sync_versions'), 1);
    for (const t of CATALOGUE_TABLES) assert.equal(reads(t), 0, t);
  });
  await ok('within 15 s: no query at all (another till of the business, the till row remembered too)', async () => {
    reset();
    await tillGet('/api/pos/catalogue-version');
    await tillGet('/api/pos/catalogue-version', T.till2, 'dev-T2');
    mem.calls = [];
    mem.db.sync_versions[0].version = 8;   // a change made outside this server (SQL, a till's push): seen within 15 s
    for (let i = 0; i < 3; i++) {
      const r = await tillGet('/api/pos/catalogue-version');
      assert.equal(r.body.version, 'cv:7');
    }
    assert.equal(mem.calls.length, 0, JSON.stringify(mem.calls.map((c) => c.table)));
  });
  await ok('after 15 s: one query again, the new version', async () => {
    reset();
    await tillGet('/api/pos/catalogue-version');
    mem.db.sync_versions[0].version = 8;
    later(15_500);
    const r = await tillGet('/api/pos/catalogue-version');
    assert.equal(r.body.version, 'cv:8');
    assert.equal(reads('sync_versions'), 2);
  });
  await ok('another business has its own version', async () => {
    reset();
    mem.db.user_devices.push({ id: 'ud-x', business_id: B2, device_id: 'dev-X', status: 'approved', retired_at: null, branch_id: null });
    const tok = sign({ userId: null, businessId: B2, deviceId: 'dev-X', till: true, permissionKeys: ['*'], surface: 'desktop' });
    assert.equal((await tillGet('/api/pos/catalogue-version')).body.version, 'cv:7');
    assert.equal((await tillGet('/api/pos/catalogue-version', tok, 'dev-X')).body.version, 'cv:40');
  });
  await ok('a category added on the web reaches the very next check (the write drops the business\'s entry at once)', async () => {
    reset();
    assert.equal((await tillGet('/api/pos/catalogue-version')).body.version, 'cv:7');
    const w = await call('POST', '/api/categories', T.owner, { name: 'Drinks' });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    mem.db.sync_versions[0].version = 8;   // what the trigger does with the insert
    await tick();
    assert.equal((await tillGet('/api/pos/catalogue-version')).body.version, 'cv:8');
  });
  await ok('a business with no row yet: cv:0 (its first change inserts version 1)', async () => {
    reset(); mem.db.sync_versions = [];
    assert.equal((await tillGet('/api/pos/catalogue-version')).body.version, 'cv:0');
  });
  await ok('before migration 150 (sync_versions missing): the 16 reads, the newest updated_at — then remembered 60 s', async () => {
    reset();
    mem.fail = (table) => (table === 'sync_versions' ? { code: '42P01', message: 'relation "public.sync_versions" does not exist' } : null);
    const r = await tillGet('/api/pos/catalogue-version?branch_id=' + BR);
    assert.equal(r.status, 200);
    assert.equal(r.body.version, '2026-10-19T09:30:00.000Z');
    for (const t of CATALOGUE_TABLES) assert.equal(reads(t) >= 1, true, `${t} not read`);
    const n = mem.calls.length;
    const again = await tillGet('/api/pos/catalogue-version?branch_id=' + BR);
    assert.equal(again.body.version, '2026-10-19T09:30:00.000Z');
    assert.equal(mem.calls.length, n, 'remembered: no query');
    assert.equal(reads('sync_versions'), 1, 'the missing table is not asked again for 60 s');
    later(61_000);
    mem.calls = [];
    await tillGet('/api/pos/catalogue-version?branch_id=' + BR);
    assert.ok(reads('products') >= 1, 'after 60 s: computed again');
  });
  await ok('the fallback: a write here drops it too; every read failing answers version null (the till keeps its floor), not kept', async () => {
    reset();
    mem.fail = (table) => (table === 'sync_versions' ? { code: '42P01', message: 'missing' } : null);
    await tillGet('/api/pos/catalogue-version');
    mem.db.products[0].updated_at = '2026-10-19T10:00:00.000Z';
    await call('POST', '/api/categories', T.owner, { name: 'Sides' });
    await tick();
    assert.equal((await tillGet('/api/pos/catalogue-version')).body.version, '2026-10-19T10:00:00.000Z', 'not the remembered 09:30');
    reset();
    mem.fail = (table) => (CATALOGUE_TABLES.includes(table) || table === 'sync_versions') && table !== 'users' && table !== 'businesses' ? { message: 'timeout' } : null;
    mem.db.users.forEach((u) => { delete u.updated_at; }); mem.db.businesses.forEach((b) => { delete b.updated_at; });
    const r = await tillGet('/api/pos/catalogue-version');
    assert.equal(r.status, 200); assert.equal(r.body.version, null);
    mem.fail = (table) => (table === 'sync_versions' ? { message: 'missing' } : null);
    assert.equal((await tillGet('/api/pos/catalogue-version')).body.version, '2026-10-19T09:30:00.000Z', 'a null answer was not kept');
  });

  console.log('\nS. branch-staff — "unchanged" without reading the staff\n');
  await ok('the first ask reads the list; asked again holding it: "unchanged" with NO staff read', async () => {
    reset();
    const first = await tillGet('/api/pos/branch-staff');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.staff.length, 3); assert.equal(reads('users'), 1);
    mem.calls = [];
    for (let i = 0; i < 3; i++) {
      const r = await tillGet(`/api/pos/branch-staff?v=${first.body.version}`);
      assert.deepEqual(r.body, { branch_id: BR, version: first.body.version, unchanged: true });
    }
    assert.equal(mem.calls.length, 0, JSON.stringify(mem.calls.map((c) => c.table)));
  });
  await ok('another till of the branch holding the same list: "unchanged" too, no staff read', async () => {
    reset();
    const first = await tillGet('/api/pos/branch-staff');
    mem.calls = [];
    const r = await tillGet(`/api/pos/branch-staff?v=${first.body.version}`, T.till2, 'dev-T2');
    assert.equal(r.body.unchanged, true); assert.equal(reads('users'), 0);
  });
  await ok('a till holding an OLD list (or none) gets the whole list', async () => {
    reset();
    await tillGet('/api/pos/branch-staff');
    mem.calls = [];
    const r = await tillGet('/api/pos/branch-staff?v=0123456789abcdef01234567');
    assert.equal(r.body.staff.length, 3); assert.equal(reads('users'), 1);
  });
  await ok('the staff version moved (a cashier added in SQL, seen after 15 s): the list is read again and sent', async () => {
    reset();
    const first = await tillGet('/api/pos/branch-staff');
    mem.db.users.push(person('aaaaaaaa-0000-4000-8000-000000000009', 'New'));
    mem.db.sync_versions[1].version = 4;
    later(15_500);
    mem.calls = [];
    const r = await tillGet(`/api/pos/branch-staff?v=${first.body.version}`);
    assert.equal(r.body.staff.length, 4, JSON.stringify(r.body)); assert.equal(reads('users'), 1);
  });
  await ok('a cashier deactivated on the web: the next ask reads the list again (the staff write drops the version at once)', async () => {
    reset();
    const first = await tillGet('/api/pos/branch-staff');
    const w = await call('DELETE', `/api/staff/${CASH}`, T.owner);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    mem.db.sync_versions[1].version = 4;   // what the trigger does
    await tick();
    const r = await tillGet(`/api/pos/branch-staff?v=${first.body.version}`);
    assert.equal(r.body.staff.length, 2, JSON.stringify(r.body));
  });
  await ok('before migration 150: the list is read on every ask (as before), and still "unchanged" when it is', async () => {
    reset();
    mem.fail = (table) => (table === 'sync_versions' ? { code: '42P01', message: 'missing' } : null);
    const first = await tillGet('/api/pos/branch-staff');
    mem.calls = [];
    const r = await tillGet(`/api/pos/branch-staff?v=${first.body.version}`);
    assert.equal(r.body.unchanged, true); assert.equal(reads('users'), 1);
  });

  console.log('\nA. requireAuth — the rows remembered 30 s, forgotten at once\n');
  await ok('a till: the second request makes no user_devices query', async () => {
    reset();
    await tillGet('/api/pos/catalogue-version');
    await tillGet('/api/pos/catalogue-version');
    await tillGet('/api/pos/branch-staff');
    assert.equal(reads('user_devices'), 1);
  });
  await ok('a person: the second request makes no users query', async () => {
    reset();
    assert.equal((await call('GET', '/api/pos/catalogue-version', T.cash)).status, 200);
    assert.equal((await call('GET', '/api/pos/catalogue-version', T.cash)).status, 200);
    assert.equal(reads('users'), 1);
  });
  await ok('after 30 s: read again', async () => {
    reset();
    await tillGet('/api/pos/catalogue-version');
    later(30_500);
    await tillGet('/api/pos/catalogue-version');
    assert.equal(reads('user_devices'), 2);
  });
  await ok('a till retired through the API is refused on the VERY next request (DEVICE_BLOCKED) — no 30-s window', async () => {
    reset();
    assert.equal((await tillGet('/api/pos/catalogue-version')).status, 200);
    const w = await call('PATCH', '/api/devices/ud-1/retire', T.owner, {});
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const r = await tillGet('/api/pos/catalogue-version');
    assert.equal(r.status, 401); assert.equal(r.body.code, 'DEVICE_BLOCKED');
  });
  await ok('a person deactivated through the API is refused on the VERY next request (ACCOUNT_INACTIVE)', async () => {
    reset();
    assert.equal((await call('GET', '/api/pos/catalogue-version', T.cash)).status, 200);
    assert.equal((await call('DELETE', `/api/staff/${CASH}`, T.owner)).status, 200);
    const r = await call('GET', '/api/pos/catalogue-version', T.cash);
    assert.equal(r.status, 401); assert.equal(r.body.code, 'ACCOUNT_INACTIVE');
  });
  await ok('a failed read is never kept: 503, then read again (and let in)', async () => {
    reset();
    mem.fail = (table) => (table === 'user_devices' ? { message: 'timeout' } : null);
    const r = await tillGet('/api/pos/catalogue-version');
    assert.equal(r.status, 503); assert.equal(r.body.code, 'AUTH_BACKEND_UNAVAILABLE');
    mem.fail = () => null;
    assert.equal((await tillGet('/api/pos/catalogue-version')).status, 200);
    assert.equal(reads('user_devices'), 2);
    mem.fail = (table) => (table === 'users' ? { message: 'timeout' } : null);
    assert.equal((await call('GET', '/api/pos/catalogue-version', T.cash)).status, 503);
    mem.fail = () => null;
    assert.equal((await call('GET', '/api/pos/catalogue-version', T.cash)).status, 200);
  });
  await ok('a refused till is never kept: rejoined, it is let in on the next request', async () => {
    reset();
    mem.db.user_devices[0].status = 'rejected';
    assert.equal((await tillGet('/api/pos/catalogue-version')).status, 401);
    mem.db.user_devices[0].status = 'approved';
    assert.equal((await tillGet('/api/pos/catalogue-version')).status, 200);
  });
  await ok('a token newer than the remembered row (renewed after a change in SQL) is read again, not refused', async () => {
    reset();
    assert.equal((await call('GET', '/api/pos/catalogue-version', T.cash)).status, 200);
    mem.db.users.find((u) => u.id === CASH).permissions_version = 2;
    const renewed = sign({ userId: CASH, permissionKeys: ['orders.create'], surface: 'pos', permissionsVersion: 2 });
    assert.equal((await call('GET', '/api/pos/catalogue-version', renewed)).status, 200);
    // and the OLD token, now behind the row, is refused as before
    const old = await call('GET', '/api/pos/catalogue-version', T.cash);
    assert.equal(old.status, 401); assert.equal(old.body.code, 'PERMISSIONS_CHANGED');
  });

  console.log('\nH. helmet — the API headers only\n');
  await ok('dropped: CSP, COOP, origin-agent-cluster, x-dns-prefetch-control, x-download-options, x-permitted-cross-domain-policies, x-xss-protection', async () => {
    reset();
    const r = await tillGet('/api/pos/catalogue-version');
    for (const h of ['content-security-policy', 'cross-origin-opener-policy', 'origin-agent-cluster', 'x-dns-prefetch-control', 'x-download-options',
      'x-permitted-cross-domain-policies', 'x-xss-protection', 'x-powered-by']) assert.equal(r.headers.get(h), null, h);
  });
  await ok('kept: strict-transport-security, x-content-type-options, cross-origin-resource-policy (cross-origin), referrer-policy, x-frame-options', async () => {
    const r = await tillGet('/api/pos/catalogue-version');
    assert.ok(r.headers.get('strict-transport-security'));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.ok(r.headers.get('referrer-policy')); assert.ok(r.headers.get('x-frame-options'));
  });

  console.log('\nT. the admin portal\'s System page — traffic since start\n');
  await ok('a super admin: traffic (route families, the catalogue and sign-in hit rates, the staff list)', async () => {
    reset();
    await tillGet('/api/pos/catalogue-version'); await tillGet('/api/pos/catalogue-version');
    const first = await tillGet('/api/pos/branch-staff');
    await tillGet(`/api/pos/branch-staff?v=${first.body.version}`);
    const r = await call('GET', '/api/admin/ops/summary', ADM.sa);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = r.body.traffic;
    const pos = t.routes.find((x) => x.family === '/api/pos');
    assert.equal(pos.requests, 4); assert.ok(pos.bytes > 0);
    assert.equal(t.catalogue_version.answered, 2); assert.equal(t.catalogue_version.hit_rate, 50);
    assert.equal(t.branch_staff.full, 1); assert.equal(t.branch_staff.unchanged_from_memory, 1);
    assert.ok(t.auth_cache.hits >= 3 && t.auth_cache.misses === 1, JSON.stringify(t.auth_cache));
    assert.ok(t.db_queries_polled >= 3);
  });
  await ok('an agent and a business\'s token are refused', async () => {
    assert.equal((await call('GET', '/api/admin/ops/summary', ADM.agent)).status, 403);
    assert.notEqual((await call('GET', '/api/admin/ops/summary', T.owner)).status, 200);
  });
  await ok('routeFamily: the first two segments, lower case, no query; junk is "other"', async () => {
    assert.equal(TR.routeFamily('/api/pos/catalogue-version?branch_id=x'), '/api/pos');
    assert.equal(TR.routeFamily('/health'), '/health');
    assert.equal(TR.routeFamily('/API/Auth/refresh'), '/api/auth');
    assert.equal(TR.routeFamily('/%3Cscript%3E/x'), 'other');
  });
} finally {
  Date.now = realNow;
  console.warn = warn;
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
