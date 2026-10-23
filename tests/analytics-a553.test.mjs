/**
 * analytics-a553.test.mjs — A553: Analytics v2's GET /api/analytics/overview over HTTP. The COMPILED analytics router
 * behind the REAL requireAuth (as tests/analytics-a549.test.mjs — the same harness); supabase.rpc answered by the REAL
 * migration-158 and -160 functions in PGlite, on the A549 scenario plus sales with payments and a previous period.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/analytics-a553.test.mjs
 *
 *   - the daily series: every day of the period, each beside the same day of the previous period (by position), the
 *     figures the SQL gives (completed sales, East Africa Time);
 *   - the previous period: the same length, ending the day before — ONE aggregate call covering both;
 *   - the KPIs: sales, orders, average bill, gross margin (points), money at risk; each change against the previous period;
 *   - the payment mix: the period's completed payments only, folded into cash / M-Pesa / card / on account / other;
 *   - costs (A490): without reports.costs no margin (and no menu aggregate run), and wastage is not in money at risk;
 *   - the branch: a manager held to their own; the owner all branches or one; the flag off: 403 ANALYTICS_OFF;
 *   - the cache: the same question twice runs nothing more.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A553 report):
 *   - previousPeriod ending ON `from` instead of the day before       → "the previous period" fails
 *   - buildOverview reading the mix of both periods (no day range)    → "the payment mix" fails
 *   - /overview passing costs: true always                            → "costs withheld" fails
 *   - /overview's daily() with p_branch: null                          → "a manager is held to their own branch" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openSchema, seedAnalytics } from '../scripts/lib/analytics-pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.message).split('\n').slice(0, 30).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/analytics.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const ROUTE = require(path.join(DIST, 'routes/analytics.js'));

const pg = await openSchema({ through: 160 });
const S = await seedAnalytics(pg);
// A553's additions (as scripts/test-migration-160.mjs): sales with payments in the period, and a previous period
const sale = async (o, pays = [], items = []) => {
  const row = await pg.put('orders', { business_id: S.A, branch_id: S.W, order_number: `D-${randomUUID().slice(0, 8)}`, status: 'completed', subtotal: o.total, discount_amount: 0, cashier_id: S.CATE, ...o });
  for (const [method, amount, status = 'completed'] of pays) await pg.put('payments', { order_id: row.id, business_id: row.business_id, branch_id: row.branch_id, method, amount, status });
  for (const [pid, name, qty, sub] of items) await pg.put('order_items', { order_id: row.id, product_id: pid, product_name: name, quantity: qty, unit_price: sub / qty, subtotal: sub });
};
await sale({ total: 1000, created_at: '2026-10-12T08:00:00Z' }, [['cash', 400], ['mpesa', 600], ['card', 1000, 'failed']]);
await sale({ total: 300, created_at: '2026-10-13T08:00:00Z' }, [['credit', 300]]);
await sale({ total: 200, created_at: '2026-10-13T09:00:00Z' }, [['glovo', 200]]);
await sale({ total: 700, branch_id: S.K, cashier_id: S.EVE, created_at: '2026-10-13T08:00:00Z' }, [['card', 700]]);
await sale({ total: 777, created_at: '2026-09-30T21:30:00Z' });   // 00:30 EAT on 1 October: this period
await sale({ total: 250, created_at: '2026-09-30T20:30:00Z' }, [['mpesa', 250]]);   // 23:30 EAT on 30 September: the previous one
await sale({ total: 1000, created_at: '2026-09-15T09:00:00Z' }, [], [[S.BURGER, 'Burger', 5, 1000]]);   // margin 500 on 1,000
const id = () => randomUUID();
const OWNER = id(), OWNER_B = id(), MGR = S.MGR, MGR_K = id(), MGR_NC = id(), CASH = S.CATE;
const R_MGR = id(), R_MGR_NC = id(), R_CASH = id();
const KEYS = ['reports.sales', 'reports.costs', 'customers.view', 'orders.create'];
const PID = Object.fromEntries(KEYS.map((k) => [k, id()]));
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });

let db; let rpcs = [];
const reset = (flags = []) => {
  db = {
    businesses: [{ id: S.A, owner_id: OWNER, name: 'Test Grill' }, { id: S.B, owner_id: OWNER_B, name: 'Other' }],
    branches: [{ id: S.W, business_id: S.A, name: 'Westlands', status: 'active' }, { id: S.K, business_id: S.A, name: 'Kilimani', status: 'active' },
      { id: S.BB, business_id: S.B, name: 'Theirs', status: 'active' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [{ id: R_MGR, business_id: S.A, name: 'Manager' }, { id: R_MGR_NC, business_id: S.A, name: 'Supervisor' }, { id: R_CASH, business_id: S.A, name: 'Cashier' }],
    role_permissions: [grant(R_MGR, 'reports.sales'), grant(R_MGR, 'reports.costs'), grant(R_MGR, 'customers.view'), grant(R_MGR_NC, 'reports.sales'), grant(R_CASH, 'orders.create')],
    users: [
      { id: OWNER, business_id: S.A, name: 'Olga', role_id: null, status: 'active', permissions_version: 1 },
      { id: OWNER_B, business_id: S.B, name: 'Bea', role_id: null, status: 'active', permissions_version: 1 },
      { id: MGR, business_id: S.A, name: 'Max', role_id: R_MGR, status: 'active', permissions_version: 1 },
      { id: MGR_K, business_id: S.A, name: 'Kim', role_id: R_MGR, status: 'active', permissions_version: 1 },
      { id: MGR_NC, business_id: S.A, name: 'Sue', role_id: R_MGR_NC, status: 'active', permissions_version: 1 },
      { id: CASH, business_id: S.A, name: 'Cate', role_id: R_CASH, status: 'active', permissions_version: 1 },
      ...[[S.DAN, 'Dan'], [S.VIC, 'Vic'], [S.EVE, 'Eve'], [S.FAY, 'Fay']].map(([uid, name]) => ({ id: uid, business_id: S.A, name, role_id: R_CASH, status: 'active', permissions_version: 1 })),
    ],
    user_branches: [{ user_id: MGR, branch_id: S.W }, { user_id: MGR_K, branch_id: S.K }, { user_id: MGR_NC, branch_id: S.W }, { user_id: CASH, branch_id: S.W }],
    user_permissions: [], business_settings: [], branch_settings: [],
    feature_flags: flags.map((business_id) => ({ id: id(), business_id, key: 'analytics', enabled: true })),
  };
  ROUTE._analyticsCache().clear();
  rpcs = [];
};
const view = (table, r) => {
  if (table === 'role_permissions' || table === 'user_permissions') return { ...r, permissions: db.permissions.find((p) => p.id === r.permission_id) ?? null };
  if (table === 'roles') return { ...r, role_permissions: db.role_permissions.filter((g) => g.role_id === r.id).map((g) => view('role_permissions', g)) };
  if (table === 'users') {
    const role = db.roles.find((x) => x.id === r.role_id);
    return { ...r, roles: role ? view('roles', role) : null,
      user_permissions: db.user_permissions.filter((u) => u.user_id === r.id).map((u) => view('user_permissions', u)),
      user_branches: db.user_branches.filter((b) => b.user_id === r.id) };
  }
  return r;
};
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => { if (inserted) return inserted; if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; } return rows().map((r) => view(table, r)); };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => (k.includes('.') ? true : r[k] === v)); return q; };
      if (prop === 'neq') return (k, v) => { f.push((r) => r[k] !== v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => (k.includes('.') ? true : a.includes(r[k]))); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'insert' || prop === 'upsert') return (r) => { inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: id(), ...x })); db[table].push(...inserted); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none', code: 'PGRST116' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null, count: run().length }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async (name, args) => { rpcs.push({ name, args }); return pg.rpc(name, args); };

const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', businessId: S.A, branchId: S.W, isOwner: false, ...p },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'] }),
  ownerB: sign({ userId: OWNER_B, isOwner: true, ownerLogin: true, businessId: S.B, branchId: null, permissionKeys: ['*'] }),
  mgr: sign({ userId: MGR, permissionKeys: ['reports.sales', 'reports.costs', 'customers.view'] }),
  mgrK: sign({ userId: MGR_K, branchId: S.K, permissionKeys: ['reports.sales', 'reports.costs', 'customers.view'] }),
  mgrNoCosts: sign({ userId: MGR_NC, permissionKeys: ['reports.sales'] }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create'] }),
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/analytics', ROUTE.default);
app.use('/api/flags', require(path.join(DIST, 'routes/flags.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (p, token, headers = {}, method = 'GET', body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const PERIOD = `from=${S.FROM}&to=${S.TO}`;
const OV = (q = '') => `/api/analytics/overview?${PERIOD}${q}`;

try {
  state._setPermissionsMigrated(true);
  console.log('\nA553 — Analytics v2 overview over HTTP, the SQL in PGlite\n');

  await ok('the flag off: /overview 403 ANALYTICS_OFF, and no aggregate is run', async () => {
    reset([]);
    const r = await call(OV(), T.owner);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ANALYTICS_OFF');
    assert.equal(rpcs.length, 0);
  });

  await ok('the previous period: the same 21 days ending the day before — one daily call covering both periods', async () => {
    reset([S.A]);
    const r = await call(OV(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.period.from, '2026-10-01');
    assert.deepEqual(r.body.previous, { from: '2026-09-10', to: '2026-09-30' });
    const d = rpcs.filter((x) => x.name === 'analytics_daily_sales');
    assert.equal(d.length, 1, 'one call for both periods');
    assert.equal(d[0].args.p_from, '2026-09-09T21:00:00.000Z', '10 September 00:00 EAT');
    assert.equal(d[0].args.p_to, S.END);
    assert.equal(d[0].args.p_branch, S.W);
  });

  await ok('the daily series: every day of the period, each beside the same day of the previous period', async () => {
    reset([S.A]);
    const { body } = await call(OV(), T.mgr);
    assert.equal(body.days.length, 21);
    const at = (day) => body.days.find((x) => x.day === day);
    assert.deepEqual([at('2026-10-19').revenue, at('2026-10-19').orders, at('2026-10-19').avgBill], [5350, 7, 764.29]);
    assert.equal(at('2026-10-19').prevDay, '2026-09-28');
    assert.deepEqual([at('2026-10-01').revenue, at('2026-10-01').prevDay], [777, '2026-09-10'], '00:30 EAT on 1 October is this period');
    assert.deepEqual([at('2026-10-06').prevDay, at('2026-10-06').prevRevenue], ['2026-09-15', 1000]);
    assert.deepEqual([at('2026-10-21').revenue, at('2026-10-21').prevDay, at('2026-10-21').prevRevenue], [500, '2026-09-30', 250]);
    assert.deepEqual([at('2026-10-02').revenue, at('2026-10-02').orders, at('2026-10-02').avgBill], [0, 0, null], 'a day without sales is there, at 0');
    assert.equal(at('2026-10-17').atRisk, 100 + 200 + 200, 'the day\'s discount, kitchen void and wastage');
  });

  await ok('the KPIs: sales, orders, average bill, margin (points) and money at risk, each against the previous period', async () => {
    reset([S.A]);
    const { body } = await call(OV(), T.mgr);
    const k = body.kpis;
    assert.deepEqual(k.revenue, { value: 12497, prev: 1250, change: 8.9976 });
    assert.deepEqual(k.orders, { value: 41, prev: 2, change: 19.5 });
    assert.deepEqual(k.avgBill, { value: 304.8, prev: 625, change: -0.5123 });
    assert.deepEqual(k.margin, { value: 0.5365, prev: 0.5, change: 0.0365 }, '2,790 on 5,200 of costed sales; 500 on 1,000 before');
    assert.deepEqual(k.atRisk, { value: 11449, prev: 0, change: null }, 'nothing at risk before: no change to show');
    assert.deepEqual(body.atRiskParts, { voids: 10899, refunds: 250, discounts: 100, wastage: 200 });
    assert.equal(body.marginHidden, false);
  });

  await ok('the payment mix: this period\'s completed payments only, folded into the five groups', async () => {
    reset([S.A]);
    const { body } = await call(OV(), T.mgr);
    const mix = Object.fromEntries(body.paymentMix.map((m) => [m.key, [m.amount, m.share]]));
    assert.deepEqual(mix, { cash: [400, 0.2667], mpesa: [600, 0.4], account: [300, 0.2], other: [200, 0.1333] },
      'not the failed card, not Kilimani\'s card, not the previous period\'s M-Pesa');
  });

  await ok('costs withheld (A490): no margin and no menu aggregate; wastage is not in money at risk', async () => {
    reset([S.A]);
    const { status, body } = await call(OV(), T.mgrNoCosts);
    assert.equal(status, 200);
    assert.equal(body.kpis.margin, null);
    assert.equal(body.marginHidden, true);
    assert.equal(body.wastageHidden, true);
    assert.equal(body.kpis.atRisk.value, 11249, 'the 200 of wastage (valued at cost) left out');
    assert.equal(body.atRiskParts.wastage, null);
    assert.equal(body.days.find((x) => x.day === '2026-10-17').atRisk, 300);
    assert.equal(rpcs.filter((x) => x.name === 'analytics_menu_engineering').length, 0, 'the menu (costs) is never worked out');
    assert.ok(!JSON.stringify(body).includes('"margin":{'), 'no margin object anywhere');
  });

  await ok('a manager is held to their own branch; the owner sees all branches or one of theirs', async () => {
    reset([S.A]);
    const other = await call(OV(`&branch=${S.K}`), T.mgr);
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'BRANCH_SCOPE');
    const k = await call(OV(), T.mgrK);
    assert.equal(k.body.branchId, S.K);
    assert.deepEqual([k.body.kpis.revenue.value, k.body.kpis.orders.value], [900, 2], 'Kilimani\'s 200 burger and 700 card sale');
    assert.deepEqual(k.body.paymentMix.map((m) => [m.key, m.amount]), [['card', 700]]);
    const all = await call(OV(), T.owner);
    assert.equal(all.body.branchId, null);
    assert.equal(all.body.kpis.revenue.value, 12497 + 900);
    const theirs = await call(OV(`&branch=${S.BB}`), T.owner);
    assert.equal(theirs.status, 404);
  });

  await ok('the range cap still holds (367 days: 400 RANGE_TOO_LONG)', async () => {
    reset([S.A]);
    const r = await call(`/api/analytics/overview?from=2025-10-01&to=2026-10-02`, T.owner);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'RANGE_TOO_LONG');
  });

  await ok('the cache: the same question twice runs nothing more; the tabs reuse this period\'s answers', async () => {
    reset([S.A]);
    await call(OV(), T.mgr);
    const n = ROUTE._analyticsCache().rpcCalls();
    await call(OV(), T.mgr);
    await call(`/api/analytics/money-leaks?${PERIOD}`, T.mgr);
    await call(`/api/analytics/menu-engineering?${PERIOD}`, T.mgr);
    assert.equal(ROUTE._analyticsCache().rpcCalls(), n);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
