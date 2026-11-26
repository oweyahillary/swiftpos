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
 * normalised" fails; skip saving token_hash on a refusal → "a refusal keeps the prior registration" fails; drop the
 * reversalOf detection → "a reversal CALLBACK … never recorded as income" fails (the reversal lands as a second receipt).
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
const ALLOC = require(path.join(DIST, 'lib/cloudBillingAllocate.js'));
console.warn = () => {}; console.error = () => {};
const mem = installMemDb(supabase);

const SUPER = 'cccccccc-0000-4000-8000-000000000001', AGENT = 'cccccccc-0000-4000-8000-000000000002';
const BIZ = 'dddddddd-0000-4000-8000-000000000001', BIZ2 = 'dddddddd-0000-4000-8000-000000000002';
const reset = () => {
  mem.fail = () => null; mem.calls = [];
  daraja.registered = []; daraja.simulated = []; daraja.refuse = null;
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    businesses: [
      { id: BIZ, name: 'Acme Co', type: 'retail', status: 'active', billing_code: 'ACME', billing_code_norm: 'ACME', web_access_expires_at: null, created_at: '2026-01-01T00:00:00Z' },
      { id: BIZ2, name: 'Duka Bora', type: 'retail', status: 'active', billing_code: null, billing_code_norm: null, created_at: '2026-01-02T00:00:00Z' },
    ],
    zaptill_billing_c2b: [], cloud_billing_receipts: [], admin_audit_log: [],
    branches: [], branch_cloud_plans: [], invoices: [], feature_flags: [], business_settings: [],
    business_cloud_credit: [], cloud_credit_entries: [],
  };
  adminAuth.forgetAdmin?.();
};

