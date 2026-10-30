/**
 * supabase-calls-a593.test.mjs — A593: the NUMBER of Supabase calls brought down (log ingestion), the answers unchanged.
 *
 * Owner, 2026-10-26 (the System page's "Supabase pulled (24 h)" card, 1.1 h after a restart: 3,916 calls → ~82,000 a day;
 * Free plan log ingestion 1 GB a month): "logs are full already". Target: ≤ ~15,000 calls a day.
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/supabase-calls-a593.test.mjs
 *
 * RUNS the COMPILED server (routes/index.js behind the real requireAuth, lib/supabaseMeter.js labelRequests and
 * lib/writeActivity.js trackWrites mounted as index.ts mounts them) over HTTP on the in-memory database (tests/lib-memdb.mjs,
 * every call it answers counted):
 *   A the sign-in check: a POS polling every 20 s reads its row once per 5 minutes while nothing is written; any write of
 *     the business → the 30 s rule again; blocking it through this server → refused on the very next request; a refusal
 *     never kept; A591_MEMO=off → 30 s
 *   B the cloud-plan gate: the FACTS kept (4 reads for every business at once, not 4 per business per minute), the standing
 *     worked out at each request's own time; a write of the business → read again after a minute; forgetStanding → at once
 *   C a GET route's own write moves its own business only (not every business)
 *   D GET /api/pos/branch-drawers: the SAME answer as the reads before A593 (the three drawer reads, every beat read);
 *     a quiet beat: 2 reads (drawers, sales) — 0 within the minute; the beat and the names kept; a write → read again; a
 *     log request's expiry decided at each ask; 1,000 drawer rows → the three reads, as before
 *   E the polled answers — GET /api/shifts/state, /api/day-close/pending, /api/pos/test-data-clears, /api/stations: a
 *     repeat ask with nothing written makes 0 Supabase calls and gets the same answer; a write → read again; the
 *     delivered stamp written once; A591_MEMO=off → read every time
 *   F the jobs: ownerAlerts' tick reads every business's settings / branches / tills at once (the same emails as each
 *     business on its own); the watchdog's quiet tills one orders read per branch, its unchanged open alerts one update,
 *     its writes quiet; dailySummary one settings read for every business
 *   G the System page: calls a day against the 15,000 target, the 5 sources with the most calls highlighted
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A593 report):
 *   - authCache quiet rule without the write generation              → A "a write of the business: read again" fails
 *   - QuietMemo.get ignoring the generation                          → E "a write → read again" fails
 *   - branchShifts' awaiting list without its 50 cap                 → D "the same answer" fails
 *   - standingFor's quiet rule without the write generation          → B "a write → read again after a minute" fails
 *   - watchdog: an open alert with a new detail counted as "seen only" → F "a changed detail is its own update" fails
 *   - liveHub headsDue reading on a write of a business with no socket → A591 D "nothing read" fails
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
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 6).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/quietMemo.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.A591_MEMO;
delete process.env.RESEND_API_KEY; delete process.env.SENDGRID_API_KEY; delete process.env.SMTP_HOST;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const M = require(path.join(DIST, 'lib/supabaseMeter.js'));
const WA = require(path.join(DIST, 'lib/writeActivity.js'));
const QM = require(path.join(DIST, 'lib/quietMemo.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const SV = require(path.join(DIST, 'lib/syncVersions.js'));
const LBD = require(path.join(DIST, 'lib/branchDrawers.js'));
const SO = require(path.join(DIST, 'lib/shiftOrdersMemo.js'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const warn = console.warn; console.warn = () => {};
const log = console.log;

const mem = installMemDb(supabase);
const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '22222222-2222-4222-8222-999999999999', BRX = '22222222-2222-4222-8222-333333333333';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', JANE = 'aaaaaaaa-0000-4000-8000-000000000002', OTIENO = 'aaaaaaaa-0000-4000-8000-000000000003';
const sid = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`;
let clockMs = Date.parse('2026-10-26T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

const reset = () => {
  WA._resetWrites(); WA._setTracking(true); WA._setWriteClock(() => clockMs);
  QM._resetQuietMemos(); QM._setQuietClock(() => clockMs);
  AC._resetAuthCache(); AC._setAuthClock(() => clockMs);
  CP._resetStanding(); CP._setStandingClock(() => clockMs);
  SV._resetSyncVersions(); SO._resetShiftMemo(); SO._setShiftMemoClock(() => clockMs);
  LBD._resetBranchDrawersMemo();
  delete process.env.A591_MEMO;
  mem.realOr = true; mem.rowCap = Infinity;
  const closed = (n, o) => ({ id: sid(n), business_id: B, branch_id: BR, device_id: 'dev-T2', status: 'closed', opened_at: iso(clockMs - 3 * DAY), ...o });
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Krunch & Co', currency: 'KES', status: 'active', web_access_expires_at: null },
      { id: B2, owner_id: OWNER, name: 'Second', currency: 'KES', status: 'active', web_access_expires_at: null }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', desktop_licensed: true }, { id: BRX, business_id: B, name: 'Kilimani', desktop_licensed: true },
      { id: BR2, business_id: B2, name: 'Second Main', desktop_licensed: true }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B, permissions_version: 1 },
      { id: JANE, name: 'Jane', status: 'active', business_id: B, permissions_version: 1 },
      { id: OTIENO, name: 'Otieno', status: 'active', business_id: B, permissions_version: 1 }],
    user_devices: [
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', status: 'approved', retired_at: null, branch_id: BR, device_role: 'till' },
      { id: 'ud-3', business_id: B, device_id: 'dev-T3', status: 'approved', retired_at: null, branch_id: BR, device_role: 'till' },
      { id: 'ud-s', business_id: B, device_id: 'dev-S', status: 'approved', retired_at: null, branch_id: BR, device_role: 'node', role_confirmed_at: iso(clockMs - 30 * DAY) },
      { id: 'ud-x', business_id: B2, device_id: 'dev-X', status: 'approved', retired_at: null, branch_id: BR2, device_role: 'till' }],
    shifts: [
      { id: sid(1), business_id: B, branch_id: BR, device_id: 'dev-T2', status: 'open', opened_at: iso(clockMs - 3_600_000), opened_by: OWNER, cashier_id: OWNER },
      { id: sid(2), business_id: B, branch_id: BR, device_id: 'dev-T3', status: 'open', opened_at: iso(clockMs - 7_200_000), opened_by: OWNER, cashier_id: OWNER },
      closed(3, { closed_at: iso(clockMs - 2 * 3_600_000), closed_by: JANE, close_method: 'till', confirmed_at: iso(clockMs - 3_600_000), confirmed_by: OTIENO }),
      closed(4, { closed_at: iso(clockMs - 2 * DAY), closed_by: JANE, close_method: 'web_force', declared_methods: { cash: 100 } }),
      closed(5, { closed_at: iso(clockMs - 6 * DAY), closed_by: OTIENO }),
      closed(6, { closed_at: iso(clockMs - 9 * DAY), closed_by: JANE, confirmed_at: iso(clockMs - 8 * DAY) }),            // old, confirmed: out
      ...Array.from({ length: 55 }, (_, i) => closed(100 + i, { closed_at: iso(clockMs - (10 + i) * DAY), closed_by: OTIENO, declared_methods: { cash: 10 + i } })),   // awaiting: the 50 newest
      { id: sid(7), business_id: B, branch_id: BRX, device_id: 'dev-K', status: 'open' },                                   // another branch
      { id: sid(8), business_id: B2, branch_id: BR2, device_id: 'dev-X', status: 'open' },                                  // another business
    ],
    orders: [
      { id: 'o-1', business_id: B, branch_id: BR, shift_id: sid(1), status: 'completed', total: 100, created_at: iso(clockMs - 600_000), updated_at: iso(clockMs - 600_000),
        order_items: [{ id: 'o-1-i', product_name: 'Soda', quantity: 1 }], payments: [{ id: 'o-1-p', status: 'completed', amount: 100 }, { id: 'o-1-q', status: 'pending', amount: 50 }] },
      { id: 'o-2', business_id: B, branch_id: BR, shift_id: sid(3), status: 'voided', total: 50, created_at: iso(clockMs - 3 * 3_600_000), updated_at: iso(clockMs - 2 * 3_600_000) },
    ],
    day_close_instructions: [{ id: 'dci-1', business_id: B, device_id: 'dev-T2', status: 'pending', payload: { day: '2026-10-25' }, created_at: iso(clockMs - DAY), delivered_at: null }],
    log_requests: [{ id: 'lr-1', business_id: B, device_id: 'dev-T3', status: 'waiting', expires_at: iso(clockMs + 90_000) }],
    test_data_purges: [{ id: 'tp-1', business_id: B, from_at: iso(clockMs - 20 * DAY), to_at: iso(clockMs - 19 * DAY), created_at: iso(clockMs - 10 * DAY), menu: false }],
    print_stations: [{ id: 'st-1', business_id: B, name: 'Kitchen', kind: 'kitchen', sort_order: 1 }, { id: 'st-2', business_id: B, name: 'Bar', kind: 'dispatch', sort_order: 2 }],
    category_stations: [{ category_id: 'cat-1', station_id: 'st-1' }, { category_id: 'cat-2', station_id: 'st-2' }],
    cloud_plans: [], business_settings: [], branch_settings: [], feature_flags: [], expenses: [], audit_log: [], notifications: [],
    sync_versions: [{ business_id: B, topic: 'catalogue', version: 7 }, { business_id: B, topic: 'staff', version: 3 }],
    refresh_tokens: [], float_transactions: [], payments: [],
  };
  mem.calls = [];
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use(M.labelRequests);
app.use(WA.trackWrites());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  till2: sign({ userId: null, deviceId: 'dev-T2', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  server: sign({ userId: null, deviceId: 'dev-S', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  tillX: sign({ businessId: B2, branchId: BR2, userId: null, deviceId: 'dev-X', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const settle = () => new Promise((r) => setTimeout(r, 30));
/** The Supabase calls `fn` made (the in-memory database answers each one). */
const callsOf = async (fn) => { const n0 = mem.calls.length; const out = await fn(); await settle(); return { calls: mem.calls.slice(n0), out }; };
const tables = (calls) => calls.map((c) => `${c.table}:${c.op}`);
const tick = (ms) => { clockMs += ms; };
const owners = () => call('POST', '/api/expenses', T.owner, {});   // a write of business B (refused for its body: still a write)
const noAt = (a) => { const { at: _at, ...rest } = a; return rest; };

