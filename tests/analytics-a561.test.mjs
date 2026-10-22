/**
 * analytics-a561.test.mjs — A561: GET /api/analytics/stock, /customers and /costs, and what /recommendations adds (the
 * run-out, wastage, lapsed-regulars and cost cards, and the tiles' hooks), over HTTP. The COMPILED analytics router
 * behind the REAL requireAuth (the A549 / A553 / A558 harness); supabase.rpc answered by the REAL migration-158/160/161/162
 * functions in PGlite, on the A549 scenario plus seedA561 (scripts/lib/analytics-pg.mjs).
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/analytics-a561.test.mjs
 *
 *   - the flag off: 403 ANALYTICS_OFF, nothing run; before migration 162: the three routes 503 ANALYTICS_NOT_READY and
 *     /recommendations still 200 (its A561 parts left out);
 *   - stock: ONE aggregate call; days left at the branch in view; every branch with two: no level and the note; a
 *     manager held to their own branch; another business 404;
 *   - customers: new and returning, the regular gone quiet, the coverage note; without customers.view / customers.credit
 *     the SQL reads no customer (p_with_customers false) and no name is sent — the order-type mix stays;
 *   - costs: seesCosts only (403 COSTS_HIDDEN, nothing run); the items with no cost, the cost rise, the unsold count;
 *   - the cut-off moves the period; the cache: a repeat runs nothing, and /recommendations after the tabs runs no A561
 *     aggregate again; every list at most 10.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A561 report):
 *   - stockUse() passing p_branch: null always (on hand never known)        → "stock" fails
 *   - customers() with p_with_customers: true for everyone                  → "customers withheld" fails
 *   - /costs without the seesCosts check                                    → "costs withheld" fails
 *   - soft() rethrowing NotReady                                            → "before migration 162" fails
 *   - the customers cache key without with / mix                            → "customers withheld" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openSchema, seedAnalytics, seedA561 } from '../scripts/lib/analytics-pg.mjs';

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
const { invalidateDayCutoff } = require(path.join(DIST, 'lib/dayCutoff.js'));

const pg = await openSchema({ through: 162 });
const S = await seedAnalytics(pg);
const X = await seedA561(pg, S);
const id = () => randomUUID();
const OWNER = id(), OWNER_B = id(), MGR = S.MGR, MGR_K = id(), MGR_NC = id(), CASH = S.CATE;
const R_MGR = id(), R_MGR_NC = id(), R_CASH = id();
const KEYS = ['reports.sales', 'reports.costs', 'customers.view', 'orders.create'];
const PID = Object.fromEntries(KEYS.map((k) => [k, id()]));
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });

let db; let rpcs = [];
const reset = (flags = [], cutoff = null) => {
  invalidateDayCutoff(S.A);
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
    user_permissions: [], branch_settings: [],
    business_settings: cutoff === null ? [] : [{ id: id(), business_id: S.A, key: 'business_day_cutoff', value: cutoff }],
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

const STOCK = (q = '') => `/api/analytics/stock?${PERIOD}${q}`;
const CUST = (q = '') => `/api/analytics/customers?${PERIOD}${q}`;
const COSTS = (q = '') => `/api/analytics/costs?${PERIOD}${q}`;
const REC = (q = '') => `/api/analytics/recommendations?${PERIOD}${q}`;
const A561_FNS = ['analytics_stock_use', 'analytics_customers', 'analytics_cost_watch'];
const named = (list, name) => list.find((x) => x.name === name);

try {
  state._setPermissionsMigrated(true);
  console.log('\nA561 — stock, customers, costs over HTTP, the SQL in PGlite\n');

  await ok('the flag off: /stock, /customers and /costs 403 ANALYTICS_OFF, and nothing is run', async () => {
    reset([]);
    for (const u of [STOCK(), CUST(), COSTS()]) {
      const r = await call(u, T.owner);
      assert.deepEqual([r.status, r.body.code], [403, 'ANALYTICS_OFF']);
    }
    assert.equal(rpcs.length, 0);
  });

  await ok('stock: ONE aggregate call; days left at the branch in view; the soonest out and the most wasted, each at most 10', async () => {
    reset([S.A]);
    const r = await call(STOCK(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rpcs.length, 1);
    assert.deepEqual([rpcs[0].name, rpcs[0].args.p_branch, rpcs[0].args.p_prev_from], ['analytics_stock_use', S.W, X.PREV_START]);
    assert.equal(r.body.onHandKnown, true);
    const t = named(r.body.items, 'Tusker lager');
    assert.deepEqual([t.used, t.onHand, t.daysLeft, t.prevUsed], [208, 20, 2, 100]);
    assert.equal(r.body.runOut[0].name, 'Tusker lager', 'the soonest out first');
    assert.equal(r.body.wasted[0].name, 'Wing');
    assert.equal(r.body.wasted[0].wasteShare, 0.2);
    assert.ok(r.body.runOut.length <= 10 && r.body.wasted.length <= 10);
    assert.match(r.body.covers, /Not covered: items that do not track stock/);
    assert.ok(!JSON.stringify(r.body).match(/cost|margin|value/i), 'quantities only');
  });

  await ok('stock: every branch with two — no level, days left none and the note; one branch of the owner\'s; scope held', async () => {
    reset([S.A]);
    const all = await call(STOCK(), T.owner);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(rpcs[0].args.p_branch, null);
    assert.equal(all.body.onHandKnown, false);
    assert.equal(all.body.note, 'Pick a branch to see how many days your stock lasts — stock is counted per branch.');
    assert.equal(named(all.body.items, 'Tusker lager').used, 258, 'both branches: 208 + 50');
    assert.ok(all.body.items.every((x) => x.daysLeft === null));
    const k = await call(STOCK(`&branch=${S.K}`), T.owner);
    assert.deepEqual([named(k.body.items, 'Tusker lager').onHand, named(k.body.items, 'Tusker lager').used], [500, 50]);
    assert.equal((await call(STOCK(`&branch=${S.K}`), T.mgr)).status, 403);
    assert.equal((await call(STOCK(`&branch=${S.BB}`), T.owner)).status, 404);
  });

  await ok('customers: new and returning, the regular gone quiet, the coverage note; the top 10 by spend', async () => {
    reset([S.A]);
    const r = await call(CUST(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rpcs[0].args.p_with_customers, true);
    assert.deepEqual([r.body.now.customers, r.body.now.newCustomers, r.body.now.returning], [3, 2, 1]);
    assert.equal(r.body.top[0].name, 'Brian');
    assert.ok(r.body.top.length <= 10);
    assert.deepEqual(r.body.lapsed.map((c) => [c.name, c.gap, c.daysSince]), [['Wanjiku', 5, 28]]);
    assert.equal(r.body.coverage.low, true);
    assert.match(r.body.coverage.note, /^Only \d+(\.\d)?% of your sales are linked to a customer, so these trends cover your account and loyalty customers only\.$/);
    assert.ok(r.body.mixTotals.some((x) => x.key === 'takeaway') && r.body.mix.length === 21);
  });

  await ok('customers withheld: without customers.view / customers.credit no customer is read or sent — the mix stays', async () => {
    reset([S.A]);
    const r = await call(CUST(), T.mgrNoCosts);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rpcs[0].args.p_with_customers, false, 'the SQL reads no customer');
    assert.equal(r.body.customersHidden, true);
    assert.deepEqual([r.body.top, r.body.lapsed, r.body.totalCustomers], [[], [], 0]);
    assert.ok(!JSON.stringify(r.body).match(/Wanjiku|Brian|Acme/));
    assert.ok(r.body.mix.length === 21 && r.body.mixTotals.length > 0, 'the order-type mix is not about customers');
    // the same period for someone with the key next: its own answer, not the withheld one
    const mgr = await call(CUST(), T.mgr);
    assert.equal(mgr.body.customersHidden, false);
    assert.equal(mgr.body.top[0].name, 'Brian');
  });

  await ok('costs: seesCosts only (403 COSTS_HIDDEN, nothing run); the items with no cost, the cost rise, the unsold count', async () => {
    reset([S.A]);
    const hidden = await call(COSTS(), T.mgrNoCosts);
    assert.deepEqual([hidden.status, hidden.body.code], [403, 'COSTS_HIDDEN']);
    assert.equal(rpcs.length, 0);
    const r = await call(COSTS(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.noCost.items.map((x) => x.name), ['Soda']);
    assert.deepEqual([r.body.noCost.unsold, r.body.noCost.unsoldNames], [1, ['Ghost']]);
    assert.ok(r.body.noCost.share > 0 && r.body.noCost.share < 0.05);
    const oil = r.body.rises[0];
    assert.deepEqual([oil.name, oil.from, oil.to, oil.change, oil.extraMonth], ['Cooking oil', 0.4, 0.5, 0.25, 429]);
    assert.deepEqual(oil.products.map((p) => [p.name, p.delta, p.qty]), [['Chips masala', 10, 30]]);
    assert.equal(named(r.body.thin, 'Chips masala').topIngredient, 'Cooking oil');
    assert.ok(r.body.thin.length <= 10 && r.body.noCost.items.length <= 10);
    assert.ok(r.body.foodCost.now > 0 && r.body.foodCost.now < 1);
  });

  await ok('the recommendations add the run-out, wastage, regulars and cost-rise cards, and the tiles\' hooks; no price', async () => {
    reset([S.A]);
    const r = await call(REC(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const recs = r.body.recommendations;
    const out = recs.find((x) => x.kind === 'stock_out');
    assert.equal(out.title, 'Tusker lager runs out in about 2 days at your current rate — order now');
    assert.equal(out.why, 'You have 20 bottles left and use about 9.9 a day (208 in 21 days, 4 of it thrown away).');
    assert.deepEqual(out.stock.items[0], { name: 'Tusker lager', qty: 80, onHand: 20, order: 60 });
    assert.equal(recs[0].kind, 'stock_out', 'a stock-out risk ranks first');
    assert.equal(recs.find((x) => x.kind === 'lapsed').title, 'Wanjiku, a regular, has not been back in 28 days — call or message them');
    assert.match(recs.find((x) => x.kind === 'wastage').title, /^You throw away 20% of your Wing/);
    const rise = recs.find((x) => x.kind === 'cost_rise');
    assert.equal(rise.title, 'Compare suppliers for Cooking oil: its cost rose 25%');
    assert.match(rise.why, /from KES 0\.40 to KES 0\.50 a ml/);
    assert.equal(rise.impact, 429);
    assert.ok(recs.length <= 7);
    for (const x of recs) assert.ok(!/\bprices?\b|\brais(e|es|ing)\b|re-?pric/i.test(`${x.title} ${x.why} ${x.assumption}`), x.title);
    const h = r.body.hooks;
    assert.deepEqual([h.stock.text, h.stock.alert], ['1 item runs out this week', true]);
    assert.deepEqual([h.customers.text, h.customers.alert], ['1 regular gone quiet', true]);
    assert.equal(h.costs.text, '1 item has no cost');
    assert.equal(h.leaks.text, '1 cashier to check');
    assert.equal(h.credit.hidden, false);
  });

  await ok('the recommendations without costs or the customer keys: no cost card, no names, the tiles hidden', async () => {
    reset([S.A]);
    const r = await call(REC(), T.mgrNoCosts);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!rpcs.some((x) => x.name === 'analytics_cost_watch'));
    assert.equal(rpcs.find((x) => x.name === 'analytics_customers').args.p_with_customers, false);
    assert.ok(!r.body.recommendations.some((x) => ['lapsed', 'food_cost', 'thin_margin', 'cost_rise', 'cost'].includes(x.kind)));
    assert.ok(!JSON.stringify(r.body).match(/Wanjiku|margin/i));
    assert.deepEqual([r.body.hooks.costs.hidden, r.body.hooks.credit.hidden, r.body.hooks.customers.text], [true, true, 'Order types and average bill']);
  });

  await ok('the cut-off moves the period; the cache: a repeat runs nothing, /recommendations after the tabs runs no A561 aggregate', async () => {
    reset([S.A], 120);
    await call(CUST(), T.mgr);
    const a = rpcs.find((x) => x.name === 'analytics_customers').args;
    assert.deepEqual([a.p_cutoff, a.p_from], [120, '2026-09-30T23:00:00.000Z']);
    reset([S.A]);
    await call(STOCK(), T.mgr); await call(CUST(), T.mgr); await call(COSTS(), T.mgr);
    const n = rpcs.length;
    await call(STOCK(), T.mgr); await call(CUST(), T.mgr); await call(COSTS(), T.mgr);
    assert.equal(rpcs.length, n, 'kept 5 minutes');
    await call(REC(), T.mgr);
    assert.ok(!rpcs.slice(n).some((x) => A561_FNS.includes(x.name)), rpcs.slice(n).map((x) => x.name).join(','));
  });

  await ok('before migration 162 runs: the three routes 503 ANALYTICS_NOT_READY; /recommendations still answers', async () => {
    reset([S.A]);
    const real = supabase.rpc;
    supabase.rpc = async (name, args) => (A561_FNS.includes(name) ? { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } } : real(name, args));
    try {
      for (const u of [STOCK(), CUST(), COSTS()]) {
        const r = await call(u, T.mgr);
        assert.deepEqual([r.status, r.body.code], [503, 'ANALYTICS_NOT_READY'], u);
      }
      const rec = await call(REC(), T.mgr);
      assert.equal(rec.status, 200, JSON.stringify(rec.body));
      assert.ok(!rec.body.recommendations.some((x) => ['stock_out', 'lapsed', 'cost_rise', 'wastage'].includes(x.kind)));
      assert.equal(rec.body.hooks.stock.text, 'How fast stock goes');
    } finally { supabase.rpc = real; }
    assert.equal((await call(STOCK(), T.mgr)).status, 200, 'a failure is never kept');
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
