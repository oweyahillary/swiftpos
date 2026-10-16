// A505 — cloud fixes from the 1.0.16 pre-deployment audit (the web auditor's findings, fixed in apps/server).
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/a505-cloud-fixes.test.mjs
//
// RUNS the COMPILED routers (business, orders, shifts, reports, discounts) behind the REAL auth middleware over HTTP; the
// database in memory (tests/lib-memdb.mjs).
//
//   S1 delivery_free_over is read back by GET /api/business/settings (it was saved but never returned).
//   S2 a manager typing their OWN PIN to approve their own void / refund / shift confirmation / payout is told someone else
//      must approve (403 SELF_APPROVAL) — it is not a wrong PIN and never a strike towards the PIN lock. The owner may.
//      Only someone who could approve is told so: a cashier's own PIN stays a wrong PIN (kitchen-voids, shift-confirm pins).
//   S3 GET /reports/eod: without reports.shifts / shifts.confirm no cash figure that adds up to the expected cash.
//   S4 the admin portal's branch list carries deploy_mode.
//   P  POST /discounts/apply: a promo code is matched literally (no wildcard), and 20 wrong codes pause that caller.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-16):
//   - business.ts READABLE_SETTING_KEYS without 'delivery_free_over'       → S1 fails
//   - approver.ts findApprover returning 'invalid' instead of 'self'        → S2 fails (INVALID_APPROVER_PIN, then PIN_LOCKED)
//   - reports.ts eod cash_sales outside the seesCash block                  → S3 fails
//   - discounts.ts without likeLiteral AND the exact-code check (two layers) → P "%" applies the code-only discount
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/discounts.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.RESEND_API_KEY; delete process.env.SENDGRID_API_KEY; delete process.env.SMTP_HOST;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const mailer = require(path.join(DIST, 'lib/mailer.js'));
mailer.sendEmail = async () => {};
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const pinAttempts = require(path.join(DIST, 'lib/pinAttempts.js'));
const discounts = require(path.join(DIST, 'routes/discounts.js'));
const bcrypt = require('bcrypt');

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MGR = 'aaaaaaaa-0000-4000-8000-000000000002',
  CASH = 'aaaaaaaa-0000-4000-8000-000000000003', BOSS = 'aaaaaaaa-0000-4000-8000-000000000005';
const perms = (...keys) => ({ name: 'Role', role_permissions: keys.map((key) => ({ permissions: { key } })) });
const PIN_MGR = '4321', PIN_BOSS = '8765', OVR_MGR = '9911';
const H = { mgr: bcrypt.hashSync(PIN_MGR, 4), boss: bcrypt.hashSync(PIN_BOSS, 4), cash: bcrypt.hashSync('1111', 4), ovr: bcrypt.hashSync(OVR_MGR, 4) };
const person = (id, name, extra = {}) => ({ id, name, status: 'active', business_id: B, permissions_version: 0, user_permissions: [], user_branches: [], ...extra });
const O1 = 'cccccccc-0000-4000-8000-000000000001', SH = 'eeeeeeee-0000-4000-8000-000000000001';