const BR = 'eeeeeeee-0000-4000-8000-000000000001';
const balance = (biz) => Number((mem.db.business_cloud_credit.find((c) => c.business_id === biz) ?? {}).balance ?? 0);
// Seed a branch for BIZ with a past paid-until and one open cloud invoice of `amount` for it.
const seedInvoice = (amount, periodEnd = '2026-12-31T21:00:00Z') => {
  mem.db.branches = [{ id: BR, business_id: BIZ, name: 'Main', is_main: true, status: 'active' }];
  mem.db.branch_cloud_plans = [{ branch_id: BR, business_id: BIZ, period: 'monthly', amount: 3000, currency: 'KES', paid_until: '2026-11-01T00:00:00Z', premium: [], package: false, web_off: false }];
  mem.db.invoices = [{ id: 'inv-1', invoice_number: 'INV-2026-0001', business_id: BIZ, kind: 'cloud', status: 'pending', amount, branch_ids: [BR], period_start: '2026-11-30T21:00:00Z', period_end: periodEnd }];
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
  TransAmount: '10000.00', BusinessShortCode: '174379', BillRefNumber: 'ACME', MSISDN: '2547 ***** 149', FirstName: 'ACME', ...o });
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

  await ok('a confirmation lands a receipt (Accepted), the code is normalised, and it is matched to the client', async () => {
    reset();
    const { token } = await register();
    const r = await pay(token, { BillRefNumber: 'ac-me ' });   // a typo'd/cased form of ACME
    assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.equal(receipts().length, 1);
    const rc = receipts()[0];
    assert.deepEqual([rc.trans_id, rc.amount, rc.bill_ref, rc.bill_ref_norm], ['QJK7XT3L5P', 10000, 'ac-me', 'ACME']);
    assert.equal(rc.status, 'matched'); assert.equal(rc.business_id, BIZ);
  });

  await ok('an unknown account code is recorded unmatched (no client)', async () => {
    reset();
    const { token } = await register();
    await pay(token, { BillRefNumber: 'NOPE', TransID: 'UNKNOWN01' });
    const rc = receipts()[0];
    assert.equal(rc.status, 'unmatched'); assert.equal(rc.business_id, null);
  });

  await ok('an unmatched receipt is assigned to a client by its code (super admin; unknown code refused; agent refused)', async () => {
    reset();
    const { token } = await register();
    await pay(token, { BillRefNumber: 'NOPE' });
    const rc = receipts()[0];
    assert.equal(rc.status, 'unmatched');
    assert.equal((await call('POST', `/api/admin/cloud-billing/receipts/${rc.id}/assign`, AGENT_T, { code: 'ACME' })).status, 403);
    assert.equal((await call('POST', `/api/admin/cloud-billing/receipts/${rc.id}/assign`, ADMIN, { code: 'GHOST' })).body.code, 'UNKNOWN_CODE');
    const a = await call('POST', `/api/admin/cloud-billing/receipts/${rc.id}/assign`, ADMIN, { code: 'ac me' });   // normalised match
    assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.business_id, BIZ);
    assert.equal(receipts()[0].status, 'matched'); assert.equal(receipts()[0].business_id, BIZ);
  });

  await ok('billing code: GET returns the code, generates one from the name when none; PUT sets it (super admin only)', async () => {
    reset();
    assert.equal((await call('GET', `/api/admin/cloud-billing/clients/${BIZ}/code`, AGENT_T)).body.code, 'ACME');
    const gen = await call('GET', `/api/admin/cloud-billing/clients/${BIZ2}/code`, AGENT_T);
    assert.match(gen.body.code, /^DUKABO/);   // from "Duka Bora"
    assert.equal(mem.db.businesses.find((b) => b.id === BIZ2).billing_code, gen.body.code);   // persisted
    assert.equal((await call('PUT', `/api/admin/cloud-billing/clients/${BIZ}/code`, AGENT_T, { code: 'NEW1' })).status, 403);
    const put = await call('PUT', `/api/admin/cloud-billing/clients/${BIZ}/code`, ADMIN, { code: 'new-1' });
    assert.equal(put.status, 200); assert.equal(put.body.code, 'new-1');
    assert.equal(mem.db.businesses.find((b) => b.id === BIZ).billing_code_norm, 'NEW1');   // kept in step
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
    const r = await call('POST', '/api/admin/cloud-billing/test-payment', ADMIN, { amount: 1, bill_ref: 'ACME' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(daraja.simulated.length, 1);
    const sim = daraja.simulated[0].body;
    assert.deepEqual([sim.ShortCode, sim.CommandID, sim.Amount, sim.BillRefNumber], ['174379', 'CustomerPayBillOnline', 1, 'ACME']);
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
    assert.equal(feed.body.receipts[0].bill_ref, 'ACME');
    assert.equal(feed.body.receipts[0].business_name, 'Acme Co');   // A626 Phase 2a: the matched client
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

  // ── Phase 2b: allocation + the credit wallet ─────────────────────────────────────────────────────────────────────
  await ok('a matched payment covering the invoice settles it, extends the branch, opens access; wallet 0, allocated', async () => {
    reset(); seedInvoice(10000);
    const { token } = await register();
    await pay(token);   // 10000 to ACME
    assert.equal(mem.db.invoices[0].status, 'paid');
    assert.equal(mem.db.invoices[0].payment_method, 'mpesa');
    assert.equal(mem.db.branch_cloud_plans[0].paid_until, '2026-12-31T21:00:00Z');   // extended to the period end
    assert.equal(balance(BIZ), 0);
    assert.equal(receipts()[0].status, 'allocated');
    assert.ok(mem.db.feature_flags.some((f) => f.business_id === BIZ && f.key === 'web_hosting' && f.enabled));   // web access on
  });

  await ok('an overpayment settles the invoice and keeps the surplus as credit', async () => {
    reset(); seedInvoice(8000);
    const { token } = await register();
    await pay(token);   // 10000 > 8000
    assert.equal(mem.db.invoices[0].status, 'paid');
    assert.equal(balance(BIZ), 2000);
    assert.equal(receipts()[0].status, 'allocated');
  });

  await ok('an underpayment is held in the wallet; the invoice stays open; status matched', async () => {
    reset(); seedInvoice(15000);
    const { token } = await register();
    await pay(token);   // 10000 < 15000
    assert.equal(mem.db.invoices[0].status, 'pending');
    assert.equal(balance(BIZ), 10000);
    assert.equal(receipts()[0].status, 'matched');
  });

  await ok('with no open invoice the whole payment becomes credit', async () => {
    reset();
    const { token } = await register();
    await pay(token);
    assert.equal(balance(BIZ), 10000);
    assert.equal(receipts()[0].status, 'matched');
  });

  await ok('the wallet auto-applies: a held underpayment plus a later payment settle the invoice', async () => {
    reset(); seedInvoice(15000);
    const { token } = await register();
    await pay(token, { TransID: 'PAYA00001' });   // 10000 held
    assert.equal(mem.db.invoices[0].status, 'pending'); assert.equal(balance(BIZ), 10000);
    await pay(token, { TransID: 'PAYB00002' });    // +10000 → 20000 >= 15000 → settle, 5000 left
    assert.equal(mem.db.invoices[0].status, 'paid'); assert.equal(balance(BIZ), 5000);
  });

  await ok('the admin Allocate drains the wallet into a later invoice (super admin only)', async () => {
    reset();
    const { token } = await register();
    await pay(token);   // 10000 -> wallet (no invoice yet)
    assert.equal(balance(BIZ), 10000);
    mem.db.branches = [{ id: BR, business_id: BIZ, name: 'Main', is_main: true, status: 'active' }];
    mem.db.branch_cloud_plans = [{ branch_id: BR, business_id: BIZ, period: 'monthly', amount: 3000, currency: 'KES', paid_until: '2026-11-01T00:00:00Z', premium: [], package: false, web_off: false }];
    mem.db.invoices = [{ id: 'inv-2', invoice_number: 'INV-2026-0002', business_id: BIZ, kind: 'cloud', status: 'pending', amount: 7000, branch_ids: [BR], period_start: '2026-11-30T21:00:00Z', period_end: '2026-12-31T21:00:00Z' }];
    assert.equal((await call('POST', `/api/admin/cloud-billing/clients/${BIZ}/credit/allocate`, AGENT_T, {})).status, 403);
    const a = await call('POST', `/api/admin/cloud-billing/clients/${BIZ}/credit/allocate`, ADMIN, {});
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.settled, ['INV-2026-0002']); assert.equal(a.body.wallet, 3000);
    assert.equal(mem.db.invoices[0].status, 'paid'); assert.equal(balance(BIZ), 3000);
  });

  await ok('credit GET returns the balance and ledger', async () => {
    reset();
    const { token } = await register();
    await pay(token);   // 10000 -> wallet
    const g = await call('GET', `/api/admin/cloud-billing/clients/${BIZ}/credit`, AGENT_T);
    assert.equal(g.body.balance, 10000); assert.ok((g.body.entries ?? []).length >= 1);
  });

  await ok('auto-drain: held credit settles an open invoice (drainCredits), remainder kept', async () => {
    reset(); seedInvoice(7000);
    mem.db.business_cloud_credit = [{ business_id: BIZ, balance: 10000, currency: 'KES' }];
    const r = await ALLOC.drainCredits();
    assert.deepEqual(r.drained, [BIZ]);
    assert.equal(mem.db.invoices[0].status, 'paid');
    assert.equal(balance(BIZ), 3000);
  });

  await ok('auto-drain is a no-op when the credit is less than the invoice (nothing half-paid)', async () => {
    reset(); seedInvoice(12000);
    mem.db.business_cloud_credit = [{ business_id: BIZ, balance: 5000, currency: 'KES' }];
    const r = await ALLOC.drainCredits();
    assert.deepEqual(r.drained, []);
    assert.equal(mem.db.invoices[0].status, 'pending');
    assert.equal(balance(BIZ), 5000);   // untouched
  });

  // ── Reversal: undo a kept payment (Safaricom reversed it, or a clawback) ─────────────────────────────────────────
  await ok('reverse: a payment still held in the wallet is clawed back in full (super admin)', async () => {
    reset();
    const { token } = await register();
    await pay(token);   // 10000 -> wallet (no invoice), status matched
    assert.equal(balance(BIZ), 10000);
    const rc = receipts()[0];
    assert.equal((await call('POST', `/api/admin/cloud-billing/receipts/${rc.id}/reverse`, AGENT_T)).status, 403);   // agent refused
    const r = await call('POST', `/api/admin/cloud-billing/receipts/${rc.id}/reverse`, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.clawback, r.body.shortfall], [10000, 0]);
    assert.equal(balance(BIZ), 0);
    assert.equal(receipts()[0].status, 'reversed');
    assert.ok(mem.db.admin_audit_log.some((a) => a.action === 'cloud_billing.reverse'));
  });

  await ok('reverse: money already spent on an invoice stays paid; only the held part is clawed back, the shortfall flagged', async () => {
    reset(); seedInvoice(10000);
    const { token } = await register();
    await pay(token);   // 10000 settles the invoice -> wallet 0, allocated, access on
    assert.equal(mem.db.invoices[0].status, 'paid'); assert.equal(balance(BIZ), 0);
    const rc = receipts()[0];
    const r = await call('POST', `/api/admin/cloud-billing/receipts/${rc.id}/reverse`, ADMIN);
    assert.deepEqual([r.body.clawback, r.body.shortfall], [0, 10000]);   // nothing to claw back; 10000 already spent
    assert.equal(mem.db.invoices[0].status, 'paid');                     // NOT rolled back (A626 §10: flag, never silently lock)
    assert.equal(balance(BIZ), 0);
    assert.equal(receipts()[0].status, 'reversed');
  });

  await ok('reverse: an overpayment claws back only the surplus still held, the invoiced part is the shortfall', async () => {
    reset(); seedInvoice(8000);
    const { token } = await register();
    await pay(token);   // 10000: 8000 settles, 2000 surplus in wallet
    assert.equal(balance(BIZ), 2000);
    const rc = receipts()[0];
    const r = await call('POST', `/api/admin/cloud-billing/receipts/${rc.id}/reverse`, ADMIN);
    assert.deepEqual([r.body.clawback, r.body.shortfall], [2000, 8000]);
    assert.equal(balance(BIZ), 0);
  });

  await ok('reverse is idempotent (a second reverse changes nothing)', async () => {
    reset();
    const { token } = await register();
    await pay(token);
    const rc = receipts()[0];
    await call('POST', `/api/admin/cloud-billing/receipts/${rc.id}/reverse`, ADMIN);
    const again = await call('POST', `/api/admin/cloud-billing/receipts/${rc.id}/reverse`, ADMIN);
    assert.equal(again.body.already, true);
    assert.deepEqual([again.body.clawback, again.body.shortfall], [0, 0]);
    assert.equal(balance(BIZ), 0);
  });

  await ok('reverse: an unknown receipt id is 404', async () => {
    reset();
    const r = await call('POST', `/api/admin/cloud-billing/receipts/${BIZ}/reverse`, ADMIN);   // a valid UUID, not a receipt
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  await ok('a reversal CALLBACK undoes the matching payment and is never recorded as income', async () => {
    reset();
    const { token } = await register();
    await pay(token);   // QJK7XT3L5P, 10000 -> wallet
    assert.equal(balance(BIZ), 10000); assert.equal(receipts().length, 1);
    const rev = await pay(token, { TransactionType: 'Reversal', TransID: 'REV0000001', OriginalTransactionID: 'QJK7XT3L5P' });
    assert.deepEqual(rev.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.equal(receipts().length, 1);                 // the reversal is NOT a second receipt
    assert.equal(receipts()[0].status, 'reversed');
    assert.equal(balance(BIZ), 0);                       // the credit is clawed back
  });

  await ok('a reversal callback for an unknown original is ignored (still Accepted, nothing kept)', async () => {
    reset();
    const { token } = await register();
    const rev = await pay(token, { TransactionType: 'Reversal', TransID: 'REV0000002', OriginalTransactionID: 'GHOST99999' });
    assert.deepEqual(rev.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.equal(receipts().length, 0);
  });

  // ── Wallet adjust / refund (super admin) ────────────────────────────────────────────────────────────────────────
  const adjust = (token, body) => call('POST', `/api/admin/cloud-billing/clients/${BIZ}/credit/adjust`, token, body);
  await ok('credit adjust: super admin adds goodwill credit (balance rises, ledger entry, audited; agent refused)', async () => {
    reset();
    assert.equal((await adjust(AGENT_T, { delta: 5000, reason: 'goodwill' })).status, 403);
    const a = await adjust(ADMIN, { delta: 5000, reason: 'goodwill' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.balance, 5000); assert.equal(balance(BIZ), 5000);
    assert.ok(mem.db.cloud_credit_entries.some((e) => e.business_id === BIZ && e.delta === 5000 && e.reason === 'goodwill'));
    assert.ok(mem.db.admin_audit_log.some((l) => l.action === 'cloud_billing.credit_adjust'));
  });

  await ok('credit adjust: a debit/refund removes credit, but never more than the balance (INSUFFICIENT)', async () => {
    reset();
    mem.db.business_cloud_credit = [{ business_id: BIZ, balance: 8000, currency: 'KES' }];
    const over = await adjust(ADMIN, { delta: -9000, reason: 'refund' });
    assert.equal(over.status, 409); assert.equal(over.body.code, 'INSUFFICIENT');
    assert.equal(balance(BIZ), 8000);   // unchanged
    const r = await adjust(ADMIN, { delta: -3000, reason: 'refund paid via B2C' });
    assert.equal(r.status, 200); assert.equal(r.body.balance, 5000); assert.equal(balance(BIZ), 5000);
  });

  await ok('credit adjust: a reason is required; a zero or non-numeric amount is refused', async () => {
    reset();
    assert.equal((await adjust(ADMIN, { delta: 1000, reason: '  ' })).body.code, 'NO_REASON');
    assert.equal((await adjust(ADMIN, { delta: 0, reason: 'x' })).body.code, 'BAD_AMOUNT');
    assert.equal((await adjust(ADMIN, { delta: 'abc', reason: 'x' })).body.code, 'BAD_AMOUNT');
    assert.equal(mem.db.cloud_credit_entries.length, 0);   // nothing written
  });
} finally { server.close(); }

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
