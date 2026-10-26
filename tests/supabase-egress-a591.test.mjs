/**
 * supabase-egress-a591.test.mjs — A591: Supabase egress and log calls brought down, measured on the System page.
 *
 * Owner, 2026-10-26 (Supabase usage page): "can we use redis to reduce this?" — the organisation went over the Free plan's
 * 5 GB egress last cycle (~250-270 MB a day this cycle; the production database is 33 MB, so it was re-read 7-8 times a
 * day) and Log Ingestion stands at 0.8 of 1 GB; Supabase restricts the projects from 20 Nov 2026.
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/supabase-egress-a591.test.mjs
 *
 * RUNS the COMPILED server — lib/supabaseMeter.js over the real supabase-js client, lib/writeActivity.js, the shifts,
 * pos, variants and modifiers routers over HTTP on the in-memory database (tests/lib-memdb.mjs), lib/syncVersions.js,
 * lib/posInit.js, lib/liveHub.js headsDue, lib/choiceGroups.js:
 *   A the meter: every Supabase answer counted by the route or job that asked (bytes, compressed bytes, calls), the answer
 *     handed back unchanged; ids folded; the last 24 h only; a job's own write noted, a quiet job's not
 *   B the write generation: a client's write moves its business; a read (GET, the drawer's read-only POSTs, a renewal)
 *     does not; a write with no business moves every business; nothing is remembered unless the tracking is mounted
 *   C a drawer's web sales (POST /api/shifts/:id/foreign-orders): the SAME answer as the old full read for a drawer of
 *     own sales, web sales, own sales voided / refunded on the web, open tabs; only the sales the answer can hold read in
 *     full; the next ask with nothing written: no read at all; a web sale / a web void after a write: there at once (a
 *     delta read); 60 s on: a delta read (A593: 5 minutes); 10 min on: the whole drawer; A591_MEMO=off: the old read every time
 *   D the 5 s change-log read: every 5 s while writes come in (and 130 s after), once a minute when nothing is written
 *     (A593: the next tick after a write of a business with a socket open; every 5 minutes when nothing is written)
 *   E the catalogue version kept up to 5 min while nothing is written (the 15 s rule still answers after a write)
 *   F /init kept up to an hour while nothing is written (10 min after any write, as before)
 *   G a till's whole-menu pull: every product's variants and modifiers from one read of the business's groups — the same
 *     rows, the same 404; the dashboard's ask reads as before
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A591 report):
 *   - meteredFetch not counting the body (bytes 0)                 → A "bytes and calls by route" fails
 *   - shiftOrdersFor fresh() ignoring the write generation          → C "a web sale … there at once" fails
 *   - neededIds keeping every sale                                  → C "only the sales the answer can hold" fails
 *   - READ_POST removed (the poll counts as a write)                → B "the drawer's read-only POST" fails
 *   - headsDue always false when idle                               → D "once a minute" fails
 *   - readTopicVersion quiet rule without the generation            → E "after a write: read again" fails
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
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 5).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/supabaseMeter.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.A591_MEMO;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const M = require(path.join(DIST, 'lib/supabaseMeter.js'));
const WA = require(path.join(DIST, 'lib/writeActivity.js'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const warn = console.warn; console.warn = () => {};

// ── A. the meter, over the REAL supabase-js client (before the in-memory database replaces .from) ───────────────────
console.log('\nA. the meter\n');
const realFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), method: init?.method ?? 'GET' });
  if (String(url).startsWith('http://supabase.test/rest/v1/products')) {
    const body = JSON.stringify([{ id: 'p1', name: 'Soda' }, { id: 'p2', name: 'Water' }]);
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } });
  }
  if (String(url).startsWith('http://supabase.test/rest/v1/notes')) return new Response(null, { status: 201 });
  return realFetch(url, init);
};
await ok('the real client: its answer unchanged, its bytes and calls counted by the route that asked', async () => {
  M._resetMeter();
  // awaited INSIDE the label, as a route's await is (the builder runs its fetch when awaited)
  const r = await M.withLabel('GET /api/pos/catalogue-version', async () => await supabase.from('products').select('id, name'));
  assert.equal(r.error, null);
  assert.deepEqual(r.data, [{ id: 'p1', name: 'Soda' }, { id: 'p2', name: 'Water' }]);
  const snap = M.meterSnapshot();
  const row = snap.rows.find((x) => x.label === 'GET /api/pos/catalogue-version');
  assert.ok(row, JSON.stringify(snap.rows));
  assert.equal(row.calls, 1);
  assert.equal(row.bytes, Buffer.byteLength(JSON.stringify([{ id: 'p1', name: 'Soda' }, { id: 'p2', name: 'Water' }])));
  assert.equal(row.wire, row.bytes);
  assert.deepEqual(row.kinds, { rest: 1 });
  assert.equal(snap.totals.calls, 1);
});
await ok('a call outside any route or job is "background"; a 201 with no body is a call of 0 bytes', async () => {
  M._resetMeter();
  const r = await supabase.from('notes').insert({ id: 'n1' });
  assert.equal(r.error, null);
  const row = M.meterSnapshot().rows.find((x) => x.label === 'background');
  assert.equal(row.calls, 1); assert.equal(row.bytes, 0);
});
globalThis.fetch = realFetch;

await ok('meteredFetch: gzip answer counted decoded (bytes) and as sent (wire); status, headers, body handed back; a failed fetch rethrown and counted', async () => {
  M._resetMeter();
  const body = JSON.stringify({ rows: 'x'.repeat(5000) });
  const f = M.meteredFetch(async () => new Response(body, { status: 206, statusText: 'Partial', headers: { 'content-length': '900', 'content-range': '0-9/10', 'content-encoding': 'gzip' } }));
  const res = await M.withLabel('GET /api/reports/sales', () => f('http://supabase.test/rest/v1/orders?select=id'));
  assert.equal(res.status, 206); assert.equal(res.statusText, 'Partial');
  assert.equal(res.headers.get('content-range'), '0-9/10');
  assert.equal(await res.text(), body);
  const boom = M.meteredFetch(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(() => M.withLabel('GET /api/reports/sales', () => boom('http://supabase.test/auth/v1/user')), /fetch failed/);
  const row = M.meterSnapshot().rows.find((x) => x.label === 'GET /api/reports/sales');
  assert.equal(row.calls, 2); assert.equal(row.bytes, Buffer.byteLength(body)); assert.equal(row.wire, 900);
  assert.deepEqual(row.kinds, { rest: 1, auth: 1 });
  const nb = M.meteredFetch(async () => new Response(null, { status: 204 }));
  assert.equal((await nb('http://supabase.test/rest/v1/rpc/x', { method: 'POST' })).status, 204);
});
await ok('route labels fold ids and numbers (one line per route, not per drawer)', () => {
  assert.equal(M.routeLabel('post', '/api/shifts/55555555-0000-4000-8000-000000000001/foreign-orders?x=1'), 'POST /api/shifts/:id/foreign-orders');
  assert.equal(M.routeLabel('GET', '/api/pos/changes?since=40'), 'GET /api/pos/changes');
  assert.equal(M.routeLabel('GET', '/api/orders/1234/receipt'), 'GET /api/orders/:id/receipt');
  assert.equal(M.callKind('http://x/rest/v1/rpc/sync_changes_heads'), 'rpc');
  assert.equal(M.callKind('http://x/storage/v1/object/a'), 'storage');
});
await ok('the last 24 h only; a day "at this rate" after a restart; the top rows and the rest summed', () => {
  M._resetMeter();
  const H = 3_600_000, T0 = Date.parse('2026-10-26T00:30:00Z');
  M._setMeterClock(() => T0);
  M.recordCall('job:watchdog', 'rest', 1000, 1000);
  M._setMeterClock(() => T0 + 25 * H);
  for (let i = 0; i < 45; i++) M.recordCall(`GET /api/r${i}`, 'rest', 100 + i, 50);
  const s = M.meterSnapshot(40);
  assert.ok(!s.rows.some((r) => r.label === 'job:watchdog'), 'a call 25 h ago is out of the window');
  assert.equal(s.rows.length, 41);
  assert.equal(s.rows[0].label, 'GET /api/r44');
  assert.equal(s.rows[40].label, '(the rest)');
  assert.equal(s.rows[40].calls, 5);
  assert.equal(s.totals.calls, 45);
  assert.ok(s.per_day.calls >= s.totals.calls);
  M._setMeterClock(null);
});
await ok('a job is labelled job:<name> and its runs counted; its table write moves every business (a quiet job: not)', async () => {
  M._resetMeter(); WA._resetWrites();
  const g0 = WA.writeGen('b1');
  const writes = M.meteredFetch(async () => new Response('[]', { status: 201 }));
  await M.meterJob('ownerAlerts', () => writes('http://supabase.test/rest/v1/business_settings', { method: 'PATCH' }))();
  assert.notEqual(WA.writeGen('b1'), g0, 'a job write: every business read again');
  const g1 = WA.writeGen('b1');
  await M.meterJob('lossAlerts', () => writes('http://supabase.test/rest/v1/loss_alerts', { method: 'POST' }), { quietWrites: true })();
  assert.equal(WA.writeGen('b1'), g1, 'a quiet job: its own records move nothing');
  await M.withLabel('POST /api/orders', () => writes('http://supabase.test/rest/v1/orders', { method: 'POST' }));
  assert.equal(WA.writeGen('b1'), g1, 'a request\'s writes are counted when it finishes (for its business)');
  await M.withLabel('GET /api/pos/init', () => writes('http://supabase.test/rest/v1/user_devices', { method: 'PATCH' }));
  assert.notEqual(WA.writeGen('b1'), g1, 'a GET route that writes: every business');
  const g2 = WA.writeGen('b1');
  await M.meterJob('liveHeads', () => writes('http://supabase.test/rest/v1/rpc/sync_changes_heads', { method: 'POST' }))();
  assert.equal(WA.writeGen('b1'), g2, 'an rpc (the 5 s read) is not a write');
  const snap = M.meterSnapshot();
  assert.equal(snap.rows.find((r) => r.label === 'job:ownerAlerts').api, 1);
});
await ok('wired: both clients take the meter; index.ts labels every request and tracks writes after the body parser; the System page shows it', () => {
  const sb = read('apps/server/src/lib/supabase.ts');
  assert.equal((sb.match(/global:\s+\{ fetch: meteredFetch\(\)/g) ?? []).length, 2);
  const ix = read('apps/server/src/index.ts');
  assert.ok(ix.indexOf('app.use(labelRequests);') > ix.indexOf("app.use(express.json("));
  assert.ok(ix.indexOf('app.use(trackWrites());') > ix.indexOf("app.use(express.json("));
  assert.ok(ix.indexOf('app.use(labelRequests);') < ix.indexOf("app.use('/api', apiRoutes);"));
  const ts = require(path.join(DIST, 'lib/trafficStats.js'));
  assert.ok(ts.trafficSnapshot().supabase && Array.isArray(ts.trafficSnapshot().supabase.rows));
  const sp = read('apps/admin/src/SystemPage.tsx');
  assert.match(sp, /<SupabaseCard m=\{summary\?\.traffic\?\.supabase\} \/>/);
  for (const j of ['watchdog', 'ownerAlerts', 'lossAlerts', 'dailySummary', 'monthlyPack', 'etimsRetry', 'cloudPlanReminders']) {
    assert.match(read(`apps/server/src/jobs/${j}.ts`), new RegExp(`meterJob\\('${j}'`), j);
  }
  assert.match(read('apps/server/src/lib/liveHub.ts'), /meterJob\('liveHeads'/);
});

// ── the in-memory database from here on ────────────────────────────────────────────────────────────────────────────
const mem = installMemDb(supabase);
const reads = [];
mem.fail = (table, op, filters, payload, cols) => { if (op === 'select') reads.push({ table, cols: String(cols ?? '*'), filters }); return null; };
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const SV = require(path.join(DIST, 'lib/syncVersions.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const PI = require(path.join(DIST, 'lib/posInit.js'));
const SO = require(path.join(DIST, 'lib/shiftOrdersMemo.js'));
const CG = require(path.join(DIST, 'lib/choiceGroups.js'));
const LH = require(path.join(DIST, 'lib/liveHub.js'));
const { foreignOrders, ownReversals } = require(path.join(DIST, 'lib/foreignCash.js'));

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const SHIFT = '55555555-0000-4000-8000-000000000001', OTHER_SHIFT = '55555555-0000-4000-8000-000000000002';
const pid = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuid = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
let clockMs = Date.parse('2026-10-26T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const order = (id, n, over = {}) => ({
  id, business_id: B, branch_id: BR, shift_id: SHIFT, order_number: `#${n}`, status: 'completed', subtotal: 100, vat_amount: 0,
  discount_amount: 0, total: 100, idempotency_key: null, refunded_amount: 0, created_at: iso(clockMs - (500 - n) * 60_000), updated_at: iso(clockMs - (500 - n) * 60_000),
  order_items: [{ id: `${id}-i`, product_name: 'Soda', unit_price: 100, quantity: 1, subtotal: 100 }],
  payments: [{ id: `${id}-p`, method: 'cash', amount: 100, status: 'completed' }, { id: `${id}-m`, method: 'mpesa', amount: 100, status: 'pending' }],
  ...over,
});
const OWN = Array.from({ length: 200 }, (_, i) => uuid(i + 1));   // the till's own ids (the cloud keeps them as idempotency_key)
const reset = () => {
  reads.length = 0; WA._resetWrites(); WA._setTracking(true); SO._resetShiftMemo(); SO._setShiftMemoClock(() => clockMs); WA._setWriteClock(() => clockMs);
  SV._resetSyncVersions(); AC._resetAuthCache(); PI._resetInitCache(); CG._resetChoiceGroups(); CG._setChoiceClock(() => clockMs);
  delete process.env.A591_MEMO;
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Krunch & Co', type: 'restaurant', currency: 'KES', status: 'active' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B, permissions_version: 1 }],
    user_devices: [{ id: 'ud-2', business_id: B, device_id: 'dev-T2', status: 'approved', retired_at: null, branch_id: BR }],
    shifts: [{ id: SHIFT, business_id: B, branch_id: BR, device_id: 'dev-T2', terminal_code: null, status: 'open', opened_by: OWNER, cashier_id: OWNER },
      { id: OTHER_SHIFT, business_id: B, branch_id: BR, device_id: 'dev-T2', terminal_code: null, status: 'open', opened_by: OWNER, cashier_id: OWNER }],
    orders: [
      ...OWN.map((k, i) => order(`cloud-own-${i + 1}`, i + 1, { idempotency_key: k })),                       // 200 rung on the till
      order('cloud-web-1', 201, { idempotency_key: 'web-k-1' }),                                               // rung on the web
      order('cloud-web-2', 202, { idempotency_key: 'web-k-2', status: 'voided', voided_at: iso(clockMs - 60_000) }),   // a web void
      order('cloud-own-voided', 203, { idempotency_key: uuid(900), status: 'voided', voided_at: iso(clockMs - 30_000) }),   // the till's, voided on the web
      order('cloud-own-refunded', 204, { idempotency_key: uuid(901), refunded_amount: 40, refunded_at: iso(clockMs - 20_000),
        payments: [{ id: 'pay-r', method: 'cash', amount: 100, status: 'completed' }, { id: 'pay-r-', method: 'cash', amount: -40, status: 'refunded', created_at: iso(clockMs - 20_000) }] }),
      order('cloud-tab', 205, { idempotency_key: 'web-k-5', status: 'open' }),                                 // an open tab: not a sale yet
      order('cloud-elsewhere', 206, { shift_id: OTHER_SHIFT, idempotency_key: 'web-k-6' }),                    // another drawer
    ],
    sync_versions: [{ business_id: B, topic: 'catalogue', version: 7 }],
    products: [{ id: pid(1), business_id: B, name: 'Burger' }, { id: pid(2), business_id: B, name: 'Fries' }, { id: pid(3), business_id: B, name: 'Soda' },
      { id: pid(9), business_id: B2, name: 'Theirs' }],
    variant_groups: [
      { id: 'vg-1', product_id: pid(1), name: 'Size', sort_order: 2, variant_options: [{ id: 'vo-1', name: 'Large', price_adjustment: 50 }] },
      { id: 'vg-0', product_id: pid(1), name: 'Bun', sort_order: 1, variant_options: [{ id: 'vo-0', name: 'Brioche', price_adjustment: 0 }] },
      { id: 'vg-2', product_id: pid(2), name: 'Salt', sort_order: 1, variant_options: [] },
      { id: 'vg-9', product_id: pid(9), name: 'Theirs', sort_order: 1, variant_options: [] },
    ],
    modifier_groups: [{ id: 'mg-1', product_id: pid(1), name: 'Extras', sort_order: 1, modifier_options: [{ id: 'mo-1', name: 'Cheese', price: 30 }] }],
    float_transactions: [], expenses: [], payments: [], refresh_tokens: [], audit_log: [], notifications: [], business_settings: [], branch_settings: [], feature_flags: [],
  };
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
const ask = (own = OWN) => call('POST', `/api/shifts/${SHIFT}/foreign-orders`, T.till2, { own_ids: own }, { 'x-device-id': 'dev-T2' });
/** The answer the old route gave: every completed/voided sale on the drawer, in full, through the same rules. */
const oldAnswer = (own = OWN) => {
  const rows = mem.db.orders.filter((o) => o.shift_id === SHIFT && o.business_id === B && ['completed', 'voided'].includes(o.status))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).slice(0, 2000).map((o) => JSON.parse(JSON.stringify(o)));
  return JSON.parse(JSON.stringify({ orders: foreignOrders(rows, own), own_reversals: ownReversals(rows, own) }));
};
const orderReads = () => reads.filter((r) => r.table === 'orders');
const fullReads = () => orderReads().filter((r) => /order_items/.test(r.cols));
const counters = () => require(path.join(DIST, 'lib/trafficStats.js')).trafficSnapshot().counters;

