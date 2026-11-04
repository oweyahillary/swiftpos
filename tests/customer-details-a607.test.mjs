/**
 * customer-details-a607.test.mjs — A607: customer details at the counter, the cloud's and the web POS's half.
 *
 * Owner, 2026-10-28: "a feature where clients details can be captured by the cashier both on the main screen and the second
 * screen also, and if mpesa integration is available the client can key in their mpesa, if KRA is integrated they can key
 * in KRA pin etc" — "should work for both main and second screen".
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/customer-details-a607.test.mjs
 *
 * RUNS the COMPILED server — routes/index.js behind the REAL requireAuth — over HTTP on the in-memory database
 * (tests/lib-memdb.mjs; create_order_atomic as the A602 test models it), with a stand-in KRA eTIMS (ETIMS_PROVIDER=vscu,
 * ETIMS_BASE_URL → a local server that records what it is sent) and a stand-in Daraja (Safaricom's addresses answered in
 * the process); and the REAL web POS channel (lib/customerScreenChannel.ts) and form (packages/ui CustomerAskForm.tsx), bundled.
 *
 *   1 the sale's buyer PIN: stored (upper case) by POST /api/orders and by /pay; a malformed one refused 400 BAD_BUYER_PIN and
 *     nothing written; the history backfill drops one instead (an old sale is never refused) and still never fiscalises.
 *   2 KRA eTIMS custTin: the sale's PIN, else the attached customer's kra_pin, else null — end to end (the sale → the
 *     invoice → the stand-in KRA), and a database before migration 181 still fiscalises (no PIN).
 *   3 consent: a sale with the customer's details but no "save" makes NO customer record (the phone is not on the sale).
 *   4 the desktop POS's M-Pesa prompt (POST /api/mpesa/stk-push-pos): from a POS's own session; the amount rounded up,
 *     the number normalised, kept in mpesa_stk_requests BEFORE Safaricom is asked; the callback completes it (a shortfall
 *     refused, a replay ignored, a decline failed) and /status answers it (the payer masked for someone without
 *     customers.contacts); 400 / 422 / 403 as they should; the web's /stk-push contract unchanged.
 *   5 /api/pos/init tells the POS eTIMS is on (etimsEnabled).
 *   6 the web POS: the customer screen window's form round trip over the BroadcastChannel (only the typed fields, checked
 *     by the POS window, only to the open request) and the M-Pesa prompt shown on the customer screen (no phone).
 *
 * MUTATIONS TO CONFIRM BITE (each made in src, rebuilt, seen to fail, reverted and checked byte for byte — A607 entry).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const out = console.log.bind(console);
const ok = async (n, f) => { try { await f(); pass++; out(`PASS  ${n}`); } catch (e) { fail++; out(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/orders.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

// ── The stand-in KRA (before the server is loaded: it reads ETIMS_BASE_URL once) ──────────────────────────────────────
const kra = { got: [] };
const kraSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { try { kra.got.push(JSON.parse(b)); } catch { /* */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ resultCd: '000', resultMsg: 'ok', data: { curRcptNo: String(kra.got.length), rcptSign: 'SIG', intrlData: 'INT' } })); });
});
await new Promise((r) => kraSrv.listen(0, '127.0.0.1', r));
process.env.ETIMS_PROVIDER = 'vscu';
process.env.ETIMS_BASE_URL = `http://127.0.0.1:${kraSrv.address().port}`;
delete process.env.MPESA_ENVIRONMENT;   // sandbox: the callback's IP allow-list is not applied (as on a developer's PC)
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
delete process.env.DESKTOP_ONLY_CUTOFF_AT; delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.RESEND_API_KEY; delete process.env.SENDGRID_API_KEY; delete process.env.SMTP_HOST;

