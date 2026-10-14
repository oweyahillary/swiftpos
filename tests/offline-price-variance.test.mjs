/**
 * offline-price-variance.test.mjs — cloud audit 2026-10-14: an offline till sale the cloud prices differently.
 *
 * Owner decision: "let the sale go through but count it as a loss".
 *
 *   P0-2  A till's sale (desktop token, made with its own created_at) whose catalogue price changed before it synced is
 *         stored AT THE TILL'S PRICES — the money taken, so its payment legs reconcile — and the difference (catalogue -
 *         till; positive = a loss) is recorded in order_price_variances (migration 133). A difference over half the
 *         catalogue total is accepted and flagged suspicious. An option renamed / removed since, or a product the cloud
 *         does not have, keeps the line at the till's price with a reason — never refused. A web / live sale is re-priced
 *         and refused as before (anti-tampering unchanged).
 *   P1-8a A product the till created offline whose create the cloud answered with another id (change_requests.canonical_id)
 *         is sold under the cloud's id.
 *   P2-12 Refund / void claim the order first (a conditional update): of two overlapping requests exactly one reverses the
 *         money; the other is told ALREADY_REFUNDED / ALREADY_VOIDED.
 *   Shown: Reports › Voids & Exceptions (GET /api/reports/voids → price_differences) and the owner's daily email ("Offline
 *         sales priced differently: N, loss KES X", only when N > 0). P2-16: the daily email's orders are paged.
 *
 * RUNS the COMPILED orders and reports routers behind the REAL auth middleware over HTTP, and the REAL daily-summary job;
 * the database is in memory (tests/lib-memdb.mjs), create_order_atomic emulated with migration 115's legs check.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/offline-price-variance.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - tillSale forced false (the old re-price for every sale)         → "stored at the till's price … 201" fails (400)
 *   - tillPricing's suspicious share 0.5 → 5                          → "flagged suspicious" fails
 *   - mapCanonicalProducts not called                                → "sold under the cloud's id" fails
 *   - the refund claim's .is('refunded_at', null) removed             → "exactly one refund" fails
 *   - the void claim's .neq('status', 'voided') removed               → "exactly one void" fails
 *   - priceDiffLine ignoring count (always a line)                    → "no line when there are none" fails
 *   - the daily email's orders read back to one plain select          → "all 1200 sales counted" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/orders.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.RESEND_API_KEY; delete process.env.SENDGRID_API_KEY; delete process.env.SMTP_HOST;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
supabase.auth.admin.getUserById = async () => ({ data: null, error: { message: 'no user' } });   // no network
const mailer = require(path.join(DIST, 'lib/mailer.js'));
let SENT = []; mailer.sendEmail = async (m) => { SENT.push(m); };

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const OWNER = '44444444-4444-4444-8444-444444444444', TOM = 'cccccccc-0000-4000-8000-000000000001';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001', P2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const P8 = 'aaaaaaaa-0000-4000-8000-000000000008', P9 = 'aaaaaaaa-0000-4000-8000-000000000009';
const reset = () => {
  mem.fail = () => null; mem.latency = () => 0; mem.rowCap = Infinity;
  mem.db = {
    businesses: [{ id: B, name: 'Mama Ngina Foods', owner_id: OWNER, currency: 'KES', vat_rate: 16, ctl_rate: 0, type: 'restaurant' }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B }, { id: TOM, name: 'Tom', status: 'active', business_id: B }],
    branches: [{ id: BR, business_id: B, name: 'Westlands' }],
    products: [{ id: P1, business_id: B, name: 'Chips', base_price: 200, category_id: null }, { id: P2, business_id: B, name: 'Soda', base_price: 100, category_id: null }],
    variant_groups: [{ name: 'Size', product_id: P2, variant_options: [{ id: 'vo-large', name: 'Large', price_adjustment: 50 }] }],
    modifier_groups: [], branch_prices: [], change_requests: [], user_devices: [], orders: [], order_items: [], payments: [],
    order_price_variances: [], kitchen_tickets: [], business_settings: [], branch_settings: [], feature_flags: [], shifts: [],
  };
};
reset();
// create_order_atomic, as migration 115: the legs must reconcile to total + tip (+ the fee unless free), or it raises.
mem.rpc = async (fn, args) => {
  if (fn !== 'create_order_atomic') return { data: null, error: null };
  const o = args.p_order;
  const due = Number(o.total) + Number(o.tip_amount || 0) + (o.delivery_free ? 0 : Number(o.delivery_fee || 0));
  const paid = args.p_payments.reduce((s, l) => s + Number(l.amount), 0);
  if (Math.abs(paid - due) > 0.005) return { data: null, error: { code: 'P0001', message: `payment legs sum to ${paid} but the amount due is ${due}` } };
  const id = randomUUID();
  mem.db.orders.push({ id, ...o, status: 'completed' });
  for (const it of args.p_items) mem.db.order_items.push({ id: randomUUID(), order_id: id, ...it.item });
  for (const p of args.p_payments) mem.db.payments.push({ id: randomUUID(), order_id: id, ...p });
  return { data: [{ order_id: id, order_number: o.order_number }], error: null };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api/orders', require(path.join(DIST, 'routes/orders.js')).default);
app.use('/api/reports', require(path.join(DIST, 'routes/reports.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const tok = (surface, userId, extra = {}) => jwt.sign({ userId, businessId: B, branchId: BR, isOwner: false, permissionKeys: ['orders.create'],
  permissionsVersion: 0, sessionId: 's', surface, ...(surface === 'desktop' ? { pinSignIn: true } : {}), ...extra }, process.env.JWT_SECRET, { expiresIn: '5m' });
const req = async (method, p, body, token, headers = {}) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tillSale = (body, key = randomUUID()) => req('POST', '/api/orders', { created_at: '2026-10-14T09:00:00Z', ...body }, tok('desktop', TOM), { 'X-Idempotency-Key': key });
const webSale = (body) => req('POST', '/api/orders', body, tok('web', TOM));
const owner = tok('dashboard', OWNER, { isOwner: true, permissionKeys: ['*'] });
const sale = (items, total, extra = {}) => ({ branch_id: BR, order_number: `T1-${Math.floor(Math.random() * 1e6)}`, items, total, subtotal: total,
  payments: [{ method: 'cash', amount: total }], ...extra });
const chips = (qty, unit) => ({ product: { id: P1, name: 'Chips' }, quantity: qty, unitPrice: unit, lineTotal: qty * unit });
const orderOf = (id) => mem.db.orders.find((o) => o.id === id);
const varianceOf = (id) => mem.db.order_price_variances.filter((v) => v.order_id === id);

try {
  console.log('\nP0-2 — a till\'s sale priced differently is kept, and counted\n');
  await ok('Chips went 150 → 200 before the till\'s sale synced: stored at the till\'s price, 201 (not 400 → lost after 5 tries)', async () => {
    const r = await tillSale(sale([chips(2, 150)], 300));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = orderOf(r.body.orderId);
    assert.equal(o.total, 300); assert.equal(o.subtotal, 300);
    const lines = mem.db.order_items.filter((i) => i.order_id === r.body.orderId);
    assert.equal(lines[0].unit_price, 150); assert.equal(lines[0].subtotal, 300); assert.equal(lines[0].product_id, P1);
  });
  await ok('…and the difference is recorded: catalogue 400, till 300, loss 100, "price changed before sync", not suspicious', () => {
    const o = mem.db.orders.at(-1); const v = varianceOf(o.id);
    assert.equal(v.length, 1);
    assert.equal(v[0].catalogue_total, 400); assert.equal(v[0].till_total, 300); assert.equal(v[0].difference, 100);
    assert.match(v[0].reason, /price changed before sync/); assert.equal(v[0].suspicious, false);
    assert.equal(v[0].business_id, B); assert.equal(v[0].branch_id, BR); assert.equal(v[0].sold_at, '2026-10-14T09:00:00Z');
  });
  await ok('a retried push of the same sale is the same sale — no second loss counted', async () => {
    const key = randomUUID();
    const a = await tillSale(sale([chips(1, 150)], 150), key);
    const b = await tillSale(sale([chips(1, 150)], 150), key);
    assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.body.duplicate, true);
    assert.equal(varianceOf(a.body.orderId).length, 1);
  });
  await ok('a difference over half the catalogue price is accepted and flagged suspicious', async () => {
    const r = await tillSale(sale([chips(2, 50)], 100));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const v = varianceOf(r.body.orderId)[0];
    assert.equal(v.difference, 300); assert.equal(v.suspicious, true);
  });
  await ok('a till sale at the catalogue\'s price records no difference', async () => {
    const r = await tillSale(sale([chips(1, 200)], 200));
    assert.equal(r.status, 201); assert.equal(varianceOf(r.body.orderId).length, 0);
  });
  await ok('a variant renamed since: the line kept at the till\'s price, with the reason — never refused', async () => {
    const r = await tillSale(sale([{ product: { id: P2, name: 'Soda' }, quantity: 1, unitPrice: 180, lineTotal: 180,
      selectedVariants: [{ groupName: 'Size', optionName: 'Jumbo', priceAdjustment: 80 }] }], 180));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const line = mem.db.order_items.find((i) => i.order_id === r.body.orderId);
    assert.equal(line.unit_price, 180); assert.equal(line.product_id, P2);
    const v = varianceOf(r.body.orderId)[0];
    assert.match(v.reason, /variant renamed or removed: Soda — Size \/ Jumbo/); assert.equal(v.difference, 0);
  });
  await ok('a product the cloud does not have: a line at the till\'s price with its name (no product id), reason recorded', async () => {
    const r = await tillSale(sale([{ product: { id: P9, name: 'Mandazi' }, quantity: 3, unitPrice: 20, lineTotal: 60 }, chips(1, 200)], 260));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const lines = mem.db.order_items.filter((i) => i.order_id === r.body.orderId);
    const m = lines.find((l) => l.product_name === 'Mandazi');
    assert.equal(m.product_id, null); assert.equal(m.subtotal, 60);
    assert.match(varianceOf(r.body.orderId)[0].reason, /product not on the cloud: Mandazi/);
  });
  await ok('P1-8a: a product the till created offline, known on the cloud by another id, is sold under the cloud\'s id', async () => {
    mem.db.change_requests.push({ id: randomUUID(), business_id: B, entity: 'product', entity_id: P8, canonical_id: P1, status: 'identical' });
    const r = await tillSale(sale([{ product: { id: P8, name: 'Chips' }, quantity: 1, unitPrice: 200, lineTotal: 200 }], 200));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(mem.db.order_items.find((i) => i.order_id === r.body.orderId).product_id, P1);
    assert.equal(varianceOf(r.body.orderId).length, 0);
  });

  console.log('\nAnti-tampering for the web and live sales — unchanged\n');
  await ok('a WEB sale claiming the old price is re-priced and refused (400 PAYMENT_LEGS_MISMATCH), nothing recorded', async () => {
    const before = mem.db.orders.length;
    const r = await webSale(sale([chips(2, 150)], 300));
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'PAYMENT_LEGS_MISMATCH');
    assert.equal(mem.db.orders.length, before);
  });
  await ok('a WEB sale naming a product of no business here is still refused (400)', async () => {
    const r = await webSale(sale([{ product: { id: P9, name: 'Mandazi' }, quantity: 1, unitPrice: 20, lineTotal: 20 }], 20));
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
  await ok('a till\'s LIVE sale (no created_at) is re-priced as before', async () => {
    const r = await req('POST', '/api/orders', sale([chips(2, 150)], 300), tok('desktop', TOM));
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  console.log('\nShown to the owner\n');
  await ok('Reports › Voids & Exceptions lists the price differences of the period, with the loss and the flagged count', async () => {
    const r = await req('GET', '/api/reports/voids?from=2026-10-14&to=2026-10-14', null, owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.price_differences) && r.body.price_differences.length >= 4, JSON.stringify(r.body.price_differences?.length));
    const s = r.body.price_difference_summary;
    assert.equal(s.count, r.body.price_differences.length);
    assert.equal(s.loss, mem.db.order_price_variances.reduce((t, v) => t + v.difference, 0));
    assert.equal(s.suspicious, 1);
  });
  await ok('…and before migration 133 the report still answers (the section empty)', async () => {
    mem.fail = (t) => (t === 'order_price_variances' ? { code: '42P01', message: 'relation "public.order_price_variances" does not exist' } : null);
    const r = await req('GET', '/api/reports/voids?from=2026-10-14&to=2026-10-14', null, owner);
    mem.fail = () => null;
    assert.equal(r.status, 200); assert.deepEqual(r.body.price_differences, []);
  });

  console.log('\nThe owner\'s daily email (and P2-16: every sale of the day, past the row cap)\n');
  const DS = require(path.join(DIST, 'jobs/dailySummary.js'));
  const day = () => {
    reset();
    mem.db.business_settings.push({ id: 's1', business_id: B, key: 'report_schedule', value: { enabled: true, send_time: '21:00', recipients: ['books@biz.test'] } });
    for (let i = 0; i < 1200; i++) mem.db.orders.push({ id: `o-${String(i).padStart(5, '0')}`, business_id: B, status: 'completed', total: 10, vat_amount: 1, cashier_id: null, created_at: '2026-10-14T10:00:00Z' });
    mem.rowCap = 1000;   // Supabase's db-max-rows
    SENT = [];
  };
  day();
  mem.db.order_price_variances.push(
    { id: 'v1', business_id: B, branch_id: BR, order_id: 'o-00001', difference: 100, suspicious: false, sold_at: '2026-10-14T09:00:00Z' },
    { id: 'v2', business_id: B, branch_id: BR, order_id: 'o-00002', difference: 250.5, suspicious: true, sold_at: '2026-10-14T11:00:00Z' },
    { id: 'v3', business_id: B, branch_id: BR, order_id: 'o-00003', difference: 999, suspicious: false, sold_at: '2026-10-13T11:00:00Z' });   // yesterday
  await DS.runDailySummary(new Date('2026-10-14T18:05:00Z'));
  await ok('the email says "Offline sales priced differently: 2, loss KES 350.50" and flags the one over half the price', () => {
    assert.equal(SENT.length, 1);
    const html = SENT[0].html;
    assert.match(html, /Offline sales priced differently: <strong>2<\/strong>, loss <strong[^>]*>KES 350\.50<\/strong>/);
    assert.match(html, /1 over half the price/);
  });
  await ok('P2-16: all 1200 sales of the day are counted (the read is paged past the 1000-row cap)', () => {
    assert.match(SENT[0].html, />1200</); assert.match(SENT[0].html, /KES 12,000\.00/);
  });
  day();
  await DS.runDailySummary(new Date('2026-10-14T18:05:00Z'));
  await ok('no line when there are none', () => {
    assert.equal(SENT.length, 1); assert.doesNotMatch(SENT[0].html, /Offline sales priced differently/);
  });

  console.log('\nP2-12 — one refund, one void\n');
  reset();
  const O1 = randomUUID(), O2 = randomUUID();
  const done = (id, n) => ({ id, business_id: B, branch_id: BR, order_number: n, status: 'completed', total: 500, delivery_fee: 0,
    created_at: new Date().toISOString(), device_id: null, shift_id: null, customer_id: null, refunded_at: null,
    order_items: [{ product_id: null, quantity: 1 }], payments: [{ id: `p-${id}`, status: 'completed', amount: 500, method: 'cash' }] });
  mem.db.orders.push(done(O1, 'W-1'), done(O2, 'W-2'));
  const reversals = (id, ref) => mem.db.payments.filter((p) => p.order_id === id && String(p.reference).startsWith(ref)).length;
  // Both requests read the order before either writes (a slow read) — the overlap a till's retry or a double tap makes.
  // Each on its own connection (fetch would queue the second behind the first on one kept-alive socket).
  // A barrier: a read of the order waits for the other request's read, then both answer together (200 ms at most).
  let waiting = [];
  mem.latency = (t, op) => {
    if (t !== 'orders' || op !== 'select') return 0;
    return new Promise((res) => {
      waiting.push(res);
      const release = () => { const w = waiting; waiting = []; w.forEach((f) => f()); };
      if (waiting.length >= 2) release(); else setTimeout(release, 200);
    });
  };
  const http = await import('node:http');
  const rawPost = (p, body, token) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${token}` } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let b = null; try { b = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, body: b }); });
    });
    r.on('error', reject); r.end(data);
  });
  await ok('two overlapping refunds of one sale: exactly one refund (one negative leg); the other ALREADY_REFUNDED', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => rawPost(`/api/orders/${O1}/refund`, { reason: 'Returned' }, owner)));
    const st = [a.status, b.status].sort();
    assert.deepEqual(st, [200, 400], JSON.stringify([a.body, b.body]));
    assert.equal([a, b].find((x) => x.status === 400).body.code, 'ALREADY_REFUNDED');
    assert.equal(reversals(O1, 'REFUND-'), 1);
  });
  await ok('two overlapping voids of one sale: exactly one void (one reversal); the other ALREADY_VOIDED', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => rawPost(`/api/orders/${O2}/void`, { reason: 'Wrong order' }, owner)));
    const st = [a.status, b.status].sort();
    assert.deepEqual(st, [200, 400], JSON.stringify([a.body, b.body]));
    assert.equal([a, b].find((x) => x.status === 400).body.code, 'ALREADY_VOIDED');
    assert.equal(reversals(O2, 'VOID-'), 1);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
