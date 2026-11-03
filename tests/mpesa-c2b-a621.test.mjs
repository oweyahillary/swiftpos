/**
 * mpesa-c2b-a621.test.mjs — A621: M-Pesa payment notifications (Safaricom C2B).
 *
 * Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
 * directly; what the cashier gets is a notification of the payments done, then they match it to the bill." Decisions: the
 * cashier always TAPS (never matched by amount); premium (the online licence); the next desktop release. Proves:
 *   1 the rules (lib/c2b.ts): Safaricom's confirmation read (Kenyan time, a full phone number never kept, junk refused);
 *     the callback addresses (https, no word Safaricom refuses, a hex token that can never spell one); the list's order
 *     (exact amount and the bill's number first, never filtered); who may take a payment; the order's M-Pesa codes.
 *   2 the owner's routes (/api/mpesa/c2b-settings): the owner only; the licence; Register asks Safaricom with the branch's
 *     details and the STORE number for Buy Goods, keeps only the token's hash, saves only once Safaricom accepted; one
 *     branch per number; the sandbox test payment.
 *   3 Safaricom's calls (/api/payments/c2b/confirm|validate/:token): always "Accepted"; kept once per M-Pesa code; an
 *     unknown token, a branch switched off or a broken body keeps nothing; the branch's POSs rung, no other branch's.
 *   4 the POS routes: the list (its branch only, the best fit first, "unchanged" without a database read, nothing when not
 *     licensed); claim — the first POS wins, two at once exactly one; release only by the holder; an order's M-Pesa code
 *     marks the payment used; the owner's unmatched list.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/mpesa-c2b-a621.test.mjs
 *
 * RUNS the COMPILED server (routes/index.js) behind the REAL auth middleware over HTTP; the database in memory (lib-memdb),
 * Safaricom a stand-in (fetch).
 *
 * MUTATIONS TO CONFIRM BITE: claimPayment without .eq('status','received') → "two POSs at once: exactly one" fails;
 * keepPayment without ignoreDuplicates → "Safaricom's retry is one payment" fails; the register route saving the token
 * before Safaricom answered → "a refusal keeps the registration that worked" fails; ringMpesaPayment without the branch
 * check → "no other branch's POS" fails; maskPayerPhone returning the number → "never a full number" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const out = console.log.bind(console);
const ok = async (n, f) => { try { await f(); pass++; out(`PASS  ${n}`); } catch (e) { fail++; out(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/c2b.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

delete process.env.MPESA_ENVIRONMENT;   // sandbox (the server's)
process.env.MPESA_CALLBACK_BASE_URL = 'https://api.zaptill.example';
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
delete process.env.DESKTOP_ONLY_CUTOFF_AT; delete process.env.TELEGRAM_BOT_TOKEN;

// ── The stand-in Safaricom ───────────────────────────────────────────────────────────────────────────────────────────
const daraja = { registered: [], simulated: [], refuse: null };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://sandbox.safaricom.co.ke') && !u.startsWith('https://api.safaricom.co.ke')) return realFetch(url, init);
  if (u.includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: '3599' }), { status: 200 });
  const body = JSON.parse(String(init.body ?? '{}'));
  if (u.endsWith('/mpesa/c2b/v2/registerurl')) {
    daraja.registered.push({ url: u, body });
    if (daraja.refuse) return new Response(JSON.stringify({ errorCode: '500.003.1001', errorMessage: daraja.refuse }), { status: 400 });
    return new Response(JSON.stringify({ OriginatorCoversationID: 'x', ResponseCode: '0', ResponseDescription: 'Success' }), { status: 200 });
  }
  if (u.endsWith('/mpesa/c2b/v2/simulate')) {
    daraja.simulated.push({ url: u, body });
    return new Response(JSON.stringify({ ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
supabase.auth.admin.getUserById = async () => ({ data: null, error: { message: 'no user' } });
const C = require(path.join(DIST, 'lib/c2b.js'));
const ACT = require(path.join(DIST, 'lib/c2bActivity.js'));
const ACC = require(path.join(DIST, 'lib/c2bAccess.js'));
const ORD = require(path.join(DIST, 'lib/c2bOrders.js'));
const HUB = require(path.join(DIST, 'lib/liveHub.js'));
const { encryptSecret } = require(path.join(DIST, 'lib/crypto.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));

const B = '11111111-1111-4111-8111-1111111116a9', BR = '22222222-2222-4222-8222-2222222216a9', BR2 = '33333333-3333-4333-8333-3333333316a9';
const OWNER = 'aaaaaaaa-0000-4000-8000-0000000006a9', MGR = 'aaaaaaaa-0000-4000-8000-0000000016a9';
// Daraja details: the business's Paybill (Westlands uses it), Kilimani its own Buy Goods (store 600100, Till 163726).
const DEFAULT_SETTINGS = () => [
  { business_id: B, key: 'mpesa_consumer_key', value: 'ck-default-1234' }, { business_id: B, key: 'mpesa_consumer_secret', value: encryptSecret('cs-default') },
  { business_id: B, key: 'mpesa_shortcode', value: '174379' }, { business_id: B, key: 'mpesa_passkey', value: encryptSecret('pk-default') },
  { business_id: B, key: 'mpesa_type', value: 'CustomerPayBillOnline' }, { business_id: B, key: 'mpesa_environment', value: 'sandbox' },
];
const KILIMANI = () => ({ branch_id: BR2, business_id: B, type: 'CustomerBuyGoodsOnline', shortcode: '600100', till_number: '163726',
  consumer_key: 'ck-kilimani-5678', consumer_secret: encryptSecret('cs-kilimani'), passkey: encryptSecret('pk-kilimani'), environment: 'sandbox' });
const reset = ({ licensed = true } = {}) => {
  mem.fail = () => null; mem.latency = () => 0; mem.rowCap = Infinity; mem.calls = [];
  daraja.registered = []; daraja.simulated = []; daraja.refuse = null;
  mem.db = {
    businesses: [{ id: B, name: 'Kifaru Grill', owner_id: OWNER, status: 'active', currency: 'KES', type: 'restaurant', created_at: '2026-01-01T00:00:00Z' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', status: 'active', desktop_licensed: true, is_main: true },
      { id: BR2, business_id: B, name: 'Kilimani', status: 'active', desktop_licensed: true, is_main: false }],
    business_settings: DEFAULT_SETTINGS(), branch_settings: [], branch_mpesa_settings: [KILIMANI()],
    branch_c2b_settings: [], mpesa_c2b_payments: [],
    feature_flags: licensed ? [{ business_id: B, key: 'web_hosting', enabled: true }] : [],
    users: [{ id: OWNER, business_id: B, name: 'Wanjiru', status: 'active', permissions_version: 0, user_branches: [], roles: { name: 'Admin' }, user_permissions: [] },
      { id: MGR, business_id: B, name: 'Otieno', status: 'active', permissions_version: 0, user_branches: [{ branch_id: BR }], roles: { name: 'Manager' }, user_permissions: [] }],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, device_role: 'till' },
      { id: 'ud-3', business_id: B, device_id: 'dev-T3', status: 'approved', retired_at: null, branch_id: BR, device_role: 'till' },
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', status: 'approved', retired_at: null, branch_id: BR2, device_role: 'till' }],
    orders: [], payments: [], cloud_plans: [], branch_cloud_plans: [], notifications: [], audit_log: [],
  };
  AC._resetAuthCache?.(); ACC._resetC2bLicence(); ACT._resetC2bActivity();
};

const express = require('express');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const sign = (p) => jwt.sign({ permissionsVersion: 0, sessionId: 's', businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const OWNER_T = sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' });
const MANAGER_T = sign({ userId: MGR, permissionKeys: ['settings.business', 'orders.create', 'reports.payments'], surface: 'dashboard' });
const TILL_1 = sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' });
const TILL_3 = sign({ userId: null, deviceId: 'dev-T3', till: true, permissionKeys: ['*'], surface: 'desktop' });
const TILL_KIL = sign({ userId: null, deviceId: 'dev-T2', till: true, branchId: BR2, permissionKeys: ['*'], surface: 'desktop' });
const DEVICE_OF = new Map([[TILL_1, 'dev-T1'], [TILL_3, 'dev-T3'], [TILL_KIL, 'dev-T2']]);
const call = async (method, p, token, body) => {
  const r = await realFetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-device-id': DEVICE_OF.get(token) ?? 'dev-T1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json, text };
};
const confirmation = (o = {}) => ({ TransactionType: 'Pay Bill', TransID: 'QJK7XT3L5P', TransTime: '20261102143005', TransAmount: '1080.00',
  BusinessShortCode: '174379', BillRefNumber: 'T12', InvoiceNumber: '', OrgAccountBalance: '50000.00', ThirdPartyTransID: '',
  MSISDN: '2547 ***** 149', FirstName: 'John', MiddleName: '', LastName: '', ...o });
const payments = () => mem.db.mpesa_c2b_payments;
/** Westlands switched on and registered (the token returned, as Safaricom would call it). */
const registerWestlands = async () => {
  await call('PUT', `/api/mpesa/c2b-settings/branches/${BR}`, OWNER_T, { enabled: true });
  const r = await call('POST', `/api/mpesa/c2b-settings/branches/${BR}/register`, OWNER_T, {});
  assert.equal(r.status, 200, r.text);
  return daraja.registered.at(-1).body.ConfirmationURL.split('/').pop();
};
const pay = (token, o = {}) => call('POST', `/api/payments/c2b/confirm/${token}`, null, confirmation(o));

