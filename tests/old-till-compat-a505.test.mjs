// A505 — the 1.0.16 cloud against tills still on 1.0.15 (or older, down to 1.0.11): nothing a till already did may be
// refused for good. The cloud deploys first and tills stay old until each business's update is approved and installed.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/old-till-compat-a505.test.mjs
//
// RUNS the COMPILED orders router behind the REAL auth middleware over HTTP; the database in memory (tests/lib-memdb.mjs).
//
//   1 A sale the till already made (its own created_at), pushed under a person's PIN sign-in on the till — what every till
//     does while someone is signed in (syncEngine pushAuthHeaders) — is stored even when that person's keys would refuse
//     a LIVE sale: a manual discount without sales.discount (A494 refused it 403 DISCOUNT_NOT_ALLOWED), a role without
//     orders.create (403 Missing permission). A till before 1.0.16 counts a 403 as a failure, gives up after 5 tries and
//     never re-sends under its own session: the paid, printed sale never reached the cloud.
//   2 Everything else keeps A494's rule: a web sale, a desktop request without the till's time, and /pay.
//   3 The limiters bucket an EXPIRED till token by the till (its signature is ours), not by the shop's shared address.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-15):
//   - orders.ts discountRefused without the tillMadeSale exemption          → 1(a) fails (403 DISCOUNT_NOT_ALLOWED)
//   - orders.ts POST / back to `sells`                                        → 1(b) fails (403 orders.create)
//   - tillMadeSale without the req.path === '/' condition                     → 2(c) fails (/pay discount accepted)
//   - limiterKeys BUCKET_VERIFY_OPTIONS without ignoreExpiration              → 3 fails (the expired till token → 'ip')
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
mailer.sendEmail = async () => {};
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const LK = require(path.join(DIST, 'lib/limiterKeys.js'));

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const OWNER = '44444444-4444-4444-8444-444444444444', JOE = 'cccccccc-0000-4000-8000-000000000001', STOCK = 'cccccccc-0000-4000-8000-000000000002';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const O_OPEN = 'dddddddd-0000-4000-8000-000000000001';
const reset = () => {
  mem.fail = () => null; mem.latency = () => 0; mem.rowCap = Infinity;
  mem.db = {
    businesses: [{ id: B, name: 'Pollo', owner_id: OWNER, currency: 'KES', vat_rate: 16, ctl_rate: 0, type: 'restaurant' }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B },
      { id: JOE, name: 'Joe', status: 'active', business_id: B },
      { id: STOCK, name: 'Stock clerk', status: 'active', business_id: B }],
    branches: [{ id: BR, business_id: B, name: 'Westlands' }],
    products: [{ id: P1, business_id: B, name: 'Chips', base_price: 200, category_id: null }],
    variant_groups: [], modifier_groups: [], branch_prices: [], change_requests: [], user_devices: [], order_items: [], payments: [],
    order_price_variances: [], kitchen_tickets: [], business_settings: [], branch_settings: [], feature_flags: [], shifts: [], customers: [],
    orders: [{ id: O_OPEN, business_id: B, branch_id: BR, order_number: 'T1-OPEN', status: 'open', subtotal: 1000, total: 1000,
      order_type: 'dine_in', created_at: new Date().toISOString(), cashier_id: JOE, order_items: [] }],
  };
};
reset();
// create_order_atomic, as migration 115 (the legs must reconcile to the total).
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
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const sign = (p, opts = { expiresIn: '5m' }) => jwt.sign({ businessId: B, branchId: BR, isOwner: false, permissionsVersion: 0, sessionId: 's', ...p },
  process.env.JWT_SECRET, opts);
// A person's PIN sign-in on a till (verify-pin issues exactly this shape).
const pinOnTill = (userId, keys) => sign({ userId, permissionKeys: keys, surface: 'desktop', pinSignIn: true });
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const chips = (qty, unit) => ({ product: { id: P1, name: 'Chips' }, quantity: qty, unitPrice: unit, lineTotal: qty * unit });
// The till's payload: its own time (created_at), its number, its lines, its payments.
const tillSale = (discount = 0) => ({ branch_id: BR, order_number: `T1--${Math.floor(Math.random() * 1e6)}`, created_at: '2026-10-15T09:00:00Z',
  items: [chips(2, 200)], subtotal: 400, discount_amount: discount, total: 400 - discount, payments: [{ method: 'cash', amount: 400 - discount }] });
const push = (token, body) => call('POST', '/api/orders', token, body, { 'X-Idempotency-Key': randomUUID(), 'X-Device-Id': 'dev-T1' });

const warned = [];
const realWarn = console.warn;
console.warn = (...a) => { warned.push(a.join(' ')); };