// ── The stand-in Daraja: Safaricom's addresses answered here; everything else is the real fetch ──────────────────────
const daraja = { pushes: [], answer: { ResponseCode: '0', CheckoutRequestID: 'ws_CO_A607_1', MerchantRequestID: 'm1', ResponseDescription: 'Success' } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://sandbox.safaricom.co.ke') || u.startsWith('https://api.safaricom.co.ke')) {
    if (u.includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    daraja.pushes.push(JSON.parse(String(init.body ?? '{}')));
    return new Response(JSON.stringify(daraja.answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
supabase.auth.admin.getUserById = async () => ({ data: null, error: { message: 'no user' } });
const BF = require(path.join(DIST, 'lib/backfill.js'));
const ET = require(path.join(DIST, 'lib/etims/index.js'));
const CDT = require('@zaptill/core/customerDetails');   // shared-components batch E: packages/core
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const PI = require(path.join(DIST, 'lib/posInit.js'));
const SV = require(path.join(DIST, 'lib/syncVersions.js'));

const uuid = () => crypto.randomUUID();
const B = '11111111-1111-4111-8111-1111111111a7', BR = '22222222-2222-4222-8222-2222222222a7';
const CASH = 'cccccccc-0000-4000-8000-0000000000a7', OWNER = 'aaaaaaaa-0000-4000-8000-0000000000a7';
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000b1', CUST = 'dddddddd-0000-4000-8000-0000000000a7';
const reset = ({ etims = true, mpesa = true } = {}) => {
  mem.fail = () => null; mem.latency = () => 0; mem.rowCap = Infinity; mem.calls = [];
  kra.got = []; daraja.pushes = [];
  mem.db = {
    businesses: [{ id: B, name: 'Kifaru Mart', owner_id: OWNER, status: 'active', currency: 'KES', vat_rate: 16, ctl_rate: 0, type: 'retail', tax_pin: 'P051234567X', web_access_expires_at: null, created_at: '2026-01-01T00:00:00Z' }],
    branches: [{ id: BR, business_id: B, name: 'Main', status: 'active', desktop_licensed: true, is_main: true }],
    cloud_plans: [], feature_flags: etims ? [{ business_id: B, key: 'etims_enabled', enabled: true }, { business_id: B, key: 'web_hosting', enabled: true }] : [{ business_id: B, key: 'web_hosting', enabled: true }],
    etims_branch_config: [{ id: 'ec-1', business_id: B, branch_id: BR, environment: 'sandbox', mode: 'vscu', bhf_id: '00', device_serial: 'S1', cmc_key: null, sdc_id: null, last_invoice_no: 0, status: 'registered' }],
    etims_invoices: [],
    business_settings: mpesa ? [
      { business_id: B, key: 'mpesa_consumer_key', value: 'ck' }, { business_id: B, key: 'mpesa_consumer_secret', value: 'cs' },
      { business_id: B, key: 'mpesa_shortcode', value: '174379' }, { business_id: B, key: 'mpesa_passkey', value: 'pk' },
      { business_id: B, key: 'mpesa_type', value: 'CustomerBuyGoodsOnline' }] : [],
    branch_settings: [], cloud_payments: [], invoices: [], cloud_plan_reminders: [],
    users: [{ id: CASH, business_id: B, name: 'Cate', status: 'active', permissions_version: 0, user_branches: [{ branch_id: BR }], roles: { name: 'Cashier' }, user_permissions: [] },
      { id: OWNER, business_id: B, name: 'Owner', status: 'active', permissions_version: 0, user_branches: [], roles: { name: 'Admin' }, user_permissions: [] }],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, device_role: 'till' }],
    products: [{ id: P1, business_id: B, name: 'Bread', base_price: 65, category_id: null, status: 'active', tax_type: 'B' }],
    customers: [{ id: CUST, business_id: B, name: 'Mary Wanjiku', phone: '0712345678', kra_pin: 'A111111111B' }],
    variant_groups: [], modifier_groups: [], branch_prices: [], change_requests: [], order_items: [], payments: [], orders: [],
    order_price_variances: [], kitchen_tickets: [], shifts: [], business_days: [], float_transactions: [], expenses: [], kitchen_voids: [],
    stock_levels: [], stock_movements: [], offers: [], promotions: [], roles: [], role_permissions: [], permissions: [], user_permissions: [],
    mpesa_stk_requests: [], payment_exceptions: [], loyalty_transactions: [], sync_versions: [], sync_changes: [], sync_change_floor: [{ id: 1, floor_seq: 0 }],
    categories: [], tables: [], combo_items: [], menus: [], stock_takes: [], business_branding: [], branch_branding: [], audit_log: [], notifications: [], ops_events: [],
  };
  AC._resetAuthCache?.(); PI._resetInitCache?.(); SV._resetSyncVersions?.();
};
mem.rpc = async (fn, args) => {
  if (fn !== 'create_order_atomic') return { data: null, error: null };
  const o = args.p_order;
  const due = Number(o.total) + Number(o.tip_amount || 0) + (o.delivery_free ? 0 : Number(o.delivery_fee || 0));
  const paid = args.p_payments.reduce((s, l) => s + Number(l.amount), 0);
  if (Math.abs(paid - due) > 0.005) return { data: null, error: { code: 'P0001', message: `payment legs sum to ${paid} but the amount due is ${due}` } };
  if (mem.db.orders.some((x) => x.business_id === o.business_id && x.idempotency_key === o.idempotency_key)) return { data: null, error: { code: '23505', message: 'duplicate key orders_idempotency' } };
  const id = uuid();
  mem.db.orders.push({ id, ...o, status: 'completed' });
  for (const it of args.p_items) mem.db.order_items.push({ id: uuid(), order_id: id, product_name: it.item?.product_name ?? 'Bread', quantity: 1, unit_price: 65, subtotal: 65, product_id: P1, ...it.item });
  for (const p of args.p_payments) mem.db.payments.push({ id: uuid(), order_id: id, business_id: o.business_id, ...p });
  return { data: [{ order_id: id, order_number: o.order_number }], error: null };
};

const express = require('express');
const app = express();
app.use('/api/sync/backfill', BF.backfillBodyParser);
app.use(express.json({ limit: '1mb' }));
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const sign = (p) => jwt.sign({ permissionsVersion: 0, sessionId: 's', businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const TILL = sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' });
const WEB = sign({ userId: CASH, permissionKeys: ['orders.create'], surface: 'dashboard' });
const MANAGER = sign({ userId: OWNER, permissionKeys: ['orders.create', 'customers.view', 'customers.contacts'], surface: 'dashboard' });
const NOSELL = sign({ userId: CASH, permissionKeys: ['reports.view'], surface: 'dashboard' });
const call = async (method, p, token, body, headers = {}) => {
  const r = await realFetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-device-id': 'dev-T1', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json, text };
};
let seq = 0;
const sale = (extra = {}) => ({ branch_id: BR, order_number: `T1-${++seq}`, order_type: 'retail',
  items: [{ product: { id: P1, name: 'Bread' }, quantity: 1, unitPrice: 65, lineTotal: 65 }],
  subtotal: 65, total: 65, payments: [{ method: 'cash', amount: 65, amount_tendered: 100, change_given: 35 }], ...extra });
const settle = () => new Promise((r) => setTimeout(r, 120));   // fiscalisation is fire-and-forget
const orderBy = (id) => mem.db.orders.find((o) => o.id === id);

console.log = () => {}; console.warn = () => {}; console.error = () => {};
try {
  state._setPermissionsMigrated(true);

  out('\n1. The sale\'s buyer KRA PIN\n');
  await ok('POST /api/orders keeps the PIN (upper case) on the order', async () => {
    reset();
    const r = await call('POST', '/api/orders', WEB, sale({ buyer_kra_pin: 'a123456789z', customer_name: 'Walk-in Mary' }), { 'x-idempotency-key': uuid() });
    assert.equal(r.status, 201, r.text);
    assert.equal(orderBy(r.body.orderId).buyer_kra_pin, 'A123456789Z');
  });
  await ok('a malformed PIN is refused 400 BAD_BUYER_PIN — and nothing is written', async () => {
    reset();
    for (const bad of ['B123456789Z', 'A12345678Z', '123', 'A123456789']) {
      const r = await call('POST', '/api/orders', WEB, sale({ buyer_kra_pin: bad }), { 'x-idempotency-key': uuid() });
      assert.equal(r.status, 400, `${bad}: ${r.text}`); assert.equal(r.body.code, 'BAD_BUYER_PIN');
    }
    assert.equal(mem.db.orders.length, 0);
  });
  await ok('no PIN (or an empty one) → none, as before', async () => {
    reset();
    const a = await call('POST', '/api/orders', WEB, sale(), { 'x-idempotency-key': uuid() });
    const b = await call('POST', '/api/orders', WEB, sale({ buyer_kra_pin: '' }), { 'x-idempotency-key': uuid() });
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    assert.equal(orderBy(a.body.orderId).buyer_kra_pin ?? null, null); assert.equal(orderBy(b.body.orderId).buyer_kra_pin ?? null, null);
  });
  await ok('a desktop POS\'s own session syncing its sale: the PIN comes with it', async () => {
    reset();
    const id = uuid();
    const r = await call('POST', '/api/orders', TILL, sale({ buyer_kra_pin: 'P051234567X', idempotency_key: id }), { 'x-idempotency-key': id });
    assert.equal(r.status, 201, r.text);
    assert.equal(orderBy(r.body.orderId).buyer_kra_pin, 'P051234567X');
  });
  await ok('/pay (an order already open — a restaurant\'s bill) takes the PIN too; a bad one is refused', async () => {
    reset();
    const id = uuid();
    mem.db.orders.push({ id, business_id: B, branch_id: BR, order_number: 'T1-OPEN', order_type: 'dine_in', status: 'open', subtotal: 65, total: 65, discount_amount: 0, tip_amount: 0, vat_amount: 8.97 });
    const bad = await call('POST', `/api/orders/${id}/pay`, WEB, { payments: [{ method: 'cash', amount: 65 }], buyer_kra_pin: 'X' });
    assert.equal(bad.status, 400); assert.equal(bad.body.code, 'BAD_BUYER_PIN');
    const r = await call('POST', `/api/orders/${id}/pay`, WEB, { payments: [{ method: 'cash', amount: 65 }], buyer_kra_pin: 'A123456789Z' });
    assert.equal(r.status, 200, r.text);
    assert.equal(orderBy(id).buyer_kra_pin, 'A123456789Z');
  });
  await ok('the history backfill: a malformed PIN is dropped (the old sale is kept), and NOTHING is sent to KRA', async () => {
    await settle();   // the /pay above sends its invoice in the background
    reset();
    const ids = [uuid(), uuid()];
    const SHIFT = uuid(), DAYID = uuid();
    const r = await call('POST', '/api/sync/backfill', TILL, {
      orders: [{ id: ids[0], body: sale({ buyer_kra_pin: 'not-a-pin', shift_id: SHIFT, created_at: '2025-11-02T09:00:00Z', device_id: 'dev-T1' }) },
        { id: ids[1], body: sale({ buyer_kra_pin: 'A123456789Z', shift_id: SHIFT, created_at: '2025-11-02T10:00:00Z', device_id: 'dev-T1' }) }],
      business_days: [{ id: DAYID, business_id: B, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', business_date: '2025-11-02', opened_at: '2025-11-02T06:00:00Z', status: 'closed', closed_at: '2025-11-02T20:00:00Z' }],
      shifts: [{ id: SHIFT, business_id: B, branch_id: BR, cashier_id: CASH, opened_at: '2025-11-02T06:05:00Z', closed_at: '2025-11-02T19:55:00Z', status: 'closed', opening_float: 0, business_day_id: DAYID, business_date: '2025-11-02', device_id: 'dev-T1', terminal_code: 'T1', created_at: '2025-11-02T06:05:00Z' }],
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.results.map((x) => x.status), ['accepted', 'accepted'], r.text);
    await settle();
    const o0 = mem.db.orders.find((o) => o.idempotency_key === ids[0]), o1 = mem.db.orders.find((o) => o.idempotency_key === ids[1]);
    assert.equal(o0.buyer_kra_pin ?? null, null, 'the bad PIN dropped');
    assert.equal(o1.buyer_kra_pin, 'A123456789Z', 'a good PIN kept');
    assert.equal(mem.db.etims_invoices.length, 0, 'no invoice row'); assert.equal(kra.got.length, 0, 'nothing sent to KRA');
  });

  out('\n2. KRA eTIMS: the buyer\'s PIN as custTin\n');
  await ok('a sale with its own PIN → KRA gets it as custTin (both places in the payload)', async () => {
    reset();
    const r = await call('POST', '/api/orders', WEB, sale({ buyer_kra_pin: 'A123456789Z', customer_id: CUST }), { 'x-idempotency-key': uuid() });
    assert.equal(r.status, 201, r.text);
    await settle();
    assert.equal(kra.got.length, 1, JSON.stringify(mem.db.etims_invoices));
    assert.equal(kra.got[0].custTin, 'A123456789Z', 'the sale\'s PIN wins over the customer\'s');
    assert.equal(kra.got[0].receipt.custTin, 'A123456789Z');
  });
  await ok('no sale PIN, a customer attached with one → the customer\'s kra_pin', async () => {
    reset();
    const r = await call('POST', '/api/orders', WEB, sale({ customer_id: CUST }), { 'x-idempotency-key': uuid() });
    assert.equal(r.status, 201, r.text);
    await settle();
    assert.equal(kra.got[0]?.custTin, 'A111111111B');
  });
  await ok('neither → null (as before A607)', async () => {
    reset();
    await call('POST', '/api/orders', WEB, sale(), { 'x-idempotency-key': uuid() });
    await settle();
    assert.equal(kra.got.length, 1); assert.equal(kra.got[0].custTin, null); assert.equal(kra.got[0].receipt.custTin, null);
  });
  await ok('a customer whose stored PIN is not valid → null (only a valid PIN is ever sent)', async () => {
    reset();
    mem.db.customers[0].kra_pin = 'A•••B';
    const id = uuid();
    mem.db.orders.push({ id, business_id: B, branch_id: BR, customer_id: CUST, buyer_kra_pin: null });
    assert.equal(await ET.buyerPinFor(id), null);
  });
  await ok('a database before migration 181 (no buyer_kra_pin column): the customer\'s PIN still found, the invoice still sent', async () => {
    reset();
    const id = uuid();
    mem.db.orders.push({ id, business_id: B, branch_id: BR, customer_id: CUST });
    mem.fail = (table, op, _f, _p, cols) => (table === 'orders' && op === 'select' && String(cols).includes('buyer_kra_pin') ? { code: '42703', message: 'column orders.buyer_kra_pin does not exist' } : null);
    assert.equal(await ET.buyerPinFor(id), 'A111111111B');
  });

  out('\n3. Consent: no customer record without "save"\n');
  await ok('the details used for this sale only (name, PIN; no customer_id, no phone) → no customers row is made', async () => {
    reset();
    const plan = CDT.consentPlan({ name: 'Walk-in John', phone: '254722000111', kraPin: 'A222222222C', save: false }, true);
    assert.equal(plan.saveCustomer, null);
    const before = mem.db.customers.length;
    const r = await call('POST', '/api/orders', WEB, sale(plan.sale), { 'x-idempotency-key': uuid() });
    assert.equal(r.status, 201, r.text);
    assert.equal(mem.db.customers.length, before, 'no customer record');
    const o = orderBy(r.body.orderId);
    assert.equal(o.customer_name, 'Walk-in John'); assert.equal(o.buyer_kra_pin, 'A222222222C'); assert.equal(o.customer_phone ?? null, null, 'the phone is not kept on the sale');
  });
  await ok('"Save my details for next time" → the plan makes the record (the POS then saves it with the person\'s own sign-in)', async () => {
    const plan = CDT.consentPlan({ name: 'Walk-in John', phone: '254722000111', kraPin: 'A222222222C', save: true }, true);
    assert.deepEqual(plan.saveCustomer, { name: 'Walk-in John', phone: '254722000111', kra_pin: 'A222222222C' });
  });

  out('\n4. The desktop POS\'s M-Pesa prompt\n');
  await ok('a POS\'s own session: the prompt is sent — whole shillings rounded up, the number normalised, kept BEFORE Safaricom is asked', async () => {
    reset();
    let rowsAtPush = -1;
    const realAns = daraja.answer;
    daraja.answer = new Proxy(realAns, { get: (t, k) => { if (k === 'ResponseCode') rowsAtPush = mem.db.mpesa_stk_requests.length; return t[k]; } });
    const r = await call('POST', '/api/mpesa/stk-push-pos', TILL, { phone: '0712 345 678', amount: 449.3, client_ref: 'POS-ABC' });
    daraja.answer = realAns;
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.checkoutRequestId, 'ws_CO_A607_1');
    assert.equal(daraja.pushes.length, 1);
    assert.equal(daraja.pushes[0].Amount, 450); assert.equal(daraja.pushes[0].PhoneNumber, '254712345678'); assert.equal(daraja.pushes[0].PartyA, '254712345678');
    assert.equal(daraja.pushes[0].AccountReference, 'POS-ABC');
    assert.equal(rowsAtPush, 1, 'the row existed before Safaricom answered');
    const row = mem.db.mpesa_stk_requests[0];
    assert.deepEqual([row.business_id, row.branch_id, row.device_id, row.amount, row.mpesa_phone, row.status, row.mpesa_checkout_id, row.client_ref],
      [B, BR, 'dev-T1', 450, '254712345678', 'pending', 'ws_CO_A607_1', 'POS-ABC']);
  });
  await ok('/status while pending → pending; the callback completes it → completed with the M-Pesa receipt', async () => {
    let s = await call('GET', '/api/mpesa/status/ws_CO_A607_1', TILL);
    assert.equal(s.status, 200, s.text); assert.equal(s.body.status, 'pending');
    const cb = await call('POST', '/api/mpesa/callback', null, { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_A607_1', ResultCode: 0, ResultDesc: 'ok',
      CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'QJK7XT3L5P' }, { Name: 'Amount', Value: 450 }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } });
    assert.equal(cb.status, 200);
    await settle();
    s = await call('GET', '/api/mpesa/status/ws_CO_A607_1', TILL);
    assert.equal(s.body.status, 'completed', s.text); assert.equal(s.body.mpesaRef, 'QJK7XT3L5P');
    assert.equal(mem.db.mpesa_stk_requests[0].paid_amount, 450);
  });
  await ok('the payer\'s number: masked for the POS\'s own session and a cashier without customers.contacts, full with it', async () => {
    const till = await call('GET', '/api/mpesa/status/ws_CO_A607_1', TILL);
    const cashier = await call('GET', '/api/mpesa/status/ws_CO_A607_1', WEB);
    const mgr = await call('GET', '/api/mpesa/status/ws_CO_A607_1', MANAGER);
    assert.ok(String(till.body.phone).includes('•'), till.text); assert.ok(String(cashier.body.phone).includes('•'), cashier.text);
    assert.equal(mgr.body.phone, '254712345678', mgr.text);
  });
  await ok('a replayed callback changes nothing; a late failure never undoes the payment', async () => {
    await call('POST', '/api/mpesa/callback', null, { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_A607_1', ResultCode: 0, ResultDesc: 'ok',
      CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'OTHER00000' }, { Name: 'Amount', Value: 1 }] } } } });
    await call('POST', '/api/mpesa/callback', null, { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_A607_1', ResultCode: 1032, ResultDesc: 'cancelled' } } });
    await settle();
    const row = mem.db.mpesa_stk_requests[0];
    assert.deepEqual([row.status, row.reference], ['completed', 'QJK7XT3L5P']);
  });
  await ok('a shortfall is refused (failed, with why); a decline fails it; another business cannot read the checkout', async () => {
    reset();
    daraja.answer = { ...daraja.answer, CheckoutRequestID: 'ws_CO_A607_2' };
    await call('POST', '/api/mpesa/stk-push-pos', TILL, { phone: '0712345678', amount: 1000, client_ref: 'POS-2' });
    await call('POST', '/api/mpesa/callback', null, { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_A607_2', ResultCode: 0, ResultDesc: 'ok',
      CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'SHORT00001' }, { Name: 'Amount', Value: 10 }] } } } });
    await settle();
    assert.equal(mem.db.mpesa_stk_requests[0].status, 'failed'); assert.match(mem.db.mpesa_stk_requests[0].mpesa_result_desc, /mismatch/i);
    daraja.answer = { ...daraja.answer, CheckoutRequestID: 'ws_CO_A607_3' };
    await call('POST', '/api/mpesa/stk-push-pos', TILL, { phone: '0712345678', amount: 100, client_ref: 'POS-3' });
    await call('POST', '/api/mpesa/callback', null, { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_A607_3', ResultCode: 1032, ResultDesc: 'Request cancelled by user' } } });
    await settle();
    const s = await call('GET', '/api/mpesa/status/ws_CO_A607_3', TILL);
    assert.equal(s.body.status, 'failed'); assert.match(s.body.error, /cancelled/i);
    const other = sign({ userId: null, deviceId: 'dev-X', till: true, businessId: '99999999-9999-4999-8999-999999999999', branchId: BR, permissionKeys: ['*'], surface: 'desktop' });
    const x = await call('GET', '/api/mpesa/status/ws_CO_A607_3', other);
    assert.notEqual(x.body?.status, 'failed', 'another business never sees it');
    daraja.answer = { ...daraja.answer, CheckoutRequestID: 'ws_CO_A607_1' };
  });
  await ok('refused: a bad number / amount / reference 400; no M-Pesa integration 422 (and nothing kept); no sale rights 403', async () => {
    reset();
    for (const [body, code] of [[{ phone: '0812345678', amount: 100, client_ref: 'R' }, 'BAD_PHONE'], [{ phone: '0712345678', amount: 0, client_ref: 'R' }, 'BAD_AMOUNT'],
      [{ phone: '0712345678', amount: 250001, client_ref: 'R' }, 'BAD_AMOUNT'], [{ phone: '0712345678', amount: 10, client_ref: 'a b' }, 'BAD_REF']]) {
      const r = await call('POST', '/api/mpesa/stk-push-pos', TILL, body);
      assert.equal(r.status, 400, r.text); assert.equal(r.body.code, code);
    }
    reset({ mpesa: false });
    const nc = await call('POST', '/api/mpesa/stk-push-pos', TILL, { phone: '0712345678', amount: 10, client_ref: 'R' });
    assert.equal(nc.status, 422); assert.equal(nc.body.code, 'NOT_CONFIGURED');
    assert.equal(mem.db.mpesa_stk_requests.length, 0); assert.equal(daraja.pushes.length, 0);
    reset();
    const ns = await call('POST', '/api/mpesa/stk-push-pos', NOSELL, { phone: '0712345678', amount: 10, client_ref: 'R' });
    assert.equal(ns.status, 403, ns.text);
    const anon = await call('POST', '/api/mpesa/stk-push-pos', null, { phone: '0712345678', amount: 10, client_ref: 'R' });
    assert.equal(anon.status, 401);
  });
  await ok('the web\'s /stk-push is unchanged: order first (phone and order_id required)', async () => {
    reset();
    const r = await call('POST', '/api/mpesa/stk-push', WEB, { phone: '0712345678', amount: 100 });
    assert.equal(r.status, 400); assert.match(r.body.error, /order_id/);
  });

  out('\n5. /api/pos/init tells the POS eTIMS is on\n');
  await ok('etimsEnabled true with the flag on; false without', async () => {
    reset();
    let r = await call('GET', `/api/pos/init?branch_id=${BR}`, TILL);
    assert.equal(r.status, 200, r.text.slice(0, 300)); assert.equal(r.body.etimsEnabled, true);
    assert.ok(!('etims_enabled' in (r.body.posFeatures ?? {})), 'not mixed into the admin portal\'s POS switches');
    reset({ etims: false });
    r = await call('GET', `/api/pos/init?branch_id=${BR}`, TILL);
    assert.equal(r.body.etimsEnabled, false);
  });

  out('\n6. The web POS: both screens over the BroadcastChannel\n');
  {
    const esbuild = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('esbuild');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a607-web-'));
    const fwd = (p) => JSON.stringify(path.join(ROOT, p).split(path.sep).join('/'));
    const entry = path.join(tmp, 'entry.tsx');
    fs.writeFileSync(entry, `export * as CH from ${fwd('apps/dashboard/src/lib/customerScreenChannel.ts')};
export { default as Form, StkBanner } from ${fwd('packages/ui/src/CustomerAskForm.tsx')};
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';`);
    await esbuild.build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, 'web.cjs'), logLevel: 'silent',
      jsx: 'automatic', nodePaths: [path.join(ROOT, 'apps/dashboard/node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
    const W = require(path.join(tmp, 'web.cjs'));
    // A pair of channel ends (the POS window and the customer screen window), as a BroadcastChannel delivers.
    const pair = () => {
      const a = { sent: [], onmessage: null, postMessage(m) { this.sent.push(m); b.onmessage?.({ data: JSON.parse(JSON.stringify(m)) }); }, close() {} };
      const b = { got: [], onmessage: null, postMessage(m) { a.onmessage?.({ data: JSON.parse(JSON.stringify(m)) }); }, close() {} };
      b.onmessage = (e) => b.got.push(e.data);
      return { pos: a, screen: b };
    };
    let now = 1000;
    const { pos, screen } = pair();
    const pub = W.CH.createPublisher(pos, () => now);
    await ok('the customer screen says "here"; the POS then counts it as showing (and not 12 s later)', async () => {
      assert.equal(pub.showing(), false);
      screen.postMessage({ type: 'here' });
      assert.equal(pub.showing(), true);
      now += W.CH.HERE_MS + 1; assert.equal(pub.showing(), false);
      screen.postMessage({ type: 'here' });
    });
    const answers = [];
    pub.onAnswer((a) => answers.push(a));
    await ok('"Ask the customer": the customer screen gets the CLEANED request (no customer, staff or cart)', async () => {
      pub.ask({ id: 'ask-web001', purpose: 'details', needPin: true, amount: 650, currency: 'KES', customer: 'Mary', cashier: 'Cate', lines: [{ name: 'Bread' }] });
      const m = screen.got.filter((x) => x.type === 'ask').at(-1);
      assert.deepEqual(m.ask, { id: 'ask-web001', purpose: 'details', needPin: true, amount: 650, currency: 'KES' });
    });
    await ok('an answer to another request, or not a good one, never reaches the cashier', async () => {
      screen.postMessage({ type: 'answer', answer: { id: 'ask-other1', name: 'X', phone: '0712345678' } });
      screen.postMessage({ type: 'answer', answer: { id: 'ask-web001', phone: '0812' } });
      assert.equal(answers.length, 0);
    });
    await ok('a good answer: checked by the POS window — only the typed fields reach the cashier; the form leaves the screen', async () => {
      screen.postMessage({ type: 'answer', answer: { id: 'ask-web001', name: 'Mary', phone: '0712 345 678', kraPin: 'a123456789z', save: false, customer_id: 'c-x', discount: 50 } });
      assert.deepEqual(answers.at(-1), { id: 'ask-web001', answer: { id: 'ask-web001', name: 'Mary', phone: '254712345678', kraPin: 'A123456789Z', save: false } });
      assert.equal(screen.got.filter((x) => x.type === 'ask').at(-1).ask, null);
      screen.postMessage({ type: 'answer', answer: { id: 'ask-web001', name: 'Again' } });
      assert.equal(answers.length, 1, 'the closed request takes no second answer');
    });
    await ok('Skip → the cashier is told; a customer screen that opens late gets the open form and the prompt with "hello"', async () => {
      pub.ask({ id: 'ask-web002', purpose: 'mpesa', amount: 200, currency: 'KES' });
      screen.postMessage({ type: 'answer', answer: { id: 'ask-web002', skip: true } });
      assert.deepEqual(answers.at(-1), { id: 'ask-web002', skipped: true });
      pub.ask({ id: 'ask-web003', purpose: 'mpesa', amount: 200, currency: 'KES' });
      pub.stk({ stage: 'waiting', amount: 200, currency: 'KES', phone: '0712345678' });
      screen.got.length = 0;
      screen.postMessage({ type: 'hello' });
      assert.equal(screen.got.find((x) => x.type === 'ask')?.ask?.id, 'ask-web003');
      assert.equal(screen.got.find((x) => x.type === 'stk')?.stk?.stage, 'waiting');
    });
    await ok('the web M-Pesa prompt on the customer screen: the stage and the amount, never the phone', async () => {
      const s = pub.stk({ stage: 'failed', amount: 200, currency: 'KES', phone: '0712345678', reason: 'Request to 254712345678 cancelled' });
      assert.ok(!/0712|254712/.test(JSON.stringify(screen.got.filter((x) => x.type === 'stk'))), JSON.stringify(s));
      const banner = W.renderToStaticMarkup(W.createElement(W.StkBanner, { stk: { stage: 'waiting', amount: 200, currency: 'KES', reason: null } }));
      assert.match(banner, /Waiting for M-Pesa… \(check your phone\)/); assert.match(banner, /KES 200\.00/);
      assert.match(W.renderToStaticMarkup(W.createElement(W.StkBanner, { stk: { stage: 'paid', amount: 200, currency: 'KES', reason: null } })), /Paid ✓/);
      assert.equal(W.renderToStaticMarkup(W.createElement(W.StkBanner, { stk: { stage: 'idle', amount: 0, currency: 'KES', reason: null } })), '');
    });
    await ok('the web STK panel and the payment wire it: the number from the details, the progress to the customer screen', async () => {
      const panel = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/MpesaStkPanel.tsx'), 'utf8');
      const pay = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/PaymentModal.tsx'), 'utf8');
      assert.match(panel, /customerScreenPublisher\(\)\?\.stk\(\{ stage: STAGE\[mode\], amount: total, currency, reason: mode === 'failed' \? error : null \}\)/);
      assert.match(pay, /phone=\{buyer\?\.stkPhone\} masked=\{buyer\?\.masked\}/);
      assert.match(pay, /\.\.\.\(buyer\?\.sale\.buyer_kra_pin \? \{ buyer_kra_pin: buyer\.sale\.buyer_kra_pin \} : \{\}\)/);
      assert.match(pay, /buyerPin=\{buyer\?\.sale\.buyer_kra_pin\}/);
    });
    await ok('the web customer screen page shows the form when asked, checks it, and posts back only the typed fields', async () => {
      const page = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/CustomerDisplayWebPage.tsx'), 'utf8');
      assert.match(page, /chan\.postMessage\(\{ type: 'answer', answer: \{ id: ask\.id, name: v\.name, phone: v\.phone, kraPin: v\.kraPin, save: v\.save \} \}\)/);
      assert.match(page, /const c = cleanAnswer\(v, ask\);/);
    });
  }
} finally {
  server.close(); kraSrv.close();
  out(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
