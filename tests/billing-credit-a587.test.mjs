/**
 * billing-credit-a587.test.mjs — A587: the owner's billing and credit decisions of 2026-10-24.
 *
 * Owner, 2026-10-24 (billing): "What happens to the old unpaid invoice of a locked client who pays? — we offset it; if they
 * fail to pay for 3 months we assume they are not interested", corrected the same day: "it's pay as you go, not pay for
 * missed months, since they won't be using the system at that time" · "Trial: Yes they get an invoice then as usual" ·
 * "Should already-locked clients get the 7 days? — no" · "Should Disable switch a client off at once? — yes".
 * (credit): General Managers may set credit limits · "Can a co-owner partner set credit limits? — yes for their selected
 * branch" · "Is confirming a waiting credit sale limited to the approvers? — yes".
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/billing-credit-a587.test.mjs
 *
 * RUNS the COMPILED server — lib/cloudPlan.js, lib/webAccess.js, the billing job, the real requireAuth (both gates), the
 * admin, cloud-plan admin, auth (enrolment), business, credit and pos routers over HTTP on in-memory databases — and the
 * dashboard's / admin portal's own words from their TypeScript.
 *   1 pay as you go: a LOCKED client who pays starts a fresh period from the payment day; the locked time's open invoice(s)
 *     are closed (written off, not charged); within the 7 days the period continues from the due date (A584); a locked
 *     client is not invoiced again; month ends
 *   2 "Not interested" 3 months after the first unpaid due date (month ends held): the open invoices written off, audited,
 *     ZapTill once, still locked, no more invoices; a payment starts afresh; the admin list and filter
 *   3 a trial ends like a paid client: the invoice on its end day, the 7 days with full access, then locked
 *     (CLOUD_TRIAL_ENDED); the last-7-days notice kept
 *   4 the bridge keeps an already-locked licence locked (no 7 days, no arrears invoice)
 *   5 Disable = a hard off at once (web, sync, enrolment), audited; Enable restores only while paid-until is ahead
 *   6 credit: the built-in General Manager sets limits; a partner at one of their branches does (audited with the branch),
 *     not in "All my branches" nor with no branch picked; with approval ON only the branch's chosen approvers (and the
 *     owner) confirm or dispute a waiting sale — on the web and replayed by a POS; OFF unchanged
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A587 report):
 *   - workOut's fresh start only for 'not_interested' (a locked client continuing from its due date)  → 1 "fresh" fails
 *   - paymentCovers closing nothing on a fresh start                                                     → 1 "closed, not charged" fails
 *   - adminMilestones invoicing a locked client                                                          → 1 "not invoiced again" fails
 *   - cloudStanding without the not_interested state                                                     → 2 fails
 *   - the job not writing off on not_interested                                                          → 2 "written off" fails
 *   - cloudStanding's trial on trialState (the old reports-only week)                                    → 3 "the 7 days" fails
 *   - the bridge without lockedUnderOldLadder                                                            → 4 fails
 *   - the hard off removed (webHosting false ignored on a plan)                                          → 5 fails
 *   - isBuiltInManagerRole without 'general manager'                                                     → 6 "GM" fails
 *   - maySetCreditLimits without isPartnerAtOwnBranch                                                    → 6 "partner at their branch" fails
 *   - partnerLimitScope ignoring branchSet                                                               → 6 "All my branches" fails
 *   - decide() without the approver check                                                                → 6 "confirm limited" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/cloudPlan.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.ADMIN_ALERT_EMAIL = 'billing@zaptill.test';
process.env.TILL_SCOPE_ENFORCE = 'true';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.LOGIN_OTP;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const memFrom = supabase.from;
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
supabase.auth.admin.getUserById = async (uid) => ({ data: { user: { id: uid, email: uid === OWNER ? 'owner@pollo.test' : null } }, error: null });
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const mails = [];
mailer.sendEmailChecked = async (m) => { mails.push(m); return { ok: true, provider: 'test' }; };
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
const { requireAuth } = require(path.join(DIST, 'middleware/auth.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const W = require(path.join(DIST, 'lib/webAccess.js'));
const JOB = require(path.join(DIST, 'jobs/cloudPlanReminders.js'));
const CA = require(path.join(DIST, 'lib/creditApprovers.js'));
const N = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/cloudTrialNotice.ts')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/cloudPlan.ts')).href);
const LA = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/creditApprovers.ts')).href);

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const SUPER = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const M = '11111111-1111-4111-8111-111111111111';    // a monthly plan (Pollo)
const BL = '11111111-1111-4111-8111-111111111113';   // a licence locked under the old ladder, no plan yet
const TR = '11111111-1111-4111-8111-111111111116';   // a cloud trial
const MR = '22222222-2222-4222-8222-222222222221', TRB = '22222222-2222-4222-8222-222222222226';
const CODE = 'ABCD-EFGH';
const hash = (c) => crypto.createHash('sha256').update(c).digest('hex');
const biz = (id = M) => mem.db.businesses.find((b) => b.id === id);
const setPaidUntil = (ms, id = M) => { biz(id).web_access_expires_at = ms === null ? null : iso(ms); CP.forgetStanding(); };
const LONG_AGO = '2026-01-01T00:00:00.000Z';
const trialRow = () => mem.db.business_settings.find((r) => r.business_id === TR && r.key === 'cloud_trial');
const setTrialEnd = (ms) => { trialRow().value = { ...trialRow().value, ends_at: iso(ms) }; biz(TR).web_access_expires_at = iso(ms); CP.forgetStanding(); };
const reset = () => {
  supabase.from = memFrom;
  mem.fail = () => null; mem.calls = []; mails.length = 0;
  const now = Date.now();
  mem.db = {
    admin_users: [{ id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true }],
    businesses: [
      { id: M, name: 'Pollo Grill', owner_id: OWNER, email: 'shop@pollo.test', status: 'active', type: 'restaurant', currency: 'KES', web_access_expires_at: iso(now + 20 * DAY), created_at: '2026-01-01T00:00:00Z' },
      { id: BL, name: 'Old Kiosk', owner_id: 'b', email: 'old@kiosk.test', status: 'active', type: 'retail', currency: 'KES', web_access_expires_at: iso(now - 40 * DAY), created_at: '2025-06-01T00:00:00Z' },
      { id: TR, name: 'Trial Salon', owner_id: 't', email: 'trial@salon.test', status: 'active', type: 'other', currency: 'KES', web_access_expires_at: iso(now + 10 * DAY), created_at: '2026-09-20T00:00:00Z' },
    ],
    branches: [{ id: MR, business_id: M, name: 'Main', is_main: true, status: 'active', desktop_licensed: true },
      { id: TRB, business_id: TR, name: 'Main', is_main: true, status: 'active', desktop_licensed: true }],
    cloud_plans: [{ business_id: M, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: 'boss@zaptill.test', created_at: LONG_AGO }],
    business_settings: [{ business_id: TR, key: 'cloud_trial', value: { started_at: iso(now - 20 * DAY), ends_at: iso(now + 10 * DAY), branch_id: TRB, started_by: SUPER, converted_at: null } }],
    feature_flags: [{ business_id: M, key: 'web_hosting', enabled: true }, { business_id: BL, key: 'web_hosting', enabled: true }, { business_id: TR, key: 'web_hosting', enabled: true }],
    user_devices: [{ id: 'ud1', business_id: M, device_id: 'till-M', status: 'approved', retired_at: null, branch_id: MR },
      { id: 'ud2', business_id: BL, device_id: 'till-BL', status: 'approved', retired_at: null, branch_id: null },
      { id: 'ud3', business_id: TR, device_id: 'till-TR', status: 'approved', retired_at: null, branch_id: TRB }],
    device_enrolment_codes: [{ id: 'ec1', business_id: M, branch_id: MR, code_hash: hash(CODE), status: 'active', expires_at: iso(now + 600_000) }],
    cloud_payments: [], cloud_plan_reminders: [], invoices: [], admin_audit_log: [], subscriptions: [], plans: [],
    users: [{ id: OWNER, business_id: M, name: 'Owner', status: 'active', permissions_version: 0 }],
    refresh_tokens: [], products: [], orders: [], notifications: [],
  };
  adminAuth.forgetAdmin();
  CP.forgetStanding();
};
reset();

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin/clients', require(path.join(DIST, 'routes/cloudPlanAdmin.js')).default);
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
app.use('/api/business', require(path.join(DIST, 'routes/business.js')).default);
app.use('/api/credit', require(path.join(DIST, 'routes/credit.js')).default);
app.post('/api/sync/push', requireAuth, (_req, res) => res.json({ ok: true, upserted: {}, rejected: [] }));
app.get('/api/reports/daily', requireAuth, (_req, res) => res.json({ total: 1 }));
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ADMIN = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const till = (businessId, deviceId, branchId) => jwt.sign({ userId: null, deviceId, till: true, businessId, branchId, isOwner: false,
  permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const web = (businessId) => jwt.sign({ userId: OWNER, businessId, branchId: null, isOwner: true, ownerLogin: true, surface: 'dashboard', permissionKeys: ['*'],
  permissionsVersion: 0, sessionId: 's' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const TILL_M = till(M, 'till-M', MR), TILL_BL = till(BL, 'till-BL', null), TILL_TR = till(TR, 'till-TR', TRB);
const pay = (id, body) => call('POST', `/api/admin/clients/${id}/cloud-plan/payments`, ADMIN, body);
const preview = (id, body) => call('POST', `/api/admin/clients/${id}/cloud-plan/payments/preview`, ADMIN, body);
const run = (now = new Date()) => JOB.runCloudBilling(now, { force: true });
const pendingInvoice = (businessId, start, n = '0001') => {
  const row = { id: `inv-${n}`, business_id: businessId, invoice_number: `INV-2026-${n}`, amount: 3000, currency: 'KES', status: 'pending', kind: 'cloud',
    period_start: start, period_end: CP.addMonthsClamped(start, 1), created_at: start };
  mem.db.invoices.push(row); return row;
};
const NO_REVOKE = /lock|revok|paus|suspend|grace|expir|deadline|overdue|7 days|until|warn/i;
const stripTags = (h) => h.replace(/<[^>]+>/g, ' ');
const near = (a, b, ms = 120_000) => Math.abs(Date.parse(a) - Date.parse(b)) < ms;

try {
  console.log('\n1. Pay as you go — a locked client starts afresh; the locked time is not charged\n');
  await ok('the rules: a fresh start closes every open invoice; within the 7 days the due invoice is paid; month ends held', () => {
    const open = [{ id: 'a', invoice_number: 'INV-1', period_start: '2026-08-01T07:00:00.000Z', period_end: '2026-09-01T07:00:00.000Z', amount: 3000, status: 'pending' },
      { id: 'b', invoice_number: 'INV-2', period_start: '2026-09-01T07:00:00.000Z', period_end: '2026-10-01T07:00:00.000Z', amount: 3000, status: 'pending' },
      { id: 'c', invoice_number: 'INV-3', period_start: '2026-07-01T07:00:00.000Z', period_end: '2026-08-01T07:00:00.000Z', amount: 3000, status: 'paid' }];
    const f = CP.paymentCovers({ from: '2026-10-24T09:00:00.000Z', until: '2026-11-24T09:00:00.000Z', outstanding: open, fresh: true });
    assert.deepEqual([f.fresh, f.settles.length, f.closes.map((i) => i.invoice_number)], [true, 0, ['INV-1', 'INV-2']], 'both unpaid ones closed, the paid one untouched');
    const w = CP.paymentCovers({ from: '2026-09-01T07:00:00.000Z', until: '2026-10-01T07:00:00.000Z', outstanding: open, fresh: false });
    assert.deepEqual([w.settles.map((i) => i.invoice_number), w.closes.length], [['INV-2'], 0]);
    // within the 7 days at a month end: due 31 Jan → paid until 28 Feb (the period continues from the due date)
    const m = CP.nextPaidUntil({ period: 'monthly', now: Date.parse('2027-02-03T09:00:00Z'), paidUntil: '2027-01-31T07:00:00.000Z', continueFrom: '2027-01-31T07:00:00.000Z' });
    assert.deepEqual([m.from, m.until], ['2027-01-31T07:00:00.000Z', '2027-02-28T07:00:00.000Z']);
    const words = P.coversLine({ from: '2026-10-24T09:00:00.000Z', until: '2026-11-24T09:00:00.000Z', fresh: true, state: 'locked', settles: [], closes: f.closes });
    assert.equal(words, 'Starts a new period: 24 Oct 2026 – 24 Nov 2026. INV-1 and INV-2 (not used while paused) are closed, not charged.');
    assert.match(P.coversLine({ from: '2026-09-01T07:00:00.000Z', until: '2026-10-01T07:00:00.000Z', fresh: false, settles: w.settles, closes: [] }), /^Pays INV-2 \(0?1 Sept? 2026 – 0?1 Oct 2026\); paid until 0?1 Oct 2026\.$/);
  });
  await ok('a locked client is not invoiced again (no invoice for the months it cannot use); ZapTill hears of the lock once', async () => {
    reset(); setPaidUntil(Date.now() - 40 * DAY);
    pendingInvoice(M, biz(M).web_access_expires_at);
    const out = await run();
    assert.equal(mem.db.invoices.filter((i) => i.business_id === M).length, 1, 'no second invoice');
    assert.deepEqual(out.sent.filter((x) => x.business_id === M).map((x) => x.milestone), ['locked']);
    assert.equal(mails.filter((m) => m.to === 'owner@pollo.test').length, 0);
    const s = CP.cloudStanding((await CP.readCloudFacts([M])).get(M));
    assert.deepEqual(CP.invoiceStarts(s, null, Date.now()), []); assert.deepEqual(CP.adminMilestones(s, Date.now()), ['locked']);
  });
  await ok('the Record payment form says it: "Starts a new period: … INV-… (not used while paused) is closed, not charged."', async () => {
    const r = await preview(M, { period: 'monthly' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.fresh, r.body.state, r.body.closes.map((i) => i.invoice_number)], [true, 'locked', ['INV-2026-0001']]);
    assert.ok(near(r.body.from, iso(Date.now())));
    assert.match(P.coversLine(r.body), /^Starts a new period: .+ – .+\. INV-2026-0001 \(not used while paused\) is closed, not charged\.$/);
    assert.match(read('apps/admin/src/CloudPlanCard.tsx'), /data-testid="pay-covers"[\s\S]{0,200}coversLine\(cover\)/);
  });
  await ok('the payment: a fresh period from today (not from the due date), the locked time\'s invoice closed (written off, audited), a new paid invoice; all open at once', async () => {
    const r = await pay(M, { amount: 3000, method: 'mpesa', reference: 'SJK0FRESH1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(near(biz(M).web_access_expires_at, CP.addMonthsClamped(iso(Date.now()), 1)), 'a month from today');
    const old = mem.db.invoices.find((i) => i.id === 'inv-0001');
    assert.equal(old.status, 'written_off', 'not charged');
    const paid = mem.db.invoices.filter((i) => i.business_id === M && i.status === 'paid');
    assert.equal(paid.length, 1); assert.ok(near(paid[0].period_start, iso(Date.now()))); assert.equal(paid[0].payment_reference, 'SJK0FRESH1');
    assert.deepEqual(r.body.not_charged, ['INV-2026-0001']);
    const a = mem.db.admin_audit_log.find((x) => x.action === 'cloud_plan.payment');
    assert.deepEqual([a.before_data.state, a.after_data.fresh_start, a.after_data.not_charged], ['locked', true, ['INV-2026-0001']]);
    assert.match(a.after_data.not_charged_reason, /Not charged — access was paused/);
    assert.equal((await call('GET', '/api/reports/daily', web(M))).status, 200);
    assert.equal((await call('POST', '/api/sync/push', TILL_M, {})).status, 200);
  });
  await ok('within the 7 days (it still had access): the period continues from the due date and pays that invoice — nothing closed', async () => {
    reset(); setPaidUntil(Date.now() - 3 * DAY);
    const due = biz(M).web_access_expires_at;
    const inv = pendingInvoice(M, due);
    const pv = await preview(M, { period: 'monthly' });
    assert.deepEqual([pv.body.fresh, pv.body.settles.map((i) => i.invoice_number), pv.body.closes.length, pv.body.from], [false, ['INV-2026-0001'], 0, due]);
    assert.match(P.coversLine(pv.body), /^Pays INV-2026-0001/);
    const r = await pay(M, { amount: 3000, method: 'mpesa', reference: 'SJK0WEEK01' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(biz(M).web_access_expires_at, CP.addMonthsClamped(due, 1));
    assert.deepEqual([inv.status, inv.payment_reference], ['paid', 'SJK0WEEK01']);
    assert.deepEqual(r.body.not_charged, []);
  });

  console.log('\n2. "Not interested" — 3 months unpaid after the first unpaid due date\n');
  await ok('the clock: 3 months after the due date (month ends held: 30 Nov → 28 Feb; 30 Nov 2027 → 29 Feb 2028), or after billing began when later', () => {
    assert.equal(CP.notInterestedAtFor('2026-11-30T07:00:00.000Z'), '2027-02-28T07:00:00.000Z');
    assert.equal(CP.notInterestedAtFor('2027-11-30T07:00:00.000Z'), '2028-02-29T07:00:00.000Z');
    assert.equal(CP.notInterestedAtFor('2026-08-01T07:00:00.000Z', '2026-10-24T07:00:00.000Z'), '2027-01-24T07:00:00.000Z');
    const due = '2026-11-30T07:00:00.000Z';
    const f = { onPlan: true, planCreatedAt: LONG_AGO, trial: null, expiresAt: due, webHosting: true };
    const before = CP.cloudStanding(f, Date.parse('2027-02-28T06:59:00Z')), after = CP.cloudStanding(f, Date.parse('2027-02-28T07:00:00Z'));
    assert.equal(before.state, 'locked'); assert.equal(after.state, 'not_interested');
    assert.deepEqual([after.syncRefused, after.webLocked, after.notInterestedAt], [true, true, '2027-02-28T07:00:00.000Z']);
    assert.deepEqual(CP.adminMilestones(after, Date.parse('2027-02-28T09:00:00Z')), ['not_interested']);
    assert.deepEqual(CP.invoiceStarts(after, null, Date.parse('2027-02-28T09:00:00Z')), [], 'no more invoices');
  });
  const threeMonthsAgo = () => Date.parse(CP.addMonthsClamped(iso(Date.now()), -3)) - 2 * DAY;
  await ok('the job: the open cloud invoice written off (audited, the numbers), ZapTill once — never the client; no invoice after', async () => {
    reset(); setPaidUntil(threeMonthsAgo());
    const inv = pendingInvoice(M, biz(M).web_access_expires_at);
    await run();
    assert.equal(inv.status, 'written_off');
    const a = mem.db.admin_audit_log.find((x) => x.action === 'cloud_plan.not_interested' && x.business_id === M);
    assert.ok(a); assert.deepEqual(a.after_data.written_off, ['INV-2026-0001']); assert.equal(a.after_data.state, 'not_interested');
    // A589: ZapTill hears on the admin portal's bell (and the daily billing summary), not by an email each.
    const n = (mem.db.admin_notifications ?? []).filter((x) => x.category === 'billing' && x.data?.milestone === 'not_interested');
    assert.equal(n.length, 1); assert.match(n[0].title, /Not interested/); assert.match(n[0].detail, /INV-2026-0001/);
    assert.deepEqual(n[0].data.written_off, ['INV-2026-0001']);
    assert.equal(mails.filter((m) => /billing@zaptill\.test/.test(m.to)).length, 0, 'no admin email');
    assert.equal(mails.filter((m) => m.to === 'owner@pollo.test').length, 0);
    mails.length = 0; await run();
    assert.equal(mails.length, 0, 'once'); assert.equal(mem.db.invoices.filter((i) => i.business_id === M).length, 1, 'no new invoice');
    assert.equal((mem.db.admin_notifications ?? []).filter((x) => x.data?.milestone === 'not_interested').length, 1, 'the bell once');
    assert.equal((await call('POST', '/api/sync/push', TILL_M, {})).status, 503, 'still locked');
    assert.equal((await call('GET', '/api/reports/daily', web(M))).status, 403);
  });
  await ok('the admin list: "Not interested (since …)" with its own filter; not in Locked; not in the daily digest', async () => {
    const list = await call('GET', '/api/admin/clients?expiry=not_interested', ADMIN);
    assert.deepEqual(list.body.clients.map((c) => c.id), [M]);
    assert.match(P.expiryText(list.body.clients[0].cloud).text, /^Not interested \(since \d+ \w+ \d{4}\)$/);
    assert.equal((await call('GET', '/api/admin/clients?expiry=locked', ADMIN)).body.clients.some((c) => c.id === M), false);
    assert.equal((await CP.billingDigestLines()).some((l) => /Pollo/.test(l)), false);
    assert.match(P.standingLine(list.body.clients[0].cloud).title, /^Not interested \(since/);
    assert.match(read('apps/admin/src/AdminPortal.tsx'), /<option value="not_interested">Not interested<\/option>/);
  });
  await ok('if it pays later: a fresh period from that day (no arrears), active again', async () => {
    const r = await pay(M, { amount: 3000, method: 'mpesa', reference: 'SJK0BACK01' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(near(biz(M).web_access_expires_at, CP.addMonthsClamped(iso(Date.now()), 1)));
    assert.equal(r.body.standing.state, 'active'); assert.equal(r.body.covers.fresh, true);
  });

  console.log('\n3. A trial ends like a paid client\n');
  await ok('the last 7 days\' notice is kept (the owner only); nothing after the end (no reports-only week)', async () => {
    assert.match(N.trialNotice({ ends_at: iso(Date.now() + 3 * DAY), phase: 'active' }), /Your cloud trial ends on/);
    assert.equal(N.trialNotice({ ends_at: iso(Date.now() + 9 * DAY), phase: 'active' }), null);
    reset(); setTrialEnd(Date.now() - 2 * 3600_000);
    assert.equal((await call('GET', '/api/business/cloud-trial', web(TR))).body.trial.phase, 'ended');
    assert.equal(N.trialNotice({ ends_at: iso(Date.now() - 3600_000), phase: 'ended' }), null);
  });
  await ok('its end day: an invoice like a paid client\'s (KES 3,000, from the end) emailed to the owner — says the trial ended, no lock words', async () => {
    const end = biz(TR).web_access_expires_at;
    await run();
    const inv = mem.db.invoices.find((i) => i.business_id === TR);
    assert.ok(inv, 'invoiced'); assert.deepEqual([inv.status, inv.kind, inv.amount, inv.period_start], ['pending', 'cloud', 3000, end]);
    const mail = mails.find((m) => m.to === 'trial@salon.test');
    assert.ok(mail); assert.match(stripTags(mail.html), /trial ended on/); assert.doesNotMatch(stripTags(mail.html), NO_REVOKE);
    // A589: ZapTill's copy on the admin portal's bell, not an email.
    assert.ok((mem.db.admin_notifications ?? []).some((n) => n.category === 'billing' && n.business_id === TR && /Trial Salon/.test(n.title)));
    assert.equal(mails.filter((m) => /billing@zaptill\.test/.test(m.to)).length, 0);
  });
  await ok('the 7 days with full access (web and sync), then locked with the trial\'s words (CLOUD_TRIAL_ENDED)', async () => {
    const w = await W.getWebAccess(TR, 'active');
    assert.deepEqual([w.state, w.fullAccess, w.trial], ['grace', true, true]);
    assert.equal((await call('POST', '/api/sync/push', TILL_TR, {})).status, 200);
    setTrialEnd(Date.now() - 9 * DAY);
    const l = await W.getWebAccess(TR, 'active');
    assert.equal(l.state, 'locked'); assert.equal(W.webAccessRefusal(l).code, 'CLOUD_TRIAL_ENDED');
    const s = await call('POST', '/api/sync/push', TILL_TR, {});
    assert.equal(s.status, 503); assert.match(s.body.error, /trial has ended/);
    const r = await call('GET', '/api/reports/daily', web(TR));
    assert.equal(r.status, 403); assert.equal(r.body.code, 'CLOUD_TRIAL_ENDED');
  });
  await ok('a locked trial that pays: converted, a fresh period from today, its invoice closed (not charged)', async () => {
    const r = await pay(TR, { amount: 3000, period: 'monthly', method: 'cash' });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.trial_converted, true);
    assert.ok(near(biz(TR).web_access_expires_at, CP.addMonthsClamped(iso(Date.now()), 1)));
    assert.equal(mem.db.invoices.find((i) => i.business_id === TR && i.status === 'written_off')?.period_start !== undefined, true);
  });

  console.log('\n4. The bridge keeps an already-locked licence locked\n');
  await ok('40 days past its date (locked under the old ladder): put on the plan due from its own date — locked at once, no 7 days, no arrears invoice', async () => {
    reset();
    const out = await run();
    assert.ok(out.bridged.includes(BL));
    const plan = mem.db.cloud_plans.find((p) => p.business_id === BL);
    assert.equal(plan.billing_from, biz(BL).web_access_expires_at);
    assert.match(plan.notes, /kept locked/);
    const a = mem.db.admin_audit_log.find((x) => x.action === 'cloud_plan.bridge' && x.business_id === BL);
    assert.equal(a.after_data.kept_locked, true);
    assert.equal(mem.db.invoices.some((i) => i.business_id === BL), false, 'no arrears invoice');
    assert.equal(mails.some((m) => m.to === 'old@kiosk.test'), false);
    assert.equal((await call('POST', '/api/sync/push', TILL_BL, {})).status, 503);
    assert.equal((await W.getWebAccess(BL, 'active')).canLogin, false);
    assert.equal(CP.lockedUnderOldLadder(iso(Date.now() - 27 * DAY), Date.now()), false, '27 days: the A584 bridge (the 7 days)');
    assert.equal(CP.lockedUnderOldLadder(iso(Date.now() - 28 * DAY), Date.now()), true);
  });
  await ok('…and when it pays: a fresh period from the payment day', async () => {
    const r = await pay(BL, { amount: 36000, period: '12_months', method: 'cash' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(near(biz(BL).web_access_expires_at, CP.addMonthsClamped(iso(Date.now()), 12)));
    assert.equal((await call('POST', '/api/sync/push', TILL_BL, {})).status, 200);
  });

  console.log('\n5. "Disable web access" is a hard off at once\n');
  await ok('paid 20 days ahead, Disable: the web paused, sync refused and no POS joins — at once; audited; not invoiced', async () => {
    reset();
    const d = await call('PATCH', `/api/admin/clients/${M}/features/web_hosting`, ADMIN, { enabled: false });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.ok(mem.db.admin_audit_log.some((a) => a.action === 'feature.disable' && a.business_id === M));
    const r = await call('GET', '/api/reports/daily', web(M));
    assert.equal(r.status, 403); assert.equal(r.body.code, 'CLOUD_ACCESS_PAUSED');
    assert.equal((await call('POST', '/api/sync/push', TILL_M, {})).status, 503);
    const e = await call('POST', '/api/auth/enrol/redeem', null, { business_id: M, code: CODE, device_id: 'new-till' });
    assert.equal(e.body?.code, 'CLOUD_SUBSCRIPTION_ENDED');
    const s = CP.cloudStanding((await CP.readCloudFacts([M])).get(M));
    assert.equal(s.state, 'off'); assert.deepEqual(CP.adminMilestones(s, Date.now()), []);
    assert.equal((await W.getWebAccess(M, 'active')).canLogin, false);
    assert.deepEqual((await call('GET', '/api/admin/clients?expiry=off', ADMIN)).body.clients.map((c) => c.id), [M]);
  });
  await ok('Enable restores it while the paid-until is ahead; once it has passed, 409 — record a payment', async () => {
    assert.equal((await call('PATCH', `/api/admin/clients/${M}/features/web_hosting`, ADMIN, { enabled: true })).status, 200);
    assert.equal((await call('GET', '/api/reports/daily', web(M))).status, 200);
    assert.equal((await call('POST', '/api/sync/push', TILL_M, {})).status, 200);
    await call('PATCH', `/api/admin/clients/${M}/features/web_hosting`, ADMIN, { enabled: false });
    setPaidUntil(Date.now() - DAY);
    const r = await call('PATCH', `/api/admin/clients/${M}/features/web_hosting`, ADMIN, { enabled: true });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'WEB_ACCESS_BY_PLAN');
    const a = read('apps/admin/src/AdminPortal.tsx');
    assert.match(a, /data-testid="web-access-enable"/); assert.match(a, /switches the client off at once/);
  });
} finally { /* the credit half shares the server */ }

