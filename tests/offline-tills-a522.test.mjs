// A522 — nothing may wait on a till that is switched off (owner, 2026-10-17: "check if anything will break or fail to
// respond because a till has not responded, I know not all tills will run 24/7 — even Pollo restaurant had the same issue
// when deleting the menu"). Act on what is known; never wait on an absent till; queue the rest for when it reconnects.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/offline-tills-a522.test.mjs
//
// RUNS the COMPILED routers (day-close, shifts, sync, pos, changes) behind the REAL auth middleware over HTTP; the database
// in memory (tests/lib-memdb.mjs).
//
//   1 remote Close Day: counted_cash optional (null = the confirmed shift counts, never 0); a drawer open / a shift not
//     confirmed is "waiting" (kept pending, retried each beat), a real refusal fails; retired tills refused
//   2 the overview: instructions matched to the day; retired tills apart; every till with its last sync
//   3 withdraw a pending close (audited); close a dead / retired till's day as abandoned
//   4 a till's own count after the web closed its drawer is kept and the owner told; a confirmation likewise
//   5 a web counted close past a dead till's unpaid kitchen orders (owner / close-day holder, noted)
//   6 late rows: a float / expense / sale landing on a closed drawer recomputes its expected cash and difference
//   7 test-data clears: a till off for more than 60 days still gets the clear it never applied
//   8 stock: an item a count posted after the sale was rung is not taken off again
//   9 a branch server relays a change made on one of its tills under the maker's proof; `relayed_for` (A521) recorded
//     as the change's device only for a branch server and a till of its own branch (4: `till_count_recorded` on the 409s)
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-17):
//   - day-close.ts waitingCode() branch removed           → "a drawer still open on the till: the close WAITS" fails
//   - sync.ts settleLateRows call removed                   → "a pay-out landing on a closed drawer" fails
//   - pos.ts 60-day floor put back for `after`              → "a till off for 90 days" fails
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
if (!fs.existsSync(path.join(DIST, 'lib/lateRows.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const rules = require(path.join(DIST, 'lib/dayCloseRules.js'));
const stockEffects = require(path.join(DIST, 'lib/stockEffects.js'));

const B = '11111111-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-3333-4333-8333-333333333333';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MGR = 'aaaaaaaa-0000-4000-8000-000000000002',
  CASH = 'aaaaaaaa-0000-4000-8000-000000000003', SUP = 'aaaaaaaa-0000-4000-8000-000000000004';
const SH = 'bbbbbbbb-0000-4000-8000-000000000001', SH2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const DAY = 'cccccccc-0000-4000-8000-000000000001';
const perms = (...keys) => ({ name: 'Role', role_permissions: keys.map((key) => ({ permissions: { key } })) });
const person = (id, name, extra = {}) => ({ id, name, status: 'active', business_id: B, permissions_version: 0, user_permissions: [], user_branches: [], ...extra });
const ago = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const MGR_KEYS = ['orders.create', 'shifts.close_day', 'shifts.confirm', 'shifts.force_close', 'reports.shifts', 'menu.edit', 'menu.prices'];

const reset = () => {
  mem.fail = () => null; mem.calls = [];
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Pollo', currency: 'KES' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true }, { id: BR2, business_id: B, name: 'Kilimani', desktop_licensed: true }],
    users: [
      person(OWNER, 'Owner', { roles: { name: 'Admin' } }),
      person(MGR, 'Mary', { roles: perms(...MGR_KEYS) }),
      person(CASH, 'Joe', { roles: perms('orders.create') }),
      person(SUP, 'Sue', { roles: perms('shifts.confirm') }),
    ],
    user_branches: [],
    user_devices: [
      { id: 'ud-1', business_id: B, device_id: 'dev-T1', terminal_code: 'T1', status: 'approved', retired_at: null, branch_id: BR, last_sync_at: ago(0.01) },
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', terminal_code: 'T2', status: 'approved', retired_at: null, branch_id: BR, last_sync_at: ago(50) },
      { id: 'ud-3', business_id: B, device_id: 'dev-T3', terminal_code: 'T3', status: 'approved', retired_at: ago(100), branch_id: BR, last_sync_at: ago(200) },
      { id: 'ud-s', business_id: B, device_id: 'dev-S', terminal_code: 'S1', status: 'approved', retired_at: null, branch_id: BR, last_sync_at: ago(0.01), device_role: 'node' },
    ],
    business_settings: [], branch_settings: [], feature_flags: [], notifications: [], refresh_tokens: [], change_requests: [],
    products: [], categories: [], orders: [], shifts: [], customers: [], day_close_instructions: [], business_days: [],
    float_transactions: [], expenses: [], payments: [], kitchen_tickets: [], audit_log: [], test_data_purges: [],
    stock_takes: [], stock_take_lines: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
for (const [mount, file] of [['day-close', 'day-close'], ['shifts', 'shifts'], ['sync', 'sync'], ['pos', 'pos'], ['changes', 'changes']]) {
  app.use(`/api/${mount}`, require(path.join(DIST, `routes/${file}.js`)).default);
}
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  mgr: sign({ userId: MGR, permissionKeys: MGR_KEYS, surface: 'dashboard' }),
  sup: sign({ userId: SUP, permissionKeys: ['shifts.confirm'], surface: 'dashboard' }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create'], surface: 'pos' }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  till2: sign({ userId: null, deviceId: 'dev-T2', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  srv: sign({ userId: null, deviceId: 'dev-S', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const DRAWER_OPEN = 'A drawer is still open on this till. Every shift must be closed before the day can be.';
const UNCONFIRMED = 'A shift must be confirmed by a manager before the day can close: Joe 09:00–17:00.';

try {
  state._setPermissionsMigrated(true);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n1. Remote Close Day: an optional count, and "not yet" is not "no"\n');
  reset();
  await ok('an empty count is the confirmed shift counts — counted_cash null on the instruction, never 0', async () => {
    for (const counted of [undefined, null, '']) {
      const r = await call('POST', '/api/day-close/instruct', T.mgr, { device_id: 'dev-T1', business_date: '2026-10-17', ...(counted === undefined ? {} : { counted_cash: counted }) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const live = mem.db.day_close_instructions.filter((i) => i.status === 'pending');
    assert.equal(live.length, 1, 'one live close per till and day');
    assert.strictEqual(live[0].payload.counted_cash, null);
  });
  await ok('a typed count is kept; a negative one refused', async () => {
    assert.equal((await call('POST', '/api/day-close/instruct', T.mgr, { device_id: 'dev-T1', business_date: '2026-10-17', counted_cash: -5 })).status, 400);
    const r = await call('POST', '/api/day-close/instruct', T.mgr, { device_id: 'dev-T1', business_date: '2026-10-17', counted_cash: 12500 });
    assert.equal(r.status, 200);
    assert.equal(mem.db.day_close_instructions.find((i) => i.status === 'pending').payload.counted_cash, 12500);
  });
  await ok('a retired till is refused (TILL_RETIRED) — its day is closed as abandoned', async () => {
    const r = await call('POST', '/api/day-close/instruct', T.mgr, { device_id: 'dev-T3', business_date: '2026-10-17' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'TILL_RETIRED');
  });
  await ok('a drawer still open on the till: the close WAITS (pending, reason kept) and the till collects it again', async () => {
    const ins = mem.db.day_close_instructions.find((i) => i.status === 'pending');
    const r = await call('POST', '/api/day-close/ack', T.till, { instruction_id: ins.id, ok: false, error: DRAWER_OPEN }, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'pending'); assert.equal(r.body.waiting, true); assert.equal(r.body.code, 'DRAWER_OPEN');
    assert.equal(ins.status, 'pending'); assert.equal(ins.ack.waiting, true); assert.equal(ins.ack.error, DRAWER_OPEN);
    const again = await call('GET', '/api/day-close/pending', T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(again.body.length, 1, 'offered again at the next beat');
  });
  await ok('a shift counted offline and not confirmed: waiting too (text, or a code from a newer till)', async () => {
    const ins = mem.db.day_close_instructions.find((i) => i.status === 'pending');
    assert.equal((await call('POST', '/api/day-close/ack', T.till, { instruction_id: ins.id, ok: false, error: UNCONFIRMED }, { 'x-device-id': 'dev-T1' })).body.code, 'SHIFTS_UNCONFIRMED');
    assert.equal((await call('POST', '/api/day-close/ack', T.till, { instruction_id: ins.id, ok: false, error: 'x', code: 'DRAWER_OPEN' }, { 'x-device-id': 'dev-T1' })).body.waiting, true);
    assert.equal(ins.status, 'pending');
  });
  await ok('a real refusal still fails it; a close acks it', async () => {
    const ins = mem.db.day_close_instructions.find((i) => i.status === 'pending');
    await call('POST', '/api/day-close/ack', T.till, { instruction_id: ins.id, ok: false, error: 'No open trading day on this till' }, { 'x-device-id': 'dev-T1' });
    assert.equal(ins.status, 'failed');
    assert.equal(rules.waitingCode({ error: 'Enter the cash you counted before closing the day' }), null);
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n2. The overview: the day\'s own instruction, retired tills apart, every till with its last sync\n');
  reset();
  mem.db.business_days = [
    { id: 'd1', business_id: B, branch_id: BR, device_id: 'dev-T1', business_date: '2026-10-17', status: 'open', opened_at: ago(5) },
    { id: 'd3', business_id: B, branch_id: BR, device_id: 'dev-T3', business_date: '2026-10-01', status: 'open', opened_at: ago(400) },
  ];
  mem.db.day_close_instructions = [
    { id: 'i-old', business_id: B, device_id: 'dev-T1', business_date: '2026-10-16', status: 'acked', created_at: ago(20), ack: { ok: true, already_closed: true } },
  ];
  await ok('"Day D+1 · Closed" is gone: yesterday\'s ack is not today\'s instruction', async () => {
    const r = await call('GET', '/api/day-close/overview', T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t1 = r.body.tills.find((t) => t.device_id === 'dev-T1');
    assert.equal(t1.instruction, null);
    assert.ok(t1.last_sync_at, 'its last sync is shown');
  });
  await ok('a retired till is never listed to close — only apart, as one to close as abandoned', async () => {
    const r = await call('GET', '/api/day-close/overview', T.mgr);
    assert.ok(!r.body.tills.some((t) => t.device_id === 'dev-T3'));
    assert.equal(r.body.retired_open_days[0].device_id, 'dev-T3'); assert.equal(r.body.retired_open_days[0].may_abandon, true);
  });
  await ok('every approved till is listed with its last sync (retired ones not)', async () => {
    const r = await call('GET', '/api/day-close/overview', T.mgr);
    const ids = r.body.devices.map((d) => d.device_id).sort();
    assert.deepEqual(ids, ['dev-S', 'dev-T1', 'dev-T2']);
    assert.equal(r.body.devices.find((d) => d.device_id === 'dev-T1').open_day, '2026-10-17');
    assert.ok('delivered_at' in r.body.devices[0]);
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Withdraw a pending close; close a dead till\'s day as abandoned\n');
  reset();
  await ok('a pending close is withdrawn (audited); a second withdraw is 409; a cashier cannot', async () => {
    await call('POST', '/api/day-close/instruct', T.mgr, { device_id: 'dev-T2', business_date: '2026-10-16' });
    const ins = mem.db.day_close_instructions[0];
    assert.equal((await call('POST', `/api/day-close/${ins.id}/cancel`, T.cash, {})).status, 403);
    const r = await call('POST', `/api/day-close/${ins.id}/cancel`, T.mgr, { reason: 'till broken' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(ins.status, 'cancelled');
    assert.ok(mem.db.audit_log.some((a) => a.action === 'day_close_cancelled' && a.business_id === B && a.user_id === MGR));
    assert.equal((await call('POST', `/api/day-close/${ins.id}/cancel`, T.mgr, {})).status, 409);
  });
  reset();
  mem.db.business_days = [{ id: DAY, business_id: B, branch_id: BR, device_id: 'dev-T2', business_date: '2026-10-15', status: 'open', opened_at: ago(60), notes: null }];
  mem.db.shifts = [{ id: SH, business_id: B, branch_id: BR, device_id: 'dev-T2', terminal_code: 'T2', business_day_id: DAY, status: 'open', opening_float: 1000, notes: null, cashier_id: CASH, opened_at: ago(59) }];
  mem.db.float_transactions = [{ id: 'f1', shift_id: SH, type: 'float_in', amount: 500 }];
  await ok('a till that synced lately is refused (TILL_NOT_SILENT); a reason and the tick are required', async () => {
    mem.db.business_days.push({ id: 'd-live', business_id: B, branch_id: BR, device_id: 'dev-T1', business_date: '2026-10-17', status: 'open' });
    const live = await call('POST', '/api/day-close/abandon', T.mgr, { device_id: 'dev-T1', reason: 'x', confirm: true });
    assert.equal(live.status, 409); assert.equal(live.body.code, 'TILL_NOT_SILENT');
    assert.equal((await call('POST', '/api/day-close/abandon', T.mgr, { device_id: 'dev-T2', confirm: true })).body.code, 'REASON_REQUIRED');
    assert.equal((await call('POST', '/api/day-close/abandon', T.mgr, { device_id: 'dev-T2', reason: 'broken' })).body.code, 'CONFIRM_REQUIRED');
    mem.db.business_days = mem.db.business_days.filter((d) => d.id !== 'd-live');
  });
  await ok('silent for 50 h: its day closes on the cloud, its drawer force-closed UNCOUNTED, a close queued for the till', async () => {
    const r = await call('POST', '/api/day-close/abandon', T.mgr, { device_id: 'dev-T2', reason: 'T2 power supply dead', confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sh = mem.db.shifts[0];
    assert.equal(sh.status, 'closed_unreconciled'); assert.equal(sh.close_method, 'forced');
    assert.strictEqual(sh.closing_float, null); assert.strictEqual(sh.cash_variance, null);
    assert.equal(sh.expected_cash, 1500);
    const day = mem.db.business_days[0];
    assert.equal(day.status, 'closed'); assert.strictEqual(day.counted_cash, null); assert.strictEqual(day.cash_variance, null);
    assert.equal(day.expected_cash, 1500); assert.match(day.notes, /abandoned[\s\S]*not in this close/);
    const queued = mem.db.day_close_instructions.find((i) => i.device_id === 'dev-T2');
    assert.equal(queued.status, 'pending'); assert.strictEqual(queued.payload.counted_cash, null);
    assert.ok(mem.db.notifications.some((n) => n.user_id === OWNER && n.type === 'day_closed_abandoned'));
    assert.ok(mem.db.audit_log.some((a) => a.action === 'day_closed_as_abandoned'));
  });
  await ok('the rule: retired or silent 24 h', () => {
    assert.equal(rules.mayAbandon({ retired_at: null, last_sync_at: ago(23) }), false);
    assert.equal(rules.mayAbandon({ retired_at: null, last_sync_at: ago(25) }), true);
    assert.equal(rules.mayAbandon({ retired_at: ago(1), last_sync_at: ago(0) }), true);
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n4. The till\'s own count after the web closed its drawer\n');
  reset();
  mem.db.shifts = [{ id: SH, business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', status: 'closed_unreconciled', close_method: 'forced',
    opening_float: 0, expected_cash: 2000, closing_float: null, cash_variance: null, notes: 'Force-closed by manager: off', opened_at: ago(10), till_counted_cash: null }];
  await ok('kept on the shift and the owner told — the 409 still answers (the till marks its close synced)', async () => {
    const r = await call('POST', `/api/shifts/${SH}/close`, T.till, { closing_float: 1950, closed_at: ago(9) }, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'ALREADY_CLOSED');
    assert.equal(r.body.till_count_recorded, true, 'A521: the till is told its count was kept');
    assert.equal(mem.db.shifts[0].till_counted_cash, 1950); assert.ok(mem.db.shifts[0].till_counted_at);
    assert.match(mem.db.shifts[0].notes, /T1 counted 1950/);
    const n = mem.db.notifications.find((x) => x.type === 'till_count_after_close');
    assert.ok(n && n.user_id === OWNER); assert.match(n.title, /T1 counted KES 1,950 after the web closed the drawer/);
  });
  await ok('sent again: kept once (no second notice); another till\'s replay is not kept', async () => {
    const again = await call('POST', `/api/shifts/${SH}/close`, T.till, { closing_float: 1950 }, { 'x-device-id': 'dev-T1' });
    assert.equal(again.body.till_count_recorded, true, 'the same count, kept earlier');
    assert.equal(mem.db.notifications.filter((x) => x.type === 'till_count_after_close').length, 1);
    mem.db.shifts[0].till_counted_cash = null;
    await call('POST', `/api/shifts/${SH}/close`, T.till2, { closing_float: 10 }, { 'x-device-id': 'dev-T2' });
    assert.strictEqual(mem.db.shifts[0].till_counted_cash, null);
  });
  await ok('the till\'s own close coming round again (the same count) is not news', async () => {
    mem.db.shifts[0] = { ...mem.db.shifts[0], status: 'closed', close_method: 'counted', closing_float: 1950, till_counted_cash: null };
    mem.db.notifications = [];
    const own = await call('POST', `/api/shifts/${SH}/close`, T.till, { closing_float: 1950 }, { 'x-device-id': 'dev-T1' });
    assert.strictEqual(mem.db.shifts[0].till_counted_cash, null); assert.equal(mem.db.notifications.length, 0);
    assert.equal(own.body.till_count_recorded, undefined, 'an ordinary lost-answer replay: nothing recorded');
  });
  await ok('a confirmation made on the till after the web confirmed: kept when it differs', async () => {
    mem.db.shifts[0] = { ...mem.db.shifts[0], confirmed_at: ago(1), confirmed_methods: { cash: 1950 }, till_confirmed_methods: null };
    const r = await call('POST', `/api/shifts/${SH}/confirm`, T.till, { confirmed_methods: { cash: 1900 }, confirmed_by: MGR }, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'ALREADY_CONFIRMED'); assert.equal(r.body.till_count_recorded, true);
    assert.deepEqual(mem.db.shifts[0].till_confirmed_methods, { cash: 1900 });
    assert.ok(mem.db.notifications.some((x) => x.type === 'till_confirm_after_close'));
  });
  await ok('the drawer list says when each till last synced', async () => {
    const r = await call('GET', '/api/shifts', T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body[0].till_last_sync_at); assert.equal(r.body[0].till_retired, false);
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n5. A web counted close past a dead till\'s unpaid kitchen orders\n');
  const openDrawer = () => {
    reset();
    mem.db.shifts = [{ id: SH2, business_id: B, branch_id: BR, device_id: 'dev-T2', terminal_code: 'T2', status: 'open', opening_float: 0, cashier_id: CASH, opened_by: CASH, opened_at: ago(30), notes: null }];
    mem.db.orders = [{ id: 'o-k', business_id: B, shift_id: SH2, status: 'open', order_number: 'T2-0042' }];
  };
  openDrawer();
  await ok('refused with the orders listed; a confirmer without close_day may not override', async () => {
    const r = await call('POST', `/api/shifts/${SH2}/close`, T.sup, { closing_float: 0, ack_unpaid: true });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'UNPAID_KITCHEN_ORDERS');
    assert.deepEqual(r.body.orders, ['T2-0042']); assert.equal(r.body.may_override, false);
    assert.equal(mem.db.shifts[0].status, 'open');
  });
  await ok('the owner / a close-day holder goes ahead with ack_unpaid — closed counted, noted, the orders stay open', async () => {
    const plain = await call('POST', `/api/shifts/${SH2}/close`, T.mgr, { closing_float: 0 });
    assert.equal(plain.status, 409); assert.equal(plain.body.may_override, true);
    const r = await call('POST', `/api/shifts/${SH2}/close`, T.mgr, { closing_float: 0, ack_unpaid: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mem.db.shifts[0].status, 'closed'); assert.match(mem.db.shifts[0].notes, /1 unpaid kitchen order still open \(#T2-0042\)/);
    assert.equal(mem.db.orders[0].status, 'open');
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n6. Late rows after a close\n');
  reset();
  mem.db.shifts = [{ id: SH, business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', status: 'closed', close_method: 'counted',
    opening_float: 1000, closing_float: 1000, expected_cash: 1000, cash_variance: 0, notes: null, closed_at: ago(2), opened_at: ago(10) }];
  await ok('a pay-out landing on a closed drawer: expected cash and the difference recomputed, noted, the owner told', async () => {
    const r = await call('POST', '/api/sync/push', T.till, { floats: [{ id: 'dddddddd-0000-4000-8000-000000000001', shift_id: SH, branch_id: BR, type: 'float_out', amount: 200, created_at: ago(3) }] }, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = mem.db.shifts[0];
    assert.equal(s.expected_cash, 800); assert.equal(s.cash_variance, 200);
    assert.match(s.notes, /Late rows after close: cash in \/ out .* moved from 1000 to 800/);
    assert.ok(mem.db.notifications.some((n) => n.type === 'late_rows_after_close' && n.user_id === OWNER));
  });
  await ok('the same push again changes nothing more (recomputed, never added twice)', async () => {
    mem.db.notifications = [];
    await call('POST', '/api/sync/push', T.till, { floats: [{ id: 'dddddddd-0000-4000-8000-000000000001', shift_id: SH, branch_id: BR, type: 'float_out', amount: 200, created_at: ago(3) }] }, { 'x-device-id': 'dev-T1' });
    assert.equal(mem.db.shifts[0].expected_cash, 800); assert.equal(mem.db.notifications.length, 0);
  });
  await ok('an expense on a force-closed drawer: expected moves, the difference stays NULL (nobody counted)', async () => {
    mem.db.shifts[0] = { ...mem.db.shifts[0], status: 'closed_unreconciled', close_method: 'forced', closing_float: null, cash_variance: null };
    const r = await call('POST', '/api/sync/push', T.till, { expenses: [{ id: 'eeeeeeee-0000-4000-8000-000000000001', shift_id: SH, branch_id: BR, description: 'gas', amount: 100, expense_date: '2026-10-17', payment_method: 'cash' }] }, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mem.db.shifts[0].expected_cash, 700); assert.strictEqual(mem.db.shifts[0].cash_variance, null);
  });
  await ok('an open drawer is left alone (it computes its figures when it closes)', async () => {
    mem.db.shifts[0] = { ...mem.db.shifts[0], status: 'open', expected_cash: null, notes: null };
    const { settleLateRows } = require(path.join(DIST, 'lib/lateRows.js'));
    assert.deepEqual(await settleLateRows(B, [SH], 'x'), []);
    assert.strictEqual(mem.db.shifts[0].expected_cash, null);
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n7. Test-data clears for a till off for months\n');
  reset();
  mem.db.test_data_purges = [{ id: 'p1', business_id: B, from_at: ago(24 * 100), to_at: ago(24 * 95), created_at: ago(24 * 90) }];
  await ok('a till off for 90 days still gets the clear after the last one it applied', async () => {
    const r = await call('GET', `/api/pos/test-data-clears?after=${encodeURIComponent(ago(24 * 120))}`, T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200); assert.deepEqual(r.body.map((c) => c.id), ['p1']);
  });
  await ok('a till that applied none yet keeps the 60-day floor (a new till never replays an old clear)', async () => {
    const r = await call('GET', '/api/pos/test-data-clears', T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.deepEqual(r.body, []);
  });

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n8. A stock count posted after the sale was rung\n');
  reset();
  mem.db.stock_takes = [{ id: 'st1', branch_id: BR, status: 'posted', posted_at: ago(1) }];
  mem.db.stock_take_lines = [
    { stock_take_id: 'st1', product_id: 'p-coke', ingredient_id: null, counted_at: ago(2), posted_at: ago(1) },
    { stock_take_id: 'st1', product_id: null, ingredient_id: 'i-oil', counted_at: ago(2), posted_at: ago(1) },
  ];
  await ok('the items counted after the sale are skipped; a live sale and an earlier count skip nothing', async () => {
    const s = await stockEffects.countedSinceSale(BR, ago(5));
    assert.ok(s.has('p:p-coke') && s.has('i:i-oil'));
    assert.equal((await stockEffects.countedSinceSale(BR, null)).size, 0);
    assert.equal((await stockEffects.countedSinceSale(BR, ago(1.5))).size, 0, 'rung after the count: taken off as usual');
    assert.equal((await stockEffects.countedSinceSale(BR2, ago(5))).size, 0, 'another branch');
  });
  await ok('…and the product deduction is not run for them', async () => {
    mem.db.products = [{ id: 'p-coke', business_id: B, track_stock: true, sold_by: 'each', is_fuel: false }];
    const rpcs = [];
    mem.rpc = async (name, args) => { rpcs.push({ name, args }); return { data: [{ quantity: 0 }], error: null }; };
    await stockEffects.applyStockEffects({ businessId: B, branchId: BR, orderId: 'o1', orderNumber: 'T1-9', orderType: 'takeaway', lines: [{ productId: 'p-coke', quantity: 2 }], soldAt: ago(5) });
    assert.ok(!rpcs.some((x) => x.name === 'adjust_product_stock'), JSON.stringify(rpcs));
    await stockEffects.applyStockEffects({ businessId: B, branchId: BR, orderId: 'o2', orderNumber: 'T1-10', orderType: 'takeaway', lines: [{ productId: 'p-coke', quantity: 2 }] });
    assert.ok(rpcs.some((x) => x.name === 'adjust_product_stock'), 'a live sale is taken off');
    mem.rpc = async () => ({ data: null, error: null });
  });

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n9. A branch server relays a change made on one of its tills\n');
  reset();
  const P1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  mem.db.products = [{ id: P1, business_id: B, name: 'Burger', base_price: 700, status: 'active' }];
  mem.db.refresh_tokens = [{ id: 'rt1', business_id: B, user_id: MGR, device_hint: 'dev-T1', session_kind: 'pin', created_at: ago(24 * 3) }];
  const chg = (data, base) => ({ id: crypto.randomUUID(), entity: 'product', op: 'update', entity_id: P1, data, base, made_by: MGR, made_by_name: 'Mary', made_at: new Date().toISOString() });
  await ok('the branch server\'s own session, the maker signed in on a till of its branch within 30 days: applied', async () => {
    const r = await call('POST', '/api/changes', T.srv, { changes: [chg({ base_price: 750 }, { base_price: 700 })] }, { 'x-device-id': 'dev-S' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results[0].status, 'applied', JSON.stringify(r.body.results[0]));
    assert.equal(mem.db.products[0].base_price, 750);
  });
  await ok('A521 relayed_for: the branch server names the till it was made on — recorded as the change\'s device', async () => {
    const c = chg({ base_price: 760 }, { base_price: 750 });
    const r = await call('POST', '/api/changes', T.srv, { changes: [c], relayed_for: 'dev-T1' }, { 'x-device-id': 'dev-S' });
    assert.equal(r.body.results[0].status, 'applied', JSON.stringify(r.body.results[0]));
    assert.equal(mem.db.change_requests.find((x) => x.id === c.id).device_id, 'dev-T1');
  });
  await ok('…not from a plain till, nor for a till of another branch, nor a device not on the fleet: the session\'s own id', async () => {
    mem.db.user_devices.push({ id: 'ud-k', business_id: B, device_id: 'dev-K', status: 'approved', branch_id: BR2, device_role: 'till' });
    const a = chg({ base_price: 761 }, { base_price: 760 });
    await call('POST', '/api/changes', T.till, { changes: [a], relayed_for: 'dev-T2' }, { 'x-device-id': 'dev-T1' });
    assert.equal(mem.db.change_requests.find((x) => x.id === a.id).device_id, 'dev-T1', 'a till is no branch server');
    const b = chg({ base_price: 762 }, { base_price: 761 });
    await call('POST', '/api/changes', T.srv, { changes: [b], relayed_for: 'dev-K' }, { 'x-device-id': 'dev-S' });
    assert.equal(mem.db.change_requests.find((x) => x.id === b.id).device_id, 'dev-S', 'another branch');
    const d = chg({ base_price: 763 }, { base_price: 762 });
    await call('POST', '/api/changes', T.srv, { changes: [d], relayed_for: 'dev-nowhere' }, { 'x-device-id': 'dev-S' });
    assert.equal(mem.db.change_requests.find((x) => x.id === d.id).device_id, 'dev-S', 'not a device of the business');
  });
  await ok('…a sign-in older than 30 days proves nothing: it waits for the owner', async () => {
    mem.db.refresh_tokens[0].created_at = ago(24 * 40);
    const r = await call('POST', '/api/changes', T.srv, { changes: [chg({ base_price: 800 }, { base_price: 763 })] }, { 'x-device-id': 'dev-S' });
    assert.equal(r.body.results[0].status, 'awaiting', JSON.stringify(r.body.results[0]));
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
