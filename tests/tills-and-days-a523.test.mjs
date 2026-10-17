// A523 — "Tills & days": the owner, a branch manager and ZapTill support close a till's day or drawer from the cloud.
// Owner, 2026-10-17: "I don't want this back and forth, clients not being able to do simple tasks day to day operations,
// to make it worse there is no location on the cloud where I can close day as the owner or tech support remote force
// close." Chose: the page for the owner (and managers, their branch), the same page in the admin portal (super admins
// AND agents), and the cloud wins — a close from the web takes effect at once; the till adopts it when it connects.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/tills-and-days-a523.test.mjs
//
// RUNS the COMPILED routers (tills-days, tillsDaysAdmin, day-close, sync) behind the REAL auth middleware (requireAuth,
// requireAdmin) over HTTP; the database in memory (tests/lib-memdb.mjs); the mailer stood in.
//
//   1 the overview: every till per branch (owner) / the manager's branch only; figures only to who may see them
//   2 close day: reason required, the branch, the silent tick, a drawer open (refused / the force tick), a shift to confirm
//   3 the cloud's close takes effect AT ONCE (the day closed in the cloud's DB, a close queued for the till), audited, the
//     owner told — and the till's later push is idempotent: never reopened before it adopts, one close after it does
//   4 drawers: force-close (uncounted) or a counted close; withdraw a stuck close (never one the web carried out);
//     close as abandoned
//   5 the admin portal: an agent and a super admin, the client's id, reason, admin audit + audit_log, the owner e-mailed,
//     super admins asked to verify an agent's action; an inactive admin refused; rate-limited
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-17, editing apps/server/dist):
//   - tillsDays.cloudCloseDay without the DRAWER_OPEN refusal               → "a drawer open: refused (DRAWER_OPEN)" fails
//   - mergeCloudClosedDays returning rows unchanged                          → "the till's open push never reopens it" fails
//   - tillsDays.cleanReason accepting an empty reason                        → "a reason is required" fails
//   - tills-days.ts actorOf giving a manager branchId null (every branch)    → "a manager of another branch is refused" fails
//   - tillsDaysAdmin afterAction without emailOwnerOfSupportAction           → "the owner is e-mailed" fails
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
if (!fs.existsSync(path.join(DIST, 'lib/tillsDays.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const TD = require(path.join(DIST, 'lib/tillsDays.js'));
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const sent = [];
mailer.sendEmailChecked = async (m) => { sent.push(m); return { ok: true, provider: 'none' }; };
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));

const B = '11111111-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-3333-4333-8333-333333333333';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MGR = 'aaaaaaaa-0000-4000-8000-000000000002',
  CASH = 'aaaaaaaa-0000-4000-8000-000000000003', MGR2 = 'aaaaaaaa-0000-4000-8000-000000000004', FO = 'aaaaaaaa-0000-4000-8000-000000000005';
const SH_OPEN = 'bbbbbbbb-0000-4000-8000-000000000001', SH_DONE = 'bbbbbbbb-0000-4000-8000-000000000002', SH_AW = 'bbbbbbbb-0000-4000-8000-000000000003',
  SH_T9 = 'bbbbbbbb-0000-4000-8000-000000000009';
const DAY1 = 'cccccccc-0000-4000-8000-000000000001', DAY2 = 'cccccccc-0000-4000-8000-000000000002', DAY5 = 'cccccccc-0000-4000-8000-000000000005',
  DAY9 = 'cccccccc-0000-4000-8000-000000000009';
const AG = 'eeeeeeee-0000-4000-8000-000000000001', SA = 'eeeeeeee-0000-4000-8000-000000000002', OFF = 'eeeeeeee-0000-4000-8000-000000000003',
  AG2 = 'eeeeeeee-0000-4000-8000-000000000004';
const perms = (...keys) => ({ name: 'Role', role_permissions: keys.map((key) => ({ permissions: { key } })) });
const person = (id, name, extra = {}) => ({ id, name, status: 'active', business_id: B, permissions_version: 0, user_permissions: [], user_branches: [], ...extra });
const ago = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const MGR_KEYS = ['orders.create', 'shifts.close_day', 'shifts.confirm', 'shifts.force_close', 'reports.shifts'];

const reset = () => {
  mem.fail = () => null; mem.calls = []; sent.length = 0;
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Krunch & Co', currency: 'KES', email: 'owner@krunch.test' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true }, { id: BR2, business_id: B, name: 'Kilimani', desktop_licensed: true }],
    users: [
      person(OWNER, 'Owner', { roles: { name: 'Admin' } }),
      person(MGR, 'Mary', { roles: perms(...MGR_KEYS) }),
      person(MGR2, 'Kim', { roles: perms(...MGR_KEYS) }),
      person(CASH, 'Joe', { roles: perms('orders.create') }),
      person(FO, 'Fred', { roles: perms('shifts.force_close') }),
    ],
    user_branches: [],
    user_devices: [
      { id: 'ud-1', business_id: B, device_id: 'dev-T1', terminal_code: 'T1', device_label: 'Front', status: 'approved', retired_at: null, branch_id: BR, last_sync_at: ago(0.01), app_version: '1.0.18' },
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', terminal_code: 'T2', device_label: 'Center', status: 'approved', retired_at: null, branch_id: BR, last_sync_at: ago(3), app_version: '1.0.15' },
      { id: 'ud-3', business_id: B, device_id: 'dev-T3', terminal_code: 'T3', status: 'approved', retired_at: ago(100), branch_id: BR, last_sync_at: ago(200) },
      { id: 'ud-5', business_id: B, device_id: 'dev-T5', terminal_code: 'T5', status: 'approved', retired_at: null, branch_id: BR, last_sync_at: ago(50) },
      { id: 'ud-9', business_id: B, device_id: 'dev-T9', terminal_code: 'T9', status: 'approved', retired_at: null, branch_id: BR2, last_sync_at: ago(0.01) },
      { id: 'ud-p', business_id: B, device_id: 'dev-P', terminal_code: 'P1', status: 'pending', retired_at: null, branch_id: BR, last_sync_at: null },
    ],
    business_days: [
      { id: DAY1, business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', business_date: '2026-10-15', opened_at: ago(50), status: 'open', notes: null },
      { id: DAY2, business_id: B, branch_id: BR, device_id: 'dev-T2', terminal_code: 'T2', business_date: '2026-10-16', opened_at: ago(30), status: 'open', notes: null },
      { id: DAY5, business_id: B, branch_id: BR, device_id: 'dev-T5', terminal_code: 'T5', business_date: '2026-10-14', opened_at: ago(70), status: 'open', notes: null },
      { id: DAY9, business_id: B, branch_id: BR2, device_id: 'dev-T9', terminal_code: 'T9', business_date: '2026-10-16', opened_at: ago(30), status: 'open', notes: null },
    ],
    shifts: [
      // T1's day: one drawer closed and confirmed (cash 3,400 confirmed of 3,500 expected)
      { id: SH_DONE, business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', cashier_id: CASH, status: 'closed', opened_at: ago(49), closed_at: ago(41),
        opening_float: 2500, business_day_id: DAY1, expected_cash: 3500, closing_float: 3450, confirmed_methods: { cash: 3400 }, confirmed_at: ago(40), declared_methods: { cash: 3450 }, notes: null },
      // T2's day: a drawer still open
      { id: SH_OPEN, business_id: B, branch_id: BR, device_id: 'dev-T2', terminal_code: 'T2', cashier_id: CASH, status: 'open', opened_at: ago(29),
        opening_float: 1000, business_day_id: DAY2, notes: null },
      // T9's day (the other branch): a shift waiting for a manager
      { id: SH_AW, business_id: B, branch_id: BR2, device_id: 'dev-T9', terminal_code: 'T9', cashier_id: CASH, status: 'closed', opened_at: ago(29), closed_at: ago(20),
        opening_float: 500, business_day_id: DAY9, expected_cash: 900, closing_float: 900, confirmed_at: null, declared_methods: { cash: 900 }, notes: null },
    ],
    orders: [], payments: [], float_transactions: [], expenses: [], notifications: [], audit_log: [], day_close_instructions: [],
    admin_users: [
      { id: AG, email: 'agent@zaptill.test', role: 'agent', is_active: true },
      { id: AG2, email: 'agent2@zaptill.test', role: 'agent', is_active: true },
      { id: SA, email: 'boss@zaptill.test', role: 'super_admin', is_active: true },
      { id: OFF, email: 'gone@zaptill.test', role: 'agent', is_active: false },
    ],
    admin_audit_log: [], business_settings: [], branch_settings: [], feature_flags: [], refresh_tokens: [], kitchen_tickets: [],
  };
  adminAuth.forgetAdmin();
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.set('trust proxy', false);
app.use(express.json());
for (const [mount, file] of [['tills-days', 'tills-days'], ['admin/tills-days', 'tillsDaysAdmin'], ['day-close', 'day-close'], ['sync', 'sync']]) {
  app.use(`/api/${mount}`, require(path.join(DIST, `routes/${file}.js`)).default);
}
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  mgr: sign({ userId: MGR, permissionKeys: MGR_KEYS, surface: 'dashboard' }),
  mgr2: sign({ userId: MGR2, branchId: BR2, permissionKeys: MGR_KEYS, surface: 'dashboard' }),
  fo: sign({ userId: FO, permissionKeys: ['shifts.force_close'], surface: 'dashboard' }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create'], surface: 'pos' }),
  till1: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const A = {
  agent: adminAuth.signAdminToken({ adminId: AG, email: 'agent@zaptill.test', role: 'agent' }),
  agent2: adminAuth.signAdminToken({ adminId: AG2, email: 'agent2@zaptill.test', role: 'agent' }),
  sa: adminAuth.signAdminToken({ adminId: SA, email: 'boss@zaptill.test', role: 'super_admin' }),
  off: adminAuth.signAdminToken({ adminId: OFF, email: 'gone@zaptill.test', role: 'agent' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tick = () => new Promise((r) => setTimeout(r, 30));
const day = (id) => mem.db.business_days.find((d) => d.id === id);
const shift = (id) => mem.db.shifts.find((s) => s.id === id);
const pendingFor = (dev) => mem.db.day_close_instructions.filter((i) => i.device_id === dev && i.status === 'pending');

try {
  state._setPermissionsMigrated(true);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n1. The overview — every till, its day, its drawers, what waits\n');
  reset();
  await ok('the owner sees every approved till of every branch (a till awaiting approval is not one), with branch, version and last sync', async () => {
    const r = await call('GET', '/api/tills-days/overview', T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.tills.map((t) => t.device_id).sort();
    assert.deepEqual(ids, ['dev-T1', 'dev-T2', 'dev-T3', 'dev-T5', 'dev-T9']);
    const t2 = r.body.tills.find((t) => t.device_id === 'dev-T2');
    assert.equal(t2.branch_name, 'Westlands'); assert.equal(t2.app_version, '1.0.15'); assert.equal(t2.silent, true); assert.equal(t2.long_silent, false);
    assert.equal(t2.open_days[0].business_date, '2026-10-16');
    assert.equal(t2.open_drawers[0].cashier_name, 'Joe'); assert.equal(t2.open_drawers[0].opening_float, 1000);
    assert.equal(t2.open_drawers[0].expected_cash, 1000, 'the owner sees what the drawer expects so far');
    assert.equal(r.body.tills.find((t) => t.device_id === 'dev-T3').retired, true);
    assert.equal(r.body.tills.find((t) => t.device_id === 'dev-T5').may_abandon, true);
    assert.equal(r.body.tills.find((t) => t.device_id === 'dev-T9').awaiting[0].id, SH_AW);
    assert.deepEqual(r.body.may, { close_day: true, force_close: true });
  });
  await ok('a manager sees their own branch only (Kilimani\'s T9 is not on it)', async () => {
    const r = await call('GET', '/api/tills-days/overview', T.mgr);
    assert.equal(r.status, 200);
    assert.ok(r.body.tills.every((t) => t.branch_id === BR), JSON.stringify(r.body.tills.map((t) => t.device_id)));
    assert.ok(!r.body.tills.some((t) => t.device_id === 'dev-T9'));
    assert.deepEqual(r.body.branches.map((b) => b.id), [BR]);
  });
  await ok('a holder of force_close alone sees the page without figures (expected so far is null)', async () => {
    const r = await call('GET', '/api/tills-days/overview', T.fo);
    assert.equal(r.status, 200);
    assert.strictEqual(r.body.tills.find((t) => t.device_id === 'dev-T2').open_drawers[0].expected_cash, null);
    assert.equal(r.body.sees_figures, false); assert.deepEqual(r.body.may, { close_day: false, force_close: true });
  });
  await ok('a cashier and a till\'s own session are refused', async () => {
    assert.equal((await call('GET', '/api/tills-days/overview', T.cash)).status, 403);
    assert.equal((await call('GET', '/api/tills-days/overview', T.till1, undefined, { 'x-device-id': 'dev-T1' })).status, 403);
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n2. Close day — what it asks for, and what it refuses\n');
  reset();
  await ok('a reason is required (REASON_REQUIRED) — nothing closes', async () => {
    for (const reason of [undefined, '', '   ']) {
      const r = await call('POST', '/api/tills-days/close-day', T.mgr, { device_id: 'dev-T1', reason });
      assert.equal(r.status, 400); assert.equal(r.body.code, 'REASON_REQUIRED');
    }
    assert.equal(day(DAY1).status, 'open');
  });
  await ok('a manager of another branch is refused (403); a cashier too', async () => {
    assert.equal((await call('POST', '/api/tills-days/close-day', T.mgr2, { device_id: 'dev-T1', reason: 'x' })).status, 403);
    assert.equal((await call('POST', '/api/tills-days/close-day', T.cash, { device_id: 'dev-T1', reason: 'x' })).status, 403);
    assert.equal((await call('POST', '/api/tills-days/close-day', T.fo, { device_id: 'dev-T1', reason: 'x' })).status, 403, 'force_close alone does not close a day');
    assert.equal(day(DAY1).status, 'open');
  });
  await ok('a silent till asks for the tick first (SILENT_CONFIRM_REQUIRED, with its last sync)', async () => {
    shift(SH_OPEN).status = 'closed'; shift(SH_OPEN).expected_cash = 1000; shift(SH_OPEN).closing_float = 1000; shift(SH_OPEN).closed_at = ago(5);
    const r = await call('POST', '/api/tills-days/close-day', T.mgr, { device_id: 'dev-T2', reason: 'went home' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'SILENT_CONFIRM_REQUIRED'); assert.ok(r.body.last_sync_at);
    assert.match(r.body.error, /T2 last synced 3 h ago/);
    assert.equal(day(DAY2).status, 'open');
    shift(SH_OPEN).status = 'open'; shift(SH_OPEN).closed_at = null;
  });
  await ok('a drawer open: refused (DRAWER_OPEN) naming it — nothing force-closed, the day open', async () => {
    const r = await call('POST', '/api/tills-days/close-day', T.mgr, { device_id: 'dev-T2', reason: 'went home', silent_ok: true });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'DRAWER_OPEN');
    assert.equal(r.body.drawers[0].cashier_name, 'Joe'); assert.match(r.body.error, /force-close the open drawer first/);
    assert.equal(shift(SH_OPEN).status, 'open'); assert.equal(day(DAY2).status, 'open');
  });
  await ok('…with the second tick the drawer is force-closed uncounted first, then the day closes', async () => {
    const r = await call('POST', '/api/tills-days/close-day', T.mgr, { device_id: 'dev-T2', reason: 'T2 off, cashier gone', silent_ok: true, force_drawers: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.drawers_force_closed, [SH_OPEN]);
    const s = shift(SH_OPEN);
    assert.equal(s.status, 'closed_unreconciled'); assert.strictEqual(s.closing_float, null); assert.strictEqual(s.cash_variance, null);
    assert.match(s.notes, /^Force-closed by manager: T2 off, cashier gone/m, 'the reason in the form the till reads (remoteShiftClose)');
    assert.equal(day(DAY2).status, 'closed');
    assert.equal(day(DAY2).expected_cash, 1000); assert.equal(day(DAY2).counted_cash, 0, 'nothing confirmed — the confirmed counts are 0');
  });
  await ok('a shift waiting for a manager: refused (SHIFTS_UNCONFIRMED) — confirm it on the web first', async () => {
    const r = await call('POST', '/api/tills-days/close-day', T.owner, { device_id: 'dev-T9', reason: 'end of day' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'SHIFTS_UNCONFIRMED'); assert.equal(r.body.shifts[0].id, SH_AW);
    assert.equal(day(DAY9).status, 'open');
  });
  await ok('a retired till: refused (TILL_RETIRED — close it as abandoned); a negative count refused', async () => {
    mem.db.business_days.push({ id: 'cccccccc-0000-4000-8000-000000000003', business_id: B, branch_id: BR, device_id: 'dev-T3', business_date: '2026-10-10', status: 'open' });
    const r = await call('POST', '/api/tills-days/close-day', T.owner, { device_id: 'dev-T3', reason: 'x', silent_ok: true });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'TILL_RETIRED');
    assert.equal((await call('POST', '/api/tills-days/close-day', T.owner, { device_id: 'dev-T1', reason: 'x', counted_cash: -1 })).status, 400);
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n3. The cloud\'s close takes effect at once; the till\'s later close is the same close\n');
  reset();
  let closedAt;
  await ok('closed on the cloud NOW: closed_at, closed_by, the note, counted = the confirmed shift counts, expected = the drawers\'', async () => {
    const r = await call('POST', '/api/tills-days/close-day', T.mgr, { device_id: 'dev-T1', reason: 'T1 locked on the 15th' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = day(DAY1);
    assert.equal(d.status, 'closed'); assert.equal(d.closed_by, MGR); assert.ok(d.closed_at);
    assert.equal(d.counted_cash, 3400); assert.equal(d.expected_cash, 3500); assert.equal(d.cash_variance, -100);
    assert.match(d.notes, /Closed on the web by Mary: T1 locked on the 15th\. Counted: the confirmed shift counts/);
    assert.equal(r.body.counted_from, 'confirmed_shifts');
    closedAt = d.closed_at;
  });
  await ok('…and a close is queued for the till: the web\'s close (cloud_closed), waiting for it, counted_cash null', async () => {
    const [i] = pendingFor('dev-T1');
    assert.ok(i, 'queued');
    assert.equal(i.business_date, '2026-10-15'); assert.strictEqual(i.payload.counted_cash, null);
    assert.equal(i.payload.wait_for_till, true); assert.equal(i.payload.cloud_closed.counted_cash, 3400); assert.equal(i.payload.closed_by_staff_id, MGR);
  });
  await ok('audited (audit_log, with the reason) and the owner told', async () => {
    const a = mem.db.audit_log.find((x) => x.action === 'tills_days.close_day');
    assert.ok(a); assert.equal(a.after_data.reason, 'T1 locked on the 15th'); assert.equal(a.user_id, MGR); assert.equal(a.record_id, DAY1);
    const n = mem.db.notifications.find((x) => x.type === 'day_closed_on_web');
    assert.ok(n); assert.equal(n.user_id, OWNER); assert.match(n.title, /T1: trading day 2026-10-15 closed on the web/); assert.equal(n.link, '/dashboard/tills-days');
  });
  await ok('the owner acting themselves is not notified of their own close', async () => {
    mem.db.notifications = [];
    shift(SH_AW).confirmed_at = ago(1);
    const r = await call('POST', '/api/tills-days/close-day', T.owner, { device_id: 'dev-T9', reason: 'end of day', counted_cash: 950 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(day(DAY9).counted_cash, 950); assert.equal(r.body.counted_from, 'count_entered');
    assert.equal(mem.db.notifications.length, 0);
  });
  const push = (row) => call('POST', '/api/sync/push', T.till1, { business_days: [row] }, { 'x-device-id': 'dev-T1' });
  const tillRow = (o) => ({ id: DAY1, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', business_date: '2026-10-15', opened_at: day(DAY1).opened_at,
    opened_by: CASH, closed_at: null, closed_by: null, status: 'open', counted_cash: null, expected_cash: null, cash_variance: null, notes: null, ...o });
  await ok('the till\'s open push (it has not adopted the close yet) never reopens the day', async () => {
    const r = await push(tillRow({}));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = day(DAY1);
    assert.equal(d.status, 'closed'); assert.equal(d.closed_at, closedAt); assert.equal(d.counted_cash, 3400);
    assert.match(d.notes, /Closed on the web by Mary/);
  });
  await ok('the till\'s own close of the same day (adopted): ONE close — the web\'s time and closer, the till\'s figures, both notes', async () => {
    const r = await push(tillRow({ status: 'closed', closed_at: new Date(Date.now() + 60_000).toISOString(), closed_by: MGR,
      counted_cash: 3400, expected_cash: 3650, cash_variance: -250, notes: 'Closed on the web by Mary — this till adopted the web\'s close.' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mem.db.business_days.filter((d) => d.id === DAY1).length, 1, 'one row');
    const d = day(DAY1);
    assert.equal(d.status, 'closed'); assert.equal(d.closed_at, closedAt, 'the web\'s close time stands'); assert.equal(d.closed_by, MGR);
    assert.equal(d.expected_cash, 3650, 'the till\'s own books (an offline sale in)'); assert.equal(d.cash_variance, -250);
    assert.match(d.notes, /this till adopted/); assert.match(d.notes, /Closed on the web by Mary: T1 locked on the 15th/);
  });
  await ok('the till acks: the close is retired; a later reopen for a new shift (A364) is the till\'s own and goes through', async () => {
    const [i] = pendingFor('dev-T1');
    const a = await call('POST', '/api/day-close/ack', T.till1, { instruction_id: i.id, ok: true, summary: { closedDate: '2026-10-15' } }, { 'x-device-id': 'dev-T1' });
    assert.equal(a.status, 200); assert.equal(pendingFor('dev-T1').length, 0);
    const r = await push(tillRow({ notes: 'Reopened for a new shift.' }));
    assert.equal(r.status, 200); assert.equal(day(DAY1).status, 'open');
  });
  await ok('a day the web never closed is untouched by the merge (an ordinary close from the till lands as sent)', async () => {
    const rows = [{ id: DAY5, device_id: 'dev-T5', business_date: '2026-10-14', status: 'closed', closed_at: 'x', closed_by: null, counted_cash: 1, expected_cash: 1, cash_variance: 0, notes: 'n' }];
    const out = await TD.mergeCloudClosedDays(B, rows, [{ id: DAY5, status: 'closed', closed_at: 'y', notes: 'other' }]);
    assert.deepEqual(out, rows);
  });
  await ok('the till\'s ack of "not yet" carries the code (DRAWER_OPEN) — the close keeps waiting', async () => {
    const r = await call('POST', '/api/tills-days/close-day', T.mgr, { device_id: 'dev-T1', reason: 'again', business_date: '2026-10-15' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [i] = pendingFor('dev-T1');
    const a = await call('POST', '/api/day-close/ack', T.till1, { instruction_id: i.id, ok: false, error: 'something new', code: 'DRAWER_OPEN', wait: true }, { 'x-device-id': 'dev-T1' });
    assert.equal(a.status, 200); assert.equal(a.body.waiting, true); assert.equal(a.body.code, 'DRAWER_OPEN');
    assert.equal(pendingFor('dev-T1').length, 1);
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n4. Drawers, stuck closes, abandoned tills\n');
  reset();
  await ok('force-close a drawer: reason required; uncounted (no count, no difference); the till reads the reason', async () => {
    assert.equal((await call('POST', '/api/tills-days/close-drawer', T.fo, { shift_id: SH_OPEN, silent_ok: true })).body.code, 'REASON_REQUIRED');
    const s1 = await call('POST', '/api/tills-days/close-drawer', T.fo, { shift_id: SH_OPEN, reason: 'cashier left' });
    assert.equal(s1.status, 409); assert.equal(s1.body.code, 'SILENT_CONFIRM_REQUIRED');
    const r = await call('POST', '/api/tills-days/close-drawer', T.fo, { shift_id: SH_OPEN, reason: 'cashier left', silent_ok: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = shift(SH_OPEN);
    assert.equal(s.status, 'closed_unreconciled'); assert.equal(s.close_method, 'forced'); assert.strictEqual(s.closing_float, null); assert.equal(s.expected_cash, 1000);
    assert.match(s.notes, /^Force-closed by manager: cashier left\.$/m);
    assert.ok(mem.db.audit_log.some((a) => a.action === 'tills_days.force_close_drawer' && a.after_data.reason === 'cashier left'));
    assert.ok(mem.db.notifications.some((n) => n.type === 'drawer_closed_on_web'));
    assert.equal((await call('POST', '/api/tills-days/close-drawer', T.fo, { shift_id: SH_OPEN, reason: 'again', silent_ok: true })).body.code, 'ALREADY_CLOSED');
  });
  await ok('a counted close: closed, counted, the difference against the cloud\'s expected', async () => {
    reset();
    const r = await call('POST', '/api/tills-days/close-drawer', T.mgr, { shift_id: SH_OPEN, reason: 'counted at the safe', counted_cash: 950, silent_ok: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = shift(SH_OPEN);
    assert.equal(s.status, 'closed'); assert.equal(s.close_method, 'counted'); assert.equal(s.closing_float, 950); assert.equal(s.cash_variance, -50);
    assert.ok(mem.db.audit_log.some((a) => a.action === 'tills_days.count_close_drawer'));
  });
  await ok('another branch\'s drawer is refused to a manager', async () => {
    reset();
    shift(SH_AW).status = 'open';
    assert.equal((await call('POST', '/api/tills-days/close-drawer', T.mgr, { shift_id: SH_AW, reason: 'x' })).status, 403);
  });
  await ok('withdraw a stuck close: reason required, audited; never a close the web already carried out (CLOUD_CLOSED)', async () => {
    reset();
    mem.db.day_close_instructions.push({ id: 'ins-1', business_id: B, branch_id: BR, device_id: 'dev-T2', business_date: '2026-10-16', status: 'pending', payload: { counted_cash: null } });
    assert.equal((await call('POST', '/api/tills-days/instructions/ins-1/cancel', T.mgr, {})).body.code, 'REASON_REQUIRED');
    const r = await call('POST', '/api/tills-days/instructions/ins-1/cancel', T.mgr, { reason: 'stuck for days' });
    assert.equal(r.status, 200); assert.equal(mem.db.day_close_instructions[0].status, 'cancelled');
    assert.ok(mem.db.audit_log.some((a) => a.action === 'tills_days.cancel_close' && a.after_data.reason === 'stuck for days'));
    await call('POST', '/api/tills-days/close-day', T.mgr, { device_id: 'dev-T1', reason: 'r' });
    const web = pendingFor('dev-T1')[0];
    const c = await call('POST', `/api/tills-days/instructions/${web.id}/cancel`, T.mgr, { reason: 'oops' });
    assert.equal(c.status, 409); assert.equal(c.body.code, 'CLOUD_CLOSED'); assert.equal(pendingFor('dev-T1').length, 1);
  });
  await ok('close as abandoned: a 24-h-silent till (T5) yes — a live one (T1) no; the tick and the reason asked', async () => {
    reset();
    assert.equal((await call('POST', '/api/tills-days/abandon', T.mgr, { device_id: 'dev-T5', reason: 'broken' })).body.code, 'CONFIRM_REQUIRED');
    assert.equal((await call('POST', '/api/tills-days/abandon', T.mgr, { device_id: 'dev-T5', confirm: true })).body.code, 'REASON_REQUIRED');
    assert.equal((await call('POST', '/api/tills-days/abandon', T.mgr, { device_id: 'dev-T1', reason: 'x', confirm: true })).body.code, 'TILL_NOT_SILENT');
    const r = await call('POST', '/api/tills-days/abandon', T.mgr, { device_id: 'dev-T5', reason: 'T5 broken, replaced', confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(day(DAY5).status, 'closed');
    assert.ok(mem.db.audit_log.some((a) => a.action === 'tills_days.abandon'));
    const [q] = pendingFor('dev-T5');
    assert.equal(q.payload.cloud_closed?.abandoned, true, 'an abandoned close is a web close the till adopts (one close, never reopened by its push)');
    assert.equal((await call('POST', `/api/tills-days/instructions/${q.id}/cancel`, T.mgr, { reason: 'x' })).body.code, 'CLOUD_CLOSED');
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n5. The admin portal — support (agents and super admins)\n');
  reset();
  await ok('an agent reads the client\'s Tills & days (every branch, with figures); an inactive admin and a business token are refused', async () => {
    const r = await call('GET', `/api/admin/tills-days/${B}/overview`, A.agent);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.tills.some((t) => t.device_id === 'dev-T9') && r.body.tills.some((t) => t.device_id === 'dev-T1'));
    assert.equal(r.body.tills.find((t) => t.device_id === 'dev-T2').open_drawers[0].expected_cash, 1000);
    assert.equal((await call('GET', `/api/admin/tills-days/${B}/overview`, A.off)).status, 401);
    assert.equal((await call('GET', `/api/admin/tills-days/${B}/overview`, T.owner)).status, 401);
    assert.equal((await call('GET', '/api/admin/tills-days/not-an-id/overview', A.agent)).status, 400);
  });
  await ok('an agent closes T1\'s day: reason required; closed at once; admin audit + audit_log; the owner e-mailed; super admins asked to verify', async () => {
    assert.equal((await call('POST', `/api/admin/tills-days/${B}/close-day`, A.agent, { device_id: 'dev-T1' })).body.code, 'REASON_REQUIRED');
    sent.length = 0;
    const r = await call('POST', `/api/admin/tills-days/${B}/close-day`, A.agent, { device_id: 'dev-T1', reason: 'client called, T1 locked' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await tick();
    assert.equal(day(DAY1).status, 'closed'); assert.strictEqual(day(DAY1).closed_by, null, 'support is not a person of the business');
    assert.match(day(DAY1).notes, /Closed on the web by ZapTill support \(agent@zaptill\.test\): client called, T1 locked/);
    const aa = mem.db.admin_audit_log.find((x) => x.action === 'tills_days.close_day');
    assert.ok(aa); assert.equal(aa.admin_id, AG); assert.equal(aa.business_id, B); assert.equal(aa.reason, 'client called, T1 locked');
    const al = mem.db.audit_log.find((x) => x.action === 'tills_days.close_day');
    assert.ok(al); assert.equal(al.user_name, 'ZapTill support (agent@zaptill.test)'); assert.equal(al.after_data.support.role, 'agent');
    const owner = sent.find((m) => m.to === 'owner@krunch.test');
    assert.ok(owner, JSON.stringify(sent.map((m) => m.to)));
    assert.equal(owner.subject, 'ZapTill support closed T1\'s day for 2026-10-15 — reason: client called, T1 locked');
    assert.equal(r.body.owner_emailed, true);
    assert.ok(sent.some((m) => m.to === 'boss@zaptill.test' && /please verify/.test(m.subject)), 'the super admins hear of an agent\'s action');
    assert.ok(mem.db.notifications.some((n) => n.type === 'day_closed_on_web' && n.user_id === OWNER), 'and the owner sees it in the app');
  });
  await ok('a super admin force-closes a drawer: done, the owner e-mailed, no "please verify"', async () => {
    sent.length = 0;
    const r = await call('POST', `/api/admin/tills-days/${B}/close-drawer`, A.sa, { shift_id: SH_OPEN, reason: 'T2 dead', silent_ok: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await tick();
    assert.equal(shift(SH_OPEN).status, 'closed_unreconciled');
    assert.ok(sent.some((m) => m.to === 'owner@krunch.test' && /^ZapTill support force-closed Joe's drawer on T2 — reason: T2 dead$/.test(m.subject)), JSON.stringify(sent.map((m) => m.subject)));
    assert.ok(!sent.some((m) => /please verify/.test(m.subject)));
  });
  await ok('support closes a dead till\'s day as abandoned, and withdraws a stuck close (both audited)', async () => {
    const r = await call('POST', `/api/admin/tills-days/${B}/abandon`, A.agent, { device_id: 'dev-T5', reason: 'T5 replaced', confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    mem.db.day_close_instructions.push({ id: 'ins-9', business_id: B, branch_id: BR2, device_id: 'dev-T9', business_date: '2026-10-16', status: 'pending', payload: {} });
    const c = await call('POST', `/api/admin/tills-days/${B}/instructions/ins-9/cancel`, A.agent, { reason: 'stuck' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.ok(mem.db.admin_audit_log.some((x) => x.action === 'tills_days.abandon') && mem.db.admin_audit_log.some((x) => x.action === 'tills_days.cancel_close'));
  });
  await ok('rate-limited per admin: past 30 actions in 10 minutes → 429 (another admin unaffected)', async () => {
    let last;
    for (let n = 0; n < 31; n++) last = await call('POST', `/api/admin/tills-days/${B}/close-day`, A.agent2, { device_id: 'dev-T1' });
    assert.equal(last.status, 429); assert.equal(last.body.code, 'RATE_LIMITED');
    assert.equal((await call('POST', `/api/admin/tills-days/${B}/close-day`, A.sa, { device_id: 'dev-T1' })).status, 400);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