try {
  state._setPermissionsMigrated(true);

  console.log('\n1. A sale the till already made, pushed under a person\'s PIN sign-in, is stored\n');
  reset();
  await ok('(a) a manual discount under a cashier\'s till sign-in WITHOUT sales.discount: 201, stored with its discount', async () => {
    const r = await push(pinOnTill(JOE, ['orders.create']), tillSale(50));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = mem.db.orders.find((x) => x.id === r.body.orderId);
    assert.ok(o, 'on the cloud'); assert.equal(Number(o.total), 350); assert.equal(Number(o.discount_amount), 50);
    assert.equal(o.cashier_id, JOE, 'credited to the person who rang it');
  });
  await ok('(a) …and it is logged once (A505), naming the business and the person', async () => {
    const line = warned.find((w) => /A505/.test(w) && /sales\.discount/.test(w));
    assert.ok(line, warned.join(' | ')); assert.match(line, new RegExp(B)); assert.match(line, new RegExp(JOE));
  });
  await ok('(b) a role WITHOUT orders.create (no till build checks it before selling): 201, stored', async () => {
    const r = await push(pinOnTill(STOCK, ['inventory.view']), tillSale(0));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(mem.db.orders.find((x) => x.id === r.body.orderId)?.cashier_id, STOCK);
  });
  await ok('(b) a retried push of that sale is the same sale (idempotent, not a second one)', async () => {
    const key = randomUUID(); const body = tillSale(0); const t = pinOnTill(STOCK, ['inventory.view']);
    const a = await call('POST', '/api/orders', t, body, { 'X-Idempotency-Key': key });
    const b = await call('POST', '/api/orders', t, body, { 'X-Idempotency-Key': key });
    assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.body.duplicate, true);
  });

  console.log('\n2. Everything else keeps A494\'s rule\n');
  reset();
  await ok('(a) a WEB sale with a manual discount without sales.discount: 403 DISCOUNT_NOT_ALLOWED', async () => {
    const { created_at: _t, ...live } = tillSale(50);
    const r = await call('POST', '/api/orders', sign({ userId: JOE, permissionKeys: ['orders.create'], surface: 'pos' }), live);
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'DISCOUNT_NOT_ALLOWED');
  });
  await ok('(b) a desktop sign-in WITHOUT the till\'s time (a live request) and without orders.create: 403', async () => {
    const { created_at: _t, ...live } = tillSale(0);
    const r = await call('POST', '/api/orders', pinOnTill(STOCK, ['inventory.view']), live);
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.match(r.body.detail, /orders\.create/);
  });
  await ok('(c) /:id/pay is never a till-made sale: a discount without sales.discount is refused there, created_at or not', async () => {
    const r = await call('POST', `/api/orders/${O_OPEN}/pay`, pinOnTill(JOE, ['orders.create']),
      { payments: [{ method: 'cash', amount: 900 }], discount_amount: 100, created_at: '2026-10-15T09:00:00Z' });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'DISCOUNT_NOT_ALLOWED');
  });
  await ok('(d) a person without orders.create and no till sign-in (a browser) cannot push a "till sale": 403', async () => {
    const r = await call('POST', '/api/orders', sign({ userId: STOCK, permissionKeys: ['inventory.view'], surface: 'desktop' }), tillSale(0));
    // surface desktop without pinSignIn is a pre-A415 owner-era till session — requireAuth replaces it (401), never a sale.
    assert.ok([401, 403].includes(r.status), JSON.stringify(r.body));
  });

  console.log('\n3. The limiters: an expired till token is still the till\'s own bucket\n');
  await ok('an EXPIRED till token buckets by its device (auth and api limiters), a forged one by the address', async () => {
    const expired = sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop',
      iat: Math.floor(Date.now() / 1000) - 3600, exp: Math.floor(Date.now() / 1000) - 60 }, {});
    const verify = (t) => jwt.verify(t, process.env.JWT_SECRET, LK.BUCKET_VERIFY_OPTIONS);
    assert.match(LK.authLimiterKeyFor({ url: '/api/auth/verify-pin', authorization: `Bearer ${expired}`, ipKey: 'ip' }, verify), /^t:d:.*dev-T1$/);
    assert.match(LK.apiLimiterKeyFor({ url: '/api/orders', authorization: `Bearer ${expired}`, ipKey: 'ip' }, verify), /^t:d:.*dev-T1$/);
    const forged = jwt.sign({ deviceId: 'dev-X', till: true, businessId: B }, 'not-our-secret');
    assert.equal(LK.authLimiterKeyFor({ url: '/api/auth/verify-pin', authorization: `Bearer ${forged}`, ipKey: 'ip' }, verify), 'ip');
    assert.equal(LK.authLimiterKeyFor({ url: '/api/auth/login', authorization: `Bearer ${expired}`, ipKey: 'ip' }, verify), 'ip', 'sign-in paths: the address');
  });
  await ok('index.ts verifies limiter tokens with BUCKET_VERIFY_OPTIONS (signature, not expiry)', () => {
    const ix = fs.readFileSync(path.join(ROOT, 'apps/server/src/index.ts'), 'utf8');
    assert.match(ix, /jwt\.verify\(token, process\.env\.JWT_SECRET \?\? '', BUCKET_VERIFY_OPTIONS\)/);
  });
} finally {
  console.warn = realWarn;
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