try {
  require(path.join(DIST, 'lib/permissionsState.js'))._setPermissionsMigrated(true);

  // ── A ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  log('\nA. the sign-in check\n');
  await ok('a POS polling every 20 s: its row read once in 5 minutes while nothing is written (it was twice a minute)', async () => {
    reset();
    let devReads = 0;
    for (let i = 0; i < 15; i++) {   // 15 asks over 4 min 40 s
      const { calls } = await callsOf(() => call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2));
      devReads += calls.filter((c) => c.table === 'user_devices').length;
      tick(20_000);
    }
    assert.equal(devReads, 1, `user_devices read ${devReads}× — the old 30 s memory read it 10×`);
    tick(30_000);   // 5 min since the read
    const { calls } = await callsOf(() => call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2));
    assert.equal(calls.filter((c) => c.table === 'user_devices').length, 1, 'at most 5 minutes old');
  });
  await ok('a write of the business: the 30 s rule again (read again after 30 s); another business\'s write: not', async () => {
    reset();
    await call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2);
    tick(40_000);
    await call('POST', '/api/expenses', T.tillX, {}); await settle();   // business B2's write
    let r = await callsOf(() => call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2));
    assert.equal(r.calls.filter((c) => c.table === 'user_devices').length, 0, 'another business wrote: still quiet');
    await owners();
    tick(1_000);
    r = await callsOf(() => call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2));
    assert.equal(r.calls.filter((c) => c.table === 'user_devices').length, 1, 'a write of the business: read again');
  });
  await ok('blocked through this server: refused on the very next request; a refusal is never kept; A591_MEMO=off: 30 s', async () => {
    reset();
    assert.equal((await call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2)).status, 200);
    mem.db.user_devices.find((d) => d.device_id === 'dev-T2').status = 'blocked';
    AC.forgetTillsOf(B);   // what routes/index.ts does after a /devices write (forgetOnWrite tills)
    assert.equal((await call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2)).body?.code, 'DEVICE_BLOCKED');
    const r = await callsOf(() => call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2));
    assert.equal(r.calls.filter((c) => c.table === 'user_devices').length, 1, 'a refusal is read again every time');
    reset(); process.env.A591_MEMO = 'off';
    await call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2);
    tick(31_000);
    const r2 = await callsOf(() => call('GET', `/api/shifts/state?ids=${sid(1)}`, T.till2));
    assert.equal(r2.calls.filter((c) => c.table === 'user_devices').length, 1, 'off: the 30 s rule alone');
  });

  // ── B ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  log('\nB. the cloud-plan gate\n');
  const planReads = (calls) => calls.filter((c) => c.table === 'cloud_plans').length;
  await ok('two businesses\' POS posting every 20 s for 10 minutes: the plan read 2× in all (it was 4 reads per business per minute)', async () => {
    reset();
    let reads = 0;
    for (let i = 0; i < 29; i++) {   // 29 × 20 s < 10 min
      reads += planReads((await callsOf(() => call('POST', `/api/shifts/${sid(1)}/foreign-orders`, T.till2, { own_ids: [] }, { 'x-device-id': 'dev-T2' }))).calls);
      reads += planReads((await callsOf(() => call('POST', `/api/shifts/${sid(8)}/foreign-orders`, T.tillX, { own_ids: [] }, { 'x-device-id': 'dev-X' }))).calls);
      tick(20_000);
    }
    assert.ok(reads <= 2, `cloud_plans read ${reads}× (before A593: ${2 * 10} — every minute, per business)`);
    const one = mem.calls.filter((c) => c.table === 'cloud_plans').at(-1);
    assert.deepEqual([...one.filters['business_id:in']].sort(), [B, B2].sort(), 'one read for both businesses');
  });
  await ok('the standing is worked out at each ask\'s own time from the kept facts; a write → read again after a minute; forgetStanding → at once', async () => {
    reset();
    const facts = (await CP.readCloudFacts([B])).get(B);
    const s1 = await CP.standingFor(B, clockMs);
    assert.deepEqual(s1, facts && !facts.suspended ? CP.cloudStanding(facts, clockMs) : null);
    mem.calls = [];
    assert.deepEqual(await CP.standingFor(B, clockMs + 9 * 60_000), facts && !facts.suspended ? CP.cloudStanding(facts, clockMs + 9 * 60_000) : null);
    assert.equal(planReads(mem.calls), 0, 'kept 10 minutes while nothing is written');
    WA.noteWrite(B);
    await CP.standingFor(B, clockMs + 9 * 60_000 + 1);
    assert.equal(planReads(mem.calls), 1, 'a write of the business, a minute on: read again');
    CP.forgetStanding(B);
    await CP.standingFor(B, clockMs + 9 * 60_000 + 2);
    assert.equal(planReads(mem.calls), 2, 'a payment recorded (forgetStanding): read at once');
    process.env.A591_MEMO = 'off';
    await CP.standingFor(B, clockMs + 30 * 60_000); await CP.standingFor(B, clockMs + 30 * 60_000 + 1);
    assert.equal(planReads(mem.calls), 3, 'off: the minute rule alone (as before)');
  });
  await ok('the watchdog\'s locked clients: the governed facts kept while nothing is written (8 reads every run before)', async () => {
    reset();
    await CP.lapsedBusinessIds(clockMs);
    const n1 = mem.calls.length;
    await CP.lapsedBusinessIds(clockMs + 9 * 60_000);
    assert.equal(mem.calls.length, n1, 'no read within 10 minutes of quiet');
    WA.noteWrite(null);   // an admin portal write
    await CP.lapsedBusinessIds(clockMs + 9 * 60_000);
    assert.ok(mem.calls.length > n1, 'a write with no business (the admin portal): read again');
  });

  // ── C ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  log('\nC. a GET route\'s own write\n');
  await ok('a GET route that writes moves ITS business only — a job\'s write still moves every business', async () => {
    WA._resetWrites();
    const g = WA.writeGen(B), g2 = WA.writeGen(B2);
    const writes = M.meteredFetch(async () => new Response('[]', { status: 200 }));
    const req = { method: 'GET', originalUrl: '/api/day-close/pending', businessId: null };
    await new Promise((resolve) => M.labelRequests(req, null, () => { req.businessId = B; writes('http://supabase.test/rest/v1/day_close_instructions', { method: 'PATCH' }).then(resolve); }));
    assert.notEqual(WA.writeGen(B), g, 'its business: read again');
    assert.equal(WA.writeGen(B2), g2, 'every other business: untouched (it was every business)');
    await M.meterJob('ownerAlerts', () => writes('http://supabase.test/rest/v1/business_settings', { method: 'PATCH' }))();
    assert.notEqual(WA.writeGen(B2), g2, 'a job that is not quiet: every business, as before');
  });

  // ── D ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  log('\nD. GET /api/pos/branch-drawers\n');
  const drawers = (since) => call('GET', `/api/pos/branch-drawers${since ? `?since=${encodeURIComponent(since)}` : ''}`, T.server, undefined, { 'x-device-id': 'dev-S' });
  await ok('the drawers from ONE read: the same three lists (open · 7 days · the 50 newest awaiting), the same order, as the three reads', async () => {
    reset();
    const from = iso(clockMs - 7 * DAY);
    const three = await LBD.branchShifts(B, BR, from, false);
    mem.calls = [];
    const one = await LBD.branchShifts(B, BR, from, true);
    assert.equal(mem.calls.filter((c) => c.table === 'shifts').length, 1, 'one read');
    assert.deepEqual(one, three);
    assert.equal(one.filter((s) => s.declared_methods && !s.confirmed_at && s.status !== 'open').length, 50, 'awaiting: the 50 newest (one of them closed this week)');
    assert.ok(!one.some((s) => s.id === sid(154)) && !one.some((s) => s.id === sid(150)) && one.some((s) => s.id === sid(148)), 'the oldest awaiting left out');
    assert.ok(!one.some((s) => s.branch_id !== BR || s.business_id !== B), 'its own branch only');
    assert.ok(!one.some((s) => s.id === sid(6)), 'an old confirmed drawer stays out');
  });
  await ok('1,000 drawer rows or more: the three reads, as before (a page that may be cut short is never trusted)', async () => {
    reset();
    for (let i = 0; i < 1000; i++) mem.db.shifts.push({ id: `bulk-${i}`, business_id: B, branch_id: BR, status: 'closed', closed_at: iso(clockMs - DAY - i * 1000) });
    const from = iso(clockMs - 7 * DAY);
    mem.rowCap = 1000;
    const three = await LBD.branchShifts(B, BR, from, false);
    mem.calls = [];
    const got = await LBD.branchShifts(B, BR, from, true);
    assert.equal(mem.calls.filter((c) => c.table === 'shifts').length, 4, 'the combined read, then the three');
    assert.deepEqual(got, three);
  });
  await ok('the whole answer: the same as every read before A593 (A591_MEMO=off), minus its time', async () => {
    reset(); process.env.A591_MEMO = 'off';
    const before = await drawers();
    assert.equal(before.status, 200, before.text);
    delete process.env.A591_MEMO; reset();
    const now = await drawers();
    assert.deepEqual(noAt(now.body), noAt(before.body));
    assert.deepEqual(now.body.beat, { day_close_devices: ['dev-T2'], log_request_devices: ['dev-T3'], test_clear_latest: iso(clockMs - 10 * DAY) });
    assert.equal(now.body.shifts.find((s) => s.id === sid(3)).closed_by_name, 'Jane');
    assert.equal(now.body.shifts.find((s) => s.id === sid(3)).confirmed_by_name, 'Otieno');
  });
  await ok('a quiet beat (60 s): 2 reads (drawers, sales) — it was ~11; within the minute with nothing written: 0', async () => {
    reset();
    const first = await callsOf(() => drawers());
    assert.ok(first.calls.length >= 8, tables(first.calls).join(' '));
    tick(30_000);
    const again = await callsOf(() => drawers(first.out.body.cursor));
    tick(60_000);
    const beat = await callsOf(() => drawers(again.out.body.cursor));
    assert.deepEqual(tables(beat.calls).sort(), ['orders:select', 'shifts:select'], tables(beat.calls).join(' '));
    const r = await callsOf(() => drawers(beat.out.body.cursor));
    assert.equal(r.calls.length, 0, `within the minute: ${tables(r.calls).join(' ')}`);
    assert.deepEqual(r.out.body, beat.out.body);
  });
  await ok('a write of the business: read again at once; the beat\'s day close / log request / clear as they are now', async () => {
    reset();
    await drawers();
    mem.db.day_close_instructions[0].status = 'acked';
    await call('POST', '/api/day-close/ack', T.till2, { instruction_id: 'nope', ok: true }, { 'x-device-id': 'dev-T2' }); await settle();   // a write of B
    const r = await callsOf(() => drawers());
    assert.ok(tables(r.calls).includes('day_close_instructions:select'), tables(r.calls).join(' '));
    assert.deepEqual(r.out.body.beat.day_close_devices, []);
  });
  await ok('a log request\'s expiry is decided at each ask (kept beat, no read)', async () => {
    reset();
    const a = await drawers();
    assert.deepEqual(a.body.beat.log_request_devices, ['dev-T3']);
    tick(100_000);   // the request expired 10 s ago; the answer memory (60 s) is over, the beat (5 min) is not
    const r = await callsOf(() => drawers());
    assert.ok(!tables(r.calls).includes('log_requests:select'));
    assert.deepEqual(r.out.body.beat.log_request_devices, []);
  });
  await ok('a name changed through the staff routes: read again; otherwise the names are not read on a beat', async () => {
    reset();
    await drawers(); tick(61_000);
    let r = await callsOf(() => drawers());
    assert.ok(!tables(r.calls).includes('users:select'), 'names kept');
    mem.db.users.find((u) => u.id === JANE).name = 'Jane W.';
    WA.notePeopleWrite(B); tick(61_000);
    r = await callsOf(() => drawers());
    assert.equal(r.out.body.shifts.find((s) => s.id === sid(3)).closed_by_name, 'Jane W.');
  });
  await ok('only a confirmed branch server; its row kept only while it is one (a role taken away through this server: refused at once)', async () => {
    reset();
    assert.equal((await call('GET', '/api/pos/branch-drawers', T.till2, undefined, { 'x-device-id': 'dev-T2' })).status, 403);
    assert.equal((await drawers()).status, 200);
    mem.db.user_devices.find((d) => d.device_id === 'dev-S').device_role = 'till';
    AC.forgetTillsOf(B);
    assert.equal((await drawers()).body?.code, 'not_confirmed_server');
  });

  // ── E ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  log('\nE. the polled answers\n');
  const polled = [
    ['GET /api/shifts/state', () => call('GET', `/api/shifts/state?ids=${sid(3)},${sid(4)}`, T.till2)],
    ['GET /api/day-close/pending', () => call('GET', '/api/day-close/pending', T.till2, undefined, { 'x-device-id': 'dev-T2' })],
    ['GET /api/pos/test-data-clears (no clear applied yet)', () => call('GET', '/api/pos/test-data-clears', T.till2)],
    ['GET /api/pos/test-data-clears?after=', () => call('GET', `/api/pos/test-data-clears?after=${encodeURIComponent('2026-09-26T09:00:00.000Z')}`, T.till2)],
    ['GET /api/stations', () => call('GET', '/api/stations', T.till2)],
  ];
  for (const [name, ask] of polled) {
    await ok(`${name}: a repeat ask with nothing written — 0 Supabase calls, the same answer; a write → read again; off → read`, async () => {
      reset();
      mem.db.day_close_instructions[0].delivered_at = iso(clockMs - 3_600_000);   // delivered before: no stamp this time
      const a = await ask();
      assert.equal(a.status, 200, a.text);
      tick(20_000);
      const b = await callsOf(ask);
      assert.equal(b.calls.length, 0, tables(b.calls).join(' '));
      assert.deepEqual(b.out.body, a.body);
      if (name.startsWith('GET /api/stations')) {
        await call('POST', '/api/stations/seed-defaults', T.owner, {}); await settle();   // a catalogue write
      } else await owners();
      const c = await callsOf(ask);
      assert.ok(c.calls.length >= 1, 'read again after a write');
      process.env.A591_MEMO = 'off';
      const d = await callsOf(ask);
      assert.ok(d.calls.length >= 1, 'off: read every time');
      delete process.env.A591_MEMO;
    });
  }
  await ok('day-close/pending: the delivered stamp written once — not an update on every ask while an instruction waits', async () => {
    reset();
    const ask = () => call('GET', '/api/day-close/pending', T.till2, undefined, { 'x-device-id': 'dev-T2' });
    const a = await callsOf(ask);
    assert.equal(a.calls.filter((c) => c.op === 'update').length, 1, 'stamped');
    assert.ok(mem.db.day_close_instructions[0].delivered_at);
    tick(20_000);
    const b = await callsOf(ask);
    assert.equal(b.calls.filter((c) => c.op === 'update').length, 0, 'already delivered: no second stamp');
    tick(20_000);
    const c = await callsOf(ask);
    assert.equal(c.calls.length, 0, 'and then from memory');
    assert.deepEqual(c.out.body, a.out.body);
  });
  await ok('test-data-clears with no clear applied: the 60-day floor is applied at each ask to the kept list', async () => {
    reset();
    mem.db.test_data_purges[0].created_at = iso(clockMs - 60 * DAY + 60_000);   // falls out of the 60 days in a minute
    const ask = () => call('GET', '/api/pos/test-data-clears', T.till2);
    assert.equal((await ask()).body.length, 1);
    tick(2 * 60_000);
    const r = await callsOf(ask);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(r.out.body, [], 'older than 60 days now: not replayed to a new POS');
  });
  await ok('a drawer\'s web sales (POST foreign-orders): kept 5 minutes while nothing is written (A591: 60 s)', async () => {
    reset();
    const ask = () => call('POST', `/api/shifts/${sid(1)}/foreign-orders`, T.till2, { own_ids: [] }, { 'x-device-id': 'dev-T2' });
    await ask();
    let n = 0;
    for (let i = 0; i < 13; i++) { tick(20_000); n += (await callsOf(ask)).calls.length; }
    assert.equal(n, 0, 'every 20 s for 4 min 20 s: no call at all');
    tick(60_000);
    assert.ok((await callsOf(ask)).calls.length >= 1, '5 minutes on: read');
  });

  // ── F ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  log('\nF. the jobs\n');
  const mailer = require(path.join(DIST, 'lib/mailer.js'));
  let SENT = [];
  mailer.sendEmail = async (m) => { SENT.push(m); };
  supabase.auth.admin.getUserById = async () => ({ data: { user: { email: 'owner@biz.test' } }, error: null });
  const J = require(path.join(DIST, 'jobs/ownerAlerts.js'));
  const DS = require(path.join(DIST, 'jobs/dailySummary.js'));
  const bizFixture = (n) => {
    reset();
    mem.db.businesses = Array.from({ length: n }, (_, i) => ({ id: `b-${i}`, name: `Shop ${i}`, owner_id: `own-${i}`, currency: 'KES', status: 'active' }));
    mem.db.branches = mem.db.businesses.flatMap((b) => [{ id: `${b.id}-br1`, business_id: b.id, name: 'Main' }, { id: `${b.id}-br2`, business_id: b.id, name: 'Annex' }]);
    mem.db.business_settings = mem.db.businesses.map((b) => ({ id: `rs-${b.id}`, business_id: b.id, key: 'report_schedule',
      value: JSON.stringify({ enabled: false, send_time: '21:00', recipients: ['books@biz.test'], alert_not_syncing: true, alert_big_void: true, big_void_amount: 1000, alert_variance: true, variance_amount: 500 }) }));
    mem.db.user_devices = mem.db.businesses.map((b) => ({ id: `ud-${b.id}`, business_id: b.id, device_id: `dev-${b.id}`, branch_id: `${b.id}-br1`, status: 'approved', retired_at: null,
      last_seen_at: iso(clockMs - 60_000), last_sync_at: iso(clockMs - 60_000) }));
    mem.db.shifts = []; mem.db.orders = [
      { id: 'big-void', business_id: 'b-1', branch_id: 'b-1-br1', order_number: '7', status: 'voided', total: 5000, voided_at: iso(clockMs - 3_600_000), created_at: iso(clockMs - 4_000_000), cashier_id: null },
    ];
    mem.db.users = [];
  };
  await ok('ownerAlerts: 6 businesses in one tick read at most a third of the calls of each business on its own — the same emails', async () => {
    const at = new Date(Date.parse('2026-10-26T03:00:00Z'));   // 06:00 EAT: no branch slot due
    bizFixture(6);
    // seeded first (the first run of a business records what is there and emails none of it)
    await J.runOwnerAlertsTick(at);
    const seedState = JSON.stringify(mem.db.business_settings.filter((r) => r.key === 'owner_alerts_state').map((r) => [r.business_id, r.value]).sort());
    mem.db.orders.push({ id: 'big-void-2', business_id: 'b-1', branch_id: 'b-1-br1', order_number: '8', status: 'voided', total: 6000, voided_at: iso(clockMs - 600_000), created_at: iso(clockMs - 700_000), cashier_id: null });
    const settingsBefore = JSON.parse(JSON.stringify(mem.db.business_settings));
    // each business on its own (no tick): the reads before A593
    SENT = []; J._resetOwnerQuiet();
    const own = await callsOf(async () => {
      for (const b of mem.db.businesses) {
        const s = DS.parseReportSchedule(mem.db.business_settings.find((r) => r.business_id === b.id && r.key === 'report_schedule'));
        await J.branchOpenTillsForBusiness(b, s, at); await J.alertsForBusiness(b, s, at); await J.weeklyForBusiness(b, s, at);
      }
    });
    const ownMails = SENT.map((m) => m.subject).sort();
    // the tick, from the same rows
    mem.db.business_settings = settingsBefore; SENT = []; J._resetOwnerQuiet();
    const tickRun = await callsOf(() => J.runOwnerAlertsTick(at));
    const tickMails = SENT.map((m) => m.subject).sort();
    assert.deepEqual(tickMails, ownMails, 'the same emails');
    assert.equal(tickMails.length, 1, 'the big void told once');
    assert.ok(seedState.length > 2);
    log(`      ownerAlerts, 6 businesses: ${own.calls.length} calls one by one → ${tickRun.calls.length} in one tick (${tables(tickRun.calls).join(' ')})`);
    assert.ok(tickRun.calls.length * 3 <= own.calls.length + 6, `${tickRun.calls.length} vs ${own.calls.length}`);
  });
  await ok('dailySummary: every business\'s schedule in one read (one or two per business before)', async () => {
    bizFixture(8);
    const r = await callsOf(() => DS.runDailySummary(new Date(Date.parse('2026-10-26T03:00:00Z'))));
    assert.deepEqual(tables(r.calls), ['businesses:select', 'business_settings:select'], tables(r.calls).join(' '));
  });
  const W = require(path.join(DIST, 'jobs/watchdog.js'));
  await ok('watchdog: quiet POS of one branch — one sales read for the branch (one per POS before), each POS still counted on its own since', async () => {
    reset();
    const old = iso(clockMs - 3 * 3_600_000);
    mem.db.user_devices = [1, 2, 3, 4].map((n) => ({ id: `q-${n}`, business_id: B, branch_id: BR, device_id: `dev-q${n}`, status: 'approved', retired_at: null,
      last_seen_at: iso(clockMs - 60_000), last_sync_at: old, app_version: '1.0.19', schema_version: 70 }));
    mem.db.orders = [{ id: 'q-o1', business_id: B, branch_id: BR, device_id: 'dev-q1', created_at: iso(clockMs - 3_600_000) },
      { id: 'q-o2', business_id: B, branch_id: BR, device_id: 'web', created_at: iso(clockMs - 3_600_000) }];
    mem.calls = [];
    await W.collectAlerts(new Date(clockMs), { load: false });
    const ordersReads = mem.calls.filter((c) => c.table === 'orders').length;
    assert.ok(ordersReads <= 1, `orders read ${ordersReads}× for 4 quiet POS of one branch`);
    assert.ok(read('apps/server/src/jobs/watchdog.ts').includes("'[watchdog] A579 branch sales read failed:'"));
  });
  await ok('watchdog: open problems with nothing new move last_seen_at in ONE update; a changed detail is its own update; its writes are quiet', async () => {
    reset();
    mem.db.business_days = [1, 2, 3].map((n) => ({ id: `bd-${n}`, business_id: B, branch_id: BR, device_id: `dev-T${n + 1}`, terminal_code: `T${n + 1}`, business_date: '2026-10-20', status: 'open' }));
    const now = new Date(clockMs);
    const collected = await W.collectAlerts(now, { load: false });
    const keys = collected.alerts.map((a) => a.key);
    assert.ok(keys.length >= 1, 'a problem to keep open (the day not closed / the backup): ' + keys.join(','));
    mem.db.watchdog_alerts = collected.alerts.map((a, i) => ({ id: `wa-${i}`, alert_key: a.key, severity: a.severity, business_id: a.businessId, title: a.title,
      detail: i === 0 ? 'an older wording' : a.detail, first_seen_at: iso(clockMs - 60_000), last_notified_at: iso(clockMs - 60_000), notify_count: 1, resolved_at: null }));
    mem.calls = [];
    await W.runWatchdog(now);
    const ups = mem.calls.filter((c) => c.table === 'watchdog_alerts' && c.op === 'update');
    assert.equal(ups.filter((c) => c.filters['id:in']).length, keys.length > 1 ? 1 : 0, 'the unchanged ones together');
    assert.equal(ups.filter((c) => c.filters.id).length, 1, 'the changed one alone');
    assert.match(read('apps/server/src/jobs/watchdog.ts'), /meterJob\('watchdog', async \(\) => \{[\s\S]{0,600}\}, \{ quietWrites: true \}\)/);
    assert.match(read('apps/server/src/jobs/watchdog.ts'), /meterJob\('watchdogDigest', async \(\) => \{[\s\S]{0,400}\}, \{ quietWrites: true \}\)/);
  });

  // ── G ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  log('\nG. the System page\n');
  await ok('the meter: calls a day against the 15,000 target, the 5 sources with the most calls; the card shows both', async () => {
    M._resetMeter();
    const calls = { 'GET /api/pos/branch-drawers': 747, 'POST /api/shifts/:id/foreign-orders': 442, 'job:ownerAlerts': 375, 'job:liveHeads': 317, 'GET /api/shifts/state': 305, 'GET /api/pos/init': 103 };
    for (const [l, n] of Object.entries(calls)) for (let i = 0; i < n; i++) M.recordCall(l, 'rest', l === 'GET /api/pos/init' ? 50_000 : 10, 10);
    const s = M.meterSnapshot();
    assert.equal(s.target_calls_per_day, 15_000);
    assert.deepEqual(s.top_by_calls, ['GET /api/pos/branch-drawers', 'POST /api/shifts/:id/foreign-orders', 'job:ownerAlerts', 'job:liveHeads', 'GET /api/shifts/state']);
    assert.equal(s.rows[0].label, 'GET /api/pos/init', 'the rows stay by bytes');
    const sp = read('apps/admin/src/SystemPage.tsx');
    assert.match(sp, /<CallsTarget calls=\{m\.per_day\.calls\} target=\{m\.target_calls_per_day \?\? 15_000\} \/>/);
    assert.match(sp, /data-testid="supabase-top-calls"/);
    assert.match(sp, /m\.top_by_calls\?\.includes\(r\.label\)/);
  });
  await ok('wired: every new memory goes through the A591 switch; the renewal reads the till\'s row once', async () => {
    assert.match(read('apps/server/src/lib/quietMemo.ts'), /if \(!memoEnabled\(\)\) return undefined;/);
    assert.match(read('apps/server/src/lib/authCache.ts'), /memoEnabled\(\) && hit\.gen === writeGen\(businessId\)/);
    assert.match(read('apps/server/src/lib/cloudPlan.ts'), /if \(memoEnabled\(\)\) \{   \/\/ A593/);
    const auth = read('apps/server/src/routes/auth.ts');
    assert.match(auth, /session_lost_at, \$\{IDENTITY_COLS\}/);
    assert.match(auth, /withIdentity \? row : undefined\);   \/\/ A593: the row just read/);
    assert.match(auth, /if \(tillDevice\.sessionLost !== false\) await clearTillSessionLost/);
    assert.match(auth, /\.eq\('replaced_by', id\)\.is\('revoked_at', null\);/);
  });
} finally {
  console.warn = warn;
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
