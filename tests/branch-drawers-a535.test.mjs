// A535 — the cloud's half: a branch server asks about every drawer of its branch in ONE call; a drawer changed on the web
// rings it; stock levels travel on change, at their branch only.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/branch-drawers-a535.test.mjs
//
// Owner, 2026-10-19: "for a setup like KRUNCH only the server does the communication to cloud, not all tills" — and "this
// should only happen when there is a change, no need to keep asking for the same item".
//
// RUNS the COMPILED server (routes/index.js behind the real requireAuth; lib/liveHub.js) over HTTP; the database in memory
// (tests/lib-memdb.mjs) — the stock trigger and sync_changes_heads_by_branch are run for real in
// scripts/test-migration-153.mjs; here they are stood in by the same rules.
//
//   D  GET /api/pos/branch-drawers: only a confirmed branch server (a person, an ordinary till, a server of another
//      business are refused); its OWN branch's drawers only (never another branch's, never another business's — the
//      device's branch, not one it names); open + closed in 7 days + awaiting a confirmation; the sales on them with their
//      lines and payments (a pending M-Pesa payment left out); the cursor (only what changed after it, 120 s overlap);
//      the beat (a day close / a log request waiting for a device of THIS branch, the newest test-data clear).
//   R  a web force-close rings the business's sockets { type: 'changed', topics: ['drawers'] } (one ring per burst); a
//      till's read-only POST (foreign-orders) does not; a failed write does not.
//   K  /changes: a stock level at the till's branch is its row (quantity, threshold), another branch's never; a level a
//      blind count is counting comes as { counting: true } to a till; serves: ['stock'] once migration 153 answers;
//      the 5 s read: a stock-only change rings ITS branch only, at most every 5 minutes; a menu change rings at once.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
//   - branchDrawers.ts serverBranch without the role_confirmed_at check     → D "a server not yet confirmed" fails
//   - branchDrawers.ts shifts read without .eq('branch_id')                 → D "another branch's never" fails
//   - branchDrawers.ts orders without the since filter                      → D "the cursor" fails
//   - drawerBell.ts without the 2xx check                                   → R "a failed write does not" fails
//   - routes/index.ts without the /shifts skip list                         → R "foreign-orders does not" fails
//   - syncChanges.ts stock without the counted check                        → K "counting" fails
//   - liveHub.ts ringStock without the STOCK_RING_MS wait                   → K "at most every 5 minutes" fails
//   - liveHub.ts pushChangedAtBranch without the branch check               → K "ITS branch only" fails
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
if (!fs.existsSync(path.join(DIST, 'lib/branchDrawers.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
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
const PI = require(path.join(DIST, 'lib/posInit.js'));
const SC = require(path.join(DIST, 'lib/syncChanges.js'));
const LH = require(path.join(DIST, 'lib/liveHub.js'));
const warn = console.warn; console.warn = () => {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const B = '11111111-1111-4111-8111-111111111111', B2 = '99999999-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-2222-4222-8222-222222222222', BRX = '44444444-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MGR = 'aaaaaaaa-0000-4000-8000-000000000002';
const sid = (n) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

let seq = 10;
let stockReady = true;
mem.rpc = async (name, a) => {
  const all = (mem.db.sync_changes ?? []).slice().sort((x, y) => x.seq - y.seq);
  if (name === 'sync_stock_ready') return stockReady ? { data: true, error: null } : { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
  if (name === 'sync_changes_since') {
    return { data: all.filter((c) => c.business_id === a.p_business && c.seq > a.p_since && (!c.branch_id || !a.p_branch || c.branch_id === a.p_branch)).slice(0, a.p_limit), error: null };
  }
  if (name === 'sync_changes_heads_by_branch') {
    const by = new Map();
    for (const c of all.filter((c) => c.seq > a.p_after)) {
      const k = `${c.business_id}|${c.branch_id ?? ''}`;
      const h = by.get(k) ?? { business_id: c.business_id, branch_id: c.branch_id ?? null, max_seq: 0, n: 0, topics: [] };
      h.max_seq = Math.max(h.max_seq, c.seq); h.n++; if (!h.topics.includes(c.topic)) h.topics.push(c.topic);
      by.set(k, h);
    }
    return { data: [...by.values()], error: null };
  }
  return { data: null, error: null };
};
const logChange = (biz, table_name, row_id, topic, branch_id = null) =>
  mem.db.sync_changes.push({ seq: ++seq, business_id: biz, branch_id, topic, table_name, row_id, op: 'upsert', changed_at: ago(10_000) });

const shiftRow = (id, over) => ({ id, business_id: B, branch_id: BR, device_id: 'dev-T2', status: 'open', opened_at: ago(3 * 3600_000), opening_float: 1000,
  closed_at: null, close_method: null, closed_by: null, closing_float: null, cash_variance: null, expected_cash: null, notes: null,
  confirmed_at: null, confirmed_by: null, declared_methods: null, cashier_id: OWNER, opened_by: OWNER, terminal_code: null, ...over });
const orderRow = (id, shift, updatedMsAgo, over = {}) => ({ id, business_id: B, branch_id: BR, shift_id: shift, order_number: id, status: 'completed', subtotal: 100, vat_amount: 0,
  total: 100, idempotency_key: null, created_at: ago(updatedMsAgo), updated_at: ago(updatedMsAgo),
  order_items: [{ id: `${id}-i`, product_name: 'Soda', unit_price: 100, quantity: 1, subtotal: 100 }],
  payments: [{ id: `${id}-p`, method: 'cash', amount: 100, status: 'completed' }, { id: `${id}-m`, method: 'mpesa', amount: 100, status: 'pending' }], ...over });

const reset = () => {
  mem.fail = () => null; mem.calls = []; seq = 10; stockReady = true;
  SV._resetSyncVersions(); AC._resetAuthCache(); PI._resetInitCache(); SC._resetSyncChanges(); LH._resetLiveHub();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Krunch & Co', type: 'restaurant', currency: 'KES', vat_rate: 16, status: 'active' },
      { id: B2, owner_id: 'x', name: 'Other', type: 'retail', currency: 'KES', vat_rate: 16, status: 'active' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true }, { id: BR2, business_id: B, name: 'CBD', is_main: false, desktop_licensed: true },
      { id: BRX, business_id: B2, name: 'Theirs', is_main: true, desktop_licensed: true }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B, permissions_version: 1, roles: { name: 'Admin' }, user_branches: [], user_permissions: [] },
      { id: MGR, name: 'Akinyi', status: 'active', business_id: B, permissions_version: 1, roles: { name: 'Manager' }, user_branches: [], user_permissions: [] }],
    user_devices: [
      { id: 'ud-s', business_id: B, device_id: 'dev-S', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER, device_role: 'node', role_confirmed_at: ago(86_400_000) },
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER, device_role: 'till', role_confirmed_at: null },
      { id: 'ud-u', business_id: B, device_id: 'dev-U', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER, device_role: 'node', role_confirmed_at: null },
      { id: 'ud-c', business_id: B, device_id: 'dev-C', status: 'approved', retired_at: null, branch_id: BR2, user_id: OWNER, device_role: 'till', role_confirmed_at: null },
      { id: 'ud-x', business_id: B2, device_id: 'dev-X', status: 'approved', retired_at: null, branch_id: BRX, user_id: 'x', device_role: 'node', role_confirmed_at: ago(86_400_000) },
    ],
    shifts: [
      shiftRow(sid(1)),                                                                       // open, this branch
      shiftRow(sid(2), { status: 'closed', closed_at: ago(2 * 86_400_000), closed_by: MGR }),   // closed 2 days ago
      shiftRow(sid(3), { status: 'closed', closed_at: ago(20 * 86_400_000), declared_methods: { cash: 900 } }),   // old, awaiting
      shiftRow(sid(4), { status: 'closed', closed_at: ago(20 * 86_400_000) }),                 // old, done — not sent
      shiftRow(sid(5), { branch_id: BR2, device_id: 'dev-C' }),                                // another branch
      shiftRow(sid(6), { business_id: B2, branch_id: BRX, device_id: 'dev-X' }),               // another business
    ],
    orders: [orderRow('o-old', sid(1), 10 * 60_000), orderRow('o-new', sid(1), 5_000), orderRow('o-cbd', sid(5), 5_000, { branch_id: BR2 }),
      orderRow('o-x', sid(6), 5_000, { business_id: B2, branch_id: BRX })],
    day_close_instructions: [{ id: 'dc-1', business_id: B, device_id: 'dev-T2', status: 'pending' }, { id: 'dc-2', business_id: B, device_id: 'dev-C', status: 'pending' }],
    log_requests: [{ id: 'lr-1', business_id: B, device_id: 'dev-T2', status: 'waiting', expires_at: new Date(Date.now() + 86_400_000).toISOString() },
      { id: 'lr-2', business_id: B, device_id: 'dev-C', status: 'waiting', expires_at: new Date(Date.now() + 86_400_000).toISOString() }],
    test_data_purges: [{ id: 'tp-1', business_id: B, created_at: '2026-10-19T08:00:00.000Z' }, { id: 'tp-2', business_id: B2, created_at: '2026-10-20T08:00:00.000Z' }],
    float_transactions: [], expenses: [], payments: [],
    products: [{ id: pid(1), business_id: B, name: 'Soda', status: 'active', base_price: 100 }, { id: pid(2), business_id: B, name: 'Water', status: 'active', base_price: 50 },
      { id: pid(9), business_id: B2, name: 'Theirs', status: 'active', base_price: 1 }],
    stock_levels: [{ id: 'sl-1', product_id: pid(1), branch_id: BR, quantity: 38, low_stock_threshold: 5, qty_pieces: 0 },
      { id: 'sl-2', product_id: pid(1), branch_id: BR2, quantity: 7, low_stock_threshold: 5, qty_pieces: 0 },
      { id: 'sl-3', product_id: pid(2), branch_id: BR, quantity: 12, low_stock_threshold: 3, qty_pieces: 0 }],
    stock_takes: [], stock_take_lines: [],
    sync_versions: [{ business_id: B, topic: 'catalogue', version: 7 }], sync_changes: [], sync_change_floor: [{ id: 1, floor_seq: 0 }],
    refresh_tokens: [], audit_log: [], notifications: [], admin_users: [], ops_events: [], business_settings: [], branch_settings: [], feature_flags: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  server: sign({ userId: null, deviceId: 'dev-S', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  till2: sign({ userId: null, deviceId: 'dev-T2', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  unconfirmed: sign({ userId: null, deviceId: 'dev-U', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  serverX: sign({ userId: null, businessId: B2, branchId: BRX, deviceId: 'dev-X', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const drawers = (tok, dev, since) => call('GET', `/api/pos/branch-drawers${since ? `?since=${encodeURIComponent(since)}` : ''}`, tok, undefined, { 'x-device-id': dev });

try {
  state._setPermissionsMigrated(true);
  console.log('\nD. GET /api/pos/branch-drawers\n');
  await ok('refused: a person\'s session, an ordinary till, a server not yet confirmed (only a confirmed branch server asks)', async () => {
    reset();
    assert.equal((await call('GET', '/api/pos/branch-drawers', T.owner)).status, 403);
    assert.equal((await drawers(T.till2, 'dev-T2')).status, 403);
    const u = await drawers(T.unconfirmed, 'dev-U');
    assert.equal(u.status, 403); assert.equal(u.body.code, 'not_confirmed_server');
  });
  await ok('its OWN branch only: open + closed in 7 days + awaiting a confirmation (any age) — never another branch\'s or business\'s', async () => {
    reset();
    const r = await drawers(T.server, 'dev-S');
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.body.branch_id, BR);
    assert.deepEqual(r.body.shifts.map((s) => s.id).sort(), [sid(1), sid(2), sid(3)].sort());
    assert.equal(r.body.shifts.find((s) => s.id === sid(2)).closed_by_name, 'Akinyi');
    const rx = await drawers(T.serverX, 'dev-X');
    assert.deepEqual(rx.body.shifts.map((s) => s.id), [sid(6)]);
    assert.deepEqual(rx.body.orders.map((o) => o.id), ['o-x']);
  });
  let cursor = null;
  await ok('the sales on its drawers with their lines and payments (a pending M-Pesa payment left out); not another branch\'s', async () => {
    reset();
    const r = await drawers(T.server, 'dev-S');
    assert.deepEqual(r.body.orders.map((o) => o.id).sort(), ['o-new', 'o-old']);
    const o = r.body.orders.find((x) => x.id === 'o-new');
    assert.equal(o.order_items.length, 1); assert.deepEqual(o.payments.map((p) => p.status), ['completed']);
    cursor = r.body.cursor;
    assert.equal(cursor, mem.db.orders.find((x) => x.id === 'o-new').updated_at);
  });
  await ok('the cursor: only what changed after it (120 s overlap) — the 10-minute-old sale is not sent again', async () => {
    const r = await drawers(T.server, 'dev-S', cursor);
    assert.deepEqual(r.body.orders.map((o) => o.id), ['o-new']);
    assert.equal(r.body.shifts.length, 3, 'the drawers come whole every time');
    const bad = await drawers(T.server, 'dev-S', 'not-a-date');
    assert.equal(bad.body.orders.length, 2, 'a cursor that does not parse is no cursor');
  });
  await ok('the beat: a day close and a log request waiting for a device of THIS branch; the newest test-data clear of this business', async () => {
    const r = await drawers(T.server, 'dev-S');
    assert.deepEqual(r.body.beat.day_close_devices, ['dev-T2']);
    assert.deepEqual(r.body.beat.log_request_devices, ['dev-T2']);
    assert.equal(r.body.beat.test_clear_latest, '2026-10-19T08:00:00.000Z');
  });
  await ok('a read that fails is a 503 (asked again on the next beat), never an empty "nothing is open"', async () => {
    mem.fail = (t) => (t === 'shifts' ? { message: 'timeout', code: '57014' } : null);
    const r = await drawers(T.server, 'dev-S');
    assert.equal(r.status, 503); assert.equal(r.body.code, 'DRAWERS_BUSY');
    mem.fail = () => null;
  });

  console.log('\nR. a drawer changed on the web rings the branch server\n');
  await ok('a web force-close rings the business\'s sockets once: { type: changed, topics: [drawers] }', async () => {
    reset();
    const heard = []; const heardX = [];
    LH._addTestConn(B, 'dev-S', (m) => heard.push(m), BR);
    LH._addTestConn(B2, 'dev-X', (m) => heardX.push(m), BRX);
    const r = await call('POST', `/api/shifts/${sid(1)}/force-close`, T.owner, { reason: 'left without closing' });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    await wait(1_300);
    assert.deepEqual(heard.map((m) => [m.type, (m.topics ?? []).join()]), [['changed', 'drawers']]);
    assert.equal(heardX.length, 0, 'another business hears nothing');
  });
  await ok('a till\'s read-only POST (foreign-orders) does not ring; a refused write does not ring', async () => {
    reset();
    const heard = [];
    LH._addTestConn(B, 'dev-S', (m) => heard.push(m), BR);
    const f = await call('POST', `/api/shifts/${sid(1)}/foreign-orders`, T.till2, { own_ids: [] }, { 'x-device-id': 'dev-T2' });
    assert.ok(f.status < 300, String(f.status));
    const bad = await call('POST', `/api/shifts/${sid(1)}/force-close`, T.owner, { reason: '' });
    assert.equal(bad.status, 400);
    await wait(1_300);
    assert.equal(heard.length, 0, JSON.stringify(heard));
  });

  console.log('\nK. stock levels on change\n');
  const tillChanges = (since = 10) => call('GET', `/api/pos/changes?since=${since}&branch_id=${BR}`, T.till2, undefined, { 'x-device-id': 'dev-T2' });
  await ok('/changes: a stock level at the till\'s branch is its row; another branch\'s never; serves: [stock]', async () => {
    reset();
    logChange(B, 'stock', pid(1), 'stock', BR);
    logChange(B, 'stock', pid(1), 'stock', BR2);
    logChange(B, 'stock', pid(2), 'stock', BR);
    const r = await tillChanges();
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const rows = r.body.changes.filter((c) => c.table === 'stock');
    assert.equal(rows.length, 2, JSON.stringify(rows));
    const soda = rows.find((c) => c.id === pid(1));
    assert.deepEqual([soda.topic, soda.row.quantity, soda.row.branch_id, soda.row.low_stock_threshold], ['stock', 38, BR, 5]);
    assert.deepEqual(r.body.serves, ['stock']);
  });
  await ok('…a level a blind count is counting reaches a till as { counting: true } (no figures)', async () => {
    reset();
    mem.db.stock_takes = [{ id: 'tk-1', business_id: B, branch_id: BR, status: 'counting', freeze_sales: false }];
    mem.db.stock_take_lines = [{ id: 'tl-1', stock_take_id: 'tk-1', item_kind: 'product', product_id: pid(1), counted_qty: null }];
    logChange(B, 'stock', pid(1), 'stock', BR);
    logChange(B, 'stock', pid(2), 'stock', BR);
    const rows = (await tillChanges()).body.changes;
    const soda = rows.find((c) => c.id === pid(1)); const water = rows.find((c) => c.id === pid(2));
    assert.equal(soda.row.counting, true); assert.equal(soda.row.quantity, undefined);
    assert.equal(water.row.quantity, 12);
  });
  await ok('…before migration 153 (no sync_stock_ready): no serves — the till keeps its 30-minute re-read', async () => {
    reset(); stockReady = false;
    const r = await tillChanges();
    assert.equal(r.body.serves, undefined);
  });
  await ok('the 5 s read: a stock-only change rings ITS branch only, at most every 5 minutes; a menu change rings at once', async () => {
    reset();
    const here = []; const there = [];
    LH._addTestConn(B, 'dev-S', (m) => here.push(m), BR);
    LH._addTestConn(B, 'dev-C', (m) => there.push(m), BR2);
    const t0 = Date.now();
    await LH.headsTick(t0);                     // the first read: where the log is
    logChange(B, 'stock', pid(1), 'stock', BR);
    await LH.headsTick(t0 + 5_000);
    assert.deepEqual(here.map((m) => (m.topics ?? []).join()), ['stock'], 'rung at its branch');
    assert.equal(there.length, 0, 'not the other branch');
    logChange(B, 'stock', pid(2), 'stock', BR);
    await LH.headsTick(t0 + 10_000);
    assert.equal(here.length, 1, 'a second stock change within 5 minutes waits');
    await LH.headsTick(t0 + 5_000 + LH.STOCK_RING_MS + 1);
    assert.equal(here.length, 2, '…and rings when 5 minutes have passed');
    logChange(B, 'categories', 'cat-1', 'menu', null);
    await LH.headsTick(t0 + 5_000 + LH.STOCK_RING_MS + 5_000);
    assert.equal(here.at(-1)?.topics?.includes('menu'), true); assert.equal(there.at(-1)?.topics?.includes('menu'), true, 'a menu change: the whole business at once');
  });
} catch (e) {
  fail++; console.log(`FAIL  threw: ${e?.stack ?? e}`);
} finally {
  console.warn = warn;
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
