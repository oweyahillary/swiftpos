/**
 * cloud-billing-a626.test.mjs — A626 Phase 1 (owner, 2026-11-25): ZapTill's cloud-billing Paybill C2B pipe. Clients pay
 * their subscription to ONE ZapTill Paybill with a code as the account number; Daraja's confirmation callback feeds the
 * cloud. This proves the pipe: super admin registers the callback with Safaricom, a sandbox test fires, and a confirmation
 * lands a raw receipt (deduped on the M-Pesa code). Matching/wallet/allocation are Phase 2.
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/cloud-billing-a626.test.mjs
 *
 * RUNS the COMPILED cloud (routes/cloudBillingAdmin.js, routes/cloudBillingC2b.js, lib/cloudBilling*.js) over real HTTP with
 * real admin auth, the DB in memory (tests/lib-memdb.mjs) and Safaricom stubbed.
 *
 * MUTATIONS TO CONFIRM BITE: drop the token match in receiveBillingPayment → "a payment with the wrong token is ignored"
 * fails; drop the trans_id dedupe → "the same payment twice keeps one" fails; drop normalizeBillRef → "the account code is
 * normalised" fails; skip saving token_hash on a refusal → "a refusal keeps the prior registration" fails.
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
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/cloudBillingAdmin.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

delete process.env.MPESA_ENVIRONMENT;   // the server's environment → sandbox
process.env.MPESA_CALLBACK_BASE_URL = 'https://api.zaptill.example';
process.env.ZAPTILL_MPESA_CONSUMER_KEY = 'zt-ck-1234';
process.env.ZAPTILL_MPESA_CONSUMER_SECRET = 'zt-cs-5678';
process.env.ZAPTILL_MPESA_SHORTCODE = '174379';
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
delete process.env.TELEGRAM_BOT_TOKEN;

// ── The stand-in Safaricom ───────────────────────────────────────────────────────────────────────────────────────────
const daraja = { registered: [], simulated: [], refuse: null };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://sandbox.safaricom.co.ke') && !u.startsWith('https://api.safaricom.co.ke')) return realFetch(url, init);
  if (u.includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: '3599' }), { status: 200 });
  const body = JSON.parse(String(init.body ?? '{}'));
  if (u.endsWith('/mpesa/c2b/v2/registerurl')) {
    daraja.registered.push({ body });
    if (daraja.refuse) return new Response(JSON.stringify({ errorCode: '500.003.1001', errorMessage: daraja.refuse }), { status: 400 });
    return new Response(JSON.stringify({ ResponseCode: '0', ResponseDescription: 'Success' }), { status: 200 });
  }
  if (u.endsWith('/mpesa/c2b/v2/simulate')) {
    daraja.simulated.push({ body });
    return new Response(JSON.stringify({ ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
console.warn = () => {}; console.error = () => {};
const mem = installMemDb(supabase);

const SUPER = 'cccccccc-0000-4000-8000-000000000001', AGENT = 'cccccccc-0000-4000-8000-000000000002';
const reset = () => {
  mem.fail = () => null; mem.calls = [];
  daraja.registered = []; daraja.simulated = []; daraja.refuse = null;
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    zaptill_billing_c2b: [], cloud_billing_receipts: [], admin_audit_log: [],
  };
  adminAuth.forgetAdmin?.();
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin/cloud-billing', require(path.join(DIST, 'routes/cloudBillingAdmin.js')).default);
app.use('/api/cloud-billing/c2b', require(path.join(DIST, 'routes/cloudBillingC2b.js')).default);
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ADMIN = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const AGENT_T = jwt.sign({ adminId: AGENT, email: 'agent@zaptill.test', role: 'agent' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });

const confirmation = (o = {}) => ({ TransactionType: 'Pay Bill', TransID: 'QJK7XT3L5P', TransTime: '20261125143005',
  TransAmount: '10000.00', BusinessShortCode: '174379', BillRefNumber: 'KUDO', MSISDN: '2547 ***** 149', FirstName: 'KUDO', ...o });
const register = async (token = ADMIN) => {
  const r = await call('POST', '/api/admin/cloud-billing/register', token);
  return { r, token: daraja.registered.length ? String(daraja.registered.at(-1).body.ConfirmationURL).split('/').pop() : null };
};
const pay = (token, o = {}) => call('POST', `/api/cloud-billing/c2b/confirm/${token}`, null, confirmation(o));
const receipts = () => mem.db.cloud_billing_receipts;

console.log('\nA626 Phase 1 — ZapTill cloud-billing Paybill C2B (the pipe)\n');
try {
  await ok('settings: configured from env, server environment sandbox, not registered yet', async () => {
    reset();
    const r = await call('GET', '/api/admin/cloud-billing/settings', AGENT_T);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.configured, true); assert.equal(r.body.server_environment, 'sandbox');
    assert.equal(r.body.table, true); assert.equal(r.body.registered, null);
  });

  await ok('register is super-admin only (an agent is refused)', async () => {
    reset();
    const { r } = await register(AGENT_T);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(daraja.registered.length, 0);
  });

  await ok('register: mints a token, registers the confirm/validate URLs with Safaricom, stores only the hash', async () => {
    reset();
    const { r, token } = await register();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.ok, r.body.shortcode, r.body.environment], [true, '174379', 'sandbox']);
    assert.equal(daraja.registered.length, 1);
    const reg = daraja.registered[0].body;
    assert.equal(reg.ShortCode, '174379');
    assert.match(reg.ConfirmationURL, /^https:\/\/api\.zaptill\.example\/api\/cloud-billing\/c2b\/confirm\/[0-9a-f]{48}$/);
    assert.match(reg.ValidationURL, /\/api\/cloud-billing\/c2b\/validate\/[0-9a-f]{48}$/);
    const C = require(path.join(DIST, 'lib/c2b.js'));
    assert.equal(mem.db.zaptill_billing_c2b[0].token_hash, C.hashC2bToken(token));   // the hash, not the token
    assert.equal(mem.db.zaptill_billing_c2b.length, 1);                              // one row (singleton)
    assert.ok(mem.db.admin_audit_log.some((a) => a.action === 'cloud_billing.register'));
  });

  await ok('a confirmation on the registered token lands a receipt (Accepted), with the account code normalised', async () => {
    reset();
    const { token } = await register();
    const r = await pay(token, { BillRefNumber: 'ku-do ' });
    assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.equal(receipts().length, 1);
    const rc = receipts()[0];
    assert.deepEqual([rc.trans_id, rc.amount, rc.bill_ref, rc.bill_ref_norm], ['QJK7XT3L5P', 10000, 'ku-do', 'KUDO']);
    assert.equal(rc.status, 'received');
  });

  await ok('the same payment twice keeps one (deduped on the M-Pesa code)', async () => {
    reset();
    const { token } = await register();
    await pay(token); const r2 = await pay(token);
    assert.deepEqual(r2.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.equal(receipts().length, 1);
  });

  await ok('a payment with the WRONG token is ignored (still Accepted, no receipt)', async () => {
    reset();
    await register();
    const wrong = 'f'.repeat(48);
    const r = await pay(wrong);
    assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.equal(receipts().length, 0);
  });

  await ok('a body that is not a payment is ignored (no amount/shortcode)', async () => {
    reset();
    const { token } = await register();
    const r = await call('POST', `/api/cloud-billing/c2b/confirm/${token}`, null, { hello: 'world' });
    assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.equal(receipts().length, 0);
  });

  await ok('validate always accepts', async () => {
    reset();
    const { token } = await register();
    const r = await call('POST', `/api/cloud-billing/c2b/validate/${token}`, null, confirmation());
    assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
  });

  await ok('sandbox test payment: super admin fires a simulate to Safaricom', async () => {
    reset();
    await register();
    const r = await call('POST', '/api/admin/cloud-billing/test-payment', ADMIN, { amount: 1, bill_ref: 'KUDO' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(daraja.simulated.length, 1);
    const sim = daraja.simulated[0].body;
    assert.deepEqual([sim.ShortCode, sim.CommandID, sim.Amount, sim.BillRefNumber], ['174379', 'CustomerPayBillOnline', 1, 'KUDO']);
  });

  await ok('test payment is super-admin only; and needs a sandbox registration first', async () => {
    reset();
    await register();
    const a = await call('POST', '/api/admin/cloud-billing/test-payment', AGENT_T, {});
    assert.equal(a.status, 403, JSON.stringify(a.body));
    reset();   // not registered
    const b = await call('POST', '/api/admin/cloud-billing/test-payment', ADMIN, {});
    assert.equal(b.status, 409); assert.equal(b.body.code, 'NOT_SANDBOX');
  });

  await ok('receipts feed returns what landed; settings shows the registration', async () => {
    reset();
    const { token } = await register();
    await pay(token);
    const feed = await call('GET', '/api/admin/cloud-billing/receipts', AGENT_T);
    assert.equal(feed.body.receipts.length, 1);
    assert.equal(feed.body.receipts[0].bill_ref, 'KUDO');
    const s = await call('GET', '/api/admin/cloud-billing/settings', AGENT_T);
    assert.equal(s.body.registered.shortcode, '174379'); assert.equal(s.body.registered.environment, 'sandbox');
  });

  await ok('a Safaricom refusal keeps the prior working registration (the old token still receives)', async () => {
    reset();
    const { token: good } = await register();
    daraja.refuse = 'Invalid Access Token';
    const again = await register();
    assert.equal(again.r.status, 502); assert.equal(again.r.body.code, 'REGISTER_REFUSED');
    // the old token still lands a payment, and the last error is recorded
    const r = await pay(good, { TransID: 'NEWCODE999' });
    assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.equal(receipts().length, 1);
    assert.match(mem.db.zaptill_billing_c2b[0].last_error, /Invalid Access Token/);
  });

  await ok('no env keys → not configured, register refused NO_CREDS', async () => {
    reset();
    const saved = process.env.ZAPTILL_MPESA_CONSUMER_KEY; delete process.env.ZAPTILL_MPESA_CONSUMER_KEY;
    try {
      const s = await call('GET', '/api/admin/cloud-billing/settings', AGENT_T);
      assert.equal(s.body.configured, false);
      const r = await call('POST', '/api/admin/cloud-billing/register', ADMIN);
      assert.equal(r.status, 400); assert.equal(r.body.code, 'NO_CREDS');
    } finally { process.env.ZAPTILL_MPESA_CONSUMER_KEY = saved; }
  });
} finally { server.close(); }

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
