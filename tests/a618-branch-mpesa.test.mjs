/**
 * a618-branch-mpesa.test.mjs — A618: M-Pesa STK push details per branch, the business's as the default.
 *
 * Owner, 2026-11-01: "it should be per branch since different branches might have different payment method some paybill
 * some buy goods". Proves:
 *   1 the resolution (lib/branchMpesa.ts): the branch's own when complete → the business's → none; an incomplete branch
 *     row falls back; Buy Goods signs with the store number and pays the Till number (PartyB); Paybill both the shortcode;
 *     the receipt-number warning; the form's cleaning (blank secret = keep; the first save needs all three).
 *   2 the routes (/api/mpesa/settings): the owner only (a manager with settings.business, a partner, a POS's own session
 *     403); never a secret, the passkey, the whole key or a ciphertext in GET; the secret and passkey encrypted at rest;
 *     a blank secret keeps the stored one; the branch's own removed → the default again; Test connection asks Daraja for
 *     a token only (Sandbox / Live from the saved label), Daraja's refusal in its own words.
 *   3 every STK path uses the branch's details: the desktop POS's /stk-push-pos (its session's branch), the web POS's
 *     /stk-push (the order's branch), /config; the table missing (migration 186 not run) → the business's, never a failure.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/a618-branch-mpesa.test.mjs
 *
 * RUNS the COMPILED server (routes/index.js) behind the REAL auth middleware over HTTP; the database in memory (lib-memdb),
 * Safaricom a stand-in (fetch).
 *
 * MUTATIONS TO CONFIRM BITE: stkParties paying the shortcode on Buy Goods → "PartyB is the Till number" fails;
 * getMpesaConfig ignoring the branch → "a till at Kilimani prompts with Kilimani's details" fails; mayManageMpesa
 * admitting settings.business → "a manager … 403" fails; statusOf returning consumer_key → "never a secret" fails; the
 * PUT writing a blank secret → "a blank secret keeps" fails; readBranchMpesaRow throwing on a missing table → "migration
 * 186 not run" fails.
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
if (!fs.existsSync(path.join(DIST, 'lib/branchMpesa.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

delete process.env.MPESA_ENVIRONMENT;   // sandbox (the server's), as on a developer's PC
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
delete process.env.DESKTOP_ONLY_CUTOFF_AT; delete process.env.TELEGRAM_BOT_TOKEN;

// ── The stand-in Daraja ──────────────────────────────────────────────────────────────────────────────────────────────
const GOOD = { key: 'kilimani-consumer-key-0042', secret: 'kilimani-secret' };
const daraja = { oauth: [], pushes: [], n: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://sandbox.safaricom.co.ke') || u.startsWith('https://api.safaricom.co.ke')) {
    if (u.includes('/oauth/')) {
      const auth = Buffer.from(String(init.headers?.Authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
      daraja.oauth.push({ url: u, auth });
      if (auth === `${GOOD.key}:${GOOD.secret}` || auth.startsWith('ck-default-')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: '3599' }), { status: 200 });
      return new Response(JSON.stringify({ requestId: 'r1', errorCode: '400.008.01', errorMessage: 'Invalid Authentication passed' }), { status: 400 });
    }
    daraja.pushes.push(JSON.parse(String(init.body ?? '{}')));
    return new Response(JSON.stringify({ ResponseCode: '0', CheckoutRequestID: `ws_CO_A618_${++daraja.n}`, MerchantRequestID: 'm', ResponseDescription: 'Success' }), { status: 200 });
  }
  return realFetch(url, init);
};

const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
supabase.auth.admin.getUserById = async () => ({ data: null, error: { message: 'no user' } });
const L = require(path.join(DIST, 'lib/branchMpesa.js'));
const { encryptSecret } = require(path.join(DIST, 'lib/crypto.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));

const B = '11111111-1111-4111-8111-1111111116a8', BR = '22222222-2222-4222-8222-2222222216a8', BR2 = '33333333-3333-4333-8333-3333333316a8';
const OWNER = 'aaaaaaaa-0000-4000-8000-0000000006a8', MGR = 'aaaaaaaa-0000-4000-8000-0000000016a8';
const DEFAULT_SETTINGS = () => [
  { business_id: B, key: 'mpesa_consumer_key', value: 'ck-default-1234' }, { business_id: B, key: 'mpesa_consumer_secret', value: encryptSecret('cs-default') },
  { business_id: B, key: 'mpesa_shortcode', value: '174379' }, { business_id: B, key: 'mpesa_passkey', value: encryptSecret('pk-default') },
  { business_id: B, key: 'mpesa_type', value: 'CustomerPayBillOnline' },
];
const KILIMANI = () => ({ branch_id: BR2, business_id: B, type: 'CustomerBuyGoodsOnline', shortcode: '600100', till_number: '163726',
  consumer_key: GOOD.key, consumer_secret: encryptSecret(GOOD.secret), passkey: encryptSecret('kilimani-passkey'), environment: 'production',
  updated_at: '2026-11-01T08:00:00Z', updated_by: OWNER });
const reset = ({ mpesa = true, branchRow = true } = {}) => {
  mem.fail = () => null; mem.latency = () => 0; mem.rowCap = Infinity; mem.calls = [];
  daraja.oauth = []; daraja.pushes = [];
  mem.db = {
    businesses: [{ id: B, name: 'Kifaru Mart', owner_id: OWNER, status: 'active', currency: 'KES', type: 'retail', created_at: '2026-01-01T00:00:00Z' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', status: 'active', desktop_licensed: true, is_main: true },
      { id: BR2, business_id: B, name: 'Kilimani', status: 'active', desktop_licensed: true, is_main: false }],
    business_settings: mpesa ? DEFAULT_SETTINGS() : [],
    branch_settings: [], branch_mpesa_settings: branchRow ? [KILIMANI()] : [],
    users: [{ id: OWNER, business_id: B, name: 'Wanjiru', status: 'active', permissions_version: 0, user_branches: [], roles: { name: 'Admin' }, user_permissions: [] },
      { id: MGR, business_id: B, name: 'Otieno', status: 'active', permissions_version: 0, user_branches: [{ branch_id: BR }], roles: { name: 'Manager' }, user_permissions: [] }],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, device_role: 'till' },
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', status: 'approved', retired_at: null, branch_id: BR2, device_role: 'till' }],
    orders: [], payments: [], mpesa_stk_requests: [], payment_exceptions: [], cloud_plans: [], feature_flags: [], notifications: [], audit_log: [],
  };
  AC._resetAuthCache?.();
};

const express = require('express');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const sign = (p) => jwt.sign({ permissionsVersion: 0, sessionId: 's', businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const OWNER_T = sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' });
const MANAGER_T = sign({ userId: MGR, permissionKeys: ['settings.business', 'settings.payments', 'orders.create'], surface: 'dashboard' });
const PARTNER_T = sign({ userId: MGR, webPartner: true, partnerBranches: [BR], permissionKeys: ['*'], surface: 'dashboard' });
const TILL_WEST = sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' });
const TILL_KIL = sign({ userId: null, deviceId: 'dev-T2', till: true, branchId: BR2, permissionKeys: ['*'], surface: 'desktop' });
const call = async (method, p, token, body, device = 'dev-T1') => {
  const r = await realFetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-device-id': device },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json, text };
};
const bizKey = (k) => mem.db.business_settings.find((r) => r.key === k)?.value;

console.log = () => {}; console.warn = () => {}; console.error = () => {};
try {
  state._setPermissionsMigrated(true);

  out('\n1. Which details a payment uses\n');
  const cfg = (o = {}) => ({ consumerKey: 'k', consumerSecret: 's', shortcode: '174379', tillNumber: null, passkey: 'p', type: 'CustomerPayBillOnline', environment: 'sandbox', source: 'business', ...o });
  await ok('the branch\'s own when complete, else the business\'s, else none', async () => {
    const branch = cfg({ shortcode: '600100', source: 'branch' }), biz = cfg();
    assert.equal(L.resolveMpesaConfig(branch, biz).source, 'branch');
    assert.equal(L.resolveMpesaConfig(null, biz).source, 'business');
    assert.equal(L.resolveMpesaConfig(null, null), null);
  });
  await ok('an incomplete branch row (no passkey / an unreadable secret / no key) is no config — the default applies', async () => {
    const row = KILIMANI();
    assert.equal(L.branchConfigFrom(row).source, 'branch');
    assert.equal(L.branchConfigFrom({ ...row, passkey: '' }), null);
    assert.equal(L.branchConfigFrom({ ...row, consumer_secret: 'v1:AAAA:BBBB:CCCC' }), null);   // corrupt ciphertext
    assert.equal(L.branchConfigFrom({ ...row, consumer_key: ' ' }), null);
    assert.equal(L.branchConfigFrom(null), null);
  });
  await ok('the business\'s: legacy plain text still read; the Till number only on Buy Goods', async () => {
    const m = L.settingsMap([{ key: 'mpesa_consumer_key', value: 'k' }, { key: 'mpesa_consumer_secret', value: 'plain' }, { key: 'mpesa_shortcode', value: '174379' },
      { key: 'mpesa_passkey', value: 'pk' }, { key: 'mpesa_type', value: 'CustomerPayBillOnline' }, { key: 'mpesa_till_number', value: '163726' }]);
    const c = L.businessConfigFrom(m);
    assert.equal(c.consumerSecret, 'plain'); assert.equal(c.tillNumber, null); assert.equal(c.environment, null);
    assert.equal(L.businessConfigFrom({ ...m, mpesa_type: 'CustomerBuyGoodsOnline' }).tillNumber, '163726');
    assert.equal(L.businessConfigFrom({ ...m, mpesa_passkey: '' }), null);
  });
  await ok('Buy Goods: the store number signs, PartyB is the Till number (the store number when blank); Paybill: the shortcode', async () => {
    assert.deepEqual(L.stkParties(cfg({ type: 'CustomerBuyGoodsOnline', shortcode: '600100', tillNumber: '163726' })),
      { BusinessShortCode: '600100', PartyB: '163726', TransactionType: 'CustomerBuyGoodsOnline' });
    assert.equal(L.stkParties(cfg({ type: 'CustomerBuyGoodsOnline', shortcode: '600100' })).PartyB, '600100');
    assert.deepEqual(L.stkParties(cfg({ tillNumber: '163726' })), { BusinessShortCode: '174379', PartyB: '174379', TransactionType: 'CustomerPayBillOnline' });
  });
  await ok('the receipt warning: another number or another kind → said plainly; the same, or either missing → none', async () => {
    assert.equal(L.receiptMismatch({ kind: 'buy_goods', number: '163726', account: null }, cfg()),
      'Receipts at this branch say Buy Goods 163726, but STK payments go to Paybill 174379.');
    assert.equal(L.receiptMismatch({ kind: 'paybill', number: '174379', account: 'SHOP' }, cfg()), null);
    assert.equal(L.receiptMismatch({ kind: 'buy_goods', number: '163726', account: null }, cfg({ type: 'CustomerBuyGoodsOnline', shortcode: '600100', tillNumber: '163726' })), null);
    assert.match(L.receiptMismatch({ kind: 'paybill', number: '163726', account: 'X' }, cfg({ type: 'CustomerBuyGoodsOnline', shortcode: '600100', tillNumber: '163726' })), /say Paybill 163726, but STK payments go to Buy Goods 163726/);
    assert.equal(L.receiptMismatch(null, cfg()), null);
    assert.equal(L.receiptMismatch({ kind: 'paybill', number: '1', account: null }, null), null);
  });
  await ok('the form: type, digits, environment checked; blank secrets keep the stored ones, the first save needs all three', async () => {
    const good = { type: 'CustomerBuyGoodsOnline', shortcode: '600 100', till_number: '163726', environment: 'sandbox', consumer_key: 'k', consumer_secret: 's', passkey: 'p' };
    const none = { key: false, secret: false, passkey: false }, all = { key: true, secret: true, passkey: true };
    const r = L.cleanMpesaSettings(good, none);
    assert.equal(r.ok, true); assert.equal(r.value.shortcode, '600100'); assert.equal(r.value.tillNumber, '163726');
    assert.match(L.cleanMpesaSettings({ ...good, type: 'Paybill' }, all).error, /Paybill or Buy Goods/);
    assert.match(L.cleanMpesaSettings({ ...good, shortcode: '12ab5' }, all).error, /5 to 8 digits/);
    assert.match(L.cleanMpesaSettings({ ...good, till_number: '12' }, all).error, /Till number is 5 to 8 digits/);
    assert.match(L.cleanMpesaSettings({ ...good, environment: 'live' }, all).error, /Sandbox or Live/);
    assert.match(L.cleanMpesaSettings({ ...good, consumer_secret: '' }, none).error, /consumer secret/);
    assert.match(L.cleanMpesaSettings({ ...good, passkey: ' ' }, none).error, /passkey/);
    const keep = L.cleanMpesaSettings({ ...good, consumer_key: '', consumer_secret: '', passkey: '' }, all);
    assert.equal(keep.ok, true); assert.deepEqual([keep.value.consumerKey, keep.value.consumerSecret, keep.value.passkey], [null, null, null]);
    assert.equal(L.cleanMpesaSettings({ ...good, type: 'CustomerPayBillOnline' }, all).value.tillNumber, null);   // Paybill: no Till number
  });
  await ok('the key\'s last 4 only', async () => {
    assert.equal(L.keyLast4('kilimani-consumer-key-0042'), '0042'); assert.equal(L.keyLast4('short'), '…'); assert.equal(L.keyLast4(''), null);
  });

  out('\n2. The settings routes\n');
  await ok('the owner reads the default and every branch — never a secret, the passkey, the whole key or a ciphertext', async () => {
    reset();
    const r = await call('GET', '/api/mpesa/settings', OWNER_T);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.default.configured, true); assert.equal(r.body.default.shortcode, '174379'); assert.equal(r.body.default.keyLast4, '1234');
    assert.equal(r.body.default.secretSaved, true); assert.equal(r.body.branchTable, true); assert.equal(r.body.serverEnvironment, 'sandbox');
    const kil = r.body.branches.find((b) => b.id === BR2), west = r.body.branches.find((b) => b.id === BR);
    assert.equal(kil.uses, 'own'); assert.equal(kil.own.tillNumber, '163726'); assert.equal(kil.own.keyLast4, '0042'); assert.equal(kil.own.updatedBy, 'Wanjiru');
    assert.equal(kil.paysTo, 'Buy Goods 163726'); assert.equal(west.uses, 'default'); assert.equal(west.own, null); assert.equal(west.paysTo, 'Paybill 174379');
    for (const secret of [GOOD.key, GOOD.secret, 'kilimani-passkey', 'ck-default-1234', 'cs-default', 'pk-default', 'v1:']) assert.ok(!r.text.includes(secret), `GET leaked ${secret}`);
  });
  await ok('a manager with settings.business, a partner and a POS\'s own session are refused 403 (every route)', async () => {
    reset();
    for (const t of [MANAGER_T, PARTNER_T, TILL_WEST]) {
      for (const [m, p, b] of [['GET', '/api/mpesa/settings'], ['PUT', '/api/mpesa/settings/default', {}], ['PUT', `/api/mpesa/settings/branches/${BR}`, {}],
        ['DELETE', `/api/mpesa/settings/branches/${BR2}`], ['POST', '/api/mpesa/settings/test', {}]]) {
        const r = await call(m, p, t, b);
        assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
      }
    }
    assert.equal(mem.db.branch_mpesa_settings.length, 1); assert.equal(daraja.oauth.length, 0);
    assert.equal((await call('GET', '/api/mpesa/settings', null)).status, 401);
  });
  await ok('the default saved: the secret and passkey encrypted; blank ones keep the stored; the Till number and Sandbox / Live kept', async () => {
    reset({ mpesa: false });
    let r = await call('PUT', '/api/mpesa/settings/default', OWNER_T, { type: 'CustomerBuyGoodsOnline', shortcode: '174379', environment: 'sandbox', consumer_key: 'ck-default-9999', consumer_secret: '', passkey: 'p' });
    assert.equal(r.status, 400); assert.match(r.body.error, /consumer secret/);
    r = await call('PUT', '/api/mpesa/settings/default', OWNER_T, { type: 'CustomerBuyGoodsOnline', shortcode: '174379', till_number: '163726', environment: 'sandbox', consumer_key: 'ck-default-9999', consumer_secret: 'cs-new', passkey: 'pk-new' });
    assert.equal(r.status, 200, r.text);
    assert.match(bizKey('mpesa_consumer_secret'), /^v1:/); assert.match(bizKey('mpesa_passkey'), /^v1:/);
    assert.ok(!JSON.stringify(mem.db.business_settings).includes('cs-new'));
    const before = [bizKey('mpesa_consumer_secret'), bizKey('mpesa_passkey'), bizKey('mpesa_consumer_key')];
    r = await call('PUT', '/api/mpesa/settings/default', OWNER_T, { type: 'CustomerBuyGoodsOnline', shortcode: '174380', till_number: '', environment: 'production', consumer_key: '', consumer_secret: '', passkey: '' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([bizKey('mpesa_consumer_secret'), bizKey('mpesa_passkey'), bizKey('mpesa_consumer_key')], before);
    assert.equal(bizKey('mpesa_shortcode'), '174380'); assert.equal(bizKey('mpesa_environment'), 'production'); assert.equal(bizKey('mpesa_till_number'), '');
    assert.equal(bizKey('mpesa_updated_by'), OWNER);
    assert.ok(mem.db.business_settings.every((x) => x.business_id === B));
    const c = await L.getMpesaConfig(B, null);
    assert.deepEqual([c.consumerSecret, c.passkey, c.shortcode, c.environment], ['cs-new', 'pk-new', '174380', 'production']);
  });
  await ok('a branch\'s own saved (with business_id), a blank secret keeps the stored one; another business\'s branch is 404', async () => {
    reset({ branchRow: false });
    let r = await call('PUT', `/api/mpesa/settings/branches/${BR}`, OWNER_T, { type: 'CustomerPayBillOnline', shortcode: '4098201', environment: 'production', consumer_key: 'ck-west-5555', consumer_secret: '', passkey: 'pkw' });
    assert.equal(r.status, 400, 'the first save needs the secret');
    r = await call('PUT', `/api/mpesa/settings/branches/${BR}`, OWNER_T, { type: 'CustomerPayBillOnline', shortcode: '4098201', till_number: '163726', environment: 'production', consumer_key: 'ck-west-5555', consumer_secret: 'csw', passkey: 'pkw' });
    assert.equal(r.status, 200, r.text);
    const row = () => mem.db.branch_mpesa_settings.find((x) => x.branch_id === BR);
    assert.equal(row().business_id, B); assert.equal(row().till_number, null, 'Paybill keeps no Till number'); assert.match(row().consumer_secret, /^v1:/);
    const sealed = row().consumer_secret;
    r = await call('PUT', `/api/mpesa/settings/branches/${BR}`, OWNER_T, { type: 'CustomerPayBillOnline', shortcode: '4098202', environment: 'production', consumer_key: '', consumer_secret: '', passkey: '' });
    assert.equal(r.status, 200, r.text);
    assert.equal(row().consumer_secret, sealed); assert.equal(row().consumer_key, 'ck-west-5555'); assert.equal(row().shortcode, '4098202');
    assert.equal(mem.db.branch_mpesa_settings.length, 1);
    r = await call('PUT', '/api/mpesa/settings/branches/99999999-9999-4999-8999-999999999999', OWNER_T, { type: 'CustomerPayBillOnline', shortcode: '4098202', environment: 'production', consumer_key: 'a', consumer_secret: 'b', passkey: 'c' });
    assert.equal(r.status, 404);
  });
  await ok('the branch\'s own removed → it uses the business default again', async () => {
    reset();
    const r = await call('DELETE', `/api/mpesa/settings/branches/${BR2}`, OWNER_T);
    assert.equal(r.status, 200, r.text); assert.equal(mem.db.branch_mpesa_settings.length, 0);
    const g = await call('GET', '/api/mpesa/settings', OWNER_T);
    assert.equal(g.body.branches.find((b) => b.id === BR2).uses, 'default');
  });
  await ok('the receipt warning: Kilimani\'s receipt says Paybill 4098201, STK pays Buy Goods 163726; Westlands agrees with the default', async () => {
    reset();
    mem.db.branch_settings.push({ business_id: B, branch_id: BR2, key: 'receipt_pay_label', value: 'Paybill' }, { business_id: B, branch_id: BR2, key: 'receipt_pay_number', value: '4098201' },
      { business_id: B, branch_id: BR2, key: 'receipt_pay_account', value: 'KIL' });
    mem.db.business_settings.push({ business_id: B, key: 'receipt_pay_label', value: 'Paybill' }, { business_id: B, key: 'receipt_pay_number', value: '174379' });
    const g = await call('GET', '/api/mpesa/settings', OWNER_T);
    const kil = g.body.branches.find((b) => b.id === BR2), west = g.body.branches.find((b) => b.id === BR);
    assert.equal(kil.receiptWarning, 'Receipts at this branch say Paybill 4098201, but STK payments go to Buy Goods 163726.');
    assert.equal(west.receipt, 'Paybill 174379'); assert.equal(west.receiptWarning, null);
  });
  await ok('Test connection: a token only (no prompt), Live for Kilimani\'s, Sandbox for the default\'s; Daraja\'s refusal in its words', async () => {
    reset();
    let r = await call('POST', '/api/mpesa/settings/test', OWNER_T, { branch_id: BR2 });
    assert.equal(r.status, 200, r.text); assert.equal(r.body.ok, true); assert.equal(r.body.source, 'branch'); assert.equal(r.body.environment, 'production');
    assert.match(daraja.oauth[0].url, /^https:\/\/api\.safaricom\.co\.ke\/oauth\/v1\/generate/);
    r = await call('POST', '/api/mpesa/settings/test', OWNER_T, {});
    assert.equal(r.body.ok, true); assert.equal(r.body.source, 'business'); assert.equal(r.body.environment, 'sandbox', 'not recorded → the server\'s');
    assert.match(daraja.oauth[1].url, /^https:\/\/sandbox\.safaricom\.co\.ke/);
    r = await call('POST', '/api/mpesa/settings/test', OWNER_T, { branch_id: BR });
    assert.equal(r.body.source, 'business', 'Westlands has no own → the default it uses');
    mem.db.branch_mpesa_settings[0].consumer_secret = encryptSecret('wrong');
    r = await call('POST', '/api/mpesa/settings/test', OWNER_T, { branch_id: BR2 });
    assert.equal(r.body.ok, false); assert.equal(r.body.error, 'Invalid Authentication passed');
    assert.equal(daraja.pushes.length, 0, 'nobody prompted');
    reset({ mpesa: false, branchRow: false });
    r = await call('POST', '/api/mpesa/settings/test', OWNER_T, {});
    assert.equal(r.status, 422); assert.equal(r.body.code, 'NOT_CONFIGURED');
  });
  await ok('Test connection: no answer within the time-out → said, not hung', async () => {
    const r = await L.testDarajaConnection({ consumerKey: 'a', consumerSecret: 'b' }, 'sandbox',
      (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' })))), 30);
    assert.deepEqual(r, { ok: false, error: 'Safaricom did not answer within 0 seconds.' });
    assert.equal(L.darajaErrorText(500, ''), 'Safaricom answered 500.');
    assert.equal(L.darajaErrorText(401, ''), 'The consumer key or secret was not accepted.');
  });

  out('\n3. Every STK path uses the branch\'s details\n');
  await ok('a POS at Kilimani prompts with Kilimani\'s (store 600100 signs, Buy Goods 163726 paid); Westlands with the default\'s Paybill', async () => {
    reset();
    let r = await call('POST', '/api/mpesa/stk-push-pos', TILL_KIL, { phone: '0712345678', amount: 100, client_ref: 'POS-K1' }, 'dev-T2');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([daraja.pushes[0].BusinessShortCode, daraja.pushes[0].PartyB, daraja.pushes[0].TransactionType], ['600100', '163726', 'CustomerBuyGoodsOnline']);
    assert.equal(Buffer.from(daraja.pushes[0].Password, 'base64').toString().slice(0, 22), '600100kilimani-passkey');
    assert.equal(daraja.oauth[0].auth, `${GOOD.key}:${GOOD.secret}`);
    assert.equal(mem.db.mpesa_stk_requests[0].branch_id, BR2);
    r = await call('POST', '/api/mpesa/stk-push-pos', TILL_WEST, { phone: '0712345678', amount: 100, client_ref: 'POS-W1' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([daraja.pushes[1].BusinessShortCode, daraja.pushes[1].PartyB, daraja.pushes[1].TransactionType], ['174379', '174379', 'CustomerPayBillOnline']);
  });
  await ok('the web POS: an order made at Kilimani prompts with Kilimani\'s details', async () => {
    reset();
    mem.db.orders.push({ id: 'o-1', business_id: B, branch_id: BR2, status: 'pending' });
    mem.db.payments.push({ id: 'p-1', order_id: 'o-1', business_id: B, method: 'mpesa', status: 'pending', amount: 250, created_at: '2026-11-01T09:00:00Z' });
    const r = await call('POST', '/api/mpesa/stk-push', OWNER_T, { phone: '0712345678', order_id: 'o-1' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([daraja.pushes[0].BusinessShortCode, daraja.pushes[0].PartyB, daraja.pushes[0].Amount], ['600100', '163726', 250]);
  });
  await ok('/config answers for the session\'s branch; not set up anywhere → 422 pointing at Settings › Payments › M-Pesa', async () => {
    reset({ mpesa: false });
    let r = await call('GET', '/api/mpesa/config', TILL_KIL, undefined, 'dev-T2');
    assert.equal(r.body.configured, true); assert.equal(r.body.source, 'branch'); assert.equal(r.body.shortcode, '600100');
    r = await call('GET', '/api/mpesa/config', TILL_WEST);
    assert.equal(r.body.configured, false);
    r = await call('POST', '/api/mpesa/stk-push-pos', TILL_WEST, { phone: '0712345678', amount: 10, client_ref: 'R' });
    assert.equal(r.status, 422); assert.equal(r.body.code, 'NOT_CONFIGURED'); assert.match(r.body.error, /Settings › Payments › M-Pesa/);
    assert.equal(daraja.pushes.length, 0);
  });
  await ok('migration 186 not run: payments use the business\'s, the screen says so, a branch save is 503 MIGRATION_186', async () => {
    reset();
    mem.fail = (table) => (table === 'branch_mpesa_settings' ? { code: 'PGRST205', message: 'Could not find the table \'public.branch_mpesa_settings\' in the schema cache' } : null);
    let r = await call('POST', '/api/mpesa/stk-push-pos', TILL_KIL, { phone: '0712345678', amount: 100, client_ref: 'POS-K2' }, 'dev-T2');
    assert.equal(r.status, 200, r.text); assert.equal(daraja.pushes[0].BusinessShortCode, '174379');
    r = await call('GET', '/api/mpesa/settings', OWNER_T);
    assert.equal(r.status, 200, r.text); assert.equal(r.body.branchTable, false); assert.ok(r.body.branches.every((b) => b.uses === 'default'));
    r = await call('PUT', `/api/mpesa/settings/branches/${BR2}`, OWNER_T, { type: 'CustomerPayBillOnline', shortcode: '4098202', environment: 'production', consumer_key: 'a', consumer_secret: 'b', passkey: 'c' });
    assert.equal(r.status, 503); assert.equal(r.body.code, 'MIGRATION_186');
    r = await call('DELETE', `/api/mpesa/settings/branches/${BR2}`, OWNER_T);
    assert.equal(r.status, 200, 'nothing to remove');
  });
  await ok('the branch read failing otherwise → the business\'s, never a failed payment', async () => {
    reset();
    mem.fail = (table) => (table === 'branch_mpesa_settings' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null);
    const r = await call('POST', '/api/mpesa/stk-push-pos', TILL_KIL, { phone: '0712345678', amount: 100, client_ref: 'POS-K3' }, 'dev-T2');
    assert.equal(r.status, 200, r.text); assert.equal(daraja.pushes[0].PartyB, '174379');
  });
} finally {
  server.close();
}
out(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
