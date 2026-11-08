/**
 * owner-decisions-a595.test.mjs — A595, the owner's decisions of 2026-10-27 on user rights:
 *   D3  webhooks the owner's; who receives the report e-mails the owner's and the partners' (a manager by role: no);
 *   D4  credit limits with branches — the owner's ceiling, the owner's lock, credit per branch, partners deciding at their
 *       own branches (the owner's switch), a customer's limit at one branch, "owed here / owed in total", every change audited;
 *   D8  Overview is today's page;
 *   D1  the customer's KRA PIN (personal and tax data: masked without customers.contacts).
 * (D3's automatic e-mails: tests/owner-alerts.test.mjs; D4 at the POS offline: apps/desktop/test/credit-branch-a595.test.mjs;
 * the role changes: scripts/test-migration-177.mjs.)
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/owner-decisions-a595.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: limitRefusal ignoring the ceiling → "D4.1" fails; ignoring the lock → "D4.2" fails;
 * partnerDecidesAt ignoring the owner's switch → "D4.4" fails; mayReportEmails without webPartner → "D3 report e-mails"
 * fails; maskContacts without kra_pin → "masked (A•••Z)" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreRequire = createRequire(path.join(ROOT, 'apps/server/package.json'));   // @zaptill/core, as the cloud loads it
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/personalData.js'))) {
  console.log('\nBuild the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const P = coreRequire('@zaptill/core/permissions');
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const PD = require(path.join(DIST, 'lib/personalData.js'));
const SC = coreRequire('@zaptill/core/shiftConfirm');
const RK = require(path.join(DIST, 'lib/roleKeys.js'));
const BT = coreRequire('@zaptill/core/businessTerms');
state._setPermissionsMigrated(true);
state._setSplitsMigrated(true);

const id = () => randomUUID();
const BZ = id(), BR = id(), USER = id(), OWNER = id(), X = id(), MGR = id(), C1 = id(), CH_STAFF = id(), CH_MENU = id(), ROLE = id(), MGR_ROLE = id();
const PHONE = '0712345678', EMAIL = 'mary.k@gmail.com';

let db;
const reset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, name: 'Sample Shop', type: 'retail', status: 'active' }],
    branches: [{ id: BR, business_id: BZ, name: 'Main', is_main: true, status: 'active' }],
    users: [
      { id: USER, business_id: BZ, name: 'Pat', status: 'active', permissions_version: 1, role_id: ROLE, email: 'pat@shop.test', phone: '0722000111',
        roles: { name: 'Cashier', is_default: true }, user_branches: [{ branch_id: BR }], override_pin_hash: 'x' },
      { id: MGR, business_id: BZ, name: 'Joshua', status: 'active', permissions_version: 1, role_id: MGR_ROLE, email: 'joshua@shop.test', phone: '0733000222',
        roles: { name: 'Manager', is_default: true }, user_branches: [{ branch_id: BR }], override_pin_hash: 'y' },
    ],
    user_branches: [],
    roles: [{ id: ROLE, business_id: BZ, name: 'Cashier', is_default: true, role_permissions: [{ permissions: { key: 'orders.create' } }] },
      { id: MGR_ROLE, business_id: BZ, name: 'Manager', is_default: true, role_permissions: [{ permissions: { key: 'customers.view' } }] }],
    role_permissions: [],
    permissions: P.PERMISSIONS.map((p, i) => ({ id: `perm-${i}`, key: p.key })),
    user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null, terminal_code: 'T1' }],
    customers: [{ id: C1, business_id: BZ, name: 'Mary', phone: PHONE, email: EMAIL, credit_limit: 1000, credit_balance: 200, status: 'active', loyalty_points: 10 }],
    orders: [{ id: X, business_id: BZ, branch_id: BR, status: 'completed', cashier_id: USER, customer_phone: PHONE, customer_name: 'Mary', total: 100,
      payments: [{ method: 'mpesa', amount: 100, mpesa_phone: '254712345678' }], order_items: [] }],
    payments: [{ business_id: BZ, mpesa_checkout_id: 'ck-1', status: 'completed', amount: 100, mpesa_phone: '254712345678' }],
    change_requests: [{ id: CH_STAFF, business_id: BZ, entity: 'staff', status: 'awaiting', branch_id: BR },
      { id: CH_MENU, business_id: BZ, entity: 'product', status: 'awaiting', branch_id: BR }],
    business_settings: [], feature_flags: [], branch_settings: [],
  };
  db.user_branches = db.users.map((u) => ({ branch_id: BR, user_id: u.id, users: u }));
};
reset();
const orCalls = [];
let nextId = 1;
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null; let del = false;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (inserted) return inserted;
    if (del) { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return hit; }
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    return rows();
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => (k.includes('.') ? true : r[k] === v)); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'or') return (expr) => { orCalls.push({ table, expr }); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'delete') return () => { del = true; return q; };
      if (prop === 'insert' || prop === 'upsert') return (r) => {
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: x.id ?? `row-${nextId++}`, ...x }));
        (db[table] ??= []).push(...inserted); return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none', code: 'PGRST116' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null, count: run().length }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

// ── tokens: `parts: true` = made from A595 on (routes/auth.ts issueTokenPair) ──
const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', userId: USER, businessId: BZ, branchId: BR, isOwner: false, parts: true, ...p },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const holding = (keys, extra = {}) => sign({ permissionKeys: keys, ...extra });
const oldToken = (keys) => { const t = jwt.decode(holding(keys)); delete t.parts; delete t.iat; delete t.exp; return jwt.sign(t, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' }); };
const OWNER_T = sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'] });
const TILL_T = sign({ userId: null, till: true, deviceId: 'dev-T1', surface: 'desktop', permissionKeys: ['*'] });

const express = require('express');
const app = express(); app.use(express.json());
const mount = (p, mod, exp = 'default') => app.use(p, require(path.join(DIST, mod))[exp]);
for (const [p, m] of [
  ['/api/categories', 'categories'], ['/api/combos', 'combos'], ['/api/menus', 'menus'], ['/api/modifiers', 'modifiers'], ['/api/variants', 'variants'],
  ['/api/discounts', 'discounts'], ['/api/devices', 'devices'], ['/api/webhooks', 'webhooks'], ['/api/credit', 'credit'],
  ['/api/loyalty', 'loyalty'], ['/api/mpesa', 'mpesa'], ['/api/parking-sessions', 'parking'], ['/api/products', 'products'],
  ['/api/reports/monthly', 'reports-monthly'], ['/api/reports/export', 'reports-daily'], ['/api/staff', 'staff'], ['/api/branches', 'branches'],
  ['/api/business', 'business'], ['/api/changes', 'changes'], ['/api/orders', 'orders'], ['/api/expenses', 'expenses'], ['/api/stock', 'stock'],
  ['/api/stock-takes', 'stockTakes'], ['/api/payables', 'payables'], ['/api/inventory', 'inventory'], ['/api/analytics', 'analytics'], ['/api/pos', 'pos'],
]) mount(p, `routes/${m}.js`);
mount('/api/fuel-tanks', 'routes/fueltanks.js', 'fuelTanksRouter');
mount('/api/pumps', 'routes/fueltanks.js', 'pumpsRouter');
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const refusedFor = (r, key) => r.status === 403 && JSON.stringify(r.body ?? '').includes(`Missing permission: ${key}`);
const refused = (r) => r.status === 403 && /Missing permission/.test(JSON.stringify(r.body ?? ''));

const BC = require(path.join(DIST, 'lib/branchCredit.js'));
const CH = require(path.join(DIST, 'lib/creditHistory.js'));
const BR2 = id(), PARTNER = id();
const addPartnerUser = () => {
  db.branches.push({ id: BR2, business_id: BZ, name: 'Second', status: 'active' });
  db.users.push({ id: PARTNER, business_id: BZ, name: 'Pam', status: 'active', permissions_version: 1, role_id: ROLE, roles: { name: 'Cashier', is_default: true }, user_branches: [{ branch_id: BR }] });
};
const PARTNER_T = (keys = ['customers.view']) => sign({ userId: PARTNER, webPartner: true, partnerBranches: [BR], allBranches: false, permissionKeys: keys });
const MGR_T = (keys = ['customers.credit_limit', 'customers.view']) => sign({ userId: MGR, permissionKeys: keys });
const lim = (t, body) => call('PATCH', `/api/credit/customer/${C1}/limit`, t, body);
const setting = (key, value) => db.business_settings.push({ id: id(), business_id: BZ, key, value });

console.log('\nA595 — the owner\'s decisions of 2026-10-27 (D3, D4, D8, D1\'s KRA PIN)\n');

// ── D4 ────────────────────────────────────────────────────────────────────────
await ok('D4 rules (pure): the ceiling and the lock bind everyone but the owner; a branch limit is checked against what is owed THERE', () => {
  assert.equal(BC.limitRefusal({ owner: true, amount: 9e9, max: 100, locked: true }), null);
  assert.equal(BC.limitRefusal({ owner: false, amount: 101, max: 100, locked: false }).code, 'OVER_CREDIT_CEILING');
  assert.equal(BC.limitRefusal({ owner: false, amount: 100, max: 100, locked: false }), null);
  assert.equal(BC.limitRefusal({ owner: false, amount: 1, max: null, locked: true }).code, 'CREDIT_LIMIT_LOCKED');
  assert.equal(BC.creditAvailable({ limit: 1000, owedTotal: 300, branchLimit: 400, owedHere: 150 }), 250);
  assert.equal(BC.creditAvailable({ limit: 1000, owedTotal: 300, branchLimit: null, owedHere: 150 }), 700, 'no branch limit: today\'s rule');
  assert.equal(BC.branchCreditOn(undefined), true); assert.equal(BC.branchCreditOn('false'), false); assert.equal(BC.branchCreditOn(false), false);
  assert.equal(BC.readMaxLimit('5000'), 5000); assert.equal(BC.readMaxLimit(0), null);
});
await ok('D4.1 the ceiling: a limit-setter (key) is refused above the owner\'s maximum with a plain message; the owner is not', async () => {
  reset(); setting('credit_max_limit', 5000);
  const r = await lim(MGR_T(), { credit_limit: 6000 });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'OVER_CREDIT_CEILING'); assert.match(r.body.error, /owner/);
  assert.notEqual((await lim(MGR_T(), { credit_limit: 5000 })).status, 403);
  assert.notEqual((await lim(OWNER_T, { credit_limit: 9000 })).status, 403);
});
await ok('D4.2 the lock: the owner locks; then a limit-setter is refused; only the owner locks or unlocks', async () => {
  reset();
  assert.equal((await lim(MGR_T(), { credit_limit: 500, locked: true })).body?.code, 'OWNER_LOCKS');
  await lim(OWNER_T, { credit_limit: 800, locked: true });
  assert.equal(db.customers[0].credit_limit_locked, true); assert.ok(db.customers[0].credit_limit_locked_at);
  assert.equal((await lim(MGR_T(), { credit_limit: 900 })).body?.code, 'CREDIT_LIMIT_LOCKED');
  await lim(OWNER_T, { credit_limit: 800, locked: false });
  assert.notEqual((await lim(MGR_T(), { credit_limit: 900 })).status, 403, 'unlocked: settable again');
  assert.ok(db.audit_log.some((a) => a.action === 'customer.credit_limit.locked') && db.audit_log.some((a) => a.action === 'customer.credit_limit.unlocked'));
});
await ok('D4 settings: only the owner sets the maximum and the partners\' switch', async () => {
  reset(); addPartnerUser();
  assert.equal((await call('PUT', '/api/credit/settings', PARTNER_T(), { max_limit: 100 })).status, 403);
  assert.equal((await call('PUT', '/api/credit/settings', MGR_T(), { partners_decide: true })).status, 403);
  const r = await call('PUT', '/api/credit/settings', OWNER_T, { max_limit: 7000, partners_decide: true });
  assert.equal(r.status, 200); assert.equal(r.body.max_limit, 7000); assert.equal(r.body.partners_decide, true);
  const g = await call('GET', '/api/credit/settings', PARTNER_T());
  assert.equal(g.status, 200); assert.equal(g.body.max_limit, 7000);
});
await ok('D4.3 credit per branch: the owner switches a branch off; a manager may not; the switch is audited', async () => {
  reset();
  assert.equal((await call('PUT', `/api/credit/branches/${BR}`, MGR_T(['customers.credit', 'customers.credit_limit']), { enabled: false })).status, 403);
  assert.equal((await call('PUT', `/api/credit/branches/${BR}`, OWNER_T, { enabled: false })).status, 200);
  assert.equal(db.branch_settings.find((s) => s.key === 'credit_enabled').value, 'false');
  assert.ok(db.audit_log.some((a) => a.action === 'branch.credit.disabled' && a.branch_id === BR));
});
await ok('D4.4 partners: with the owner\'s switch off they decide nothing; on — their own branch only', async () => {
  reset(); addPartnerUser();
  assert.equal((await call('PUT', `/api/credit/branches/${BR}`, PARTNER_T(), { enabled: false })).body.code, 'PARTNERS_DO_NOT_DECIDE');
  setting('credit_partner_branches', true);
  assert.equal((await call('PUT', `/api/credit/branches/${BR}`, PARTNER_T(), { enabled: false })).status, 200);
  assert.equal((await call('PUT', `/api/credit/branches/${BR2}`, PARTNER_T(), { enabled: false })).body.code, 'NOT_YOUR_BRANCH');
  const bl = (branch, limit, t = PARTNER_T()) => call('PUT', `/api/credit/customer/${C1}/branch-limit`, t, { branch_id: branch, credit_limit: limit });
  assert.equal((await bl(BR, 300)).status, 200);
  assert.equal(db.customer_branch_credit_limits.length, 1); assert.equal(db.customer_branch_credit_limits[0].branch_id, BR);
  assert.equal((await bl(BR2, 300)).body.code, 'NOT_YOUR_BRANCH', 'never another branch');
  setting('credit_max_limit', 200);
  assert.equal((await bl(BR, 300)).body.code, 'OVER_CREDIT_CEILING', 'capped by the owner\'s maximum');
  db.customers[0].credit_limit_locked = true;
  assert.equal((await bl(BR, 100)).body.code, 'CREDIT_LIMIT_LOCKED', 'refused when the owner locked that customer');
  assert.equal((await bl(BR, 100, OWNER_T)).status, 200, 'the owner may');
  assert.ok(db.audit_log.some((a) => a.action === 'customer.branch_credit_limit.set' && a.branch_id === BR));
});
await ok('D4.5 the POS list carries whether the branch sells on account and each customer\'s limit and owed HERE', async () => {
  reset();
  db.branch_settings.push({ id: id(), business_id: BZ, branch_id: BR, key: 'credit_enabled', value: 'false' });
  db.customer_branch_credit_limits = [{ id: id(), business_id: BZ, customer_id: C1, branch_id: BR, credit_limit: 400 }];
  db.customer_credit_transactions = [{ business_id: BZ, customer_id: C1, branch_id: BR, amount: 150 }, { business_id: BZ, customer_id: C1, branch_id: id(), amount: 50 }];
  const r = await call('GET', '/api/pos/credit-customers', TILL_T);
  assert.equal(r.body.branch.credit_enabled, false);
  assert.deepEqual(r.body.branch.limits[C1], { limit: 400, owed: 150 });
});
await ok('D4.5 the customer profile: owed here / owed in total per branch, the branch limit, the lock; available at the caller\'s branch', async () => {
  reset();
  db.customer_branch_credit_limits = [{ id: id(), business_id: BZ, customer_id: C1, branch_id: BR, credit_limit: 400, set_by_name: 'Pam' }];
  db.customer_credit_transactions = [{ business_id: BZ, customer_id: C1, branch_id: BR, amount: 150, created_at: '2026-10-27T08:00:00Z' }];
  const r = await call('GET', `/api/credit/customer/${C1}`, holding(['customers.view']));
  const here = r.body.branches.find((b) => b.branch_id === BR);
  assert.equal(here.owed, 150); assert.equal(here.credit_limit, 400);
  assert.equal(r.body.customer.available_credit, 250); assert.equal(r.body.customer.owed_here, 150);
});
await ok('D4.6 the Credit history panel reads the lock and the branch limits (who, branch, old → new)', () => {
  const l = CH.limitChange({ action: 'customer.branch_credit_limit.set', before_data: { credit_limit: 100 }, after_data: { credit_limit: 300 }, branch_id: 'b1', user_name: 'Pam' }, () => 'Main');
  assert.deepEqual([l.scope, l.action, l.from, l.to, l.branch_name, l.by_name], ['branch', 'changed', 100, 300, 'Main', 'Pam']);
  assert.equal(CH.limitChange({ action: 'customer.credit_limit.locked', after_data: { credit_limit: 800 } }).action, 'locked');
  assert.ok(CH.LIMIT_ACTIONS.includes('customer.branch_credit_limit.set'));
});
await ok('D4 at a sale: the order route checks the branch switch and the branch limit (source)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/orders.ts'), 'utf8');
  assert.match(src, /const creditHere = await branchCreditEnabled\(req\.businessId!, branch_id \?\? null\);\n\s+if \(!creditHere && !ca\.tillSale\) \{ res\.status\(403\)\.json\(\{ \.\.\.CREDIT_OFF_HERE \}\); return; \}/);
  assert.match(src, /const available = creditAvailable\(\{ limit:/);
});

// ── D3 ────────────────────────────────────────────────────────────────────────
await ok('D3 report e-mails: the owner and a partner read and set who receives them; a manager by role does not (a person\'s own grant does)', async () => {
  reset(); addPartnerUser();
  assert.equal((await call('GET', '/api/business/settings/report-schedule', OWNER_T)).status, 200);
  assert.equal((await call('GET', '/api/business/settings/report-schedule', PARTNER_T([]))).status, 200);
  assert.equal((await call('GET', '/api/business/settings/report-schedule', MGR_T(['settings.integrations', 'settings.business']))).body.code, 'REPORT_EMAILS_OWNER');
  assert.equal((await call('GET', '/api/business/settings/report-schedule', MGR_T(['settings.report_emails']))).status, 200, 'given by the owner in Staff');
  const w = await call('POST', '/api/business/settings', PARTNER_T([]), { key: 'report_schedule', value: { enabled: true, recipients: ['books@x.test'] } });
  assert.notEqual(w.status, 403, JSON.stringify(w.body));
  assert.equal((await call('POST', '/api/business/settings', MGR_T(['settings.business']), { key: 'report_schedule', value: { enabled: true } })).status, 403);
});
await ok('D3 webhooks: the owner\'s (or a person given settings.webhooks); integrations alone no longer', async () => {
  reset();
  assert.equal((await call('GET', '/api/webhooks', MGR_T(['settings.integrations']))).status, 403);
  assert.notEqual((await call('GET', '/api/webhooks', OWNER_T)).status, 403);
});

// ── D8 ────────────────────────────────────────────────────────────────────────
await ok('D8 Overview alone answers today only; the Sales report holder gets the range asked (source)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/reports.ts'), 'utf8');
  assert.match(src, /const today = todayOnly\(req, 'reports\.sales'\);\n\s+const \{ start, end \} = getDateRange\(today \? undefined : from as string, today \? undefined : to as string/);
  assert.match(src, /const today = todayOnly\(req, 'reports\.items'\);/);
});

// ── D1: the KRA PIN ───────────────────────────────────────────────────────────
await ok('D1 KRA PIN: a letter, 9 digits, a letter — upper-cased, blank is none, anything else refused (400)', async () => {
  assert.deepEqual(PD.cleanKraPin(' a123456789z '), { ok: true, value: 'A123456789Z' });
  assert.deepEqual(PD.cleanKraPin(''), { ok: true, value: null });
  assert.equal(PD.cleanKraPin('A12345Z').ok, false);
  reset();
  const bad = await call('POST', '/api/loyalty/customer', holding(['customers.edit']), { name: 'Jo', phone: '0711222333', kra_pin: 'X1' });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'BAD_KRA_PIN');
  const good = await call('POST', '/api/loyalty/customer', holding(['customers.edit']), { name: 'Jo', phone: '0711222333', email: 'jo@x.test', kra_pin: 'a123456789z' });
  assert.equal(good.status, 201); assert.equal(db.customers.find((c) => c.name === 'Jo').kra_pin, 'A123456789Z');
});
await ok('D1 KRA PIN is personal and tax data: masked (A•••Z) without customers.contacts; a masked value is never written back', async () => {
  reset(); db.customers[0].kra_pin = 'A123456789Z';
  assert.equal((await call('GET', '/api/loyalty/customers', holding(['customers.view']))).body.customers[0].kra_pin, 'A•••Z');
  assert.equal((await call('GET', '/api/loyalty/customers', holding(['customers.view', 'customers.contacts']))).body.customers[0].kra_pin, 'A123456789Z');
  await call('PATCH', `/api/loyalty/customer/${C1}`, holding(['customers.edit', 'customers.contacts']), { kra_pin: 'A•••Z', name: 'Mary' });
  assert.equal(db.customers[0].kra_pin, 'A123456789Z');
  await call('PATCH', `/api/loyalty/customer/${C1}`, holding(['customers.edit', 'customers.contacts']), { kra_pin: 'b987654321c' });
  assert.equal(db.customers[0].kra_pin, 'B987654321C');
});

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
