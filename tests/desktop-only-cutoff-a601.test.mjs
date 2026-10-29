/**
 * desktop-only-cutoff-a601.test.mjs — A601: desktop-only clients cut off from the cloud backup and desktop updates, from
 * the date ZapTill sets (DESKTOP_ONLY_CUTOFF_AT), with a month's notice first.
 *
 * Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md): "Partial cut" — for a business the cloud calls not_on_plan, setup
 * (joining a POS), sign-in, catalogue and staff changes and support logs stay; the backup of sales, orders, shifts,
 * drawers, reversals and day closes is cut; desktop updates are cut too (ZapTill releases one to that business);
 * nothing is cut until the date; the cloud_backup flag keeps a business's backup. Paying, trial and A581-locked clients
 * are not affected.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/desktop-only-cutoff-a601.test.mjs
 *
 * RUNS the COMPILED server — routes/index.js behind the REAL requireAuth (where the gate lives), the admin router (real
 * requireAdmin), /api/desktop-update and /api/pos/init — over HTTP on the in-memory database (tests/lib-memdb.mjs), and
 * lib/cloudPlan.js; and the admin portal's words from apps/admin/src/cloudPlan.ts.
 *   1 the rules: the date (unset / not a date / a bare date = 00:00 Nairobi / a full ISO), the phases, the standing of
 *     each kind of client in each phase, which writes are backup writes
 *   2 the switch: unset and before the date nothing is refused
 *   3 the cut: each backup write 503 CLOUD_BACKUP_OFF (Retry-After 3600); each kept path still answered; paying, trial,
 *     exempt untouched; an A581-locked client keeps its own refusal
 *   4 setup: a desktop-only business can still join a POS (enrolment redeem, the admin's code) after the cut
 *   5 /api/pos/init's cloudBackup in each phase, and for the exempt and paying clients
 *   6 updates: no offer at the cut (bySupport; the feed refuses with DESKTOP_UPDATES_BY_SUPPORT); offered before the date,
 *     to a released business and to a paying one
 *   7 the admin portal: the "Desktop only" filter, each row's phase, the cut-off date; the two switches are a super
 *     admin's (an agent refused, the client's PUT /api/flags refused); switching cloud_backup on takes effect at once
 *   8 the watchdog and the owner's alerts leave a desktop-only business's POSs out after the cut (not before, not exempt)
 *
 * MUTATIONS TO CONFIRM BITE (each made in src, rebuilt, seen to fail, reverted — 2026-10-28):
 *   - cloudPlan.ts desktopOnlyFor backupOff without `phase === 'cut'`  → 6 fail (2 "unset", "not a date", "before the date" …)
 *   - cloudPlan.ts accessRefusal without the backupOff branch            → 2 fail (3 "each backup write → 503", 7 "at once")
 *   - cloudPlan.ts backupGateApplies taking every /api/ write            → 2 fail (1 the list, 3 "each kept path")
 *   - cloudPlan.ts desktopOnlyFor exempt ignoring the cloud_backup flag  → 5 fail (3 "exempt untouched", 7 "at once" …)
 *   - desktopUpdate.ts approvedVersion without the updatesHeld check    → 1 fail (6 "no offer at the cut")
 *   - cloudPlan.ts lapsedBusinessIds without the candidates loop         → 1 fail (8 "left out after the cut")
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
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.LOGIN_OTP;
delete process.env.DESKTOP_ONLY_CUTOFF_AT;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const PI = require(path.join(DIST, 'lib/posInit.js'));
const SV = require(path.join(DIST, 'lib/syncVersions.js'));
const P = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/cloudPlan.ts')).href);
console.warn = () => {}; console.error = () => {};

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const SUPER = 'aaaaaaaa-0000-4000-8000-0000000000a1', AGENT = 'aaaaaaaa-0000-4000-8000-0000000000a2';
// P paying cloud client · TR on a cloud trial · LK locked for not paying (A581) · D desktop only · X desktop only, exempt
// (cloud_backup) · U desktop only, updates released (desktop_updates)
const ID = { P: '11111111-1111-4111-8111-1111111111a1', TR: '11111111-1111-4111-8111-1111111111a2', LK: '11111111-1111-4111-8111-1111111111a3',
  D: '11111111-1111-4111-8111-1111111111a4', X: '11111111-1111-4111-8111-1111111111a5', U: '11111111-1111-4111-8111-1111111111a6' };
const BR = Object.fromEntries(Object.entries(ID).map(([k, v]) => [k, v.replace('11111111-1111', '22222222-2222')]));
const OWNER_D = 'aaaaaaaa-0000-4000-8000-000000000004';
const CODE = 'WXYZ-1234';
const hash = (c) => crypto.createHash('sha256').update(c).digest('hex');
const CUT_AT = '2026-12-01';
const setCutoff = (v) => { if (v === null) delete process.env.DESKTOP_ONLY_CUTOFF_AT; else process.env.DESKTOP_ONLY_CUTOFF_AT = v; PI._resetInitCache(); CP.forgetStanding(); };   // (an env change restarts the cloud)
const BEFORE = () => setCutoff(iso(Date.now() + 30 * DAY));   // notice
const AFTER = () => setCutoff(iso(Date.now() - DAY));          // cut

const reset = () => {
  mem.fail = () => null; mem.calls = []; mem.realOr = false;
  const now = Date.now();
  const biz = (k, name, extra = {}) => ({ id: ID[k], name, owner_id: k === 'D' ? OWNER_D : `owner-${k}`, email: null, status: 'active', type: 'restaurant',
    currency: 'KES', vat_rate: 16, ctl_rate: 0, web_access_expires_at: null, desktop_approved_version: '1.0.23', created_at: '2026-09-01T00:00:00Z', ...extra });
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    businesses: [
      biz('P', 'Paying Grill', { web_access_expires_at: iso(now + 60 * DAY) }),
      biz('TR', 'Trial Parking', { web_access_expires_at: iso(now + 20 * DAY) }),
      biz('LK', 'Locked Duka', { web_access_expires_at: iso(now - 30 * DAY) }),
      biz('D', 'Desktop Fries'), biz('X', 'Goodwill Cafe'), biz('U', 'Updates Bar'),
    ],
    branches: Object.keys(ID).map((k) => ({ id: BR[k], business_id: ID[k], name: 'Main', is_main: true, status: 'active', desktop_licensed: true })),
    cloud_plans: [
      { business_id: ID.P, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: 'boss', created_at: iso(now - 90 * DAY) },
      { business_id: ID.LK, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: 'boss', created_at: iso(now - 90 * DAY) },
    ],
    business_settings: [{ business_id: ID.TR, key: 'cloud_trial', value: { started_at: iso(now - 10 * DAY), ends_at: iso(now + 20 * DAY), branch_id: BR.TR, started_by: SUPER, converted_at: null } }],
    feature_flags: [
      { business_id: ID.P, key: 'web_hosting', enabled: true }, { business_id: ID.TR, key: 'web_hosting', enabled: true },
      { business_id: ID.LK, key: 'web_hosting', enabled: true },
      { business_id: ID.X, key: 'cloud_backup', enabled: true }, { business_id: ID.U, key: 'desktop_updates', enabled: true },
    ],
    user_devices: Object.keys(ID).map((k) => ({ id: `ud-${k}`, business_id: ID[k], device_id: `till-${k}`, status: 'approved', retired_at: null, branch_id: BR[k], device_role: 'till' })),
    device_enrolment_codes: [{ id: 'ec1', business_id: ID.D, branch_id: BR.D, code_hash: hash(CODE), status: 'active', expires_at: iso(now + 600_000) }],
    users: [{ id: OWNER_D, business_id: ID.D, name: 'Owner', status: 'active', permissions_version: 0, roles: { name: 'Admin' }, user_branches: [], user_permissions: [] }],
    sync_versions: Object.keys(ID).map((k) => ({ business_id: ID[k], topic: 'catalogue', version: 3 })),
    cloud_payments: [], cloud_plan_reminders: [], invoices: [], admin_audit_log: [], subscriptions: [], plans: [], refresh_tokens: [], products: [],
    orders: [], notifications: [], categories: [], branch_prices: [], tables: [], branch_settings: [], payment_methods: [], offers: [], promotions: [],
    stock_takes: [], variant_groups: [], modifier_groups: [], combo_items: [], menus: [], sync_changes: [], sync_change_floor: [{ id: 1, floor_seq: 0 }],
    business_branding: [], branch_branding: [], change_requests: [], audit_log: [], ops_events: [], roles: [], role_permissions: [], permissions: [],
  };
  adminAuth.forgetAdmin(); AC._resetAuthCache(); PI._resetInitCache(); SV._resetSyncVersions?.(); CP._resetStanding();
};
reset();

const express = require('express');
const app = express(); app.use(express.json({ limit: '2mb' }));
app.use('/api/admin/clients', require(path.join(DIST, 'routes/cloudPlanAdmin.js')).default);
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, retry: r.headers.get('retry-after'), text };
};
const ADMIN = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const AGENT_T = jwt.sign({ adminId: AGENT, email: 'agent@zaptill.test', role: 'agent' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const till = (k) => jwt.sign({ userId: null, deviceId: `till-${k}`, till: true, businessId: ID[k], branchId: BR[k], isOwner: false,
  permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const TILL = Object.fromEntries(Object.keys(ID).map((k) => [k, till(k)]));
const OWNER_WEB_D = jwt.sign({ userId: OWNER_D, businessId: ID.D, branchId: null, isOwner: true, ownerLogin: true, surface: 'dashboard', permissionKeys: ['*'],
  permissionsVersion: 0, sessionId: 's' }, process.env.JWT_SECRET, { expiresIn: '5m' });

// The POS's backup writes (refused from the cut) and the writes and reads that stay.
const REFUSED = [
  ['POST', '/api/orders'], ['POST', '/api/orders/o-1/void'], ['POST', '/api/orders/o-1/refund'], ['POST', '/api/sync/push'],
  ['POST', '/api/shifts/s-1/close'], ['POST', '/api/shifts/s-1/force-close'], ['POST', '/api/shifts/s-1/foreign-cash'],
  ['POST', '/api/shifts/s-1/foreign-orders'], ['POST', '/api/shifts/s-1/confirm'], ['POST', '/api/shifts/s-1/manager-confirm'],
  ['POST', '/api/day-close/ack'], ['POST', '/api/credit/sales/o-1/replay'],
];
const KEPT = [
  ['POST', '/api/changes'], ['POST', '/api/support/logs'], ['POST', '/api/desktop-update/state'], ['POST', '/api/tech/audit'],
  ['POST', '/api/auth/refresh'], ['POST', '/api/auth/device-token'], ['PUT', '/api/stations/st-1/categories'], ['POST', '/api/branch-prices/sync'],
  ['POST', '/api/wastage'], ['POST', '/api/pos/join-code'], ['PUT', '/api/business/branding'], ['POST', '/api/shifts/confirmer'],
  ['GET', '/api/pos/catalogue-version'], ['GET', '/api/pos/branch-drawers'], ['GET', '/api/shifts/state?ids=s-1'], ['GET', '/api/day-close/pending'],
];
const backupOff = (r) => r.status === 503 && r.body?.code === 'CLOUD_BACKUP_OFF';
const notRefused = (r) => r.status !== 503 && r.body?.code !== 'CLOUD_BACKUP_OFF' && r.body?.code !== 'CLOUD_SUBSCRIPTION_ENDED';

try {
  state._setPermissionsMigrated(true);
  console.log('\n1. The rules\n');
  await ok('the date: unset / blank / not a date → none; a bare date is 00:00 Nairobi (21:00 UTC the day before); a full ISO as given', () => {
    assert.equal(CP.parseCutoff(undefined), null); assert.equal(CP.parseCutoff(''), null); assert.equal(CP.parseCutoff('  '), null);
    assert.equal(CP.parseCutoff('soon'), null); assert.equal(CP.parseCutoff('2026-13-45'), null);
    assert.equal(CP.parseCutoff(CUT_AT), '2026-11-30T21:00:00.000Z');
    assert.equal(CP.parseCutoff('2026-12-01T09:30:00Z'), '2026-12-01T09:30:00.000Z');
    assert.equal(CP.DESKTOP_ONLY_CUTOFF_ENV, 'DESKTOP_ONLY_CUTOFF_AT');
  });
  await ok('the phases: none without a date; notice before it; cut from its very moment', () => {
    const at = CP.parseCutoff(CUT_AT), t = Date.parse(at);
    assert.equal(CP.cutoffPhase(null, t), 'none');
    assert.equal(CP.cutoffPhase(at, t - 1), 'notice');
    assert.equal(CP.cutoffPhase(at, t), 'cut');
    assert.equal(CP.cutoffPhase(at, t + 90 * DAY), 'cut');
  });
  await ok('the standing: only a not_on_plan business is desktop only; the flags decide exempt / released; off only at the cut', () => {
    const now = Date.now(), at = iso(now - DAY), soon = iso(now + DAY);
    const facts = (x = {}) => ({ onPlan: false, trial: null, expiresAt: null, webHosting: null, ...x });
    const d = CP.cloudStanding(facts(), now, at).desktopOnly;
    assert.deepEqual([d.is, d.phase, d.backupOff, d.updatesHeld, d.notice, d.cutoffAt], [true, 'cut', true, true, true, at]);
    assert.equal(CP.cloudStanding(facts({ webHosting: false }), now, at).desktopOnly.backupOff, true, 'web access switched off with no date / plan = desktop only');
    const n = CP.cloudStanding(facts(), now, soon).desktopOnly;
    assert.deepEqual([n.phase, n.backupOff, n.updatesHeld, n.notice], ['notice', false, false, true]);
    const none = CP.cloudStanding(facts(), now, null).desktopOnly;
    assert.deepEqual([none.is, none.phase, none.backupOff, none.notice, none.cutoffAt], [true, 'none', false, false, null]);
    const ex = CP.cloudStanding(facts({ cloudBackup: true }), now, at).desktopOnly;
    assert.deepEqual([ex.exempt, ex.backupOff, ex.notice, ex.updatesHeld], [true, false, false, true], 'exempt keeps the backup, not the updates');
    const rel = CP.cloudStanding(facts({ desktopUpdates: true }), now, at).desktopOnly;
    assert.deepEqual([rel.backupOff, rel.updatesHeld], [true, false]);
    // every other kind of client: not desktop only, whatever the date
    for (const [why, f] of [['paying', facts({ onPlan: true, expiresAt: iso(now + 9 * DAY), webHosting: true })],
      ['trial', facts({ trial: { started_at: iso(now - DAY), ends_at: iso(now + 9 * DAY), converted_at: null }, expiresAt: iso(now + 9 * DAY), webHosting: true })],
      ['locked', facts({ onPlan: true, expiresAt: iso(now - 30 * DAY), webHosting: true, planCreatedAt: iso(now - 90 * DAY) })],
      ['no expiry set', facts({ webHosting: true })], ['web access off with a date', facts({ webHosting: false, expiresAt: iso(now + 9 * DAY) })]]) {
      const s = CP.cloudStanding(f, now, at);
      assert.equal(s.desktopOnly.is, false, why); assert.equal(s.desktopOnly.backupOff, false, why); assert.equal(s.desktopOnly.updatesHeld, false, why);
    }
    assert.equal(CP.cloudStanding(facts({ onPlan: true, expiresAt: iso(now - 30 * DAY), webHosting: true, planCreatedAt: iso(now - 90 * DAY) }), now, at).syncRefused, true, 'locked stays A581\'s');
  });
  await ok('which writes are backup writes: sales and reversals, the sync push, a drawer\'s close / confirm / web part, the web day-close ack, a credit replay — never a read, a web write or a kept path', () => {
    const g = CP.backupGateApplies;
    for (const [m, p] of REFUSED) assert.equal(g('desktop', m, p), true, p);
    for (const [m, p] of KEPT) assert.equal(g('desktop', m, p.split('?')[0]), false, p);
    assert.equal(g('desktop', 'POST', '/api/orders?x=1'), true, 'a query string');
    assert.equal(g('dashboard', 'POST', '/api/orders'), false); assert.equal(g('web', 'POST', '/api/sync/push'), false);
    assert.equal(g('desktop', 'GET', '/api/orders'), false);
    assert.equal(g('desktop', 'DELETE', '/api/shifts/s-1'), false, 'not a blanket /api/shifts');
  });

  console.log('\n2. The switch: nothing changes until the date\n');
  await ok('DESKTOP_ONLY_CUTOFF_AT unset: every backup write of a desktop-only POS goes as before', async () => {
    reset(); setCutoff(null);
    for (const [m, p] of REFUSED) { const r = await call(m, p, TILL.D, {}); assert.ok(notRefused(r), `${p}: ${r.status} ${r.text.slice(0, 120)}`); }
  });
  await ok('DESKTOP_ONLY_CUTOFF_AT not a date: as unset', async () => {
    setCutoff('next month');
    for (const [m, p] of REFUSED.slice(0, 4)) { const r = await call(m, p, TILL.D, {}); assert.ok(notRefused(r), `${p}: ${r.status}`); }
  });
  await ok('before the date nothing is refused (the notice phase)', async () => {
    BEFORE();
    for (const [m, p] of REFUSED) { const r = await call(m, p, TILL.D, {}); assert.ok(notRefused(r), `${p}: ${r.status} ${r.text.slice(0, 120)}`); }
  });

  console.log('\n3. The cut\n');
  await ok('each backup write of a desktop-only POS → 503 CLOUD_BACKUP_OFF, plain words, Retry-After 3600, not a server error', async () => {
    reset(); AFTER();
    for (const [m, p] of REFUSED) {
      const r = await call(m, p, TILL.D, {});
      assert.ok(backupOff(r), `${p}: ${r.status} ${r.text.slice(0, 160)}`);
      assert.equal(r.retry, '3600', p);
    }
    const r = await call('POST', '/api/orders', TILL.D, {});
    assert.match(r.body.error, /no longer backs up to the ZapTill cloud/); assert.match(r.body.error, /online licence/);
    assert.doesNotMatch(r.body.error, /\btill\b/i, 'POS, never "till"');
    assert.equal(r.body.cutoffAt, CP.desktopOnlyCutoffAt());
    assert.match(read('apps/server/src/middleware/auth.ts'), /res\.locals\.cloudLapsed = true;[\s\S]{0,400}CLOUD_BACKUP_OFF' \? '3600' : '900'/);
  });
  await ok('each kept path is still answered for that POS: sign-in, the technician, support logs, the update state, catalogue and staff changes, prices, routing, wastage, a logo, the join code, every read', async () => {
    for (const [m, p] of KEPT) { const r = await call(m, p, TILL.D, m === 'GET' ? undefined : {}); assert.ok(notRefused(r), `${p}: ${r.status} ${r.text.slice(0, 160)}`); }
  });
  await ok('the web is not touched (no web gate for a desktop-only business)', async () => {
    const r = await call('GET', '/api/flags', OWNER_WEB_D);
    assert.equal(r.status, 200, r.text);
  });
  await ok('the paying client, the trial client and an exempt (cloud_backup) business are untouched at the cut', async () => {
    for (const k of ['P', 'TR', 'X']) for (const [m, p] of REFUSED) {
      const r = await call(m, p, TILL[k], {}); assert.ok(notRefused(r), `${k} ${p}: ${r.status} ${r.text.slice(0, 120)}`);
    }
  });
  await ok('an A581-locked client keeps its own refusal (CLOUD_SUBSCRIPTION_ENDED, 900) — never the backup one', async () => {
    const r = await call('POST', '/api/sync/push', TILL.LK, {});
    assert.equal(r.status, 503); assert.equal(r.body.code, 'CLOUD_SUBSCRIPTION_ENDED'); assert.equal(r.retry, '900');
    const c = await call('POST', '/api/changes', TILL.LK, {});
    assert.equal(c.body?.code, 'CLOUD_SUBSCRIPTION_ENDED', 'A581 still refuses its changes too (unchanged)');
  });

  console.log('\n4. Setup stays\n');
  await ok('a desktop-only business can still join a POS at the cut (the enrolment code redeems)', async () => {
    reset(); AFTER();
    assert.equal(await CP.enrolRefusal(ID.D), null);
    const r = await call('POST', '/api/auth/enrol/redeem', null, { business_id: ID.D, code: CODE, device_id: 'new-pos' });
    assert.notEqual(r.body?.code, 'CLOUD_SUBSCRIPTION_ENDED'); assert.notEqual(r.body?.code, 'CLOUD_BACKUP_OFF');
    assert.equal(mem.db.device_enrolment_codes[0].status, 'redeemed', r.text.slice(0, 200));
  });
  await ok('the admin\'s "Enrolment code" is given for a desktop-only client at the cut (a locked one still refused)', async () => {
    const r = await call('POST', `/api/admin/clients/${ID.D}/branches/${BR.D}/enrol-code`, ADMIN, {});
    assert.notEqual(r.status, 409, r.text.slice(0, 200)); assert.notEqual(r.body?.code, 'CLOUD_SUBSCRIPTION_ENDED');
    const l = await call('POST', `/api/admin/clients/${ID.LK}/branches/${BR.LK}/enrol-code`, ADMIN, {});
    assert.equal(l.body?.code, 'CLOUD_SUBSCRIPTION_ENDED');
  });

  console.log('\n5. /api/pos/init tells the POS\n');
  const init = async (k) => { const r = await call('GET', `/api/pos/init?branch_id=${BR[k]}`, TILL[k]); assert.equal(r.status, 200, r.text.slice(0, 200)); return r.body.cloudBackup; };
  await ok('unset: { on: true, phase: none }; before the date: on, notice, the date; from it: off, cut, the date', async () => {
    reset(); setCutoff(null);
    { const u = await init("D"); assert.deepEqual(u, { on: true, phase: "none", cutoffAt: null }, JSON.stringify(u)); }
    BEFORE();
    const n = await init('D');
    assert.deepEqual([n.on, n.phase, n.cutoffAt], [true, "notice", CP.desktopOnlyCutoffAt()], JSON.stringify(n));
    AFTER();
    const c = await init('D');
    assert.deepEqual([c.on, c.phase, c.cutoffAt], [false, 'cut', CP.desktopOnlyCutoffAt()]);
  });
  await ok('at the cut the exempt, the paying and the trial client read { on: true, phase: none } (nothing to show)', async () => {
    for (const k of ['X', 'P', 'TR']) assert.deepEqual(await init(k), { on: true, phase: 'none', cutoffAt: null }, k);
  });
  await ok('a settings change (the cloud_backup flag is a feature_flags row: a money change) carries it too', () => {
    assert.match(read('shared/syncTopics.ts'), /money: \[[^\]]*'cloudBackup'\]/);
  });

  console.log('\n6. Desktop updates\n');
  await ok('at the cut a desktop-only business is offered nothing (bySupport), and its feed refuses (DESKTOP_UPDATES_BY_SUPPORT)', async () => {
    reset(); AFTER();
    const s = await call('GET', '/api/desktop-update/status', TILL.D);
    assert.equal(s.status, 200);
    assert.deepEqual([s.body.approvedVersion, s.body.held, s.body.bySupport], [null, true, true]);
    const f = await call('GET', '/api/desktop-update/v/1.0.23/latest.yml', TILL.D);
    assert.equal(f.status, 403); assert.equal(f.body.code, 'DESKTOP_UPDATES_BY_SUPPORT');
    assert.equal(f.body.error, 'Updates for this business are released by ZapTill support.');
    const x = await call('GET', '/api/desktop-update/status', TILL.X);
    assert.equal(x.body.approvedVersion, null, 'the backup exemption does not release updates');
  });
  await ok('released (desktop_updates), paying and trial clients are offered their approved version at the cut; nobody before the date', async () => {
    for (const k of ['U', 'P', 'TR']) {
      const s = await call('GET', '/api/desktop-update/status', TILL[k]);
      assert.deepEqual([s.body.approvedVersion, s.body.bySupport], ['1.0.23', undefined], k);
    }
    BEFORE();
    const d = await call('GET', '/api/desktop-update/status', TILL.D);
    assert.equal(d.body.approvedVersion, "1.0.23", "the notice phase changes nothing " + JSON.stringify(d.body));
  });

  console.log('\n7. The admin portal\n');
  await ok('"Desktop only": every client with no plan, date, trial or web access — with its phase, and the cloud\'s date', async () => {
    reset(); BEFORE();
    const r = await call('GET', '/api/admin/clients?expiry=desktop_only', ADMIN);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.clients.map((c) => c.id).sort(), [ID.D, ID.X, ID.U].sort());
    assert.deepEqual([r.body.cutoff.at, r.body.cutoff.phase], [CP.desktopOnlyCutoffAt(), 'notice']);
    const d = r.body.clients.find((c) => c.id === ID.D).desktop_only;
    assert.deepEqual([d.phase, d.exempt, d.backup_off, d.notice], ['notice', false, false, true]);
    assert.equal(P.desktopOnlyText(d).text, `Desktop only — backup stops ${P.trialDate(d.cutoff_at)}`);
    assert.equal(P.desktopOnlyText(r.body.clients.find((c) => c.id === ID.X).desktop_only).text, 'Desktop only — backup kept (exempt)');
    const all = await call('GET', '/api/admin/clients', ADMIN);
    assert.equal(all.body.clients.find((c) => c.id === ID.P).desktop_only, null, 'a paying client is not desktop only');
    AFTER();
    const cut = (await call('GET', '/api/admin/clients?expiry=desktop_only', ADMIN)).body;
    assert.equal(P.desktopOnlyText(cut.clients.find((c) => c.id === ID.D).desktop_only).tone, 'bad');
    assert.match(P.cutoffLine(cut.cutoff), /has passed/); assert.match(P.cutoffLine({ at: null, phase: 'none' }), /No cut-off date is set/);
    const one = await call('GET', `/api/admin/clients/${ID.D}`, ADMIN);
    assert.equal(one.body.desktop_only.backup_off, true); assert.equal(one.body.desktop_only_cutoff.phase, 'cut');
    assert.match(P.desktopUpdatesLine(one.body.desktop_only), /released by ZapTill support/);
  });
  await ok('the two switches are a super admin\'s: an agent is refused; the client cannot set them (PUT /api/flags → ADMIN_ONLY_FEATURE)', async () => {
    for (const key of ['cloud_backup', 'desktop_updates']) {
      const a = await call('PATCH', `/api/admin/clients/${ID.D}/features/${key}`, AGENT_T, { enabled: true });
      assert.equal(a.status, 403); assert.equal(a.body.code, 'SUPER_ADMIN_REQUIRED');
      const c = await call('PUT', `/api/flags/${key}`, OWNER_WEB_D, { enabled: true });
      assert.equal(c.status, 403); assert.equal(c.body.code, 'ADMIN_ONLY_FEATURE');
    }
    assert.equal(mem.db.feature_flags.some((f) => f.business_id === ID.D && (f.key === 'cloud_backup' || f.key === 'desktop_updates')), false);
  });
  await ok('switching cloud_backup on (super admin) takes effect at once — the next push goes; off again, refused again', async () => {
    AFTER();
    assert.ok(backupOff(await call('POST', '/api/sync/push', TILL.D, {})));
    const on = await call('PATCH', `/api/admin/clients/${ID.D}/features/cloud_backup`, ADMIN, { enabled: true });
    assert.equal(on.status, 200, on.text);
    assert.ok(notRefused(await call('POST', '/api/sync/push', TILL.D, {})), 'the standing was forgotten');
    assert.ok(mem.db.admin_audit_log.some((a) => a.action === 'feature.enable' && a.business_id === ID.D), 'audited');
    await call('PATCH', `/api/admin/clients/${ID.D}/features/cloud_backup`, ADMIN, { enabled: false });
    assert.ok(backupOff(await call('POST', '/api/sync/push', TILL.D, {})));
    const u = await call('PATCH', `/api/admin/clients/${ID.D}/features/desktop_updates`, ADMIN, { enabled: true });
    assert.equal(u.status, 200);
    assert.equal((await call('GET', '/api/desktop-update/status', TILL.D)).body.approvedVersion, '1.0.23', 'released at once');
  });
  await ok('the portal shows the switches only for a desktop-only client, next to the other feature switches; kept out of "Other flags"', () => {
    const a = read('apps/admin/src/AdminPortal.tsx');
    assert.match(a, /\{detail\?\.desktop_only && \([\s\S]{0,300}data-testid="desktop-only-features"/);
    assert.match(a, /toggleCutoffFlag\('cloud_backup', !hasCloudBackup\)/); assert.match(a, /toggleCutoffFlag\('desktop_updates', !hasDesktopUpdates\)/);
    assert.match(a, /superOnly\(toggle\(hasCloudBackup/);
    assert.equal((a.match(/f\.key !== "cloud_backup" && f\.key !== "desktop_updates"\)/g) ?? []).length, 2);
    assert.match(a, /<option value="desktop_only">/);
  });

  console.log('\n8. The watchdog and the owner\'s alerts\n');
  await ok('after the cut a desktop-only business\'s POSs are left out of "not syncing" (with A581\'s locked one); before it, and an exempt one, not', async () => {
    reset();
    const all = Object.values(ID);
    setCutoff(null);
    assert.deepEqual([...await CP.lapsedBusinessIds(Date.now(), all)].sort(), [ID.LK]);
    BEFORE(); CP.forgetStanding();
    assert.deepEqual([...await CP.lapsedBusinessIds(Date.now(), all)].sort(), [ID.LK]);
    AFTER(); CP.forgetStanding();
    assert.deepEqual([...await CP.lapsedBusinessIds(Date.now(), all)].sort(), [ID.LK, ID.D, ID.U].sort());
    assert.deepEqual([...await CP.lapsedBusinessIds(Date.now())].sort(), [ID.LK], 'no candidates named: as before A601');
    assert.match(read('apps/server/src/jobs/watchdog.ts'), /lapsedBusinessIds\(now\.getTime\(\), \(\(data \?\? \[\]\) as any\[\]\)\.map\(\(d\) => d\.business_id\)\)/);
    assert.match(read('apps/server/src/jobs/watchdog.ts'), /filter\(\(d\) => !lapsed\.has\(d\.business_id\)\)/);
    assert.match(read('apps/server/src/jobs/ownerAlerts.ts'), /planStanding\?\.desktopOnly\?\.backupOff === true/);
  });
  await ok('a failed read of the exempt list leaves nobody out on it (only A581\'s)', async () => {
    CP.forgetStanding();
    mem.fail = (table, op, filters) => (table === 'feature_flags' && filters.key === 'cloud_backup' ? { message: 'timeout', code: '57014' } : null);
    assert.deepEqual([...await CP.lapsedBusinessIds(Date.now(), Object.values(ID))].sort(), [ID.LK]);
    mem.fail = () => null;
  });
  await ok('documented: the env var in .env.example and render.yaml (commented: unset), the flags in the plan', () => {
    assert.match(read('apps/server/.env.example'), /# DESKTOP_ONLY_CUTOFF_AT=/);
    assert.match(read('render.yaml'), /# - key: DESKTOP_ONLY_CUTOFF_AT/);
    assert.doesNotMatch(read('render.yaml'), /^\s+- key: DESKTOP_ONLY_CUTOFF_AT/m, 'not set by the blueprint');
    assert.match(read('docs/DESKTOP-ONLY-CUTOFF-PLAN.md'), /cloud_backup/);
  });
} finally {
  delete process.env.DESKTOP_ONLY_CUTOFF_AT;
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
