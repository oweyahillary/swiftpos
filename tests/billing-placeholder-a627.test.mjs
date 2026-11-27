/**
 * billing-placeholder-a627.test.mjs — A627 P0-2: ZapTill's placeholder company details must not SAVE as "real", nor PRINT
 * on a client invoice.
 *
 * The sample Paybill 000000 and the sample KRA PIN P000000000X used to save with sample:false and then print on the branch
 * invoice once the "Sample details" marker dropped. Now: INVALID values are refused at save (an EMPTY field may still save —
 * partial setup), and the billing job HOLDS a client invoice while the stored details are a placeholder or incomplete. The
 * checks live once in lib/branchBilling.ts (billingDetailProblems) so save, issue and the admin banner cannot drift.
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/billing-placeholder-a627.test.mjs
 *
 * RUNS the COMPILED cloud: lib/branchBilling.ts (pure), routes/billingDetailsAdmin.ts (save) and jobs/cloudPlanReminders.ts
 * (the issue guard) on the in-memory database (tests/lib-memdb.mjs), the mailer captured.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - billingDetailProblems always []                        → "held while placeholder" fails
 *   - digits() back to `length >= 5` (accepts 000000)        → "all-zero Paybill rejected" fails
 *   - the KRA-format check removed from the save route       → "a malformed KRA PIN is refused" fails
 *   - the issue guard removed (always sends)                 → "a client invoice is held" fails
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
if (!fs.existsSync(path.join(DIST, 'lib/branchBilling.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
delete process.env.TELEGRAM_BOT_TOKEN;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const BB = require(path.join(DIST, 'lib/branchBilling.js'));
const EM = require(path.join(DIST, 'lib/cloudPlanEmail.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const JOB = require(path.join(DIST, 'jobs/cloudPlanReminders.js'));
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
console.warn = () => {}; console.error = () => {};
const mem = installMemDb(supabase);

// The mailer, captured — so we can see which client invoice emails actually go out.
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const mails = [];
mailer.sendEmailChecked = async (m) => { mails.push(m); return { ok: true, provider: 'test' }; };

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const u = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUPER = u(1), AGENT = u(2), M = u(10), B1 = u(11);
const LONG_AGO = '2026-01-01T00:00:00Z';

const reset = (now = Date.now()) => {
  mem.fail = () => null; mem.calls = []; mails.length = 0;
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    businesses: [{ id: M, name: 'Krunch & Co', owner_id: 'not-a-uuid', email: 'owner@krunch.test', status: 'active', type: 'restaurant', currency: 'KES', web_access_expires_at: iso(now + 20 * DAY), created_at: LONG_AGO }],
    branches: [{ id: B1, business_id: M, name: 'Westlands', is_main: true, status: 'active', created_at: '2026-01-01' }],
    cloud_plans: [{ business_id: M, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: null, created_at: LONG_AGO, billing_from: null }],
    // Westlands is due its invoice (its period started an hour ago).
    branch_cloud_plans: [{ branch_id: B1, business_id: M, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, paid_until: iso(now - 3600_000), billing_from: null, web_off: false, premium: [], package: false, notes: null, created_at: LONG_AGO }],
    business_settings: [], feature_flags: [{ business_id: M, key: 'web_hosting', enabled: true }],
    cloud_payments: [], cloud_plan_reminders: [], invoices: [], admin_audit_log: [], admin_notifications: [], admin_settings: [], users: [],
  };
  adminAuth.forgetAdmin(); CP.forgetStanding(); BB.forgetBillingDetails();
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin/billing-details', require(path.join(DIST, 'routes/billingDetailsAdmin.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const ADMIN = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const VALID = { legalName: 'ZapTill Limited', address: 'P.O. Box 1, Nairobi', kraPin: 'P051234567Z', phone: '0717 675 635', mpesaPaybill: '247247', mpesaTill: '', accountRef: 'invoice' };

try {
  console.log('\nA. the shared checks (pure)\n');
  await ok('the KRA format and placeholder helpers', () => {
    assert.ok(BB.KRA_PIN_RE.test('P051234567Z') && BB.KRA_PIN_RE.test('a012345678b'));
    assert.ok(!BB.KRA_PIN_RE.test('P05123Z') && !BB.KRA_PIN_RE.test('051234567Z') && !BB.KRA_PIN_RE.test('X051234567Z'));
    assert.ok(BB.isPlaceholderPayNumber('000000') && BB.isPlaceholderPayNumber('00000'));
    assert.ok(!BB.isPlaceholderPayNumber('247247') && !BB.isPlaceholderPayNumber('') && !BB.isPlaceholderPayNumber('000123'));
    assert.ok(BB.isPlaceholderKraPin('P000000000X') && !BB.isPlaceholderKraPin('P051234567Z') && !BB.isPlaceholderKraPin(''));
  });
  await ok('billingDetailProblems: the sample is unfit (placeholder PIN + no real pay); a real seller is clean', () => {
    const codes = (s) => BB.billingDetailProblems(s).map((p) => p.code).sort();
    assert.deepEqual(codes(EM.SAMPLE_SELLER), ['NO_PAY_NUMBER', 'PLACEHOLDER_KRA_PIN']);
    assert.deepEqual(codes(VALID), []);
    assert.deepEqual(codes({ legalName: '', address: '', kraPin: '', mpesaPaybill: '', mpesaTill: '' }), ['NO_ADDRESS', 'NO_KRA_PIN', 'NO_LEGAL_NAME', 'NO_PAY_NUMBER']);
    assert.deepEqual(codes({ ...VALID, mpesaPaybill: '000000', mpesaTill: '' }), ['NO_PAY_NUMBER']);
  });
  await ok('cleanBillingDetails: an all-zero Paybill reads back as null (not "real"), and carries its problems', () => {
    const d = BB.cleanBillingDetails({ seller: { legalName: 'X', address: 'Y', kraPin: 'P051234567Z', mpesaPaybill: '000000' }, prices: {} });
    assert.equal(d.seller.mpesaPaybill, null);
    assert.ok(d.problems.some((p) => p.code === 'NO_PAY_NUMBER'));
    const good = BB.cleanBillingDetails({ seller: { legalName: 'X', address: 'Y', kraPin: 'P051234567Z', mpesaPaybill: '247247' }, prices: {} });
    assert.equal(good.seller.mpesaPaybill, '247247'); assert.deepEqual(good.problems, []);
  });

  console.log('\nB. the save route refuses invalid values (empty is allowed)\n');
  await ok('a real seller saves; GET exposes problems', async () => {
    reset();
    const s = await call('PUT', '/api/admin/billing-details', ADMIN, { seller: VALID, prices: {} });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.saved, true); assert.deepEqual(s.body.problems, []);
    const g = await call('GET', '/api/admin/billing-details', ADMIN);
    assert.deepEqual(g.body.problems, []);
  });
  await ok('a malformed KRA PIN is refused (BAD_KRA_PIN); an empty PIN saves (partial setup)', async () => {
    reset();
    assert.equal((await call('PUT', '/api/admin/billing-details', ADMIN, { seller: { ...VALID, kraPin: 'NOT-A-PIN' }, prices: {} })).body.code, 'BAD_KRA_PIN');
    const s = await call('PUT', '/api/admin/billing-details', ADMIN, { seller: { ...VALID, kraPin: '' }, prices: {} });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.ok(s.body.problems.some((p) => p.code === 'NO_KRA_PIN'), 'empty PIN saves but is still flagged for issuing');
  });
  await ok('an all-zero Paybill or Till is refused (BAD_PAYBILL), not silently accepted', async () => {
    reset();
    assert.equal((await call('PUT', '/api/admin/billing-details', ADMIN, { seller: { ...VALID, mpesaPaybill: '000000' }, prices: {} })).body.code, 'BAD_PAYBILL');
    assert.equal((await call('PUT', '/api/admin/billing-details', ADMIN, { seller: { ...VALID, mpesaPaybill: '', mpesaTill: '000000' }, prices: {} })).body.code, 'BAD_PAYBILL');
    assert.equal((await call('PUT', '/api/admin/billing-details', ADMIN, { seller: { ...VALID, mpesaPaybill: '', mpesaTill: '' }, prices: {} })).body.code, 'BAD_PAYBILL');
  });
  await ok('a format-valid-but-placeholder PIN (P000000000X) may save, but stays flagged for issuing', async () => {
    reset();
    const s = await call('PUT', '/api/admin/billing-details', ADMIN, { seller: { ...VALID, kraPin: 'P000000000X' }, prices: {} });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.ok(s.body.problems.some((p) => p.code === 'PLACEHOLDER_KRA_PIN'));
  });

  console.log('\nC. the billing job holds a client invoice until the details are real\n');
  await ok('placeholder/sample details: the branch invoice is HELD (not emailed) and the reason recorded', async () => {
    reset();   // no details saved → the sample seller (placeholders)
    const out = await JOB.runCloudBilling(new Date(), { force: true });
    assert.ok(out.sent.some((x) => x.milestone === 'invoice'), 'the invoice is still raised');
    assert.equal(mem.db.invoices.length, 1, 'the invoice is recorded for the ledger');
    assert.ok(!mails.some((m) => m.to === 'owner@krunch.test'), 'no client invoice emailed with placeholder details');
    const held = mem.db.cloud_plan_reminders.find((r) => r.milestone === 'invoice');
    assert.match(String(held?.error ?? ''), /billing details are not ready|placeholder/i);
  });
  await ok('once real details are saved: the next due invoice IS emailed to the client', async () => {
    reset();
    mem.db.admin_settings.push({ key: 'billing_details', value: { seller: { ...VALID, sample: false }, prices: {} } });
    BB.forgetBillingDetails();
    await JOB.runCloudBilling(new Date(), { force: true });
    assert.ok(mails.some((m) => m.to === 'owner@krunch.test'), 'the client invoice is emailed once the details are real');
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
