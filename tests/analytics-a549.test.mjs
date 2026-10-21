/**
 * analytics-a549.test.mjs — A549: Analytics v1 (premium) over HTTP. The COMPILED analytics router behind the REAL
 * requireAuth (JWTs signed with a per-run secret); supabase.from answered from memory (sign-in, flags, branches, names)
 * and supabase.rpc answered by the REAL migration-158 functions in PGlite on the seeded scenario of
 * scripts/lib/analytics-pg.mjs — so the figures below are the SQL's, not a stub's.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/analytics-a549.test.mjs
 *
 *   - the 'analytics' flag off: every route 403 ANALYTICS_OFF, and no aggregate is run; the client cannot switch it on;
 *   - reports.sales needed; a manager is held to their own branch (another: 403 BRANCH_SCOPE); an owner naming another
 *     business's branch: 404; another business sees none of this one's figures;
 *   - the period: at most 366 days (400 RANGE_TOO_LONG), real dates only;
 *   - the maths on the seed: the matrix classes, the heatmap in East Africa Time, the void-rate flag, the ageing buckets;
 *   - costs (A490): a manager without reports.costs gets no costs, margins, classes or wastage value;
 *   - the cache: the same question twice runs the aggregate once.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A549 report):
 *   - context() without the analyticsEnabled check                → "the flag off" fails
 *   - the non-owner branch check removed (asked !== req.branchId)  → "a manager is held to their own branch" fails
 *   - the owner's branch lookup without .eq('business_id', …)      → "another business's branch is 404" fails
 *   - rangeError's MAX_RANGE_DAYS check removed                    → "the range cap" fails
 *   - cached() always loading                                      → "the cache" fails
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
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
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

const pg = await openSchema({ through: 158 });
const S = await seedAnalytics(pg);
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
const ROUTES = ['menu-engineering', 'heatmap', 'money-leaks', 'credit-ageing', 'insights'];

try {
  state._setPermissionsMigrated(true);
  console.log('\nA549 — Analytics v1 (premium) over HTTP, the SQL in PGlite\n');

  await ok('the flag off: every route 403 ANALYTICS_OFF (the THEMES_OFF shape), and no aggregate is run', async () => {
    reset([]);
    for (const r of ROUTES) {
      const res = await call(`/api/analytics/${r}?${PERIOD}`, T.owner);
      assert.equal(res.status, 403, r);
      assert.equal(res.body.code, 'ANALYTICS_OFF', r);
      assert.match(res.body.error, /ZapTill Premium/);
    }
    assert.equal(rpcs.length, 0);
    reset([S.B]);   // another business's flag does not open this one
    assert.equal((await call(`/api/analytics/insights?${PERIOD}`, T.owner)).body.code, 'ANALYTICS_OFF');
  });

  await ok('the client cannot switch it on: PUT /api/flags/analytics is set by ZapTill (403 ADMIN_ONLY_FEATURE), nothing written', async () => {
    reset([]);
    const r = await call('/api/flags/analytics', T.owner, {}, 'PUT', { enabled: true });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ADMIN_ONLY_FEATURE');
    assert.equal(db.feature_flags.length, 0);
  });

  await ok('reports.sales is needed (a cashier: 403); credit ageing also needs customers.view', async () => {
    reset([S.A]);
    const r = await call(`/api/analytics/insights?${PERIOD}`, T.cash);
    assert.equal(r.status, 403);
    assert.match(r.body.detail, /reports\.sales/);
    const c = await call(`/api/analytics/credit-ageing`, T.mgrNoCosts);
    assert.equal(c.status, 403);
    assert.match(c.body.detail, /customers\.view/);
  });

  await ok('a manager is held to their own branch: another branch 403 BRANCH_SCOPE; none named = theirs', async () => {
    reset([S.A]);
    const other = await call(`/api/analytics/heatmap?${PERIOD}&branch=${S.K}`, T.mgr);
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'BRANCH_SCOPE');
    const own = await call(`/api/analytics/heatmap?${PERIOD}`, T.mgr);
    assert.equal(own.status, 200);
    assert.equal(own.body.branchId, S.W);
    assert.equal(rpcs.at(-1).args.p_branch, S.W, 'the aggregate ran for Westlands only');
    const header = await call(`/api/analytics/heatmap?${PERIOD}`, T.mgr, { 'x-branch-id': S.K });
    assert.equal(header.body.branchId, S.W, 'the dashboard header does not move a manager');
    const k = await call(`/api/analytics/heatmap?${PERIOD}`, T.mgrK);
    assert.equal(k.body.branchId, S.K);
    assert.equal(k.body.totalOrders, 1, 'Kilimani\'s one sale only');
  });

  await ok('the owner: all branches or one of theirs; another business\'s branch is 404; another business sees none of this one', async () => {
    reset([S.A, S.B]);
    const all = await call(`/api/analytics/heatmap?${PERIOD}`, T.owner);
    assert.equal(all.body.branchId, null);
    const viaHeader = await call(`/api/analytics/heatmap?${PERIOD}`, T.owner, { 'x-branch-id': S.K });
    assert.equal(viaHeader.body.branchId, S.K, 'the dashboard\'s branch selection');
    const allExplicit = await call(`/api/analytics/heatmap?${PERIOD}&branch=`, T.owner, { 'x-branch-id': S.K });
    assert.equal(allExplicit.body.branchId, null, 'branch= (empty) is all branches, whatever the header');
    const theirs = await call(`/api/analytics/heatmap?${PERIOD}&branch=${S.BB}`, T.owner);
    assert.equal(theirs.status, 404);
    assert.equal((await call(`/api/analytics/heatmap?${PERIOD}&branch=not-a-uuid`, T.owner)).status, 404);
    const b = await call(`/api/analytics/credit-ageing`, T.ownerB);
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.customers.map((c) => c.name), ['Theirs']);
    const bh = await call(`/api/analytics/heatmap?${PERIOD}`, T.ownerB);
    assert.equal(bh.body.totalOrders, 1, 'business B\'s one sale, none of A\'s');
    const bw = await call(`/api/analytics/heatmap?${PERIOD}&branch=${S.W}`, T.ownerB);
    assert.equal(bw.status, 404, 'B\'s owner naming A\'s branch');
  });

  await ok('the range cap: 366 days is fine, 367 is 400 RANGE_TOO_LONG; not a date / backwards is 400', async () => {
    reset([S.A]);
    assert.equal((await call(`/api/analytics/heatmap?from=2025-10-21&to=2026-10-21`, T.owner)).status, 200, '366 days (2026 is not a leap year)');
    const long = await call(`/api/analytics/heatmap?from=2025-10-20&to=2026-10-21`, T.owner);
    assert.equal(long.status, 400);
    assert.equal(long.body.code, 'RANGE_TOO_LONG');
    assert.equal((await call(`/api/analytics/heatmap?from=2026-02-30&to=2026-03-01`, T.owner)).body.code, 'BAD_RANGE');
    assert.equal((await call(`/api/analytics/heatmap?from=2026-10-21&to=2026-10-01`, T.owner)).body.code, 'BAD_RANGE');
    const def = await call(`/api/analytics/heatmap`, T.owner);
    assert.equal(def.status, 200);
    assert.equal((Date.parse(def.body.period.to) - Date.parse(def.body.period.from)) / 86_400_000 + 1, 30, 'the last 30 days by default');
  });

  await ok('menu engineering on the seed: Star, Plowhorse, Puzzle, Dog, no cost — 1/N × 0.7 and the quantity-weighted margin', async () => {
    reset([S.A]);
    const r = await call(`/api/analytics/menu-engineering?${PERIOD}&branch=${S.W}`, T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = r.body;
    const cls = Object.fromEntries(m.items.map((i) => [i.name, i.class]));
    assert.deepEqual(cls, { 'Chicken wings': 'plowhorse', Burger: 'star', Tea: 'plowhorse', Soda: 'no_cost', 'Family combo': 'puzzle', Chips: 'puzzle', Salad: 'dog' });
    assert.equal(m.popularityThreshold, 0.1, '0.7 / 7 items');
    assert.equal(m.avgUnitMargin, 73.42, '(20×60 + 8×100 + 2×220 + 2×120 + 5×20 + 1×10) / 38');
    const wings = m.items.find((i) => i.name === 'Chicken wings');
    assert.deepEqual([wings.qty, wings.unitCost, wings.unitMargin, wings.totalMargin, wings.rank], [20, 40, 60, 1200, 1]);
    assert.equal(m.costsHidden, false);
  });

  await ok('the heatmap on the seed: Tue 22:30Z lands on Wednesday 01:00 (East Africa Time); the busiest slot is Monday afternoon', async () => {
    reset([S.A]);
    const h = (await call(`/api/analytics/heatmap?${PERIOD}`, T.owner)).body;
    assert.equal(h.timeZone, 'Africa/Nairobi');
    assert.equal(h.revenue[2][1], 500, 'Wednesday (index 2) 01:00');
    assert.equal(h.revenue[1][22], 0, 'not Tuesday 22:00');
    assert.equal(h.busiest.dow, 0);
    assert.ok(h.busiest.startHour <= 15 && h.busiest.endHour > 15, JSON.stringify(h.busiest));
    assert.ok(h.quietest && h.quietest.label !== h.busiest.label);
  });

  await ok('money leaks on the seed: Vic flagged (6 voids of 12, 5× the median); Dan above 2× but under 5 events — not flagged', async () => {
    reset([S.A]);
    const l = (await call(`/api/analytics/money-leaks?${PERIOD}&branch=${S.W}`, T.owner)).body;
    const c = Object.fromEntries(l.cashiers.map((x) => [x.name, x]));
    assert.equal(l.medians.voidRate, 0.1);
    assert.deepEqual(c.Vic.flags.map((f) => [f.kind, f.multiple, f.events]), [['void', 5, 6]]);
    assert.equal(c.Dan.voidRate, 0.2);
    assert.deepEqual(c.Dan.flags, [], 'one void is not a pattern');
    assert.equal(l.cashiers[0].name, 'Vic', 'flagged first');
    assert.equal(c.Max.wastageValue, 200);
    assert.equal(l.days.find((d) => d.day === '2026-10-17').dayCloseVariance, -450);
    assert.equal(l.totals.dayCloseShort, -450);
  });

  await ok('credit ageing on the seed: FIFO buckets, older than the ledger = 90+, disputed; a manager sees their branch\'s part', async () => {
    reset([S.A]);
    const c = (await call(`/api/analytics/credit-ageing`, T.owner)).body;
    assert.deepEqual([c.totals.d0_30, c.totals.d31_60, c.totals.d61_90, c.totals.d90_plus, c.totals.owed], [900, 300, 0, 500, 1700]);
    assert.deepEqual(c.over60, { amount: 500, customers: 2 });
    assert.deepEqual([c.totals.disputedCount, c.totals.disputedAmount], [1, 350]);
    const w = (await call(`/api/analytics/credit-ageing`, T.mgr)).body;
    assert.deepEqual([w.totals.d0_30, w.totals.d31_60, w.totals.d90_plus], [600, 300, 100], 'Westlands debits only');
  });

  await ok('insights on the seed: sorted high → low, with the sentences the rules promise', async () => {
    reset([S.A]);
    const r = await call(`/api/analytics/insights?${PERIOD}&branch=${S.W}`, T.owner);
    assert.equal(r.status, 200);
    const texts = r.body.insights.map((i) => i.text);
    const sev = r.body.insights.map((i) => i.severity);
    assert.deepEqual(sev, [...sev].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)));
    assert.ok(texts.includes('Cashier Vic voided 5.0× the branch median this period (6 voids)'), texts.join('\n'));
    assert.ok(texts.includes('Chicken wings is a Plowhorse: top 3 seller but margin KES 13 below average – consider a small price rise'), texts.join('\n'));
    assert.ok(texts.some((t) => /^KES 100 is over 60 days old on credit \(1 customer\)$/.test(t)), texts.join('\n'));
    assert.ok(texts.some((t) => /is your quietest slot$/.test(t)));
    for (const i of r.body.insights) assert.ok(['menu', 'timing', 'leaks', 'credit'].includes(i.type) && ['high', 'medium', 'low'].includes(i.severity));
  });

  await ok('costs (A490): without reports.costs — no costs, margins or classes; no wastage value; no margin insights', async () => {
    reset([S.A]);
    const m = (await call(`/api/analytics/menu-engineering?${PERIOD}`, T.mgrNoCosts)).body;
    assert.equal(m.costsHidden, true);
    assert.ok(m.items.every((i) => i.unitCost === null && i.unitMargin === null && i.totalMargin === null && i.class === null));
    assert.equal(m.avgUnitMargin, null);
    const l = (await call(`/api/analytics/money-leaks?${PERIOD}`, T.mgrNoCosts)).body;
    assert.equal(l.wastageHidden, true);
    assert.ok(l.cashiers.every((c) => c.wastageValue === null));
    const ins = (await call(`/api/analytics/insights?${PERIOD}`, T.mgrNoCosts)).body.insights;
    assert.ok(!ins.some((i) => /Plowhorse|Puzzle|Dog|Star|Wastage|no cost/.test(i.text)), ins.map((i) => i.text).join('\n'));
    assert.ok(!ins.some((i) => i.type === 'credit'), 'no customers.view — no credit insight');
  });

  await ok('the cache: the same question twice runs the aggregate once; another branch or period runs again', async () => {
    reset([S.A]);
    await call(`/api/analytics/heatmap?${PERIOD}`, T.owner);
    await call(`/api/analytics/heatmap?${PERIOD}`, T.owner);
    assert.equal(rpcs.filter((x) => x.name === 'analytics_sales_heatmap').length, 1);
    await call(`/api/analytics/heatmap?${PERIOD}&branch=${S.W}`, T.owner);
    await call(`/api/analytics/heatmap?from=2026-10-02&to=${S.TO}`, T.owner);
    assert.equal(rpcs.filter((x) => x.name === 'analytics_sales_heatmap').length, 3);
    rpcs = [];
    await call(`/api/analytics/insights?${PERIOD}`, T.owner);   // menu + leaks + credit (the heatmap is kept)
    assert.deepEqual(rpcs.map((x) => x.name).sort(), ['analytics_credit_ageing', 'analytics_menu_engineering', 'analytics_money_leaks']);
    rpcs = [];
    for (const r of ['menu-engineering', 'heatmap', 'money-leaks', 'credit-ageing']) await call(`/api/analytics/${r}?${PERIOD}`, T.owner);
    assert.equal(rpcs.length, 0, 'every tab answered from what insights kept');
    assert.equal(ROUTE.CACHE_TTL_MS, 5 * 60_000);
  });

  await ok('before migration 158 runs: 503 ANALYTICS_NOT_READY (not a 500)', async () => {
    reset([S.A]);
    const real = supabase.rpc;
    supabase.rpc = async () => ({ data: null, error: { message: 'Could not find the function', code: 'PGRST202' } });
    try {
      const r = await call(`/api/analytics/heatmap?${PERIOD}`, T.owner);
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'ANALYTICS_NOT_READY');
      supabase.rpc = real;
      assert.equal((await call(`/api/analytics/heatmap?${PERIOD}`, T.owner)).status, 200, 'a failure is never kept');
    } finally { supabase.rpc = real; }
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