console.log = () => {}; console.warn = () => {}; console.error = () => {};
try {
  state._setPermissionsMigrated(true);

  out('\n1. The rules\n');
  await ok('a confirmation is read: the code, the amount, Kenyan time as an instant, the first name, the account number', async () => {
    const p = C.parseConfirmation(confirmation({ TransID: 'qjk7xt3l5p', FirstName: 'john' }));
    assert.deepEqual(p, { transId: 'QJK7XT3L5P', transType: 'Pay Bill', amount: 1080, transTime: '2026-11-02T11:30:05.000Z', shortcode: '174379',
      billRef: 'T12', firstName: 'JOHN', phoneMasked: '2547 ***** 149' });
  });
  await ok('junk is no payment: no code, no amount, a negative amount, no shortcode, not an object', async () => {
    assert.equal(C.parseConfirmation(confirmation({ TransID: '' })), null);
    assert.equal(C.parseConfirmation(confirmation({ TransAmount: 'abc' })), null);
    assert.equal(C.parseConfirmation(confirmation({ TransAmount: '-5' })), null);
    assert.equal(C.parseConfirmation(confirmation({ BusinessShortCode: '' })), null);
    assert.equal(C.parseConfirmation('hello'), null);
  });
  await ok('Kenyan time: a bad date is null (the payment is still kept)', async () => {
    assert.equal(C.kenyanTime('20261302143005'), null);
    assert.equal(C.kenyanTime('20260231120000'), null);
    assert.equal(C.kenyanTime(''), null);
    assert.equal(C.kenyanTime('20260101003000'), '2025-12-31T21:30:00.000Z');
  });
  await ok('never a full number: a full one is masked, a hash dropped, Safaricom\'s mask kept', async () => {
    assert.equal(C.maskPayerPhone('254712345149'), '071****149');
    assert.equal(C.maskPayerPhone('2547 ***** 149'), '2547 ***** 149');
    assert.equal(C.maskPayerPhone('a3f1c9e0b7d2'.repeat(5)), null);
    assert.equal(C.parseConfirmation(confirmation({ MSISDN: '254712345149' })).phoneMasked, '071****149');
  });
  await ok('the addresses: https, the paths Safaricom calls, no word it refuses', async () => {
    const t = C.newC2bToken();
    const u = C.c2bUrls('https://api.zaptill.example/', t);
    assert.equal(u.confirm, `https://api.zaptill.example/api/payments/c2b/confirm/${t}`);
    assert.equal(u.validate, `https://api.zaptill.example/api/payments/c2b/validate/${t}`);
    assert.match(C.c2bUrls('http://api.zaptill.example', t).error, /https/);
    assert.match(C.c2bUrls('https://mpesa-api.example', t).error, /"mpesa"/);
    assert.match(C.c2bUrls('https://x.ngrok.io/SQLrunner', t).error, /"sql"/);
  });
  await ok('a token is 48 hex characters and can never spell a refused word (2,000 drawn)', async () => {
    for (let i = 0; i < 2000; i++) {
      const t = C.newC2bToken();
      assert.ok(C.looksLikeToken(t)); assert.equal(C.forbiddenWordIn(t), null);
    }
    assert.match(C.hashC2bToken('abc'), /^[0-9a-f]{64}$/);
  });
  await ok('the list\'s order: exact amount and the bill\'s number, exact amount, the number, then newest — nothing dropped', async () => {
    const at = (m) => `2026-11-02T10:${String(m).padStart(2, '0')}:00Z`;
    const list = [
      { trans_id: 'A0000001', amount: 500, bill_ref: null, first_name: null, paid_at: at(9) },
      { trans_id: 'B0000002', amount: 1080, bill_ref: null, first_name: null, paid_at: at(5) },
      { trans_id: 'C0000003', amount: 200, bill_ref: 't12', first_name: null, paid_at: at(1) },
      { trans_id: 'D0000004', amount: 1080, bill_ref: 'T 12', first_name: null, paid_at: at(2) },
      { trans_id: 'E0000005', amount: 700, bill_ref: null, first_name: null, paid_at: at(8) },
    ];
    assert.deepEqual(C.sortForBill(list, 1080, 'T12').map((p) => p.trans_id), ['D0000004', 'B0000002', 'C0000003', 'A0000001', 'E0000005']);
    assert.deepEqual(C.sortForBill(list, null, null).map((p) => p.trans_id), ['A0000001', 'E0000005', 'B0000002', 'D0000004', 'C0000003']);
  });
  await ok('who may take a payment: waiting → yes; held by this POS → again; held by another → TAKEN; used → USED; none → 404', async () => {
    assert.equal(C.claimRefusal({ status: 'held', held_by: 'device:a', held_ref: 'x' }, 'device:a'), null);
    assert.equal(C.claimRefusal({ status: 'held', held_by: 'device:b', held_ref: 'x' }, 'device:a').code, 'TAKEN');
    assert.equal(C.claimRefusal({ status: 'used', held_by: null, held_ref: null }, 'device:a').code, 'USED');
    assert.equal(C.claimRefusal(null, 'device:a').status, 404);
    assert.equal(C.holderOf({ deviceId: 'dev-T1', userId: 'u' }), 'device:dev-T1');
    assert.equal(C.holderOf({ deviceId: null, userId: 'u' }), 'user:u');
  });
  await ok('an order\'s M-Pesa codes: M-Pesa legs only, cleaned, once each', async () => {
    assert.deepEqual(C.mpesaCodesOf([{ method: 'mpesa', reference: 'qjk7xt3l5p' }, { method: 'cash', reference: 'QJK7XT3L5Q' },
      { method: 'mpesa', reference: 'QJK7XT3L5P' }, { method: 'mpesa', reference: 'bad ref' }, { method: 'mpesa', reference: null }]), ['QJK7XT3L5P']);
  });
  await ok('the store number and the number registered: Buy Goods the store number typed, else the STK shortcode; Paybill the Paybill', async () => {
    assert.deepEqual(C.cleanStoreNumber(' 600 100 '), { ok: true, value: '600100' });
    assert.deepEqual(C.cleanStoreNumber(''), { ok: true, value: null });
    assert.match(C.cleanStoreNumber('12ab').error, /5 to 8 digits/);
    assert.equal(C.registerShortcode({ type: 'CustomerBuyGoodsOnline', shortcode: '600100' }, '600200'), '600200');
    assert.equal(C.registerShortcode({ type: 'CustomerBuyGoodsOnline', shortcode: '600100' }, null), '600100');
    assert.equal(C.registerShortcode({ type: 'CustomerPayBillOnline', shortcode: '174379' }, '600200'), '174379');
  });
  await ok('the unmatched list\'s days: today by default, up to 31 days, never backwards', async () => {
    assert.deepEqual(C.dayRange(undefined, undefined, '2026-11-03'), { from: '2026-11-03', to: '2026-11-03' });
    assert.deepEqual(C.dayRange('2026-10-04', '2026-11-03', 'x'), { from: '2026-10-04', to: '2026-11-03' });
    assert.equal(C.dayRange('2026-10-03', '2026-11-03', 'x'), null);
    assert.equal(C.dayRange('2026-11-04', '2026-11-03', 'x'), null);
  });

  out('\n2. The owner\'s settings\n');
  await ok('the owner sees every branch, its M-Pesa kind and the STK shortcode — never a token or its hash', async () => {
    reset();
    await registerWestlands();
    const r = await call('GET', '/api/mpesa/c2b-settings', OWNER_T);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.licensed, true); assert.equal(r.body.table, true);
    const kil = r.body.branches.find((b) => b.id === BR2), west = r.body.branches.find((b) => b.id === BR);
    assert.equal(kil.mpesaType, 'CustomerBuyGoodsOnline'); assert.equal(kil.stkShortcode, '600100');
    assert.equal(west.enabled, true); assert.equal(west.registeredShortcode, '174379');
    const hash = mem.db.branch_c2b_settings[0].token_hash;
    assert.ok(!r.text.includes(hash) && !/token/i.test(r.text));
  });
  await ok('a manager (even with settings.business) and a POS are refused', async () => {
    reset();
    assert.equal((await call('GET', '/api/mpesa/c2b-settings', MANAGER_T)).status, 403);
    assert.equal((await call('PUT', `/api/mpesa/c2b-settings/branches/${BR}`, MANAGER_T, { enabled: true })).status, 403);
    assert.equal((await call('POST', `/api/mpesa/c2b-settings/branches/${BR}/register`, TILL_1, {})).status, 403);
  });
  await ok('without the online licence: switching on and registering 403; switching off always allowed', async () => {
    reset({ licensed: false });
    const on = await call('PUT', `/api/mpesa/c2b-settings/branches/${BR}`, OWNER_T, { enabled: true });
    assert.equal(on.status, 403); assert.equal(on.body.code, 'C2B_NOT_LICENSED');
    assert.equal((await call('PUT', `/api/mpesa/c2b-settings/branches/${BR}`, OWNER_T, { enabled: false })).status, 200);
    assert.equal((await call('POST', `/api/mpesa/c2b-settings/branches/${BR}/register`, OWNER_T, {})).status, 403);
  });
  await ok('Register: Safaricom gets the Paybill, "Completed" and two https addresses with the token; only its hash is kept', async () => {
    reset();
    const token = await registerWestlands();
    const reg = daraja.registered[0];
    assert.equal(reg.url, 'https://sandbox.safaricom.co.ke/mpesa/c2b/v2/registerurl');
    assert.equal(reg.body.ShortCode, '174379'); assert.equal(reg.body.ResponseType, 'Completed');
    assert.equal(reg.body.ConfirmationURL, `https://api.zaptill.example/api/payments/c2b/confirm/${token}`);
    assert.equal(reg.body.ValidationURL, `https://api.zaptill.example/api/payments/c2b/validate/${token}`);
    for (const w of C.FORBIDDEN_URL_WORDS) assert.ok(!reg.body.ConfirmationURL.toLowerCase().includes(w), w);
    const row = mem.db.branch_c2b_settings.find((r) => r.branch_id === BR);
    assert.equal(row.token_hash, C.hashC2bToken(token));
    assert.ok(!JSON.stringify(mem.db.branch_c2b_settings).includes(token));
    assert.equal(row.registered_environment, 'sandbox');
  });
  await ok('Buy Goods registers the STORE number the owner typed (not the Till number)', async () => {
    reset();
    assert.equal((await call('PUT', `/api/mpesa/c2b-settings/branches/${BR2}`, OWNER_T, { enabled: true, store_number: '600222' })).status, 200);
    assert.equal((await call('POST', `/api/mpesa/c2b-settings/branches/${BR2}/register`, OWNER_T, {})).status, 200);
    assert.equal(daraja.registered[0].body.ShortCode, '600222');
  });
  await ok('switched off → Register refused; no Daraja details → refused', async () => {
    reset();
    assert.equal((await call('POST', `/api/mpesa/c2b-settings/branches/${BR}/register`, OWNER_T, {})).body.code, 'C2B_OFF');
    mem.db.business_settings = [];
    await call('PUT', `/api/mpesa/c2b-settings/branches/${BR}`, OWNER_T, { enabled: true });
    assert.equal((await call('POST', `/api/mpesa/c2b-settings/branches/${BR}/register`, OWNER_T, {})).body.code, 'NOT_CONFIGURED');
    assert.equal(daraja.registered.length, 0);
  });
  await ok('one branch per number: a second branch on the same Paybill is refused, naming the first', async () => {
    reset();
    await registerWestlands();
    mem.db.branch_mpesa_settings = [];   // Kilimani now uses the business Paybill too
    await call('PUT', `/api/mpesa/c2b-settings/branches/${BR2}`, OWNER_T, { enabled: true });
    const r = await call('POST', `/api/mpesa/c2b-settings/branches/${BR2}/register`, OWNER_T, {});
    assert.equal(r.status, 409); assert.equal(r.body.code, 'SHORTCODE_IN_USE'); assert.match(r.body.error, /Westlands/);
  });
  await ok('a refusal keeps the registration that worked, and Safaricom\'s words are saved for the screen', async () => {
    reset();
    const token = await registerWestlands();
    daraja.refuse = 'Urls are already registered';
    const r = await call('POST', `/api/mpesa/c2b-settings/branches/${BR}/register`, OWNER_T, {});
    assert.equal(r.status, 502); assert.match(r.body.error, /already registered/);
    const row = mem.db.branch_c2b_settings.find((x) => x.branch_id === BR);
    assert.equal(row.token_hash, C.hashC2bToken(token)); assert.match(row.last_error, /already registered/);
  });
  await ok('the sandbox test payment: from Safaricom\'s test number to the registered Paybill; refused before registering', async () => {
    reset();
    await call('PUT', `/api/mpesa/c2b-settings/branches/${BR}`, OWNER_T, { enabled: true });
    assert.equal((await call('POST', `/api/mpesa/c2b-settings/branches/${BR}/test-payment`, OWNER_T, {})).body.code, 'NOT_SANDBOX');
    await registerWestlands();
    const r = await call('POST', `/api/mpesa/c2b-settings/branches/${BR}/test-payment`, OWNER_T, { amount: 1, bill_ref: 'T12' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(daraja.simulated[0].body, { ShortCode: '174379', CommandID: 'CustomerPayBillOnline', Amount: 1, Msisdn: '254708374149', BillRefNumber: 'T12' });
  });
  await ok('Live details: no test payment', async () => {
    reset();
    mem.db.business_settings = mem.db.business_settings.map((r) => (r.key === 'mpesa_environment' ? { ...r, value: 'production' } : r));
    await registerWestlands();
    assert.equal(daraja.registered[0].url, 'https://api.safaricom.co.ke/mpesa/c2b/v2/registerurl');
    assert.equal((await call('POST', `/api/mpesa/c2b-settings/branches/${BR}/test-payment`, OWNER_T, {})).body.code, 'NOT_SANDBOX');
  });

  out('\n3. Safaricom\'s calls\n');
  await ok('a payment is kept once per M-Pesa code (Safaricom retries) and always answered "Accepted"', async () => {
    reset();
    const token = await registerWestlands();
    for (let i = 0; i < 3; i++) {
      const r = await pay(token);
      assert.equal(r.status, 200); assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    }
    assert.equal(payments().length, 1);
    const p = payments()[0];
    assert.equal(p.branch_id, BR); assert.equal(p.business_id, B); assert.equal(p.status, 'received'); assert.equal(p.amount, 1080);
    assert.equal(p.first_name, 'JOHN'); assert.equal(p.bill_ref, 'T12'); assert.equal(p.trans_time, '2026-11-02T11:30:05.000Z');
  });
  await ok('never a full phone number kept', async () => {
    reset();
    const token = await registerWestlands();
    await pay(token, { MSISDN: '254712345149' });
    assert.ok(!JSON.stringify(payments()).includes('254712345149'));
    assert.equal(payments()[0].phone_masked, '071****149');
  });
  await ok('an unknown or malformed token, a broken body, a branch switched off: "Accepted", nothing kept', async () => {
    reset();
    const token = await registerWestlands();
    assert.equal((await pay(C.newC2bToken())).body.ResultCode, 0);
    assert.equal((await pay('not-a-token')).body.ResultCode, 0);
    assert.equal((await call('POST', `/api/payments/c2b/confirm/${token}`, null, { hello: 1 })).body.ResultCode, 0);
    await call('PUT', `/api/mpesa/c2b-settings/branches/${BR}`, OWNER_T, { enabled: false });
    assert.equal((await pay(token)).body.ResultCode, 0);
    assert.equal(payments().length, 0);
  });
  await ok('the database failing: still "Accepted" (the money has moved), nothing claimed kept', async () => {
    reset();
    const token = await registerWestlands();
    mem.fail = (t, op) => (t === 'mpesa_c2b_payments' && op === 'upsert' ? { message: 'timeout', code: '57014' } : null);
    assert.deepEqual((await pay(token)).body, { ResultCode: 0, ResultDesc: 'Accepted' });
  });
  await ok('validation always accepts', async () => {
    const r = await call('POST', `/api/payments/c2b/validate/${C.newC2bToken()}`, null, confirmation());
    assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
  });
  await ok('the branch\'s POSs are rung — no other branch\'s, no socket naming no branch; a retry rings no one', async () => {
    reset();
    const token = await registerWestlands();
    const heard = { west: [], kil: [], none: [] };
    const off = [HUB._addTestConn(B, 'dev-T1', (m) => heard.west.push(m), BR), HUB._addTestConn(B, 'dev-T2', (m) => heard.kil.push(m), BR2),
      HUB._addTestConn(B, 'dev-X', (m) => heard.none.push(m), null)];
    await pay(token); await pay(token);
    off.forEach((f) => f());
    assert.deepEqual(heard.west, [{ type: 'mpesa_payment', trans_id: 'QJK7XT3L5P', amount: 1080, first_name: 'JOHN' }]);
    assert.equal(heard.kil.length, 0); assert.equal(heard.none.length, 0);
  });

  out('\n4. The POS\n');
  const seed = async () => {
    reset();
    const token = await registerWestlands();
    await pay(token, { TransID: 'AAA1111111', TransAmount: '500', BillRefNumber: '' });
    await pay(token, { TransID: 'BBB2222222', TransAmount: '1080', BillRefNumber: '', FirstName: 'Mary' });
    await pay(token, { TransID: 'CCC3333333', TransAmount: '1080', BillRefNumber: 'T12' });
    return token;
  };
  await ok('the list: this branch\'s waiting payments, the best fit for the bill first', async () => {
    await seed();
    const r = await call('GET', '/api/payments/c2b/recent?amount=1080&ref=T12', TILL_1);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.offered, true);
    assert.deepEqual(r.body.payments.map((p) => p.trans_id), ['CCC3333333', 'BBB2222222', 'AAA1111111']);
    assert.deepEqual(Object.keys(r.body.payments[0]).sort(), ['amount', 'bill_ref', 'first_name', 'paid_at', 'trans_id']);
  });
  await ok('another branch\'s POS sees none of them (Kilimani not switched on: not offered)', async () => {
    await seed();
    const r = await call('GET', '/api/payments/c2b/recent?amount=1080', TILL_KIL);
    assert.equal(r.body.offered, false); assert.deepEqual(r.body.payments, []);
  });
  await ok('nothing changed since the stamp → "unchanged", without reading the payments', async () => {
    await seed();
    const first = await call('GET', '/api/payments/c2b/recent?amount=1080', TILL_1);
    mem.calls = [];
    const again = await call('GET', `/api/payments/c2b/recent?amount=1080&since=${first.body.stamp}`, TILL_1);
    assert.equal(again.body.unchanged, true);
    assert.equal(mem.calls.filter((c) => c.table === 'mpesa_c2b_payments').length, 0);
  });
  await ok('a new payment after the stamp → read again, and it is there', async () => {
    const token = await seed();
    const first = await call('GET', '/api/payments/c2b/recent', TILL_1);
    await new Promise((r) => setTimeout(r, 5));
    await pay(token, { TransID: 'DDD4444444', TransAmount: '300' });
    const again = await call('GET', `/api/payments/c2b/recent?since=${first.body.stamp}`, TILL_1);
    assert.equal(again.body.unchanged, undefined);
    assert.ok(again.body.payments.some((p) => p.trans_id === 'DDD4444444'));
  });
  await ok('not licensed → not offered (the payments still arrive for the owner\'s list)', async () => {
    await seed();
    mem.db.feature_flags = []; ACC._resetC2bLicence();
    const r = await call('GET', '/api/payments/c2b/recent', TILL_1);
    assert.equal(r.body.offered, false);
    assert.equal((await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'AAA1111111', sale_ref: 'PAY-1' })).status, 403);
  });
  await ok('claim: the first POS takes it; the second is told plainly; it leaves every list', async () => {
    await seed();
    const a = await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'BBB2222222', sale_ref: 'PAY-1' });
    assert.equal(a.status, 200, a.text); assert.equal(a.body.payment.trans_id, 'BBB2222222'); assert.equal(a.body.payment.amount, 1080);
    const b = await call('POST', '/api/payments/c2b/claim', TILL_3, { trans_id: 'BBB2222222', sale_ref: 'PAY-9' });
    assert.equal(b.status, 409); assert.equal(b.body.code, 'TAKEN'); assert.match(b.body.error, /Another POS/);
    const row = payments().find((p) => p.trans_id === 'BBB2222222');
    assert.equal(row.status, 'held'); assert.equal(row.held_by, 'device:dev-T1'); assert.equal(row.held_ref, 'PAY-1');
    const list = await call('GET', '/api/payments/c2b/recent', TILL_3);
    assert.ok(!list.body.payments.some((p) => p.trans_id === 'BBB2222222'));
  });
  await ok('two POSs tapping the same payment at once: exactly one gets it', async () => {
    await seed();
    const [x, y] = await Promise.all([
      call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'AAA1111111', sale_ref: 'PAY-1' }),
      call('POST', '/api/payments/c2b/claim', TILL_3, { trans_id: 'AAA1111111', sale_ref: 'PAY-2' }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  });
  await ok('the same POS tapping again (a retry, a restart) keeps it for the new sale', async () => {
    await seed();
    await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'AAA1111111', sale_ref: 'PAY-1' });
    const again = await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'AAA1111111', sale_ref: 'PAY-2' });
    assert.equal(again.status, 200);
    assert.equal(payments().find((p) => p.trans_id === 'AAA1111111').held_ref, 'PAY-2');
  });
  await ok('another branch\'s POS cannot take it; an unknown code 404; a bad body 400', async () => {
    await seed();
    assert.equal((await call('POST', '/api/payments/c2b/claim', TILL_KIL, { trans_id: 'AAA1111111', sale_ref: 'PAY-1' })).status, 404);
    assert.equal((await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'ZZZ9999999', sale_ref: 'PAY-1' })).status, 404);
    assert.equal((await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'AAA1111111' })).status, 400);
  });
  await ok('release: only the POS that holds it, for the same sale — then any POS can take it', async () => {
    await seed();
    await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'AAA1111111', sale_ref: 'PAY-1' });
    assert.equal((await call('POST', '/api/payments/c2b/release', TILL_3, { trans_id: 'AAA1111111', sale_ref: 'PAY-1' })).body.released, false);
    assert.equal((await call('POST', '/api/payments/c2b/release', TILL_1, { trans_id: 'AAA1111111', sale_ref: 'PAY-OTHER' })).body.released, false);
    assert.equal((await call('POST', '/api/payments/c2b/release', TILL_1, { trans_id: 'AAA1111111', sale_ref: 'PAY-1' })).body.released, true);
    const row = payments().find((p) => p.trans_id === 'AAA1111111');
    assert.equal(row.status, 'received'); assert.equal(row.held_by, null);
    assert.equal((await call('POST', '/api/payments/c2b/claim', TILL_3, { trans_id: 'AAA1111111', sale_ref: 'PAY-3' })).status, 200);
  });
  // Owner, 2026-11-03: a payment held by a POS whose sale never reached the cloud — the owner gives it back.
  await ok('the owner releases a held payment (any holder); a manager or a POS cannot; a payment not held is 409', async () => {
    await seed();
    await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'AAA1111111', sale_ref: 'PAY-1' });
    const releasePath = '/api/mpesa/c2b-settings/payments/AAA1111111/release';
    assert.equal((await call('POST', releasePath, MANAGER_T, {})).status, 403);
    assert.equal((await call('POST', releasePath, TILL_1, {})).status, 403);
    assert.equal((await call('POST', releasePath, OWNER_T, {})).status, 200);
    const row = payments().find((p) => p.trans_id === 'AAA1111111');
    assert.equal(row.status, 'received'); assert.equal(row.held_by, null);
    assert.equal((await call('POST', releasePath, OWNER_T, {})).body.code, 'NOT_HELD');
    assert.equal((await call('POST', '/api/mpesa/c2b-settings/payments/not-a-code/release', OWNER_T, {})).status, 400);
    assert.equal((await call('POST', '/api/payments/c2b/claim', TILL_3, { trans_id: 'AAA1111111', sale_ref: 'PAY-3' })).status, 200);
  });
  await ok('an order carrying the code marks it used — tapped or typed by hand — and a used one cannot be taken', async () => {
    await seed();
    await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'BBB2222222', sale_ref: 'PAY-1' });
    await ORD.markOrderPayments(B, 'order-1', [{ method: 'mpesa', reference: 'BBB2222222' }, { method: 'mpesa', reference: 'ccc3333333' }, { method: 'cash', reference: 'AAA1111111' }]);
    const by = (id) => payments().find((p) => p.trans_id === id);
    assert.equal(by('BBB2222222').status, 'used'); assert.equal(by('BBB2222222').order_id, 'order-1');
    assert.equal(by('CCC3333333').status, 'used');
    assert.equal(by('AAA1111111').status, 'received');
    const r = await call('POST', '/api/payments/c2b/claim', TILL_3, { trans_id: 'CCC3333333', sale_ref: 'PAY-2' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'USED');
  });
  await ok('marking used never throws (the database failing, the table missing)', async () => {
    await seed();
    mem.fail = (t, op) => (t === 'mpesa_c2b_payments' && op === 'update' ? { message: 'relation "mpesa_c2b_payments" does not exist', code: '42P01' } : null);
    await ORD.markOrderPayments(B, 'order-1', [{ method: 'mpesa', reference: 'BBB2222222' }]);
  });
  await ok('both order paths call it (the sale and the payment of an open bill)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/orders.ts'), 'utf8');
    assert.equal((src.match(/await markOrderPayments\(req\.businessId, order\.id, /g) ?? []).length, 2);
  });
  await ok('the owner\'s unmatched list: waiting and held, never used; a manager with reports.payments too', async () => {
    await seed();
    await call('POST', '/api/payments/c2b/claim', TILL_1, { trans_id: 'AAA1111111', sale_ref: 'PAY-1' });
    await ORD.markOrderPayments(B, 'order-1', [{ method: 'mpesa', reference: 'CCC3333333' }]);
    const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
    const r = await call('GET', `/api/payments/c2b/unmatched?from=${today}&to=${today}`, OWNER_T);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.payments.map((p) => [p.trans_id, p.status]).sort(), [['AAA1111111', 'held'], ['BBB2222222', 'received']]);
    assert.equal(r.body.total, 1580);
    assert.equal((await call('GET', '/api/payments/c2b/unmatched', MANAGER_T)).status, 200);
    assert.equal((await call('GET', '/api/payments/c2b/unmatched?from=2026-01-01&to=2026-11-03', OWNER_T)).status, 400);
  });
  await ok('the web POS: the list under M-Pesa; a taken payment goes to the cloud as received money; closing gives it back', async () => {
    const pm = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/PaymentModal.tsx'), 'utf8');
    assert.match(pm, /<MpesaReceivedList toPay=\{grandTotal\}/);
    assert.match(pm, /l\.method === 'mpesa' && claims\.isTaken\(l\.reference\) \? \{ status: 'completed' \} : \{\}/);
    assert.match(pm, /function closeModal\(\) \{ claims\.giveBackAll\(\); onClose\(\); \}/);
    // Owner, 2026-11-03: "show payments that match the bill only" — a tap always pays the whole bill.
    assert.match(pm, /function takeReceived\(p: ReceivedPayment\) \{\n\s*void handleSplitCharge\(\[\{ id: 'c2b', method: 'mpesa', amount: grandTotal, reference: p\.trans_id \}\]\);/);
    const list = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/MpesaReceivedList.tsx'), 'utf8');
    assert.match(list, /const list = r\.offered \? paymentsForBill\(r\.payments \?\? \[\], toPay\) : \[\];/);
    const unmatched = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/reports/MpesaUnmatchedTab.tsx'), 'utf8');
    assert.match(unmatched, /p\.status === 'held' && canRelease && \(/);
  });
  await ok('migration 188 not run: the owner\'s screen says so, the POS sees nothing, Safaricom still "Accepted"', async () => {
    reset();
    mem.fail = (t) => (t === 'branch_c2b_settings' || t === 'mpesa_c2b_payments' ? { message: 'relation does not exist', code: '42P01' } : null);
    const s = await call('GET', '/api/mpesa/c2b-settings', OWNER_T);
    assert.equal(s.body.table, false);
    assert.equal((await call('PUT', `/api/mpesa/c2b-settings/branches/${BR}`, OWNER_T, { enabled: true })).body.code, 'MIGRATION_188');
    assert.equal((await call('GET', '/api/payments/c2b/recent', TILL_1)).body.offered, false);
    assert.equal((await pay(C.newC2bToken())).body.ResultCode, 0);
    assert.deepEqual((await call('GET', '/api/payments/c2b/unmatched', OWNER_T)).body.payments, []);
  });
} finally {
  server.close();
  out(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
