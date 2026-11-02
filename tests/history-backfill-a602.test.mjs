/**
 * history-backfill-a602.test.mjs — A602: "going online later", the cloud's side — POST /api/sync/backfill.
 *
 * Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 6, final): new sales first; the history as a bulk backfill
 * in quiet hours, back as far as the owner chooses; interruptions safe. One call carries up to 500 sales (gzip'd) and the
 * drawers / days they need; the cloud writes them through the SAME handlers as the normal push (/api/sync/push for the
 * cash rows, /api/orders for each sale) and answers each sale accepted / duplicate / waiting / refused / later.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/history-backfill-a602.test.mjs
 *
 * RUNS the COMPILED server — routes/index.js behind the REAL requireAuth (A581's lock and A601's cut live there), with
 * the backfill's own body parser (lib/backfill.js, as index.ts mounts it) before the app's 1 MB one — over HTTP on the
 * in-memory database (tests/lib-memdb.mjs; create_order_atomic as migration 115: the legs must reconcile).
 *   1 the rules: the answer of each sale, the body's checks, the pool's time budget
 *   2 accepted: a gzip'd batch with its drawer and day — the sales, the drawer, the day on the cloud; one call, one line
 *   3 idempotent: the same batch again → every sale a duplicate, nothing written twice; a sale the normal push already
 *     sent is a duplicate too (the order id is the idempotency key, both ways)
 *   4 the same rules as the normal push: each body answered exactly as POST /api/orders answers it (refused for its
 *     fields, its drawer of another branch, a drawer not on the cloud → waiting 424 shift_not_synced) — side by side
 *   5 refused: the backup off (A601's cut, 503 CLOUD_BACKUP_OFF), locked (A581, 503 CLOUD_SUBSCRIPTION_ENDED), not a POS
 *     (403 TILL_ONLY); the cash rows' passing refusal (503 SYNC_RETRY) is the whole call's, no sale tried
 *   6 limits: 500 sales a call (501 → 413 BACKFILL_TOO_MANY); a body over the app's 1 MB goes (12 MB inflated), and over
 *     12 MB inflated (a small gzip) is refused; plain JSON works too
 *   7 the gates know the path: A601's backup writes, A159's till writes
 *
 * MUTATIONS TO CONFIRM BITE (each made in src, rebuilt, seen to fail, reverted — 2026-10-28):
 *   - lib/backfill.ts classifySaleAnswer without the 424 → waiting line          → 3 fail (1 the answers, 4 side by side, 4 "waits")
 *   - routes/backfill.ts without the /api/sync/push handler for the cash rows    → 10 fail (2 accepted, 3 idempotent …)
 *   - lib/backfill.ts BACKFILL_JSON_LIMIT back to '1mb'                           → 2 fail (6 "over 1 MB goes", 6 the limit)
 *   - lib/backfill.ts readBackfillBody without the 500 cap                        → 2 fail (1 the body, 6 "501 sales")
 *   - routes/backfill.ts ignoring the batch look-up (every sale "known new")      → 1 fail (3 "the same batch again")
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const out = console.log.bind(console);
const ok = async (n, f) => { try { await f(); pass++; out(`PASS  ${n}`); } catch (e) { fail++; out(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/backfill.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
delete process.env.DESKTOP_ONLY_CUTOFF_AT; delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.RESEND_API_KEY; delete process.env.SENDGRID_API_KEY; delete process.env.SMTP_HOST;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
supabase.auth.admin.getUserById = async () => ({ data: null, error: { message: 'no user' } });
const BF = require(path.join(DIST, 'lib/backfill.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const TW = require(path.join(DIST, 'lib/terminalWrites.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const uuid = () => crypto.randomUUID();
const D = '11111111-1111-4111-8111-1111111111d1', LK = '11111111-1111-4111-8111-1111111111c1';
const BR = '22222222-2222-4222-8222-2222222222d1', BR2 = '22222222-2222-4222-8222-2222222222d2', BRL = '22222222-2222-4222-8222-2222222222c1';
const CASH = 'cccccccc-0000-4000-8000-000000000001';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
let rpcCalls = 0;
const reset = () => {
  mem.fail = () => null; mem.latency = () => 0; mem.rowCap = Infinity; mem.calls = [];
  const now = Date.now();
  mem.db = {
    businesses: [
      { id: D, name: 'Desktop Fries', owner_id: 'owner-d', status: 'active', currency: 'KES', vat_rate: 16, ctl_rate: 0, type: 'restaurant', web_access_expires_at: null, created_at: '2026-01-01T00:00:00Z' },
      { id: LK, name: 'Locked Duka', owner_id: 'owner-l', status: 'active', currency: 'KES', vat_rate: 16, ctl_rate: 0, type: 'retail', web_access_expires_at: iso(now - 30 * DAY), created_at: '2026-01-01T00:00:00Z' },
    ],
    branches: [{ id: BR, business_id: D, name: 'Main', status: 'active', desktop_licensed: true }, { id: BR2, business_id: D, name: 'Second', status: 'active', desktop_licensed: true },
      { id: BRL, business_id: LK, name: 'Main', status: 'active', desktop_licensed: true }],
    cloud_plans: [{ business_id: LK, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: 'boss', created_at: iso(now - 90 * DAY) }],
    feature_flags: [{ business_id: LK, key: 'web_hosting', enabled: true }],
    business_settings: [], branch_settings: [], cloud_payments: [], invoices: [], cloud_plan_reminders: [],
    users: [{ id: CASH, business_id: D, name: 'Cate', status: 'active', permissions_version: 0, user_branches: [] }],
    user_devices: [{ id: 'ud-1', business_id: D, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, device_role: 'till' },
      { id: 'ud-2', business_id: LK, device_id: 'dev-L1', status: 'approved', retired_at: null, branch_id: BRL, device_role: 'till' }],
    products: [{ id: P1, business_id: D, name: 'Chips', base_price: 200, category_id: null, status: 'active' }],
    variant_groups: [], modifier_groups: [], branch_prices: [], change_requests: [], order_items: [], payments: [], orders: [], customers: [],
    order_price_variances: [], kitchen_tickets: [], shifts: [], business_days: [], float_transactions: [], expenses: [], kitchen_voids: [],
    stock_levels: [], stock_movements: [], offers: [], promotions: [], roles: [], role_permissions: [], permissions: [], user_permissions: [],
  };
  AC._resetAuthCache?.(); CP._resetStanding?.();
};
mem.rpc = async (fn, args) => {
  if (fn !== 'create_order_atomic') return { data: null, error: null };
  rpcCalls++;
  const o = args.p_order;
  const due = Number(o.total) + Number(o.tip_amount || 0) + (o.delivery_free ? 0 : Number(o.delivery_fee || 0));
  const paid = args.p_payments.reduce((s, l) => s + Number(l.amount), 0);
  if (Math.abs(paid - due) > 0.005) return { data: null, error: { code: 'P0001', message: `payment legs sum to ${paid} but the amount due is ${due}` } };
  if (mem.db.orders.some((x) => x.business_id === o.business_id && x.idempotency_key === o.idempotency_key)) return { data: null, error: { code: '23505', message: 'duplicate key orders_idempotency' } };
  const id = uuid();
  mem.db.orders.push({ id, ...o, status: 'completed' });
  for (const it of args.p_items) mem.db.order_items.push({ id: uuid(), order_id: id, ...it.item });
  for (const p of args.p_payments) mem.db.payments.push({ id: uuid(), order_id: id, ...p });
  return { data: [{ order_id: id, order_number: o.order_number }], error: null };
};

const express = require('express');
const app = express();
app.use('/api/sync/backfill', BF.backfillBodyParser);   // as index.ts: before the app's 1 MB parser
app.use(express.json({ limit: '1mb' }));
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
app.use((err, _req, res, _next) => res.status(err?.type === 'entity.too.large' ? 413 : 500).json({ error: String(err?.message ?? err), type: err?.type ?? null }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const tillTok = (biz, br, dev) => jwt.sign({ userId: null, deviceId: dev, till: true, businessId: biz, branchId: br, isOwner: false,
  permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const TILL = tillTok(D, BR, 'dev-T1'), TILL_LK = tillTok(LK, BRL, 'dev-L1');
const WEB = jwt.sign({ userId: CASH, businessId: D, branchId: BR, isOwner: false, permissionKeys: ['orders.create'], permissionsVersion: 0, sessionId: 's', surface: 'dashboard' },
  process.env.JWT_SECRET, { expiresIn: '5m' });
const raw = async (p, token, buf, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': 'dev-T1', ...headers }, body: buf });
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body, text, retry: r.headers.get('retry-after') };
};
const backfill = (token, payload, { gzip = true } = {}) => raw('/api/sync/backfill', token,
  gzip ? zlib.gzipSync(Buffer.from(JSON.stringify(payload))) : JSON.stringify(payload), gzip ? { 'content-encoding': 'gzip' } : {});
const pushOrder = (token, id, body) => raw('/api/orders', token, JSON.stringify(body), { 'x-idempotency-key': id });

// What a POS queues: its /api/orders body (syncEngine sync_queue.payload).
const DAYID = uuid(), SHIFT = uuid();
const day = () => ({ id: DAYID, business_id: D, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', business_date: '2025-11-02',
  opened_at: '2025-11-02T06:00:00Z', opened_by: CASH, closed_at: '2025-11-02T20:00:00Z', closed_by: CASH, status: 'closed', counted_cash: 400, expected_cash: 400, cash_variance: 0, notes: null });
const shift = () => ({ id: SHIFT, business_id: D, branch_id: BR, cashier_id: CASH, opened_at: '2025-11-02T06:05:00Z', closed_at: '2025-11-02T19:55:00Z',
  status: 'closed', opening_float: 0, closing_float: 400, expected_cash: 400, cash_variance: 0, notes: null, created_at: '2025-11-02T06:05:00Z',
  business_day_id: DAYID, business_date: '2025-11-02', device_id: 'dev-T1', terminal_code: 'T1', drawer_label: null, opened_by: CASH });
let seq = 0;
const sale = (extra = {}) => {
  seq++;
  return { branch_id: BR, order_number: `T1-${seq}`, order_type: 'retail', created_at: `2025-11-02T${String(8 + (seq % 10)).padStart(2, '0')}:00:00Z`,
    shift_id: SHIFT, device_id: 'dev-T1', cashier_id: CASH, items: [{ product: { id: P1, name: 'Chips' }, quantity: 1, unitPrice: 200, lineTotal: 200 }],
    subtotal: 200, total: 200, payments: [{ method: 'cash', amount: 200, status: 'completed' }], ...extra };
};
const logs = async (fn) => {
  const lines = []; const l = console.log, w = console.warn, e = console.error;
  console.log = (...a) => lines.push(a.join(' ')); console.warn = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push(a.join(' '));
  try { return { r: await fn(), lines }; } finally { console.log = l; console.warn = w; console.error = e; }
};

console.log = () => {}; console.warn = () => {}; console.error = () => {};   // the server's lines (tests capture them with logs())
try {
  state._setPermissionsMigrated(true);
  reset();

  out('\n1. The rules\n');
  await ok('each sale\'s answer, read as the normal push reads it (201 / 200 duplicate / 424 / 5xx · 429 · 401 / any other 4xx)', () => {
    const c = BF.classifySaleAnswer;
    assert.equal(c(201, { orderId: 'o' }), 'accepted'); assert.equal(c(200, { orderId: 'o', duplicate: true }), 'duplicate');
    assert.equal(c(201, {}), 'later', 'a 2xx without the order is not proof it is stored (F14)');
    assert.equal(c(424, { code: 'shift_not_synced' }), 'waiting');
    for (const s of [500, 503, 429, 408, 401]) assert.equal(c(s, {}), 'later', String(s));
    for (const s of [400, 403, 409, 422]) assert.equal(c(s, {}), 'refused', String(s));
  });
  await ok('the body: at most 500 sales, each with its id and body, no id twice; the cash lists capped', () => {
    const r = BF.readBackfillBody;
    assert.equal(BF.BACKFILL_MAX_SALES, 500);
    assert.equal(r({ orders: Array.from({ length: 500 }, (_, i) => ({ id: `o${i}`, body: {} })) }).ok, true);
    const big = r({ orders: Array.from({ length: 501 }, (_, i) => ({ id: `o${i}`, body: {} })) });
    assert.deepEqual([big.ok, big.status, big.code], [false, 413, 'BACKFILL_TOO_MANY']);
    assert.equal(r({ orders: [{ id: 'a', body: {} }, { id: 'a', body: {} }] }).code, 'BACKFILL_INVALID');
    assert.equal(r({ orders: [{ id: 'a' }] }).code, 'BACKFILL_INVALID');
    assert.equal(r({ shifts: Array.from({ length: BF.BACKFILL_MAX_CASH_ROWS + 1 }, () => ({})) }).status, 413);
    assert.equal(r(null).ok, false); assert.equal(r({}).ok, true, 'nothing to send is fine');
  });
  await ok('the time budget: a sale not started by the deadline is "later", never half done; results in order', async () => {
    let t = 0;
    const out = await BF.inPool([1, 2, 3, 4, 5], 2, async (x) => { t += 10; return `done ${x}`; }, (x) => `late ${x}`, 25, () => t);
    assert.deepEqual(out.slice(0, 2), ['done 1', 'done 2']);
    assert.ok(out.slice(3).every((x) => x.startsWith('late')), out.join(','));
    assert.equal(out.length, 5);
  });

  out('\n2. Accepted\n');
  const ids = [uuid(), uuid(), uuid()];
  const bodies = ids.map(() => sale());
  await ok('a gzip\'d batch of 3 sales with their drawer and day: 200, each accepted, all on the cloud with the POS\'s order id as the key', async () => {
    reset(); rpcCalls = 0;
    const { r, lines } = await logs(() => backfill(TILL, { orders: ids.map((id, i) => ({ id, body: bodies[i] })), business_days: [day()], shifts: [shift()] }));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.results.map((x) => x.status), ['accepted', 'accepted', 'accepted']);
    assert.deepEqual(r.body.counts, { accepted: 3, duplicate: 0, waiting: 0, refused: 0, later: 0 });
    for (const id of ids) assert.ok(mem.db.orders.find((o) => o.idempotency_key === id && o.business_id === D), id);
    assert.equal(rpcCalls, 3);
    assert.ok(mem.db.shifts.find((s) => s.id === SHIFT), 'the drawer, before its sales (the normal push\'s order)');
    assert.equal(mem.db.shifts.find((s) => s.id === SHIFT).status, 'open', 'written as /api/sync/push writes it — the close comes by /close (C6)');
    assert.equal(mem.db.business_days.find((d) => d.id === DAYID)?.status, 'closed');
    assert.equal(r.body.cash.ok, true); assert.equal(r.body.cash.upserted.shifts, 1); assert.equal(r.body.cash.upserted.businessDays, 1);
    const own = lines.filter((x) => /\[backfill\]/.test(x));
    assert.equal(own.length, 1, lines.join('\n'));
    assert.match(own[0], /3 sale\(s\) — 3 accepted, 0 duplicate/);
    // old sales stay quiet: their kitchen tickets recorded as collected (never new on today's kitchen screen)
    const mine = mem.db.orders.filter((o) => o.business_id === D).map((o) => o.id);
    const kt = mem.db.kitchen_tickets.filter((k) => mine.includes(k.order_id));
    assert.ok(kt.length >= 3 && kt.every((k) => k.status === 'collected'), `kitchen tickets: ${JSON.stringify(kt.map((k) => k.status))}`);
    const osrc = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/orders.ts'), 'utf8');
    assert.match(osrc, /if \(!quiet\) fireWebhook\(req\.businessId, 'order\.completed'/, 'no webhook for a backfilled sale');
    assert.match(osrc, /if \(!quiet\) fiscaliseInvoice\(order\.id\)/, 'no eTIMS send for a backfilled sale');
    assert.ok(mem.db.user_devices.find((d) => d.device_id === 'dev-T1').last_sync_at, 'the POS counts as syncing (the watchdog\'s last_sync_at)');
  });
  await ok('…the sales are the normal push\'s: the drawer, the cashier claimed, the POS\'s own time', async () => {
    const o = mem.db.orders.find((x) => x.idempotency_key === ids[0]);
    assert.deepEqual([o.shift_id, o.cashier_id, o.created_at, Number(o.total)], [SHIFT, CASH, bodies[0].created_at, 200]);
  });
  await ok('one call, one log line: a sale priced differently now is counted in it, not logged on its own', async () => {
    reset();
    const id = uuid();
    const { r, lines } = await logs(() => backfill(TILL, { orders: [{ id, body: sale({ items: [{ product: { id: P1, name: 'Chips' }, quantity: 1, unitPrice: 150, lineTotal: 150 }], subtotal: 150, total: 150, payments: [{ method: 'cash', amount: 150, status: 'completed' }] }) }], shifts: [shift()], business_days: [day()] }));
    assert.equal(r.body.results[0].status, 'accepted', r.text);
    assert.equal(lines.filter((x) => /reprice-divergence/.test(x)).length, 0, lines.join('\n'));
    assert.match(lines.find((x) => /\[backfill\]/.test(x)) ?? '', /1 priced differently now/);
    const n = await logs(() => pushOrder(TILL, uuid(), sale({ items: [{ product: { id: P1, name: 'Chips' }, quantity: 1, unitPrice: 150, lineTotal: 150 }], subtotal: 150, total: 150, payments: [{ method: 'cash', amount: 150, status: 'completed' }] })));
    assert.equal(n.lines.filter((x) => /reprice-divergence/.test(x)).length, 1, 'the normal push still logs it');
  });

  out('\n3. Idempotent\n');
  await ok('the same batch again (an interrupted run sent again): every sale a duplicate, nothing written twice', async () => {
    reset(); rpcCalls = 0;
    const payload = { orders: ids.map((id, i) => ({ id, body: bodies[i] })), business_days: [day()], shifts: [shift()] };
    await backfill(TILL, payload);
    const before = mem.db.orders.length;
    const r = await backfill(TILL, payload);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.results.map((x) => x.status), ['duplicate', 'duplicate', 'duplicate']);
    assert.ok(r.body.results.every((x) => typeof x.orderId === 'string'));
    assert.equal(mem.db.orders.length, before); assert.equal(rpcCalls, 3, 'no second write');
    assert.equal(mem.db.shifts.filter((s) => s.id === SHIFT).length, 1);
  });
  await ok('a sale the normal push already sent is a duplicate in the backfill — and the other way round', async () => {
    reset();
    const a = uuid(), b = uuid();
    await backfill(TILL, { shifts: [shift()], business_days: [day()] });
    assert.equal((await pushOrder(TILL, a, sale())).status, 201);
    const r = await backfill(TILL, { orders: [{ id: a, body: sale() }, { id: b, body: sale() }] });
    assert.deepEqual(r.body.results.map((x) => x.status), ['duplicate', 'accepted']);
    const again = await pushOrder(TILL, b, sale());
    assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  });
  await ok('a race (the batch\'s look-up missed a copy written meanwhile): create_order_atomic\'s key → duplicate, not a second sale', async () => {
    reset();
    const a = uuid();
    await backfill(TILL, { shifts: [shift()], business_days: [day()] });
    // the look-up sees nothing; the write meets the key (another copy landed in between)
    let first = true;
    mem.fail = (table, op) => { if (table === 'orders' && op === 'select' && first) { first = false; return null; } return null; };
    const realRpc = mem.rpc; let raced = false;
    mem.rpc = async (fn, args) => { if (fn === 'create_order_atomic' && !raced) { raced = true; mem.db.orders.push({ id: uuid(), business_id: D, idempotency_key: a, order_number: 'X' }); } return realRpc(fn, args); };
    const r = await backfill(TILL, { orders: [{ id: a, body: sale() }] });
    mem.rpc = realRpc;
    assert.equal(r.body.results[0].status, 'duplicate', r.text);
    assert.equal(mem.db.orders.filter((o) => o.idempotency_key === a).length, 1);
  });

  out('\n4. The same rules as the normal push (side by side)\n');
  await ok('each body is answered exactly as POST /api/orders answers it: fields missing, another branch\'s drawer, a drawer not on the cloud', async () => {
    const OTHER = uuid();
    const cases = [
      ['no items', () => sale({ items: [] })],
      ['no payment', () => sale({ payments: [] })],
      ['a drawer of another branch', () => sale({ shift_id: OTHER })],
      ['a drawer not on the cloud', () => sale({ shift_id: uuid() })],
      ['legs that do not add up', () => sale({ payments: [{ method: 'cash', amount: 10, status: 'completed' }] })],
    ];
    const seen = [];
    for (const [what, mk] of cases) {
      const body = mk();
      reset(); await backfill(TILL, { shifts: [shift()], business_days: [day()] });
      mem.db.shifts.push({ id: OTHER, business_id: D, branch_id: BR2, status: 'open' });
      const n = await pushOrder(TILL, uuid(), body);
      reset(); await backfill(TILL, { shifts: [shift()], business_days: [day()] });
      mem.db.shifts.push({ id: OTHER, business_id: D, branch_id: BR2, status: 'open' });
      const b = await backfill(TILL, { orders: [{ id: uuid(), body }] });
      const x = b.body.results[0];
      assert.equal(x.http, n.status, `${what}: backfill ${x.http} vs push ${n.status}`);
      if (n.body?.code) assert.equal(x.code, n.body.code, what);
      assert.ok(String(x.error).startsWith(n.body.error), `${what}: "${x.error}" vs "${n.body.error}"`);
      seen.push(`${what}: ${x.status} ${x.http}${x.code ? ` ${x.code}` : ''}`);
    }
    assert.match(seen[3], /waiting 424 shift_not_synced/, seen.join(' | '));
    assert.match(seen[2], /refused 403 SHIFT_OTHER_BRANCH/, seen.join(' | '));
    assert.match(seen[0], /refused 400/);
  });
  await ok('a sale for an unknown drawer waits (424) while the rest of the batch is stored', async () => {
    reset();
    const a = uuid(), b = uuid();
    const r = await backfill(TILL, { orders: [{ id: a, body: sale({ shift_id: uuid() }) }, { id: b, body: sale() }], shifts: [shift()], business_days: [day()] });
    assert.deepEqual(r.body.results.map((x) => x.status), ['waiting', 'accepted']);
    assert.equal(mem.db.orders.some((o) => o.idempotency_key === a), false);
  });

  out('\n5. Refused\n');
  await ok('the backup off — A601\'s cut for a desktop-only business: 503 CLOUD_BACKUP_OFF, Retry-After 3600, nothing written', async () => {
    reset(); process.env.DESKTOP_ONLY_CUTOFF_AT = iso(Date.now() - DAY); CP.forgetStanding();
    const r = await backfill(TILL, { orders: [{ id: uuid(), body: sale() }], shifts: [shift()] });
    delete process.env.DESKTOP_ONLY_CUTOFF_AT; CP.forgetStanding();
    assert.deepEqual([r.status, r.body?.code, r.retry], [503, 'CLOUD_BACKUP_OFF', '3600'], r.text);
    assert.equal(mem.db.orders.length, 0); assert.equal(mem.db.shifts.length, 0);
  });
  await ok('…before the date (the notice phase) it is taken', async () => {
    reset(); process.env.DESKTOP_ONLY_CUTOFF_AT = iso(Date.now() + 30 * DAY); CP.forgetStanding();
    const r = await backfill(TILL, { orders: [{ id: uuid(), body: sale() }], shifts: [shift()], business_days: [day()] });
    delete process.env.DESKTOP_ONLY_CUTOFF_AT; CP.forgetStanding();
    assert.equal(r.status, 200, r.text); assert.equal(r.body.results[0].status, 'accepted');
  });
  await ok('…and with the cloud_backup flag (exempt) at the cut it is taken', async () => {
    reset(); mem.db.feature_flags.push({ business_id: D, key: 'cloud_backup', enabled: true });
    process.env.DESKTOP_ONLY_CUTOFF_AT = iso(Date.now() - DAY); CP.forgetStanding();
    const r = await backfill(TILL, { orders: [{ id: uuid(), body: sale() }], shifts: [shift()], business_days: [day()] });
    delete process.env.DESKTOP_ONLY_CUTOFF_AT; CP.forgetStanding();
    assert.equal(r.status, 200, r.text);
  });
  await ok('locked for not paying (A581): 503 CLOUD_SUBSCRIPTION_ENDED, Retry-After 900, nothing written', async () => {
    reset();
    const r = await raw('/api/sync/backfill', TILL_LK, JSON.stringify({ orders: [] }), { 'x-device-id': 'dev-L1' });
    assert.deepEqual([r.status, r.body?.code, r.retry], [503, 'CLOUD_SUBSCRIPTION_ENDED', '900'], r.text);
  });
  await ok('not a POS (a web session): 403 TILL_ONLY', async () => {
    reset();
    const r = await backfill(WEB, { orders: [{ id: uuid(), body: sale() }] });
    assert.deepEqual([r.status, r.body?.code], [403, 'TILL_ONLY'], r.text);
    assert.equal(mem.db.orders.length, 0);
  });
  await ok('the cash rows\' passing refusal (a write that failed: 503 SYNC_RETRY) is the whole call\'s — no sale tried', async () => {
    reset(); rpcCalls = 0;
    mem.fail = (table, op) => (table === 'shifts' && (op === 'upsert' || op === 'update') ? { code: '57014', message: 'statement timeout' } : null);
    const r = await logs(() => backfill(TILL, { orders: [{ id: uuid(), body: sale() }], shifts: [shift()], business_days: [day()] }));
    assert.deepEqual([r.r.status, r.r.body?.code, r.r.body?.stage], [503, 'SYNC_RETRY', 'cash'], r.r.text);
    assert.equal(rpcCalls, 0); assert.equal(mem.db.orders.length, 0);
  });

  out('\n6. Limits\n');
  await ok('501 sales in one call: 413 BACKFILL_TOO_MANY, nothing written', async () => {
    reset();
    const r = await backfill(TILL, { orders: Array.from({ length: 501 }, () => ({ id: uuid(), body: sale() })) });
    assert.deepEqual([r.status, r.body?.code], [413, 'BACKFILL_TOO_MANY'], r.text.slice(0, 200));
    assert.equal(mem.db.orders.length, 0);
  });
  await ok('a body over the app\'s 1 MB goes to the backfill (its own 12 MB) — the same body to /api/sync/push is refused 413', async () => {
    reset();
    const pad = 'x'.repeat(1_500_000);
    const r = await backfill(TILL, { orders: [{ id: uuid(), body: sale({ notes: 'n', _pad: pad }) }], shifts: [shift()], business_days: [day()] });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const p = await raw('/api/sync/push', TILL, JSON.stringify({ shifts: [], _pad: pad }));
    assert.equal(p.status, 413);
  });
  await ok('over 12 MB once inflated (a gzip of a few KB): refused 413 — the limit is on what it inflates to', async () => {
    reset();
    const huge = zlib.gzipSync(Buffer.from(JSON.stringify({ orders: [], _pad: 'y'.repeat(13 * 1024 * 1024) })));
    assert.ok(huge.length < 200_000, `gzip ${huge.length}`);
    const r = await raw('/api/sync/backfill', TILL, huge, { 'content-encoding': 'gzip' });
    assert.equal(r.status, 413, r.text.slice(0, 200));
  });
  await ok('plain JSON (no gzip) is taken too', async () => {
    reset();
    const r = await backfill(TILL, { orders: [{ id: uuid(), body: sale() }], shifts: [shift()], business_days: [day()] }, { gzip: false });
    assert.equal(r.status, 200, r.text); assert.equal(r.body.results[0].status, 'accepted');
  });
  await ok('the body limit is mounted before the app\'s 1 MB parser in index.ts, and the 413 names it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/index.ts'), 'utf8');
    const a = src.indexOf("app.use('/api/sync/backfill', backfillBodyParser)"), b = src.indexOf("app.use(express.json({ limit: '1mb' }))");
    assert.ok(a > 0 && b > a, `${a} ${b}`);
    assert.equal(BF.BACKFILL_JSON_LIMIT, '12mb');
  });

  out('\n7. The gates know the path\n');
  await ok('A601: the backfill is one of a POS\'s backup writes (refused at the cut); A159: one of the POS\'s own writes', () => {
    assert.equal(CP.backupGateApplies('desktop', 'POST', '/api/sync/backfill'), true);
    assert.equal(CP.backupGateApplies('desktop', 'GET', '/api/sync/backfill'), false);
    assert.ok(TW.TILL_WRITES.some((re) => re.test('/api/sync/backfill')));
    assert.equal(TW.terminalWriteDenied('desktop', 'POST', '/api/sync/backfill', false), false);
  });
} finally {
  server.close();
}
out(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