try {
  state._setPermissionsMigrated(true);

  console.log('\nB. the write generation\n');
  await ok('a client\'s write moves its business only; a GET, the drawer\'s read-only POST and a refused anonymous write do not', async () => {
    reset();
    const g = WA.writeGen(B), gx = WA.writeGen(B2);
    await call('GET', '/api/pos/catalogue-version', T.till2, undefined, { 'x-device-id': 'dev-T2' });
    await ask(); await settle();
    assert.equal(WA.writeGen(B), g, 'the poll is not a write');
    await call('POST', '/api/orders', undefined, { x: 1 }); await settle();
    assert.equal(WA.writeGen(B), g, 'refused before any route: nothing written');
    await call('POST', '/api/expenses', T.owner, {}); await settle();
    assert.notEqual(WA.writeGen(B), g, 'a write (even a refused one) of the business');
    assert.equal(WA.writeGen(B2), gx, 'another business untouched');
    WA.noteWrite(null);
    assert.notEqual(WA.writeGen(B2), gx, 'a write with no business (an M-Pesa callback) moves every business');
  });
  await ok('nothing is remembered unless index.ts mounted the tracking (a test app, a router alone)', async () => {
    reset(); WA._setTracking(false);
    assert.equal(WA.memoEnabled(), false);
    await ask(); reads.length = 0; await ask();
    assert.equal(fullReads().length, 1, 'the old read every time');
    WA._setTracking(true);
  });

  console.log('\nC. a drawer\'s web sales\n');
  await ok('the SAME answer as the old full read: web sales and the web void sent; own sales voided / refunded on the web as own_reversals; tabs and other drawers out', async () => {
    reset();
    const r = await ask();
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual(r.body, oldAnswer());
    // uuid(900/901) are not in OWN here: to this till those two are not its own, so they come down as sales
    assert.deepEqual(r.body.orders.map((o) => o.id), ['cloud-web-1', 'cloud-web-2', 'cloud-own-voided', 'cloud-own-refunded']);
    assert.deepEqual(r.body.own_reversals.map((o) => o.local_id), []);
    const own2 = [...OWN, uuid(900), uuid(901)];
    reset();
    const r2 = await ask(own2);
    assert.deepEqual(r2.body, oldAnswer(own2));
    assert.deepEqual(r2.body.orders.map((o) => o.id), ['cloud-web-1', 'cloud-web-2']);
    assert.deepEqual(r2.body.own_reversals.map((o) => [o.local_id, o.status, o.refunded_amount]), [[uuid(900), 'voided', 0], [uuid(901), 'completed', 40]]);
    assert.deepEqual(r2.body.own_reversals[1].refund_payments.map((p) => p.amount), [-40]);
  });
  await ok('only the sales the answer can hold are read in full (4 of 204), the rest as a light list', async () => {
    reset();
    await ask([...OWN, uuid(900), uuid(901)]);
    const light = orderReads().filter((r) => !/order_items/.test(r.cols));
    assert.equal(light.length, 1);
    assert.match(light[0].cols, /^id, status, idempotency_key, refunded_amount, created_at, updated_at$/);
    assert.equal(fullReads().length, 1);
    assert.deepEqual([...fullReads()[0].filters['id:in']].sort(), ['cloud-own-refunded', 'cloud-own-voided', 'cloud-web-1', 'cloud-web-2']);
  });
  await ok('the next ask with nothing written: no Supabase read at all (the drawer, the sales, the auth row from memory)', async () => {
    reset();
    await ask(); reads.length = 0;
    clockMs += 20_000;
    const r = await ask();
    assert.deepEqual(r.body, oldAnswer());
    assert.deepEqual(reads.filter((x) => x.table !== 'user_devices'), [], JSON.stringify(reads));
  });
  await ok('a web sale after a write: there on the very next ask (a delta read), and the same answer as the old read', async () => {
    reset();
    await ask();
    clockMs += 5_000;
    mem.db.orders.push(order('cloud-web-3', 300, { idempotency_key: 'web-k-3', created_at: iso(clockMs), updated_at: iso(clockMs) }));
    await call('POST', '/api/expenses', T.owner, {}); await settle();   // any write of the business
    const before = counters()['foreign.delta'] ?? 0;
    const r = await ask();
    assert.deepEqual(r.body, oldAnswer());
    assert.ok(r.body.orders.some((o) => o.id === 'cloud-web-3'));
    assert.equal((counters()['foreign.delta'] ?? 0) - before, 1);
  });
  await ok('the till\'s own sale voided on the web: its reversal on the next ask (the write moved the generation)', async () => {
    const own2 = [...OWN];
    reset();
    await ask(own2);
    clockMs += 5_000;
    const o = mem.db.orders.find((x) => x.id === 'cloud-own-7');
    Object.assign(o, { status: 'voided', voided_at: iso(clockMs), void_reason: 'wrong item', updated_at: iso(clockMs) });
    WA.noteWrite(B);
    const r = await ask(own2);
    assert.deepEqual(r.body, oldAnswer(own2));
    assert.deepEqual(r.body.own_reversals.map((x) => x.local_id), [uuid(7)]);
  });
  await ok('A593: 61 s on with nothing written: still from memory; 5 minutes on: read again (a delta); 10 minutes on: the whole drawer', async () => {
    reset();
    await ask();
    const c0 = counters();
    clockMs += 61_000;
    await ask();
    assert.equal((counters()['foreign.delta'] ?? 0) - (c0['foreign.delta'] ?? 0), 0, 'A593: kept 5 minutes while nothing is written (60 s before)');
    clockMs += 4 * 60_000;
    await ask();
    const c1 = counters();
    assert.equal((c1['foreign.delta'] ?? 0) - (c0['foreign.delta'] ?? 0), 1);
    clockMs += 10 * 60_000;
    await ask();
    assert.equal((counters()['foreign.whole'] ?? 0) - (c1['foreign.whole'] ?? 0), 1);
  });
  await ok('A591_MEMO=off: the old read (every sale, in full) every time — the same answer', async () => {
    reset(); process.env.A591_MEMO = 'off';
    const r = await ask(); await ask();
    assert.deepEqual(r.body, oldAnswer());
    assert.equal(fullReads().length, 2);
    delete process.env.A591_MEMO;
  });
  await ok('the reduction (a busy drawer, 200 own sales, one ask every 20 s for an hour, a write every minute): full rows read', async () => {
    reset();
    let full = 0, light = 0;
    for (let i = 0; i < 180; i++) {
      if (i % 3 === 0) WA.noteWrite(B);
      reads.length = 0;
      await ask();
      for (const r of orderReads()) if (/order_items/.test(r.cols)) full += (r.filters['id:in'] ?? []).length; else light++;
      clockMs += 20_000;
    }
    const oldFull = 180 * 204;
    console.log(`      old: ${oldFull} full order rows (+ lines, payments) and ${180 * 2} calls; now: ${full} full rows, ${light} light reads`);
    assert.ok(full < oldFull / 50, `${full}`);
  });
  await ok('another business\'s drawer: 404, as before (from memory or not)', async () => {
    reset();
    await ask();
    const tok = sign({ businessId: B2, userId: null, deviceId: 'dev-X', till: true, permissionKeys: ['*'], surface: 'desktop' });
    mem.db.user_devices.push({ id: 'ud-x', business_id: B2, device_id: 'dev-X', status: 'approved', retired_at: null, branch_id: null });
    const r = await call('POST', `/api/shifts/${SHIFT}/foreign-orders`, tok, { own_ids: [] }, { 'x-device-id': 'dev-X' });
    assert.equal(r.status, 404);
  });

  console.log('\nD. the 5 s change-log read\n');
  // A593: the read follows a write of a business with a socket open (the next tick), not "any write in 130 s"; idle: 5 min.
  await ok('A593: read on the next tick after a write of a business with a socket open; a write of a business with none reads nothing; every 5 minutes when nothing is written', async () => {
    reset();
    WA._setWriteClock(() => clockMs);
    const t0 = clockMs + 10 * 60_000;
    assert.equal(LH.headsDue(t0), true, 'never read: due');
    const drop = LH._addTestConn(B, 'dev-T2', () => {}, BR);
    await LH.headsTick(t0);
    assert.equal(LH.headsDue(t0 + 5_000), false, 'nothing written since the read: not due');
    clockMs = t0 + 7_000; WA.noteWrite(B);
    assert.equal(LH.headsDue(t0 + 10_000), true, 'a write of the business whose POS holds a socket: the next tick reads');
    await LH.headsTick(t0 + 10_000);
    assert.equal(LH.headsDue(t0 + 15_000), false, 'read since: not due');
    clockMs = t0 + 16_000; WA.noteWrite(B2);
    assert.equal(LH.headsDue(t0 + 20_000), false, 'a write of a business with no socket open: nothing read');
    clockMs = t0 + 21_000; WA.noteWrite(null);
    assert.equal(LH.headsDue(t0 + 25_000), true, 'a write with no business (it may be any): read');
    await LH.headsTick(t0 + 25_000);
    assert.equal(LH.headsDue(t0 + 25_000 + 5 * 60_000 - 1), false);
    assert.equal(LH.headsDue(t0 + 25_000 + 5 * 60_000), true, 'every 5 minutes when nothing is written');
    process.env.A591_MEMO = 'off';
    assert.equal(LH.headsDue(t0 + 30_000), true, 'off: every tick'); delete process.env.A591_MEMO;
    drop();
    assert.match(read('apps/server/src/lib/liveHub.ts'), /if \(headsDue\(now\)\) void headsTick\(now\);\s*else flushStock\(now\);/);
    assert.match(read('apps/server/src/lib/liveHub.ts'), /headsReadAt = now;/);
    assert.equal(LH.HEADS_IDLE_MS, 5 * 60_000);
  });

  console.log('\nE. the catalogue version\n');
  await ok('kept up to 5 minutes while nothing is written; after a write read again; the 15 s rule unchanged', async () => {
    reset();
    const t = Date.parse('2026-10-26T10:00:00Z');
    const n = () => reads.filter((r) => r.table === 'sync_versions').length;
    assert.equal(await SV.readTopicVersion(B, 'catalogue', t), 7);
    assert.equal(await SV.readTopicVersion(B, 'catalogue', t + 20_000), 7);
    assert.equal(await SV.readTopicVersion(B, 'catalogue', t + 4 * 60_000), 7);
    assert.equal(n(), 1, 'one read in 4 minutes');
    mem.db.sync_versions[0].version = 8;
    WA.noteWrite(B);
    assert.equal(await SV.readTopicVersion(B, 'catalogue', t + 4 * 60_000 + 1_000), 8, 'after a write: read again');
    assert.equal(n(), 2);
    assert.equal(await SV.readTopicVersion(B, 'catalogue', t + 4 * 60_000 + 10_000), 8, 'the 15 s rule');
    assert.equal(await SV.readTopicVersion(B, 'catalogue', t + 10 * 60_000), 8);
    assert.equal(n(), 3, 'past 5 minutes: read again');
    WA._setTracking(false);
    await SV.readTopicVersion(B, 'catalogue', t + 10 * 60_000 + 20_000);
    assert.equal(n(), 4, 'tracking not mounted: the 15 s rule only');
  });

  console.log('\nF. /init\n');
  await ok('kept up to an hour while the catalogue is not written (a sale does not count); 10 minutes after a catalogue write, as before', async () => {
    reset();
    let builds = 0;
    PI.setInitBuilder(async () => { builds++; return { ok: true, body: { products: [] }, opBranch: { desktop_licensed: true } }; });
    const t = Date.parse('2026-10-26T10:00:00Z');
    await PI.initAnswer(B, BR, 7, { now: t });
    await PI.initAnswer(B, BR, 7, { now: t + 11 * 60_000 });
    await PI.initAnswer(B, BR, 7, { now: t + 59 * 60_000 });
    assert.equal(builds, 1);
    WA.noteWrite(B);   // a sale: the menu did not change (a menu change moves the version, the key)
    await PI.initAnswer(B, BR, 7, { now: t + 59 * 60_000 });
    assert.equal(builds, 1, 'a sale written: still kept');
    WA.noteCatalogueWrite(B);   // a catalogue router's write (a variant edited — no version covers it)
    await PI.initAnswer(B, BR, 7, { now: t + 59 * 60_000 + 1 });
    assert.equal(builds, 2, 'after a catalogue write, an answer older than 10 minutes is rebuilt');
    await PI.initAnswer(B, BR, 7, { now: t + 61 * 60_000 });
    assert.equal(builds, 2, 'the new one is kept');
    await PI.initAnswer(B, BR, 7, { now: t + 60 * 60_000 + 61 * 60_000 });
    assert.equal(builds, 3, 'past the hour');
  });

  console.log('\nG. a till\'s whole-menu pull\n');
  const vg = (p, tok = T.till2) => call('GET', `/api/variants/groups?product_id=${p}`, tok, undefined, { 'x-device-id': 'dev-T2' });
  const mg = (p, tok = T.till2) => call('GET', `/api/modifiers/groups?product_id=${p}`, tok, undefined, { 'x-device-id': 'dev-T2' });
  await ok('every product\'s variants from one read: the same rows by sort_order as the dashboard\'s per-product read; a product not of this business 404', async () => {
    reset();
    const dash = {};
    for (const p of [pid(1), pid(2), pid(3)]) dash[p] = (await vg(p, T.owner)).body;
    reads.length = 0;
    for (const p of [pid(1), pid(2), pid(3)]) assert.deepEqual((await vg(p)).body, dash[p], p);
    assert.deepEqual(dash[pid(1)].map((g) => g.id), ['vg-0', 'vg-1']);
    assert.deepEqual(dash[pid(3)], []);
    assert.equal((await vg(pid(9))).status, 404, 'another business\'s product');
    assert.equal((await vg('not-a-product')).status, 404);
    const db = reads.filter((r) => ['products', 'variant_groups'].includes(r.table));
    assert.equal(db.length, 2, `the pull's ${5} asks: 2 reads (the old way: 2 per product): ${JSON.stringify(db.map((r) => r.table))}`);
    assert.deepEqual((await mg(pid(1))).body, (await mg(pid(1), T.owner)).body);
  });
  await ok('a write through the catalogue routers: the next ask reads again (an option edited on the web reaches the pull); a sale does not', async () => {
    reset();
    await vg(pid(1));
    mem.db.variant_groups.find((g) => g.id === 'vg-1').variant_options = [{ id: 'vo-1', name: 'Large', price_adjustment: 70 }];
    WA.noteWrite(B);   // a sale: kept
    assert.equal((await vg(pid(1))).body.find((g) => g.id === 'vg-1').variant_options[0].price_adjustment, 50);
    await call('PATCH', '/api/variants/options/not-there', T.owner, { name: 'x' }); await settle();   // any write through /api/variants
    assert.equal((await vg(pid(1))).body.find((g) => g.id === 'vg-1').variant_options[0].price_adjustment, 70);
  });
  await ok('A591_MEMO=off: per product, as before', async () => {
    reset(); process.env.A591_MEMO = 'off';
    reads.length = 0;
    await vg(pid(1)); await vg(pid(2));
    assert.equal(reads.filter((r) => r.table === 'variant_groups').length, 2);
    delete process.env.A591_MEMO;
  });
  console.log('\nH. the hourly loss-alert run\n');
  await ok('nothing written since a run that left nothing to tell, the same business day → the business is skipped (no 7-day read); a write → read again', async () => {
    reset();
    const LA = require(path.join(DIST, 'jobs/lossAlerts.js'));
    const { ANALYTICS_FLAG } = require(path.join(DIST, 'lib/analyticsRules.js'));
    LA._resetLossQuiet();
    mem.db.feature_flags = [{ id: 'ff', business_id: B, key: ANALYTICS_FLAG, enabled: true }];
    const now = new Date('2026-10-26T09:20:00Z');
    await LA.runLossAlertsTick(now);
    const firstOrders = reads.filter((r) => r.table === 'orders').length;
    assert.ok(firstOrders >= 3, `the first run reads the week (${firstOrders})`);
    reads.length = 0;
    await LA.runLossAlertsTick(new Date('2026-10-26T10:20:00Z'));
    assert.equal(reads.filter((r) => r.table === 'orders').length, 0, JSON.stringify(reads.map((r) => r.table)));
    WA.noteWrite(B);
    reads.length = 0;
    await LA.runLossAlertsTick(new Date('2026-10-26T11:20:00Z'));
    assert.ok(reads.filter((r) => r.table === 'orders').length >= 3, 'a write: read again');
    reads.length = 0;
    await LA.runLossAlertsTick(new Date('2026-10-27T09:20:00Z'));
    assert.ok(reads.filter((r) => r.table === 'orders').length >= 3, 'a new business day: read again');
    WA._setTracking(false); reads.length = 0;
    await LA.runLossAlertsTick(new Date('2026-10-27T10:20:00Z'));
    assert.ok(reads.filter((r) => r.table === 'orders').length >= 3, 'tracking not mounted: every run reads');
  });
} finally {
  server.close();
  console.warn = warn;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