// ── 6. Credit ────────────────────────────────────────────────────────────────────────────────────────────────────────
const id = () => crypto.randomUUID();
const BZ = id(), BR = id(), BR2 = id(), BR3 = id(), OWN = id(), MGR = id(), GM = id(), FGM = id(), SUP = id(), PART = id();
const CUST = id(), ORD = id();
const R = Object.fromEntries(['Manager', 'General Manager', 'Supervisor'].map((n) => [n, id()]));
const R_FGM = id();
const PID = Object.fromEntries(['orders.create', 'customers.view', 'customers.credit'].map((k) => [k, id()]));
let db;
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });
const creditReset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWN, name: 'Duka' }],
    branches: [{ id: BR, business_id: BZ, name: 'Westlands', status: 'active' }, { id: BR2, business_id: BZ, name: 'Karen', status: 'active' }, { id: BR3, business_id: BZ, name: 'CBD', status: 'active' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [...Object.entries(R).map(([name, rid]) => ({ id: rid, business_id: BZ, name, is_default: true })), { id: R_FGM, business_id: BZ, name: 'General Manager', is_default: false }],
    role_permissions: [...[R.Manager, R['General Manager'], R.Supervisor, R_FGM].flatMap((r) => ['orders.create', 'customers.view', 'customers.credit'].map((k) => grant(r, k)))],
    users: [
      { id: OWN, business_id: BZ, name: 'Olga', role_id: null, status: 'active', permissions_version: 1 },
      { id: MGR, business_id: BZ, name: 'Max', role_id: R.Manager, status: 'active', permissions_version: 1 },
      { id: GM, business_id: BZ, name: 'Gina', role_id: R['General Manager'], status: 'active', permissions_version: 1 },
      { id: FGM, business_id: BZ, name: 'Faye', role_id: R_FGM, status: 'active', permissions_version: 1 },
      { id: SUP, business_id: BZ, name: 'Ann', role_id: R.Supervisor, status: 'active', permissions_version: 1 },
      { id: PART, business_id: BZ, name: 'Peter', role_id: R.Supervisor, status: 'active', permissions_version: 1 },
    ],
    user_branches: [{ user_id: MGR, branch_id: BR }, { user_id: SUP, branch_id: BR }, { user_id: PART, branch_id: BR }, { user_id: PART, branch_id: BR2 }],
    user_permissions: [], user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null, terminal_code: 'T1', branch_id: BR }],
    customers: [{ id: CUST, business_id: BZ, name: 'Acme Ltd', phone: '0712 000 111', credit_limit: 1000, credit_balance: 0, status: 'active' }],
    orders: [{ id: ORD, business_id: BZ, order_number: 'T1-0042' }],
    credit_confirmations: [{ order_id: ORD, business_id: BZ, branch_id: BR, customer_id: CUST, amount: 250, state: 'awaiting', source: 'till', over_limit: false, cashier_id: SUP, sold_at: '2026-10-23T08:00:00.000Z' }],
    audit_log: [], business_settings: [], feature_flags: [],
  };
};
const view = (table, r) => {
  if (table === 'role_permissions' || table === 'user_permissions') return { ...r, permissions: db.permissions.find((p) => p.id === r.permission_id) ?? null };
  if (table === 'roles') return { ...r, role_permissions: db.role_permissions.filter((g) => g.role_id === r.id).map((g) => view('role_permissions', g)) };
  if (table === 'users') {
    const role = db.roles.find((x) => x.id === r.role_id);
    return { ...r, roles: role ? view('roles', role) : null, user_permissions: [], user_branches: db.user_branches.filter((b) => b.user_id === r.id) };
  }
  return r;
};
const creditFrom = (table) => {
  const f = []; let patch = null; let inserted = null; let lim = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (inserted) return inserted;
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    const all = rows().map((r) => view(table, r));
    return lim === null ? all : all.slice(0, lim);
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => (k.includes('.') ? true : r[k] === v)); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => (k.includes('.') ? true : a.includes(r[k]))); return q; };
      if (prop === 'limit') return (n) => { lim = n; return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'insert' || prop === 'upsert') return (r) => {
        inserted = (Array.isArray(r) ? r : [r]).map((x) => { const row = { id: x.id ?? id(), created_at: new Date().toISOString(), ...x }; (db[table] ??= []).push(row); return row; });
        return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none', code: 'PGRST116' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null, count: run().length }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
const KEYS = ['orders.create', 'customers.view', 'customers.credit'];
const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', businessId: BZ, branchId: BR, isOwner: false, ...p },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const K = {
  owner: sign({ userId: OWN, branchId: null, isOwner: true, ownerLogin: true, permissionKeys: ['*'], surface: undefined }),
  mgr: sign({ userId: MGR, roleId: R.Manager, permissionKeys: KEYS }),
  gm: sign({ userId: GM, roleId: R['General Manager'], permissionKeys: KEYS }),
  fgm: sign({ userId: FGM, roleId: R_FGM, permissionKeys: KEYS }),
  sup: sign({ userId: SUP, roleId: R.Supervisor, permissionKeys: KEYS }),
  partner: sign({ userId: PART, webPartner: true, partnerBranches: [BR, BR2], permissionKeys: KEYS, surface: undefined }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const LIMIT = `/api/credit/customer/${CUST}/limit`;
const limitOf = () => db.customers.find((c) => c.id === CUST).credit_limit;
const ccall = (method, p, token, body, headers = {}) => call(method, p, token, body, { 'x-device-id': 'dev-T1', ...headers });
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const setRule = (rule) => { db.business_settings = [{ id: id(), business_id: BZ, key: CA.CREDIT_APPROVERS_KEY, value: rule }]; };
const resetSale = () => { Object.assign(db.credit_confirmations[0], { state: 'awaiting', decided_by: null, decided_by_name: null, decided_at: null, dispute_reason: null }); };

try {
  console.log('\n6. Credit — General Managers and partners set limits; confirming is the approvers\'\n');
  require(path.join(DIST, 'lib/permissionsState.js'))._setPermissionsMigrated(true);
  creditReset(); supabase.from = creditFrom;
  await ok('the built-in General Manager sets a limit (and the picker) — audited with who and the branch', async () => {
    assert.equal((await ccall('GET', '/api/credit/candidates?search=acme', K.gm)).status, 200);
    const r = await ccall('PATCH', LIMIT, K.gm, { credit_limit: 2000 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(limitOf(), 2000);
    const a = db.audit_log.at(-1);
    assert.deepEqual([a.action, a.user_id, a.user_name, a.branch_id], ['customer.credit_limit.changed', GM, 'Gina', BR]);
    assert.equal(CA.isBuiltInManagerRole({ name: 'general_manager', is_default: true }), true);
    assert.equal(LA.limitBoxForRole('General Manager'), true, 'the web POS manager screen shows the box');
  });
  await ok('a custom role named "General Manager" (not the built-in one) and a Supervisor are still refused', async () => {
    for (const t of [K.fgm, K.sup]) {
      const r = await ccall('PATCH', LIMIT, t, { credit_limit: 9000 });
      assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWNER_SETS_LIMITS');
    }
    assert.equal(limitOf(), 2000);
  });
  await ok('a partner at one of their branches sets it — audited and shown with that branch (customers are business-wide)', async () => {
    const r = await ccall('PATCH', LIMIT, K.partner, { credit_limit: 3000 }, { 'x-branch-id': BR2 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(limitOf(), 3000);
    const a = db.audit_log.at(-1);
    assert.deepEqual([a.user_id, a.branch_id], [PART, BR2]);
    assert.equal((await ccall('GET', '/api/credit/candidates?search=acme', K.partner, undefined, { 'x-branch-id': BR })).status, 200);
  });
  await ok('…never in "All my branches" (set mode) — told to pick one; a branch not theirs falls back to theirs (the cloud never acts at another)', async () => {
    const w = await ccall('PATCH', LIMIT, K.partner, { credit_limit: 9999 }, { 'x-branch-id': 'mine' });
    assert.ok(w.status === 400 || w.status === 403, JSON.stringify(w)); assert.equal(w.body.code, 'PICK_ONE_BRANCH');
    const g = await ccall('GET', '/api/credit/candidates?search=acme', K.partner, undefined, { 'x-branch-id': 'mine' });
    assert.equal(g.status, 403); assert.equal(g.body.code, 'PICK_ONE_BRANCH');
    assert.equal(limitOf(), 3000);
    const o = await ccall('PATCH', LIMIT, K.partner, { credit_limit: 3100 }, { 'x-branch-id': BR3 });
    assert.equal(o.status, 200, JSON.stringify(o.body)); assert.notEqual(db.audit_log.at(-1).branch_id, BR3, 'recorded at one of their own branches');
    assert.equal(CA.partnerLimitScope({ webPartner: true, branchSet: [BR, BR2], branchId: BR }), 'set');
    assert.equal(CA.partnerLimitScope({ webPartner: true, branchId: null, allBranches: true }), 'none');
    assert.equal(CA.partnerLimitScope({ webPartner: true, branchId: BR3, partnerBranches: [BR] }), 'none');
    assert.equal(CA.partnerLimitScope({ webPartner: false, branchId: BR }), null);
  });
  await ok('the dashboard: the editors for the owner and a partner with one branch picked; the line otherwise', () => {
    assert.equal(LA.dashboardSetsLimits({ isOwner: true, isPartner: false, activeBranchId: null }), true);
    assert.equal(LA.dashboardSetsLimits({ isOwner: false, isPartner: true, activeBranchId: BR }), true);
    assert.equal(LA.dashboardSetsLimits({ isOwner: false, isPartner: true, activeBranchId: null, allMine: true }), false);
    assert.equal(LA.dashboardSetsLimits({ isOwner: false, isPartner: true, activeBranchId: null }), false);
    assert.equal(LA.limitLineFor({ isOwner: false, isPartner: true, activeBranchId: null, allMine: true }), LA.PICK_ONE_BRANCH_LINE);
    assert.match(read('apps/dashboard/src/hooks/useSetsLimits.ts'), /dashboardSetsLimits\(who\)/);
  });
  const SALE = `/api/credit/sales/${ORD}`;
  await ok('approval OFF: a manager at the branch confirms a waiting sale (A545 unchanged)', async () => {
    resetSale();
    const r = await quiet(() => ccall('POST', `${SALE}/confirm`, K.mgr, {}));
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(db.credit_confirmations[0].state, 'confirmed');
  });
  await ok('approval ON: a manager not on the list is refused (confirm and dispute); Ann on the list confirms; the owner may', async () => {
    setRule({ on: true, branches: { [BR]: [SUP] } }); resetSale();
    for (const [what, body] of [['confirm', {}], ['dispute', { reason: 'not right at all' }]]) {
      const r = await quiet(() => ccall('POST', `${SALE}/${what}`, K.mgr, body));
      assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'NOT_A_CHOSEN_APPROVER');
    }
    assert.equal(db.credit_confirmations[0].state, 'awaiting');
    const a = await quiet(() => ccall('POST', `${SALE}/confirm`, K.sup, {}));
    assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(db.credit_confirmations[0].decided_by, SUP);
    resetSale();
    const o = await quiet(() => ccall('POST', `${SALE}/dispute`, K.owner, { reason: 'never delivered' }));
    assert.equal(o.status, 200, JSON.stringify(o.body)); assert.equal(db.credit_confirmations[0].state, 'disputed');
  });
  await ok('approval ON: a POS replaying an offline decision — by a manager not on the list refused; by Ann taken', async () => {
    resetSale();
    const no = await quiet(() => ccall('POST', `${SALE}/replay`, K.till, { decision: 'confirm', by: MGR, at: new Date().toISOString() }));
    assert.equal(no.status, 403, JSON.stringify(no.body)); assert.equal(no.body.code, 'NOT_A_CHOSEN_APPROVER');
    const yes = await quiet(() => ccall('POST', `${SALE}/replay`, K.till, { decision: 'confirm', by: SUP, at: new Date().toISOString() }));
    assert.equal(yes.status, 200, JSON.stringify(yes.body)); assert.equal(db.credit_confirmations[0].decided_by, SUP);
    assert.equal(CA.mayDecideCreditSale({ on: false, branches: {} }, BR, { id: MGR }), null, 'OFF: the A545 rule decides');
    assert.equal(CA.mayDecideCreditSale({ on: true, branches: { [BR]: [SUP] } }, null, { id: SUP }), false, 'no branch: the owner only');
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