const reset = () => {
  mem.fail = () => null; mem.calls = [];
  pinAttempts._resetAttempts(); discounts._resetPromoAttempts();
  const now = new Date().toISOString();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Pollo', currency: 'KES', vat_rate: 16, ctl_rate: 0 }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true }],
    users: [
      person(OWNER, 'Owner', { roles: { name: 'Admin' }, pin_hash: null }),
      person(MGR, 'Mary', { roles: perms('orders.create', 'sales.void', 'sales.refund', 'shifts.confirm'), pin_hash: H.mgr, override_pin_hash: H.ovr }),
      person(CASH, 'Joe', { roles: perms('orders.create'), pin_hash: H.cash }),
      person(BOSS, 'Boss', { roles: perms('orders.create', 'sales.void', 'sales.refund', 'shifts.confirm'), pin_hash: H.boss }),
    ],
    user_branches: [], user_devices: [], business_settings: [
      { id: 's1', business_id: B, key: 'delivery_free_allowed', value: 'true' },
      { id: 's2', business_id: B, key: 'delivery_free_over', value: '2000' },
      { id: 's3', business_id: B, key: 'supervisor_pin', value: 'secret-hash' },
    ],
    branch_settings: [], feature_flags: [], notifications: [], refresh_tokens: [], change_requests: [], products: [], categories: [],
    orders: [{ id: O1, business_id: B, branch_id: BR, order_number: 'T1-1', status: 'completed', total: 500, subtotal: 500, vat_amount: 0,
      discount_amount: 0, created_at: now, device_id: 'dev-T1', cashier_id: MGR, shift_id: SH,
      order_items: [], payments: [{ id: 'pay1', status: 'completed', amount: 500, method: 'cash' }] }],
    shifts: [{ id: SH, business_id: B, branch_id: BR, status: 'closed', opened_by: CASH, cashier_id: CASH, opening_float: 1000,
      closing_float: 1400, expected_cash: 1500, cash_variance: -100, opened_at: now, closed_at: now }],
    payments: [{ id: 'pay1', order_id: O1, status: 'completed', amount: 500, method: 'cash', orders: { shift_id: SH } }],
    float_transactions: [], expenses: [], customers: [], kitchen_tickets: [], kitchen_voids: [], business_days: [],
    discounts: [
      { id: 'd-open', business_id: B, name: 'Happy hour', type: 'percentage', value: 10, status: 'active', promo_code: null, min_order_value: 0, max_uses: null, used_count: 0 },
      { id: 'd-code', business_id: B, name: 'VIP', type: 'percentage', value: 50, status: 'active', promo_code: 'VIP50', min_order_value: 0, max_uses: null, used_count: 0 },
    ],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
for (const [mount, file] of [['business', 'business'], ['orders', 'orders'], ['shifts', 'shifts'], ['reports', 'reports'], ['discounts', 'discounts']]) {
  app.use(`/api/${mount}`, require(path.join(DIST, `routes/${file}.js`)).default);
}
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'], ownerLogin: true }),
  mgr: sign({ userId: MGR, permissionKeys: ['orders.create', 'sales.void', 'sales.refund', 'shifts.confirm', 'sales.discount'], surface: 'pos' }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create', 'sales.discount'], surface: 'pos' }),
};
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  state._setPermissionsMigrated(true);

  console.log('\nS1. delivery_free_over is read back\n');
  reset();
  await ok('GET /api/business/settings returns delivery_free_over (and still never the supervisor PIN)', async () => {
    const r = await call('GET', '/api/business/settings', T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const keys = r.body.map((x) => x.key);
    assert.ok(keys.includes('delivery_free_over'), keys.join(','));
    assert.equal(r.body.find((x) => x.key === 'delivery_free_over').value, '2000');
    assert.ok(!keys.includes('supervisor_pin'));
  });

  console.log('\nS2. Your own PIN is "someone else must approve", never a strike\n');
  reset();
  await ok('a manager approving their own void with their OWN sign-in PIN: 403 SELF_APPROVAL, sale untouched', async () => {
    const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: PIN_MGR });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'SELF_APPROVAL');
    assert.equal(mem.db.orders[0].status, 'completed');
  });
  await ok('…with their own OVERRIDE PIN (refund): 403 SELF_APPROVAL', async () => {
    const r = await call('POST', `/api/orders/${O1}/refund`, T.mgr, { reason: 'x', override_pin: OVR_MGR });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'SELF_APPROVAL');
  });
  await ok('…repeated past the PIN limit, it never locks PIN entry: another manager\'s PIN then approves (200)', async () => {
    for (let i = 0; i < pinAttempts.PIN_MAX_FAILS + 2; i++) {
      const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: PIN_MGR });
      assert.equal(r.body.code, 'SELF_APPROVAL', `try ${i}: ${JSON.stringify(r.body)}`);
    }
    const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: PIN_BOSS });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(mem.db.orders[0].authorized_by, BOSS);
  });
  reset();
  await ok('a really wrong PIN is still INVALID_APPROVER_PIN (and counts)', async () => {
    const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: '0000' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'INVALID_APPROVER_PIN');
  });
  await ok('shift confirmer: the asker\'s own PIN → 403 SELF_APPROVAL; another manager\'s → who it is', async () => {
    let r = await call('POST', '/api/shifts/confirmer', T.mgr, { pin: PIN_MGR });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'SELF_APPROVAL');
    r = await call('POST', '/api/shifts/confirmer', T.mgr, { pin: PIN_BOSS });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.id, BOSS);
  });
  await ok('shift confirm by PIN: the asker\'s own PIN → 403 SELF_APPROVAL, the shift stays unconfirmed', async () => {
    const r = await call('POST', `/api/shifts/${SH}/confirm`, T.mgr, { pin: PIN_MGR, confirmed_methods: { cash: 1400 } });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'SELF_APPROVAL');
    assert.ok(!mem.db.shifts[0].confirmed_at);
  });

  console.log('\nS3. The Z-report keeps a blind close blind\n');
  reset();
  await ok('a cashier\'s own Z-report: opening float only — no cash sales, floats, counted cash or expected cash', async () => {
    const r = await call('GET', `/api/reports/eod?shift_id=${SH}`, T.cash);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body.shifts?.[0];
    assert.ok(s, JSON.stringify(r.body.shifts));
    for (const k of ['cash_sales', 'float_in', 'float_out', 'closing_float', 'expected_cash', 'cash_variance']) assert.ok(!(k in s), `${k} sent`);
    assert.equal(s.opening_float, 1000);
  });
  await ok('someone who may confirm shifts gets every figure', async () => {
    const mgrAll = sign({ userId: MGR, permissionKeys: ['shifts.confirm', 'reports.sales'], surface: 'pos' });
    const r = await call('GET', `/api/reports/eod?shift_id=${SH}`, mgrAll);
    const s = r.body.shifts?.[0];
    assert.ok(s && 'cash_sales' in s && 'closing_float' in s && 'expected_cash' in s, JSON.stringify(s));
  });

  console.log('\nS4. The admin portal\'s branch list carries deploy_mode\n');
  await ok('GET /clients/:id/branches selects deploy_mode', () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/admin.ts'), 'utf8');
    const at = src.indexOf("router.get('/clients/:id/branches'");
    assert.ok(at > 0); assert.match(src.slice(at, at + 600), /\.select\('[^']*\bdeploy_mode\b[^']*'\)/);
  });

  console.log('\nP. Promo codes\n');
  reset();
  await ok('a code is matched literally — "%" never applies a code-only discount', async () => {
    const r = await call('POST', '/api/discounts/apply', T.cash, { code: '%', order_total: 1000 });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
  await ok('the right code applies (any case)', async () => {
    const r = await call('POST', '/api/discounts/apply', T.cash, { code: 'vip50', order_total: 1000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  reset();
  await ok('20 wrong codes from one cashier pause THEIR look-ups (429 PROMO_LOCKED); another person is not paused', async () => {
    for (let i = 0; i < discounts.PROMO_MAX_FAILS; i++) {
      const r = await call('POST', '/api/discounts/apply', T.cash, { code: `GUESS${i}`, order_total: 1000 });
      assert.equal(r.status, 404, `try ${i}`);
    }
    const r = await call('POST', '/api/discounts/apply', T.cash, { code: 'VIP50', order_total: 1000 });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'PROMO_LOCKED');
    const other = await call('POST', '/api/discounts/apply', T.mgr, { code: 'VIP50', order_total: 1000 });
    assert.equal(other.status, 200, JSON.stringify(other.body));
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
