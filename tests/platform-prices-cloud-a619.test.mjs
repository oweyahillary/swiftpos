/**
 * platform-prices-cloud-a619.test.mjs — A619 (owner, 2026-11-01): the cloud accepts a delivery platform's prices as
 * legitimate — not a price change, not a hand discount, not refused — and re-derives them itself (packages/core/src/platformPrices.ts)
 * so a POS cannot claim an arbitrary "platform price". "assume 3 piece chicken is 1000 normal price ordering with glovo it
 * is 1150 a 15% bump so the receipt shows 1150".
 *
 * RUNS the COMPILED orders, reports, business and branches routers behind the REAL auth middleware over HTTP; the database
 * is in memory (tests/lib-memdb.mjs), create_order_atomic emulated with migration 115's legs check.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/platform-prices-cloud-a619.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - createOrder passing platform: null (the claim ignored)          → "a Glovo sale at Glovo prices is accepted" fails (400)
 *   - platformLine ignoring the own price                              → "an item's own Glovo price" fails
 *   - salePlatform accepting a split                                   → "a split is never priced for a platform" fails
 *   - the order record not written                                     → "the sale records" fails
 *   - upliftByPlatform not merged into the master report               → "of which uplift" fails
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
const { loadPlatformPricing } = require(path.join(DIST, 'lib/platformPricing.js'));

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222', BR2 = '22222222-2222-4222-8222-222222222223';
const OWNER = '44444444-4444-4444-8444-444444444444', TOM = 'cccccccc-0000-4000-8000-000000000001';
const CHICKEN = 'aaaaaaaa-0000-4000-8000-000000000001', SODA = 'aaaaaaaa-0000-4000-8000-000000000002', COMBO = 'aaaaaaaa-0000-4000-8000-000000000003';
const OFFER = 'dddddddd-0000-4000-8000-000000000001';
const setting = (key, value, branch) => (branch ? { business_id: B, branch_id: branch, key, value } : { business_id: B, key, value });
const reset = () => {
  mem.fail = () => null; mem.latency = () => 0; mem.rowCap = Infinity;
  mem.db = {
    businesses: [{ id: B, name: 'Kuku Grill', owner_id: OWNER, currency: 'KES', vat_rate: 16, ctl_rate: 0, type: 'restaurant' }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B }, { id: TOM, name: 'Tom', status: 'active', business_id: B }],
    branches: [{ id: BR, business_id: B, name: 'Westlands' }, { id: BR2, business_id: B, name: 'Kilimani' }],
    products: [
      { id: CHICKEN, business_id: B, name: '3 Piece Chicken', base_price: 1000, category_id: null },
      { id: SODA, business_id: B, name: 'Soda', base_price: 350, category_id: null },
      { id: COMBO, business_id: B, name: 'Family Combo', base_price: 2000, category_id: null, platform_prices: { glovo: 2200 } },
    ],
    variant_groups: [],
    modifier_groups: [{ name: 'Extras', product_id: CHICKEN, modifier_options: [{ name: 'Cheese', price: 100 }] }],
    branch_prices: [], change_requests: [], user_devices: [], orders: [], order_items: [], payments: [], offers: [], promotions: [],
    order_price_variances: [], kitchen_tickets: [], feature_flags: [], shifts: [], categories: [], expenses: [],
    business_settings: [setting('delivery_platform_prices', '{"glovo":{"kind":"percent","value":15},"uber_eats":{"kind":"amount","value":250}}'),
      setting('delivery_platform_rounding', 'exact')],
    branch_settings: [],
  };
};
reset();
mem.rpc = async (fn, args) => {
  if (fn !== 'create_order_atomic') return { data: null, error: null };
  const o = args.p_order;
  const due = Number(o.total) + Number(o.tip_amount || 0) + (o.delivery_free ? 0 : Number(o.delivery_fee || 0));
  const paid = args.p_payments.reduce((s, l) => s + Number(l.amount), 0);
  if (Math.abs(paid - due) > 0.005) return { data: null, error: { code: 'P0001', message: `payment legs sum to ${paid} but the amount due is ${due}` } };
  const id = randomUUID();
  // the payments embedded on the row, as the reports' select reads them
  mem.db.orders.push({ id, ...o, status: 'completed', created_at: o.created_at ?? '2026-11-01T10:00:00Z', payments: args.p_payments.map((p) => ({ ...p, status: 'completed' })) });
  for (const it of args.p_items) mem.db.order_items.push({ id: randomUUID(), order_id: id, ...it.item, _modifiers: it.modifiers });
  for (const p of args.p_payments) mem.db.payments.push({ id: randomUUID(), order_id: id, ...p });
  return { data: [{ order_id: id, order_number: o.order_number }], error: null };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api/orders', require(path.join(DIST, 'routes/orders.js')).default);
app.use('/api/reports', require(path.join(DIST, 'routes/reports.js')).default);
app.use('/api/business', require(path.join(DIST, 'routes/business.js')).default);
app.use('/api/branches', require(path.join(DIST, 'routes/branches.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const tok = (surface, userId, extra = {}) => jwt.sign({ userId, businessId: B, branchId: BR, isOwner: false, permissionKeys: ['orders.create'],
  permissionsVersion: 0, sessionId: 's', surface, ...(surface === 'desktop' ? { pinSignIn: true } : {}), ...extra }, process.env.JWT_SECRET, { expiresIn: '5m' });
const req = async (method, p, body, token, headers = {}) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const owner = tok('dashboard', OWNER, { isOwner: true, permissionKeys: ['*'] });
const webSale = (body) => req('POST', '/api/orders', body, tok('web', TOM));
const tillSale = (body) => req('POST', '/api/orders', { created_at: '2026-11-01T09:00:00Z', ...body }, tok('desktop', TOM), { 'X-Idempotency-Key': randomUUID() });
const sale = (items, total, method = 'glovo', extra = {}) => ({ branch_id: BR, order_number: `W-${Math.floor(Math.random() * 1e7)}`, items, total, subtotal: total,
  payments: [{ method, amount: total, reference: 'GLV-123' }], price_list: method, ...extra });
const ln = (id, name, qty, unit, mods = []) => ({ product: { id, name }, quantity: qty, unitPrice: unit,
  lineTotal: (unit + mods.reduce((s, m) => s + m.price, 0)) * qty, selectedVariants: [], selectedModifiers: mods });
const orderOf = (id) => mem.db.orders.find((o) => o.id === id);
const linesOf = (id) => mem.db.order_items.filter((i) => i.order_id === id);

try {
  console.log('\nA platform sale at the platform\'s prices — accepted, re-derived on the cloud\n');
  await ok('a Glovo sale at Glovo prices is accepted: 3 Piece Chicken 1,000 → 1,150 (+15%), stored at 1,150', async () => {
    const r = await webSale(sale([ln(CHICKEN, '3 Piece Chicken', 1, 1150)], 1150));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = orderOf(r.body.orderId);
    assert.equal(o.total, 1150); assert.equal(o.subtotal, 1150); assert.equal(o.discount_amount, 0);
    assert.equal(linesOf(r.body.orderId)[0].unit_price, 1150); assert.equal(linesOf(r.body.orderId)[0].subtotal, 1150);
    assert.ok(Math.abs(o.vat_amount - 158.62) < 0.01, String(o.vat_amount));   // VAT on the platform price
  });
  await ok('…the sale records the platform, its rule and what it added (1,150 − 1,000 = 150)', async () => {
    const o = mem.db.orders.at(-1);
    assert.equal(o.price_list, 'glovo');
    assert.deepEqual(o.platform_rule, { kind: 'percent', value: 15, rounding: 'exact' });
    assert.equal(o.platform_uplift, 150);
  });
  await ok('a fixed amount on every item (Uber Eats +250): a 350 soda is 600; quantity 2 = 1,200', async () => {
    const r = await webSale(sale([ln(SODA, 'Soda', 2, 600)], 1200, 'uber_eats'));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(linesOf(r.body.orderId)[0].unit_price, 600); assert.equal(orderOf(r.body.orderId).platform_uplift, 500);
  });
  await ok('add-ons are re-priced too (+15%): chicken 1,150 + cheese 115 = 1,265, the add-on row at 115', async () => {
    const r = await webSale(sale([ln(CHICKEN, '3 Piece Chicken', 1, 1150, [{ groupName: 'Extras', optionName: 'Cheese', price: 115 }])], 1265));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const l = linesOf(r.body.orderId)[0];
    assert.equal(l.subtotal, 1265); assert.equal(l._modifiers[0].price, 115);
  });
  await ok('an item\'s own Glovo price wins over the uplift: the Family Combo at 2,200 (not 2,300)', async () => {
    const r = await webSale(sale([ln(COMBO, 'Family Combo', 1, 2200)], 2200));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(linesOf(r.body.orderId)[0].unit_price, 2200);
  });
  await ok('the rounding the owner chose applies to each bumped unit price (up to the nearest 10: 333 → 390)', async () => {
    mem.db.business_settings.find((s) => s.key === 'delivery_platform_rounding').value = 'up10';
    mem.db.products.push({ id: 'aaaaaaaa-0000-4000-8000-000000000009', business_id: B, name: 'Wings', base_price: 333, category_id: null });
    const r = await webSale(sale([ln('aaaaaaaa-0000-4000-8000-000000000009', 'Wings', 1, 390)], 390));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(orderOf(r.body.orderId).platform_rule.rounding, 'up10');
    mem.db.business_settings.find((s) => s.key === 'delivery_platform_rounding').value = 'exact';
  });

  console.log('\nA POS cannot claim an arbitrary platform price\n');
  await ok('a web sale claiming a Glovo price LOWER than the rule gives is re-priced and refused (as any wrong price)', async () => {
    const before = mem.db.orders.length;
    const r = await webSale(sale([ln(CHICKEN, '3 Piece Chicken', 1, 1050)], 1050));
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'PAYMENT_LEGS_MISMATCH');
    assert.equal(mem.db.orders.length, before);
  });
  await ok('a split is never priced for a platform: Glovo + cash at Glovo prices is refused (the platform pays the whole bill)', async () => {
    const r = await webSale({ ...sale([ln(CHICKEN, '3 Piece Chicken', 1, 1150)], 1150),
      payments: [{ method: 'glovo', amount: 650 }, { method: 'cash', amount: 500 }] });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
  await ok('a cash sale claiming Glovo prices is priced normally (1,000), the claim ignored', async () => {
    const r = await webSale(sale([ln(CHICKEN, '3 Piece Chicken', 1, 1000)], 1000, 'cash', { price_list: 'glovo' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(orderOf(r.body.orderId).price_list, undefined);
  });
  await ok('a Glovo sale with no claim (an older POS) is priced normally, as before', async () => {
    const r = await webSale(sale([ln(CHICKEN, '3 Piece Chicken', 1, 1000)], 1000, 'glovo', { price_list: undefined }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(orderOf(r.body.orderId).price_list, undefined);
  });
  await ok('a till\'s offline Glovo sale at an old rate (+10%) is kept at its price and the difference recorded, with its rule', async () => {
    const r = await tillSale(sale([ln(CHICKEN, '3 Piece Chicken', 1, 1100)], 1100, 'glovo', { platform_rule: { kind: 'percent', value: 10, rounding: 'exact' } }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = orderOf(r.body.orderId);
    assert.equal(o.total, 1100); assert.equal(o.price_list, 'glovo');
    assert.deepEqual(o.platform_rule, { kind: 'percent', value: 10, rounding: 'exact' }); assert.equal(o.platform_uplift, 100);
    const v = mem.db.order_price_variances.find((x) => x.order_id === r.body.orderId);
    assert.equal(v.difference, 50); assert.match(v.reason, /glovo price changed before sync/);
  });
  await ok('a till\'s Glovo sale at the rule\'s price: no difference recorded', async () => {
    const r = await tillSale(sale([ln(CHICKEN, '3 Piece Chicken', 2, 1150)], 2300));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(mem.db.order_price_variances.filter((x) => x.order_id === r.body.orderId).length, 0);
  });

  console.log('\nOffers and discounts on platform prices\n');
  await ok('offers are recomputed on the platform prices: 10% off chicken = 115 off 1,150 (not 100)', async () => {
    mem.db.offers.push({ id: OFFER, business_id: B, name: 'Chicken 10%', kind: 'percent_off', value: 10, applies_to: 'products', product_ids: [CHICKEN], category_ids: [], active: true });
    const r = await webSale(sale([ln(CHICKEN, '3 Piece Chicken', 1, 1150)], 1035, 'glovo',
      { discount_amount: 115, offer_discount: 115, offers: [{ offer_id: OFFER, name: 'Chicken 10%', amount: 115 }] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = orderOf(r.body.orderId);
    assert.equal(o.total, 1035); assert.equal(o.offer_discount, 115); assert.equal(o.platform_uplift, 150);
    mem.db.offers = [];
  });
  await ok('…and a sale claiming the offer on the normal price at Glovo prices is not over-discounted', async () => {
    mem.db.offers.push({ id: OFFER, business_id: B, name: 'Chicken 10%', kind: 'percent_off', value: 10, applies_to: 'products', product_ids: [CHICKEN], category_ids: [], active: true });
    const r = await webSale(sale([ln(CHICKEN, '3 Piece Chicken', 1, 1150)], 1050, 'glovo',
      { discount_amount: 100, offer_discount: 100, offers: [{ offer_id: OFFER, name: 'Chicken 10%', amount: 100 }] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(orderOf(r.body.orderId).total, 1050);   // offers never give more than claimed
    mem.db.offers = [];
  });

  console.log('\nBefore migration 187\n');
  await ok('own prices unreadable (no column): the rule applies; the record not written; the sale is still made', async () => {
    mem.fail = (t, op, _f, payload, cols) => ((t === 'products' && op === 'select' && /platform_prices/.test(String(cols)))
      || (t === 'orders' && op === 'update' && payload && 'price_list' in payload)
      ? { code: '42703', message: 'column "platform_prices" does not exist' } : null);
    const r = await webSale(sale([ln(COMBO, 'Family Combo', 1, 2300)], 2300));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(orderOf(r.body.orderId).price_list, undefined);
    mem.fail = () => null;
  });
  await ok('no settings readable: normal prices, never a failed sale', async () => {
    mem.fail = (t) => (t === 'business_settings' ? { code: '57014', message: 'timeout' } : null);
    const r = await webSale(sale([ln(CHICKEN, '3 Piece Chicken', 1, 1000)], 1000));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    mem.fail = () => null;
  });

  console.log('\nThe settings\n');
  await ok('the branch\'s own rules win over the business\'s; the rounding is the business\'s', async () => {
    mem.db.branch_settings.push(setting('delivery_platform_prices', '{"glovo":{"kind":"percent","value":20}}', BR2));
    mem.db.business_settings.find((s) => s.key === 'delivery_platform_rounding').value = 'up5';
    const own = await loadPlatformPricing(B, BR2), def = await loadPlatformPricing(B, BR);
    assert.deepEqual(own, { rounding: 'up5', rules: { glovo: { kind: 'percent', value: 20 } } });
    assert.deepEqual(def.rules.glovo, { kind: 'percent', value: 15 }); assert.equal(def.rules.uber_eats.value, 250);
    mem.db.business_settings.find((s) => s.key === 'delivery_platform_rounding').value = 'exact';
  });
  await ok('the owner saves the rules and the rounding; a bad value is refused (400)', async () => {
    const a = await req('POST', '/api/business/settings', { key: 'delivery_platform_prices', value: { bolt_food: { kind: 'percent', value: 12 } } }, owner);
    assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.value, '{"bolt_food":{"kind":"percent","value":12}}');
    const b = await req('POST', '/api/business/settings', { key: 'delivery_platform_rounding', value: 'up10' }, owner);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const c = await req('POST', '/api/business/settings', { key: 'delivery_platform_prices', value: { cash: { kind: 'percent', value: 12 } } }, owner);
    assert.equal(c.status, 400);
    const d = await req('POST', '/api/business/settings', { key: 'delivery_platform_rounding', value: 'up3' }, owner);
    assert.equal(d.status, 400);
  });
  await ok('a branch\'s own platform prices (settings.payments); the rounding is not per branch', async () => {
    const a = await req('POST', `/api/branches/${BR}/settings`, { key: 'delivery_platform_prices', value: '{"glovo":{"kind":"amount","value":100}}' }, owner);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await req('POST', `/api/branches/${BR}/settings`, { key: 'delivery_platform_rounding', value: 'up5' }, owner);
    assert.equal(b.status, 400);
    const c = await req('POST', `/api/branches/${BR}/settings`, { key: 'delivery_platform_prices', value: '{"glovo":{"kind":"percent","value":900}}' }, owner);
    assert.equal(c.status, 400);
  });
  await ok('the settings are readable back on the settings screens', async () => {
    const r = await req('GET', '/api/business/settings', null, owner);
    assert.ok(r.body.some((s) => s.key === 'delivery_platform_prices') && r.body.some((s) => s.key === 'delivery_platform_rounding'), JSON.stringify(r.body));
  });

  console.log('\nReports — sales by platform as now, plus "of which uplift"\n');
  await ok('the master report\'s Glovo row says what Glovo prices added in the period', async () => {
    const r = await req('GET', '/api/reports/master?from=2026-11-01&to=2026-11-01', null, owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const glovo = r.body.payments.find((p) => p.method === 'glovo');
    const expected = mem.db.orders.filter((o) => o.price_list === 'glovo' && o.status === 'completed').reduce((s, o) => s + Number(o.platform_uplift || 0), 0);
    assert.ok(expected > 0); assert.equal(glovo.uplift, expected);
    assert.equal(r.body.payments.find((p) => p.method === 'cash')?.uplift, undefined);
  });
  await ok('…and before migration 187 the report answers as before (no uplift)', async () => {
    mem.fail = (t, op, _f, _p, cols) => (t === 'orders' && /price_list/.test(String(cols)) ? { code: '42703', message: 'column "price_list" does not exist' } : null);
    const r = await req('GET', '/api/reports/master?from=2026-11-01&to=2026-11-01', null, owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.payments.find((p) => p.method === 'glovo')?.uplift, undefined);
    mem.fail = () => null;
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
