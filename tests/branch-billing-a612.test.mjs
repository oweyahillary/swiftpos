/**
 * branch-billing-a612.test.mjs — A612 phases 3 and 4: the cloud billed per branch, premium per branch.
 *
 * Owner, 2026-10-30: "the owner should be the one who gets the invoice not individual branch" · "we itemize the items being
 * billed, give unit price and under note we add list of branches" · Cloud / Analytics / Attendance / Themes · "one premium
 * package that of 15000 that covers all the items" · ZapTill's details "in the admin panel". (docs/A612-per-branch-cloud.md)
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/branch-billing-a612.test.mjs
 *
 * RUNS the COMPILED cloud: lib/branchBilling.ts (pure), the billing job (jobs/cloudPlanReminders.ts runCloudBilling) and the
 * admin routes (routes/cloudPlanAdmin.ts, routes/billingDetailsAdmin.ts, routes/admin.ts — a branch made) on the in-memory
 * database (tests/lib-memdb.mjs). Pins the premium gates (analytics, attendance, the POS's themes) and the admin portal.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - branchGroups keyed by the branch (not the date)            → "ONE invoice for the branches due today" fails
 *   - the branch payment's invoice match "some" (not "every")    → "a payment for one branch never pays another's invoice" fails
 *   - premiumOf without the package rule                         → "the package is every premium item" fails
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
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/branchBilling.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.ADMIN_ALERT_EMAIL = 'billing@zaptill.test';
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

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const u = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUPER = u(1), AGENT = u(2), M = u(10), N = u(20), B1 = u(11), B2 = u(12), B3 = u(13), N1 = u(21);
const LONG_AGO = '2026-01-01T00:00:00Z';
const row = (branch_id, paid_until, extra = {}) => ({ branch_id, business_id: M, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null,
  paid_until, billing_from: null, web_off: false, premium: [], package: false, notes: null, created_at: LONG_AGO, ...extra });

const reset = (now = Date.now()) => {
  mem.fail = () => null; mem.calls = [];
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    businesses: [
      { id: M, name: 'Krunch & Co', owner_id: 'not-a-uuid', email: 'owner@krunch.test', status: 'active', type: 'restaurant', currency: 'KES', web_access_expires_at: iso(now + 20 * DAY), created_at: LONG_AGO },
      { id: N, name: 'One Duka', owner_id: 'x', email: 'n@duka.test', status: 'active', type: 'retail', currency: 'KES', web_access_expires_at: iso(now + 10 * DAY), created_at: LONG_AGO },
    ],
    branches: [
      { id: B1, business_id: M, name: 'Westlands', is_main: true, status: 'active', created_at: '2026-01-01' },
      { id: B2, business_id: M, name: 'CBD', is_main: false, status: 'active', created_at: '2026-01-02' },
      { id: B3, business_id: M, name: 'Thika Road', is_main: false, status: 'active', created_at: '2026-01-03' },
      { id: N1, business_id: N, name: 'Main', is_main: true, status: 'active', created_at: '2026-01-01' },
    ],
    cloud_plans: [
      { business_id: M, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: null, created_at: LONG_AGO, billing_from: null },
      { business_id: N, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: null, created_at: LONG_AGO, billing_from: null },
    ],
    // Westlands and CBD due an hour ago (their invoice day); Thika Road paid 20 days ahead
    branch_cloud_plans: [row(B1, iso(now - 3600_000), { premium: ['analytics'] }), row(B2, iso(now - 3600_000), { package: true }), row(B3, iso(now + 20 * DAY))],
    business_settings: [], feature_flags: [{ business_id: M, key: 'web_hosting', enabled: true }, { business_id: N, key: 'web_hosting', enabled: true }],
    cloud_payments: [], cloud_plan_reminders: [], invoices: [], admin_audit_log: [], admin_notifications: [], admin_settings: [], users: [],
  };
  adminAuth.forgetAdmin(); CP.forgetStanding(); BB.forgetBillingDetails();
};

console.log('A612 phases 3-4 — billed per branch, premium per branch\n\nA. the rules (pure)\n');
await ok('billing details: none saved → the sample seller and the default prices; saved → theirs; a bad price → the default', () => {
  const none = BB.cleanBillingDetails(null);
  assert.equal(none.saved, false); assert.equal(none.seller.sample, true); assert.deepEqual(none.prices, BB.DEFAULT_PRICES);
  const mine = BB.cleanBillingDetails({ seller: { legalName: 'ZapTill Ltd', address: 'Nairobi', kraPin: 'p051234567z', phone: '0717 675 635', mpesaPaybill: '247 247', accountRef: 'business' },
    prices: { cloud: '3,500', analytics: -5, package: 14000 } });
  assert.equal(mine.saved, true); assert.equal(mine.seller.sample, false); assert.equal(mine.seller.kraPin, 'P051234567Z');
  assert.equal(mine.seller.mpesaPaybill, '247247'); assert.equal(mine.seller.accountRef, 'business');
  assert.deepEqual([mine.prices.cloud, mine.prices.analytics, mine.prices.package], [3500, BB.DEFAULT_PRICES.analytics, 14000]);
});
await ok('the package is every premium item; premium only the three keys', () => {
  assert.deepEqual([...BB.premiumOf({ premium: [], package: true })].sort(), ['analytics', 'attendance', 'themes']);
  assert.deepEqual([...BB.premiumOf({ premium: ['themes', 'images'], package: false })], ['themes']);
  assert.equal(BB.premiumOf(null).size, 0);
});
await ok('a branch\'s bill: the package alone; else the Cloud (its period price) and each premium × months', () => {
  const p = BB.DEFAULT_PRICES;
  assert.deepEqual(BB.branchBill({ amount: 3000, premium: ['analytics'], package: true, period: 'monthly' }, 'CBD', p, 1), { branch: 'CBD', cloud: 0, package: 15000, period: 'monthly' });
  const q = BB.branchBill({ amount: 9000, premium: ['analytics', 'themes'], package: false, period: '3_months' }, 'W', p, 3);
  assert.equal(q.cloud, 9000); assert.deepEqual(q.premium, [{ name: 'Analytics', price: 30000 }, { name: 'Themes', price: 3000 }]);
  assert.equal(BB.periodMonths('6_months'), 6); assert.equal(BB.periodMonths('custom', '2026-01-01T00:00:00Z', '2026-03-02T00:00:00Z'), 2);
});
await ok('the invoice: the package one line, the Cloud and premium items by quantity; another plan length says so', () => {
  const items = EM.invoiceItems([
    { branch: 'A', cloud: 0, package: 15000, period: 'monthly' }, { branch: 'B', cloud: 3000, premium: [{ name: 'Analytics', price: 10000 }], package: null, period: 'monthly' },
    { branch: 'C', cloud: 3000, premium: [], package: null, period: 'monthly' }]);
  assert.deepEqual(items.map((i) => [i.description, i.qty, i.unitPrice]), [['Premium package', 1, 15000], ['Cloud', 2, 3000], ['Analytics', 1, 10000]]);
  const mixed = EM.invoiceItems([{ branch: 'A', cloud: 3000, period: 'monthly' }, { branch: 'B', cloud: 9000, period: '3_months' }]);
  assert.deepEqual(mixed.map((i) => i.description), ['Cloud (Monthly (month on month))', 'Cloud (3 months)']);
});
await ok('premium per branch: null for a business billed as one; else the branches that pay (the package counts)', () => {
  assert.equal(BB.featureBranches({ branchIds: [B1], branchPlans: [] }, 'analytics'), null);
  const f = { branchIds: [B1, B2, B3], branchPlans: [row(B1, null, { premium: ['analytics'] }), row(B2, null, { package: true }), row(B3, null)] };
  assert.deepEqual(BB.featureBranches(f, 'analytics'), [B1, B2]);
  assert.deepEqual(BB.featureBranches(f, 'themes'), [B2]);
});

console.log('\nB. the billing job\n');
reset();
await ok('ONE invoice for the branches due today (Westlands and CBD), itemised; the paid-ahead branch not on it', async () => {
  const out = await JOB.runCloudBilling(new Date(), { force: true });
  const inv = mem.db.invoices;
  assert.equal(inv.length, 1, JSON.stringify(out));
  assert.deepEqual([...inv[0].branch_ids].sort(), [B1, B2].sort());
  // Westlands: Cloud 3,000 + Analytics 10,000; CBD: the package 15,000
  assert.equal(Number(inv[0].amount), 28000);
  assert.deepEqual(inv[0].lines.items.map((i) => [i.description, i.qty, i.amount]), [['Premium package', 1, 15000], ['Cloud', 1, 3000], ['Analytics', 1, 10000]]);
  assert.equal(inv[0].status, 'pending');
  assert.ok(out.sent.some((s) => s.milestone === 'invoice' && s.branches?.length === 2));
});
await ok('…once: the next pass raises nothing more', async () => {
  await JOB.runCloudBilling(new Date(), { force: true });
  assert.equal(mem.db.invoices.length, 1);
});
await ok('ZapTill hears once, naming the branches', () => {
  const n = mem.db.admin_notifications.filter((x) => x.category === 'billing');
  assert.equal(n.length, 1);
  assert.match(n[0].title + n[0].detail, /Krunch & Co — Westlands, CBD/);
});

console.log('\nC. the admin portal\n');
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin/clients', require(path.join(DIST, 'routes/cloudPlanAdmin.js')).default);
app.use('/api/admin/billing-details', require(path.join(DIST, 'routes/billingDetailsAdmin.js')).default);
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
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

try {
  await ok('the Plan & billing view: billed per branch, each branch its plan, premium, standing and a period\'s total', async () => {
    const r = await call('GET', `/api/admin/clients/${M}/cloud-plan`, AGENT_T);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.per_branch, true);
    const by = Object.fromEntries(r.body.branches.map((b) => [b.name, b]));
    assert.deepEqual(by.CBD.premium.sort(), ['analytics', 'attendance', 'themes']); assert.equal(by.CBD.package, true);
    assert.equal(by.Westlands.standing.state, 'unpaid'); assert.equal(by['Thika Road'].standing.state, 'active');
    assert.equal(by.Westlands.period_total, 13000); assert.equal(by.CBD.period_total, 15000);
  });
  await ok('preview: what a payment for Westlands and CBD covers, and the amount expected', async () => {
    const r = await call('POST', `/api/admin/clients/${M}/cloud-plan/branch-payments/preview`, AGENT_T, { branch_ids: [B1, B2] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.expected, 28000);
    assert.deepEqual(r.body.branches.map((b) => b.fresh), [false, false]);
  });
  await ok('a payment for one branch never pays another\'s invoice (Westlands alone: the shared invoice stays open)', async () => {
    const r = await call('POST', `/api/admin/clients/${M}/cloud-plan/branch-payments`, ADMIN, { branch_ids: [B1], amount: 13000, method: 'cash', reference: null });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(mem.db.invoices.find((i) => (i.branch_ids ?? []).length === 2).status, 'pending');
    const raised = mem.db.invoices.find((i) => i.status === 'paid');
    assert.deepEqual(raised.branch_ids, [B1], 'a paid invoice of its own for Westlands');
    const w = mem.db.branch_cloud_plans.find((p) => p.branch_id === B1);
    assert.ok(Date.parse(w.paid_until) > Date.now() + 25 * DAY, 'Westlands moved on a month from its due date');
    assert.equal(mem.db.branch_cloud_plans.find((p) => p.branch_id === B2).paid_until < new Date().toISOString(), true, 'CBD untouched');
  });
  await ok('the business\'s paid-until is its latest branch\'s (sign-in stays open while one is paid); the payment names its branches', () => {
    const latest = mem.db.branch_cloud_plans.map((p) => p.paid_until).sort().slice(-1)[0];
    assert.equal(mem.db.businesses.find((b) => b.id === M).web_access_expires_at, latest);
    assert.deepEqual(mem.db.cloud_payments.slice(-1)[0].branch_ids, [B1]);
  });
  reset();
  await JOB.runCloudBilling(new Date(), { force: true });
  await ok('Westlands and CBD paid together: their invoice marked paid, each moved on its own period', async () => {
    const r = await call('POST', `/api/admin/clients/${M}/cloud-plan/branch-payments`, ADMIN, { branch_ids: [B1, B2], amount: 28000, method: 'mpesa', reference: 'SJK4H7Q2LM' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(mem.db.invoices.length, 1);
    assert.equal(mem.db.invoices[0].status, 'paid');
    assert.equal(r.body.invoice_number, mem.db.invoices[0].invoice_number);
  });
  await ok('a locked branch pays: afresh from today, its locked time\'s invoice closed, not charged (pay as you go)', async () => {
    reset();
    const t3 = mem.db.branch_cloud_plans.find((p) => p.branch_id === B3);
    t3.paid_until = iso(Date.now() - 20 * DAY);
    mem.db.invoices.push({ id: 'inv-t3', business_id: M, invoice_number: 'ZT-OLD', amount: 3000, currency: 'KES', status: 'pending', kind: 'cloud',
      period_start: t3.paid_until, period_end: iso(Date.now() + 10 * DAY), branch_ids: [B3], created_at: t3.paid_until });
    const r = await call('POST', `/api/admin/clients/${M}/cloud-plan/branch-payments`, ADMIN, { branch_ids: [B3], amount: 3000, method: 'cash' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.paid_branches[0].fresh, true);
    assert.deepEqual(r.body.not_charged, ['ZT-OLD']);
    assert.ok(Math.abs(Date.parse(r.body.paid_branches[0].from) - Date.now()) < 2 * DAY, 'from today');
  });
  await ok('a branch\'s plan: premium checked, the package and Disable saved and audited; an agent may not', async () => {
    reset();
    assert.equal((await call('PUT', `/api/admin/clients/${M}/cloud-plan/branches/${B3}`, ADMIN, { premium: ['images'] })).status, 400);
    assert.equal((await call('PUT', `/api/admin/clients/${M}/cloud-plan/branches/${B3}`, AGENT_T, { package: true })).status, 403);
    const r = await call('PUT', `/api/admin/clients/${M}/cloud-plan/branches/${B3}`, ADMIN, { premium: ['themes'], web_off: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t3 = mem.db.branch_cloud_plans.find((p) => p.branch_id === B3);
    assert.deepEqual([t3.premium, t3.web_off], [['themes'], true]);
    assert.ok(mem.db.admin_audit_log.some((a) => a.action === 'cloud_plan.branch'));
    assert.equal(r.body.branches.find((b) => b.branch_id === B3).standing.state, 'off', 'Disabled: off at once');
  });
  await ok('"Bill per branch": every branch of a client billed as one gets the business\'s plan and paid-until', async () => {
    const r = await call('POST', `/api/admin/clients/${N}/cloud-plan/branches/start`, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const n1 = mem.db.branch_cloud_plans.find((p) => p.branch_id === N1);
    assert.equal(n1.paid_until, mem.db.businesses.find((b) => b.id === N).web_access_expires_at);
    assert.equal(r.body.per_branch, true);
  });
  await ok('a branch made for a client billed per branch gets its own plan, due the day it is made', async () => {
    const r = await call('POST', `/api/admin/clients/${M}/branches`, ADMIN, { name: 'Ruaka' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = mem.db.branch_cloud_plans.find((x) => x.branch_id === r.body.id);
    assert.ok(p && Math.abs(Date.parse(p.paid_until) - Date.now()) < 60_000);
    assert.ok(r.body.cloud_billed_from);
  });
  await ok('Billing details: the sample until saved; a Paybill or Till required; saved by a super admin, audited', async () => {
    const g = await call('GET', '/api/admin/billing-details', AGENT_T);
    assert.equal(g.body.saved, false); assert.equal(g.body.seller.sample, true);
    const seller = { legalName: 'ZapTill Limited', address: 'Nairobi', kraPin: 'P051234567Z', phone: '0717 675 635', mpesaPaybill: '', mpesaTill: '' };
    assert.equal((await call('PUT', '/api/admin/billing-details', ADMIN, { seller, prices: {} })).body.code, 'BAD_PAYBILL');
    assert.equal((await call('PUT', '/api/admin/billing-details', AGENT_T, { seller: { ...seller, mpesaPaybill: '247247' }, prices: {} })).status, 403);
    const s = await call('PUT', '/api/admin/billing-details', ADMIN, { seller: { ...seller, mpesaPaybill: '247247' }, prices: { package: 14000 } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.saved, true); assert.equal(s.body.prices.package, 14000);
    assert.ok(mem.db.admin_audit_log.some((a) => a.action === 'billing.details'));
  });
} finally { server.close(); }

console.log('\nD. premium per branch — the gates and the screens\n');
await ok('Analytics: billed per branch, only the branches that pay (a branch named that does not: off); the comparison too', () => {
  const a = read('apps/server/src/routes/analytics.ts');
  assert.match(a, /const paying = featureBranches\(await cloudFactsFor\(businessId\)\.catch\(\(\) => null\), 'analytics'\);/);
  assert.match(a, /if \(branch && !paying\.includes\(branch\)\) \{ res\.status\(403\)\.json\(\{ error: ANALYTICS_OFF_MESSAGE, code: 'ANALYTICS_OFF' \}\)/);
  assert.match(a, /return \(w \?\? paying\)\.filter\(\(b\) => paying\.includes\(b\)\);/);
});
await ok('Attendance: the branch server of a branch without it reads no device; reads and new devices only where it is paid', () => {
  const t = read('apps/server/src/routes/attendance.ts');
  assert.match(t, /if \(paying && !paying\.includes\(who\.branchId\)\) \{ off\(res\); return; \}/);
  assert.match(t, /if \(paying && !paying\.includes\(branchId\)\) \{ res\.status\(403\)\.json\(\{ error: 'This branch does not have Attendance/);
  assert.match(t, /const paying = \(req as \{ attendanceBranches\?: string\[\] \| null \}\)\.attendanceBranches;\s*if \(!paying\) return f;/);
});
await ok('Themes: a branch\'s POS takes the brand only when that branch pays for it; a plan change reaches the POS (catalogue version)', () => {
  assert.match(read('apps/server/src/routes/pos.ts'), /const themesOn = themesBusiness && \(!themesPaying \|\| themesPaying\.includes\(/);
  assert.match(read('migrations/182_branch_cloud_plans.sql'), /CREATE TRIGGER trg_sync_version_catalogue AFTER INSERT OR UPDATE OR DELETE ON public\.branch_cloud_plans/);
});
await ok('the admin portal: Cloud per branch on Plan & billing; Billing details on the Billing page', () => {
  const p = read('apps/admin/src/AdminPortal.tsx');
  assert.match(p, /<BranchBillingCard clientId=\{client\.id\} req=\{req\} isSuper=\{isSuper\} onChanged=\{reloadDetail\} \/>/);
  assert.match(p, /<BillingDetailsCard req=\{req\} isSuper=\{isSuper\} \/>/);
  assert.match(read('apps/admin/src/BranchBillingCard.tsx'), /cloud-plan\/branch-payments\/preview/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
