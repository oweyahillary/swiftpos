/**
 * cloud-trial-a569.test.mjs — A569: a one-month cloud trial starts with the client's first desktop licence.
 *
 * Owner, 2026-10-22: "they should get a 1 month trial plan for cloud if they have subscribed on the desktop platform".
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/cloud-trial-a569.test.mjs
 *
 * RUNS the COMPILED admin and business routers (the real admin and auth middleware) over HTTP on the in-memory database
 * (tests/lib-memdb.mjs), lib/cloudTrial.js and lib/webAccess.js directly, and the dashboard's notice and the admin
 * portal's labels from their TypeScript (Node strips the types):
 *   1 the rules: who is eligible (first licence; never twice; never after web access was on, off or dated), the phases,
 *     the plan in words, the trial ladder (no grace — a week of reports only — then locked) beside the paid one
 *   2 the first licence starts the trial — web access on, 30 days, NO invoice (a licence fee raises only its own),
 *     audited; a second licence, a re-activated one and a paid client never (re)start it; Convert to paid
 *   3 the end: reports only for 7 days, then sign-in refused "Your cloud trial has ended" (CLOUD_TRIAL_ENDED); a
 *     disabled trial is over at once; a converted one is a paid term; auth.ts answers every refusal from webAccessRefusal
 *   4 the owner's dashboard: GET /api/business/cloud-trial for the owner only; the record cannot be written by the owner;
 *     the notice in the last 7 days only
 *   5 the admin portal: the header tiles, Plan & billing, the client list, the create-client subtitle
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A569 report):
 *   - trialEligibility without the `f.trial` check (a trial twice)                  → 1 "never twice", 2 "re-activated" fail
 *   - trialEligibility without the otherLicensedBranches check                       → 1 "first licence only", 2 "a second licence" fail
 *   - trialEligibility without the webHostingFlag check                              → 1 and 2 "a paid client" fail
 *   - ladderState giving a trial the 21-day grace                                    → 1 "trial ladder", 3 "reports only" fail
 *   - webAccessRefusal without the trial branch                                      → 3 "CLOUD_TRIAL_ENDED" fails
 *   - trialNotice with 8 days instead of NOTICE_DAYS                                 → 4 "the last 7 days only" fails
 *   - startTrialIfEligible raising an invoice                                        → 2 "no invoice" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/cloudTrial.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.LOGIN_OTP;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const mailer = require(path.join(DIST, 'lib/mailer.js'));
mailer.sendEmailChecked = async () => ({ ok: true, provider: 'test' });
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
const T = require(path.join(DIST, 'lib/cloudTrial.js'));
const W = require(path.join(DIST, 'lib/webAccess.js'));
const N = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/cloudTrialNotice.ts')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/cloudPlan.ts')).href);

const DAY = 86400000;
const SUPER = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const B = '11111111-1111-4111-8111-111111111111', BR1 = '22222222-2222-4222-8222-222222222221', BR2 = '22222222-2222-4222-8222-222222222222';
const B2 = '11111111-1111-4111-8111-111111111112', B2R = '22222222-2222-4222-8222-222222222223';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MGR = 'aaaaaaaa-0000-4000-8000-000000000002';
const reset = () => {
  mem.fail = () => null; mem.calls = [];
  mem.db = {
    admin_users: [{ id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true }],
    businesses: [
      { id: B, name: 'Pollo', owner_id: OWNER, status: 'active', type: 'restaurant', currency: 'KES', web_access_expires_at: null, created_at: '2026-10-01T00:00:00Z' },
      { id: B2, name: 'Paid Co', owner_id: 'x', status: 'active', type: 'retail', currency: 'KES', web_access_expires_at: null, created_at: '2026-09-01T00:00:00Z' },
    ],
    branches: [
      { id: BR1, business_id: B, name: 'Main', is_main: true, status: 'active', desktop_licensed: false },
      { id: BR2, business_id: B, name: 'Two', is_main: false, status: 'active', desktop_licensed: false },
      { id: B2R, business_id: B2, name: 'Main', is_main: true, status: 'active', desktop_licensed: false },
    ],
    feature_flags: [], business_settings: [], invoices: [], admin_audit_log: [], subscriptions: [], plans: [], users: [
      { id: OWNER, business_id: B, name: 'Owner', status: 'active', permissions_version: 0, role_id: 'r-o', roles: { name: 'owner', role_permissions: [] }, user_permissions: [], user_branches: [{ branch_id: BR1 }] },
      { id: MGR, business_id: B, name: 'Mgr', status: 'active', permissions_version: 0, role_id: 'r-m', roles: { name: 'Manager', role_permissions: [{ permissions: { key: 'settings.business' } }] }, user_permissions: [], user_branches: [{ branch_id: BR1 }] },
    ],
    products: [], orders: [], notifications: [], refresh_tokens: [], branch_settings: [], user_devices: [],
  };
  adminAuth.forgetAdmin();
};
reset();

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin/clients', require(path.join(DIST, 'routes/cloudPlanAdmin.js')).default);   // A584: Record payment converts
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
app.use('/api/business', require(path.join(DIST, 'routes/business.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ADMIN = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR1, isOwner: false, surface: 'dashboard', ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const OWNER_T = sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'] });
const MGR_T = sign({ userId: MGR, permissionKeys: ['settings.business'] });
const licence = (biz, br, body = {}) => call('POST', `/api/admin/clients/${biz}/branches/${br}/licence`, ADMIN, { licensed: true, ...body });
const trialRow = (biz = B) => mem.db.business_settings.find((s) => s.business_id === biz && s.key === 'cloud_trial');
const flag = (biz = B) => mem.db.feature_flags.find((f) => f.business_id === biz && f.key === 'web_hosting');
const biz = (id = B) => mem.db.businesses.find((b) => b.id === id);
const audits = (action) => mem.db.admin_audit_log.filter((a) => a.action === action);
const near = (iso, ms, tol = 60000) => Math.abs(Date.parse(iso) - (Date.now() + ms)) < tol;

try {
  console.log('\n1. The rules\n');
  const facts = (x = {}) => ({ trial: null, otherLicensedBranches: 0, webHostingFlag: null, webAccessExpiresAt: null, ...x });
  await ok('the first licence of a client that never had web access is eligible', () => {
    assert.deepEqual(T.trialEligibility(facts()), { eligible: true, reason: 'first_licence' });
  });
  await ok('never twice: a client that had a trial (even converted or long ended) is not eligible', () => {
    assert.equal(T.trialEligibility(facts({ trial: T.newTrial(Date.now() - 400 * DAY, BR1, 'x') })).eligible, false);
  });
  await ok('first licence only: another licensed branch means no trial', () => {
    assert.equal(T.trialEligibility(facts({ otherLicensedBranches: 1 })).reason, 'not_first_licence');
  });
  await ok('a paid client is not eligible: web access on, switched off before, or a dated term', () => {
    assert.equal(T.trialEligibility(facts({ webHostingFlag: { enabled: true } })).reason, 'web_access_on');
    assert.equal(T.trialEligibility(facts({ webHostingFlag: { enabled: false } })).reason, 'web_access_was_set');
    assert.equal(T.trialEligibility(facts({ webAccessExpiresAt: '2027-01-01T00:00:00Z' })).reason, 'web_access_dated');
  });
  await ok('a trial is 30 days; its phases: active, reports only for 7 days, ended; converted', () => {
    const now = Date.parse('2026-10-22T09:00:00Z');
    const t = T.newTrial(now, BR1, 'boss');
    assert.equal(Date.parse(t.ends_at) - now, 30 * DAY);
    assert.equal(T.trialPhase(t, now + 29 * DAY), 'active');
    assert.equal(T.trialPhase(t, now + 31 * DAY), 'reports_only');
    assert.equal(T.trialPhase(t, now + 36.9 * DAY), 'reports_only');
    assert.equal(T.trialPhase(t, now + 37.1 * DAY), 'ended');
    assert.equal(T.trialPhase({ ...t, converted_at: new Date(now).toISOString() }, now + 99 * DAY), 'converted');
  });
  await ok('the plan in words: Cloud trial / Cloud trial ended / Cloud / Desktop / No licence yet', () => {
    const now = Date.now(); const t = T.newTrial(now, BR1, null);
    assert.equal(T.planLabel({ trial: t, webHosting: true, licensedBranches: 1, now }), 'Cloud trial');
    assert.equal(T.planLabel({ trial: t, webHosting: true, licensedBranches: 1, now: now + 40 * DAY }), 'Cloud trial ended');
    assert.equal(T.planLabel({ trial: { ...t, converted_at: new Date().toISOString() }, webHosting: true, licensedBranches: 1, now }), 'Cloud');
    assert.equal(T.planLabel({ trial: null, webHosting: false, licensedBranches: 2, now }), 'Desktop');
    assert.equal(T.planLabel({ trial: null, webHosting: false, licensedBranches: 0, now }), 'No licence yet');
  });
  await ok('the trial ladder has no grace: reports only for 7 days, then locked — the paid ladder (A584): 7 unpaid days, locked at the end of the 7th (Nairobi)', () => {
    const end = '2026-11-21T09:00:00.000Z', e = Date.parse(end);   // 12:00 Nairobi, 21 Nov
    assert.equal(W.ladderState(end, e - 1, true), 'active');
    assert.equal(W.ladderState(end, e + 1, true), 'reports_only');
    assert.equal(W.ladderState(end, e + 6.9 * DAY, true), 'reports_only');
    assert.equal(W.ladderState(end, e + 7.1 * DAY, true), 'locked');
    assert.equal(W.ladderState(end, e + 1, false), 'grace');
    assert.equal(W.ladderState(end, Date.parse('2026-11-28T20:59:00Z'), false), 'grace', '23:59 Nairobi on day 7: still open');
    assert.equal(W.ladderState(end, Date.parse('2026-11-28T21:00:00Z'), false), 'locked', '00:00 Nairobi on day 8: locked');
    assert.equal(W.ladderState(end, e + 22 * DAY, false), 'locked', 'no 21-day grace, no reports-only stage');
  });

  console.log('\n2. The first licence starts it — no invoice\n');
  await ok('the first licence starts a 30-day trial: web access on, the expiry set, the record kept, audited', async () => {
    reset();
    const r = await licence(B, BR1);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.cloud_trial?.ends_at, 'the answer names the trial');
    const t = trialRow(); assert.ok(t, 'the trial is recorded');
    assert.ok(near(t.value.ends_at, 30 * DAY));
    assert.equal(biz().web_access_expires_at, t.value.ends_at);
    assert.equal(flag()?.enabled, true);
    assert.equal(audits('web_access.trial_start').length, 1);
    assert.equal(audits('web_access.trial_start')[0].after_data.invoice, false);
  });
  await ok('no invoice for the trial: none without a licence fee; with one, only the licence\'s own', async () => {
    reset();
    await licence(B, BR1);
    assert.equal(mem.db.invoices.length, 0, 'no invoice at all');
    reset();
    await licence(B, BR1, { invoice_amount: 30000, invoice_ref: 'QWE123' });
    assert.equal(mem.db.invoices.length, 1);
    assert.equal(mem.db.invoices[0].amount, 30000, 'the licence fee, never the 10,000 web access');
    assert.ok(trialRow());
  });
  await ok('a second licence (another branch) does not restart it', async () => {
    reset();
    await licence(B, BR1);
    const first = trialRow().value.ends_at;
    biz().web_access_expires_at = first;
    const r = await licence(B, BR2);
    assert.equal(r.status, 200); assert.equal(r.body.cloud_trial, undefined);
    assert.equal(trialRow().value.ends_at, first);
    assert.equal(audits('web_access.trial_start').length, 1);
  });
  await ok('a re-activated licence (revoked, then on again — the only branch) does not restart it', async () => {
    reset();
    await licence(B, BR1);
    const first = trialRow().value;
    assert.equal((await call('POST', `/api/admin/clients/${B}/branches/${BR1}/licence`, ADMIN, { licensed: false })).status, 200);
    // as if the trial were long over and web access switched off since
    flag().enabled = false;
    const r = await licence(B, BR1);
    assert.equal(r.status, 200); assert.equal(r.body.cloud_trial, undefined);
    assert.deepEqual(trialRow().value, first);
    assert.equal(mem.db.business_settings.filter((s) => s.key === 'cloud_trial').length, 1);
  });
  await ok('a paid client (web access on, or a dated term) is not affected', async () => {
    reset();
    mem.db.feature_flags.push({ business_id: B2, key: 'web_hosting', enabled: true });
    const r = await licence(B2, B2R);
    assert.equal(r.status, 200); assert.equal(trialRow(B2), undefined);
    assert.equal(biz(B2).web_access_expires_at, null, 'its term untouched');
    reset();
    biz(B2).web_access_expires_at = '2027-03-01T00:00:00.000Z';
    await licence(B2, B2R);
    assert.equal(trialRow(B2), undefined); assert.equal(biz(B2).web_access_expires_at, '2027-03-01T00:00:00.000Z');
  });
  await ok('a trial that cannot be read never starts and never undoes the licence', async () => {
    reset();
    mem.fail = (table, op) => (table === 'business_settings' && op === 'select' ? { message: 'timeout' } : null);
    const r = await licence(B, BR1);
    assert.equal(r.status, 200); assert.equal(mem.db.branches[0].desktop_licensed, true);
    assert.equal(trialRow(), undefined); assert.equal(flag(), undefined);
  });
  await ok('Convert to paid (A584): "Enable web access" is retired (409 WEB_ACCESS_BY_PLAN, nothing converted); Record payment converts', async () => {
    reset();
    await licence(B, BR1);
    const r = await call('PATCH', `/api/admin/clients/${B}/features/web_hosting`, ADMIN, { enabled: true, notes: 'paid' });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'WEB_ACCESS_BY_PLAN');
    assert.equal(trialRow().value.converted_at, null);
    const p = await call('POST', `/api/admin/clients/${B}/cloud-plan/payments`, ADMIN, { amount: 3000, period: 'monthly', method: 'cash' });
    assert.equal(p.status, 201, JSON.stringify(p.body)); assert.equal(p.body.trial_converted, true);
    assert.ok(trialRow().value.converted_at);
    assert.ok(near(biz().web_access_expires_at, 60 * DAY, 3 * DAY), 'the trial\'s days kept, then a month (the plan) — not a fixed year');
    assert.equal(audits('cloud_plan.payment').length, 1);
  });
  await ok('the client list and the client read the plan in words', async () => {
    reset();
    await licence(B, BR1);
    mem.db.branches.find((b) => b.id === B2R).desktop_licensed = true;
    const list = await call('GET', '/api/admin/clients', ADMIN);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const label = (id) => list.body.clients.find((c) => c.id === id)?.plan_label;
    assert.equal(label(B), 'Cloud trial'); assert.equal(label(B2), 'Desktop');
    const one = await call('GET', `/api/admin/clients/${B}`, ADMIN);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.plan_label, 'Cloud trial'); assert.equal(one.body.cloud_trial.phase, 'active');
    mem.db.feature_flags.push({ business_id: B2, key: 'web_hosting', enabled: true });
    assert.equal((await call('GET', `/api/admin/clients/${B2}`, ADMIN)).body.plan_label, 'Cloud');
  });

  console.log('\n3. When the trial ends\n');
  const endIn = (ms) => { const e = new Date(Date.now() + ms).toISOString(); trialRow().value = { ...trialRow().value, ends_at: e }; biz().web_access_expires_at = e; };
  await ok('in the trial: full access', async () => {
    reset(); await licence(B, BR1);
    const w = await W.getWebAccess(B, 'active');
    assert.equal(w.state, 'active'); assert.equal(w.trial, true); assert.equal(w.canLogin, true); assert.equal(w.fullAccess, true);
  });
  await ok('3 days after: reports only (sign-in works, the web POS is off) — no 21-day grace', async () => {
    reset(); await licence(B, BR1); endIn(-3 * DAY);
    const w = await W.getWebAccess(B, 'active');
    assert.equal(w.state, 'reports_only'); assert.equal(w.canLogin, true); assert.equal(w.fullAccess, false);
  });
  await ok('8 days after: sign-in refused — "Your cloud trial has ended" (CLOUD_TRIAL_ENDED)', async () => {
    reset(); await licence(B, BR1); endIn(-8 * DAY);
    const w = await W.getWebAccess(B, 'active');
    assert.equal(w.state, 'locked'); assert.equal(w.canLogin, false);
    const r = W.webAccessRefusal(w);
    assert.equal(r.code, 'CLOUD_TRIAL_ENDED'); assert.match(r.error, /cloud trial has ended/i); assert.match(r.error, /points of sale keep working/);
    // A584: a PAID term 8 days past (on a plan since before) is locked — no 21-day grace; one not yet bridged is not
    reset(); biz().web_access_expires_at = new Date(Date.now() - 8 * DAY).toISOString();
    assert.equal((await W.getWebAccess(B, 'active')).state, 'grace', 'a licence not yet bridged is never locked');
    mem.db.cloud_plans = [{ business_id: B, period: 'monthly', amount: 3000, currency: 'KES', created_at: new Date(Date.now() - 60 * DAY).toISOString() }];
    assert.equal((await W.getWebAccess(B, 'active')).state, 'locked');
    const paused = W.webAccessRefusal({ state: 'locked', expiresAt: null, fullAccess: false, canLogin: false });
    assert.equal(paused.code, 'CLOUD_ACCESS_PAUSED'); assert.equal(paused.error, 'Your ZapTill cloud access is paused. Call 0717 675 635 to renew.');
  });
  await ok('"End trial" (web access switched off during the trial) is over at once', async () => {
    reset(); await licence(B, BR1);
    assert.equal((await call('PATCH', `/api/admin/clients/${B}/features/web_hosting`, ADMIN, { enabled: false })).status, 200);
    const w = await W.getWebAccess(B, 'active');
    assert.equal(w.state, 'none'); assert.equal(w.canLogin, false); assert.equal(W.webAccessRefusal(w).code, 'WEB_HOSTING_REQUIRED');
  });
  await ok('a converted trial is a paid term (the paid ladder)', async () => {
    reset(); await licence(B, BR1);
    await call('POST', `/api/admin/clients/${B}/cloud-plan/payments`, ADMIN, { amount: 3000, period: 'monthly', method: 'cash' });
    const w = await W.getWebAccess(B, 'active');
    assert.equal(w.state, 'active'); assert.equal(w.trial, undefined);
  });
  await ok('auth.ts answers every web sign-in refusal from webAccessRefusal; the login page knows CLOUD_TRIAL_ENDED; tills never ask', () => {
    const a = read('apps/server/src/routes/auth.ts');
    assert.equal((a.match(/res\.status\(403\)\.json\(webAccessRefusal\(webAccess\)\)/g) ?? []).length, 2);
    assert.doesNotMatch(a, /Your web portal subscription has expired/, 'the words live in lib/webAccess.ts only');
    assert.match(read('apps/dashboard/src/pages/LoginPage.tsx'), /CLOUD_TRIAL_ENDED: \{[\s\S]*?Your cloud trial has ended/);
    assert.doesNotMatch(read('apps/server/src/routes/enrol.ts'), /getWebAccess/, 'a till\'s enrolment never checks web access');
  });

  console.log('\n4. The owner\'s dashboard\n');
  await ok('GET /api/business/cloud-trial: the owner sees the trial; a manager gets nothing', async () => {
    reset(); await licence(B, BR1);
    const o = await call('GET', '/api/business/cloud-trial', OWNER_T);
    assert.equal(o.status, 200, JSON.stringify(o.body)); assert.equal(o.body.trial.phase, 'active'); assert.ok(o.body.trial.ends_at);
    const m = await call('GET', '/api/business/cloud-trial', MGR_T);
    assert.equal(m.status, 200); assert.equal(m.body.trial, null);
  });
  await ok('the owner cannot write or reset the trial record (READ_ONLY_KEY)', async () => {
    reset(); await licence(B, BR1);
    const r = await call('POST', '/api/business/settings', OWNER_T, { key: 'cloud_trial', value: '{}' });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'READ_ONLY_KEY');
  });
  await ok('the notice shows in the last 7 days only (and the week after, ended); never paid, never earlier', () => {
    const now = Date.parse('2026-10-22T09:00:00Z');
    const at = (days, phase = 'active') => N.trialNotice({ ends_at: new Date(now + days * DAY).toISOString(), phase }, now);
    assert.equal(at(8), null, '8 days left: nothing yet');
    assert.equal(at(7.5), null);
    assert.match(at(7), /^Your cloud trial ends on .+ — contact ZapTill to keep the dashboard\.$/);
    assert.match(at(1), /ends on/);
    assert.match(at(-2, 'reports_only'), /ended on/);
    assert.equal(at(-9, 'ended'), null);
    assert.equal(at(3, 'converted'), null);
    assert.equal(N.trialNotice(null, now), null);
  });
  await ok('the notice is the owner\'s: asked only for the owner, above the page, no cashier screen', () => {
    const c = read('apps/dashboard/src/components/CloudTrialNotice.tsx');
    assert.match(c, /if \(!isOwner \|\| isPartner\) \{ setText\(null\); return; \}/);
    assert.match(read('apps/dashboard/src/components/DashboardLayout.tsx'), /<CloudTrialNotice \/>\n\s*<Outlet/);
    assert.doesNotMatch(read('apps/dashboard/src/pages/pos/CashierScreen.tsx'), /CloudTrialNotice/);
  });

  console.log('\n5. The admin portal\n');
  const trial = (phase, days = 10) => ({ started_at: '2026-10-22T09:00:00Z', ends_at: new Date(Date.parse('2026-10-22T09:00:00Z') + days * DAY).toISOString(), converted_at: null, phase });
  await ok('the header: "Cloud trial — ends {date}"; ended; paid "Active"; none "Not enabled"', () => {
    assert.deepEqual(P.webPortalTile(trial('active', 30), true), { text: 'Cloud trial — ends 21 Nov 2026', tone: 'warn' });
    assert.match(P.webPortalTile(trial('reports_only', -2), true).text, /^Trial ended .+ — reports only$/);
    assert.equal(P.webPortalTile(trial('ended', -9), true).tone, 'bad');
    assert.equal(P.webPortalTile({ ...trial('converted'), converted_at: 'x' }, true).text, 'Active');
    assert.equal(P.webPortalTile(null, false).text, 'Not enabled');
  });
  await ok('"Plan" never reads "None" for a desktop client: Desktop / Cloud trial / Cloud; a real subscription first', () => {
    assert.equal(P.planTile(null, 'Desktop').text, 'Desktop');
    assert.deepEqual(P.planTile(null, 'Cloud trial'), { text: 'Cloud trial', tone: 'warn' });
    assert.equal(P.planTile(null, 'Cloud').text, 'Cloud');
    assert.equal(P.planTile(null, null).text, 'Desktop');
    assert.match(P.planTile({ expires_at: '2027-01-01T00:00:00Z', plans: { name: 'Annual' } }, 'Cloud').text, /^Annual · to /);
    assert.equal(P.planTone('Cloud trial ended'), 'bad');
  });
  await ok('Plan & billing: the trial line and Convert to paid (the paid flow with its invoice)', () => {
    assert.match(P.trialBillingLine(trial('active', 30)).title, /^Cloud trial — ends 21 Nov 2026$/);
    assert.match(P.trialBillingLine(trial('active', 30)).text, /no invoice was raised/);
    assert.match(P.trialBillingLine(trial('reports_only', -2)).text, /7 days/);
    assert.equal(P.trialBillingLine({ ...trial('converted'), converted_at: 'x' }), null);
    const a = read('apps/admin/src/AdminPortal.tsx');
    assert.match(a, /data-testid="trial-convert">Convert to paid/);
    // A581: Convert to paid is the Cloud plan's Record payment (amount and period editable), not a fixed KES 10,000 year.
    assert.match(a, /querySelector\('\[data-testid="pay-amount"\]'\)/);
    assert.match(a, /<CloudPlanCard /);
    assert.match(a, /data-testid="client-plan"/);
  });
  await ok('create-client no longer promises a trial it cannot give', () => {
    const a = read('apps/admin/src/AdminPortal.tsx');
    assert.doesNotMatch(a, /A trial subscription is automatically applied/);
    assert.match(a, /The one-month cloud trial starts when the first desktop licence is activated\./);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
