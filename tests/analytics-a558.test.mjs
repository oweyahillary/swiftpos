/**
 * analytics-a558.test.mjs — A558 ("decisions made easy"): GET /api/analytics/item-times and /recommendations over HTTP.
 * The COMPILED analytics router behind the REAL requireAuth (the A549 / A553 harness); supabase.rpc answered by the REAL
 * migration-158/160/161 functions in PGlite, on the A549 scenario plus order lines on the edges that matter.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/analytics-a558.test.mjs
 *
 *   - the flag off: both 403 ANALYTICS_OFF, nothing run; before migration 161: 503 ANALYTICS_NOT_READY;
 *   - what sells when: ONE aggregate call; the dayparts at the EAT boundary (07:59Z Tuesday is morning, 08:00Z lunch);
 *   - the owner's cut-off: the range moves, and a Saturday 01:30 sale is Friday's late night;
 *   - the branch: a manager held to their own; the owner all branches or one; another business's branch 404;
 *   - the recommendations: ranked, each with its estimate and assumption, the summary, the value found; costs withheld
 *     (A490: no menu aggregate, no menu advice, no margin anywhere); no credit rule without customers.view;
 *   - the cache: after /overview and /item-times, /recommendations runs only what it alone needs; a repeat runs nothing.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A558 report):
 *   - /item-times without p_cutoff (0 always)                       → "the cut-off" fails
 *   - /recommendations working the menu out without costs too        → "costs withheld" fails
 *   - itemTimes() with p_branch: null                                 → "a manager is held to their own branch" fails
 *   - the item-times cache key without the period                     → "the cache" fails
 * A560 (what to stock; never a price rise; voids a warning):
 *   - stockLevels() reading every branch (no branch check)               → "A560: stock levels" fails
 *   - stockLevels() keeping a product sold through a recipe, or one not tracked → "A560: stock levels" fails
 *   - /item-times without `week`                                         → "A560: the week at a glance" fails
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
const { invalidateDayCutoff } = require(path.join(DIST, 'lib/dayCutoff.js'));

const pg = await openSchema({ through: 161 });
const S = await seedAnalytics(pg);
// A558's additions (as scripts/test-migration-161.mjs): order lines on the edges that matter
const PILAU = (await pg.put('products', { business_id: S.A, name: 'Pilau', base_price: 100, cost_price: 40 })).id;
const TUSKER = (await pg.put('products', { business_id: S.A, name: 'Tusker', base_price: 300, cost_price: 190 })).id;
const sale = async (o, items) => {
  const row = await pg.put('orders', { business_id: S.A, branch_id: S.W, order_number: `T-${randomUUID().slice(0, 8)}`, status: 'completed', subtotal: o.total ?? 0, discount_amount: 0, cashier_id: S.CATE, ...o });
  for (const [pid, name, qty, sub] of items) await pg.put('order_items', { order_id: row.id, product_id: pid, product_name: name, quantity: qty, unit_price: sub / qty, subtotal: sub });
};
await sale({ total: 300, created_at: '2026-10-13T07:59:00Z' }, [[PILAU, 'Pilau', 3, 300]]);           // Tue 10:59 EAT — morning
await sale({ total: 400, created_at: '2026-10-13T08:00:00Z' }, [[PILAU, 'Pilau', 4, 400]]);           // Tue 11:00 EAT — lunch
await sale({ total: 1800, created_at: '2026-10-16T22:30:00Z' }, [[TUSKER, 'Tusker', 6, 1800]]);       // Sat 01:30 EAT — Friday's night with a 02:00 cut-off
await sale({ total: 900, status: 'voided', created_at: '2026-10-13T08:00:00Z' }, [[PILAU, 'Pilau', 9, 900]]);
await sale({ total: 500, branch_id: S.K, cashier_id: S.EVE, created_at: '2026-10-13T08:00:00Z' }, [[PILAU, 'Pilau', 5, 500]]);
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

const IT = (q = '') => `/api/analytics/item-times?${PERIOD}${q}`;
const REC = (q = '') => `/api/analytics/recommendations?${PERIOD}${q}`;
const cellOf = (item, dow, hour) => item?.cells.find((c) => c[0] === dow && c[1] === hour);

try {
  state._setPermissionsMigrated(true);
  console.log('\nA558 — what sells when and the recommendations over HTTP, the SQL in PGlite\n');

  await ok('the flag off: /item-times and /recommendations 403 ANALYTICS_OFF, and no aggregate is run', async () => {
    reset([]);
    for (const u of [IT(), REC()]) {
      const r = await call(u, T.owner);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'ANALYTICS_OFF');
    }
    assert.equal(rpcs.length, 0);
  });

  await ok('what sells when: ONE aggregate call; the dayparts at the East Africa Time boundary', async () => {
    reset([S.A]);
    const r = await call(IT(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const calls = rpcs.filter((x) => x.name === 'analytics_item_times');
    assert.equal(rpcs.length, 1);
    assert.deepEqual([calls[0].args.p_branch, calls[0].args.p_from, calls[0].args.p_to, calls[0].args.p_cutoff, calls[0].args.p_limit], [S.W, S.START, S.END, 0, 100]);
    const pilau = r.body.items.find((i) => i.name === 'Pilau');
    assert.equal(pilau.qty, 7, 'not the voided 9, not Kilimani\'s 5');
    assert.deepEqual([pilau.dayparts.morning, pilau.dayparts.lunch], [3, 4], '10:59 is morning, 11:00 lunch');
    assert.deepEqual(cellOf(pilau, 1, 10), [1, 10, 3, 300], 'Tuesday (0 = Monday) 10:00');
    const morning = r.body.dayparts.find((d) => d.key === 'morning');
    assert.deepEqual(morning.top.map((x) => [x.name, x.share]), [['Pilau', 1]]);
    const afternoon = r.body.dayparts.find((d) => d.key === 'afternoon');
    assert.equal(afternoon.top[0].name, 'Chicken wings', 'Monday 12:00Z is 15:00 EAT — the afternoon');
    assert.deepEqual(r.body.hours.find((h) => h.hour === 15).top.map((x) => x.name), ['Chicken wings', 'Burger', 'Tea']);
    const tusker = r.body.items.find((i) => i.name === 'Tusker');
    assert.deepEqual([cellOf(tusker, 5, 1)?.[2], tusker.bestDaypart], [6, 'late'], 'Saturday 01:30 at midnight; late at night');
    assert.equal(r.body.timeZone, 'Africa/Nairobi');
    assert.ok(!JSON.stringify(r.body).match(/cost|margin/i), 'quantities and revenue only');
  });

  await ok('the cut-off: the period moves with it, and a Saturday 01:30 sale is Friday\'s late night', async () => {
    reset([S.A], 120);
    const r = await call(IT(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = rpcs.find((x) => x.name === 'analytics_item_times').args;
    assert.deepEqual([a.p_cutoff, a.p_from], [120, '2026-09-30T23:00:00.000Z'], '1 October 02:00 EAT');
    assert.equal(r.body.cutoff, 120);
    const tusker = r.body.items.find((i) => i.name === 'Tusker');
    assert.deepEqual(cellOf(tusker, 4, 1), [4, 1, 6, 1800], 'Friday (4), the clock hour 01');
    assert.equal(cellOf(tusker, 5, 1), undefined);
  });

  await ok('a manager is held to their own branch; the owner sees all branches or one of theirs', async () => {
    reset([S.A]);
    const other = await call(IT(`&branch=${S.K}`), T.mgr);
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'BRANCH_SCOPE');
    const k = await call(IT(), T.mgrK);
    assert.equal(k.body.branchId, S.K);
    assert.deepEqual(k.body.items.map((i) => [i.name, i.qty]), [['Pilau', 5], ['Burger', 1]]);
    const all = await call(IT(), T.owner);
    assert.equal(all.body.items.find((i) => i.name === 'Pilau').qty, 12);
    const one = await call(IT(`&branch=${S.K}`), T.owner);
    assert.equal(one.body.items.find((i) => i.name === 'Pilau').qty, 5);
    assert.equal((await call(IT(`&branch=${S.BB}`), T.owner)).status, 404);
    assert.equal((await call(REC(`&branch=${S.K}`), T.mgr)).status, 403);
  });

  await ok('the recommendations: ranked by the KES at stake, each with its estimate and assumption; the summary; the value found', async () => {
    reset([S.A]);
    const r = await call(REC(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const recs = r.body.recommendations;
    assert.ok(recs.length >= 1 && recs.length <= 7);
    const vic = recs.find((x) => x.kind === 'leak');
    assert.equal(vic.title, "Check Vic's voids", 'A560: a warning to look into');
    assert.equal(vic.evidence, 'leaks');
    assert.deepEqual([vic.impact, vic.impactPer, vic.warning], [null, null, true], 'no KES estimate');
    assert.ok(!recs.some((x) => x.kind === 'price'), 'A560: never a price rise');
    for (let i = 1; i < recs.length; i++) assert.ok((recs[i - 1].impact ?? -1) >= (recs[i].impact ?? -1), 'ranked by the estimate');
    assert.deepEqual(r.body.found.monthly, recs.filter((x) => x.impactPer === 'month' && !x.warning).reduce((s, x) => s + x.impact, 0));
    assert.equal(r.body.found.warnings, 1);
    assert.match(r.body.found.line, /^This period: \d+ things? to act on/);
    assert.match(r.body.summary.good, /^You sold KES 12,720 (from 1 Oct to 21 Oct|in the last 21 days)\.$/, 'nothing sold before: no change claimed (the wording follows the date it runs on)');
    assert.equal(r.body.costsHidden, false);
    assert.ok(!recs.some((x) => x.kind === 'credit'), 'KES 500 over 60 days is under the KES 1,000 floor');
  });

  await ok('costs withheld (A490): no menu aggregate, no menu advice, no margin anywhere', async () => {
    reset([S.A]);
    const r = await call(REC(), T.mgrNoCosts);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rpcs.filter((x) => x.name === 'analytics_menu_engineering').length, 0, 'the menu is never worked out');
    assert.equal(r.body.costsHidden, true);
    assert.ok(!r.body.recommendations.some((x) => ['price', 'promote', 'rework', 'cost'].includes(x.kind)));
    assert.ok(r.body.recommendations.some((x) => x.kind === 'leak'), 'the rest still comes');
    assert.ok(!JSON.stringify(r.body).match(/margin|after its cost|wastage/i), JSON.stringify(r.body).slice(0, 300));
    assert.equal(rpcs.filter((x) => x.name === 'analytics_credit_ageing').length, 0, 'no customers.view: no credit aggregate');
  });

  await ok('the cache: after /overview and /item-times, /recommendations runs only the heatmap and credit (and the three of A561); a repeat runs nothing', async () => {
    reset([S.A]);
    await call(`/api/analytics/overview?${PERIOD}`, T.mgr);
    await call(IT(), T.mgr);
    const before = rpcs.length;
    await call(REC(), T.mgr);
    // A561: plus its own three (stock use, customers, cost watch) and A575's what sells together — not in this schema
    // (through 161), so left out softly
    assert.deepEqual(rpcs.slice(before).map((x) => x.name).sort(), ['analytics_cost_watch', 'analytics_credit_ageing', 'analytics_customers', 'analytics_sales_heatmap', 'analytics_stock_use', 'analytics_together']);
    const n = ROUTE._analyticsCache().rpcCalls();
    await call(REC(), T.mgr);
    await call(IT(), T.mgr);
    assert.equal(ROUTE._analyticsCache().rpcCalls(), n);
    await call(`/api/analytics/item-times?from=2026-10-02&to=${S.TO}`, T.mgr);
    assert.equal(ROUTE._analyticsCache().rpcCalls(), n + 1, 'another period is its own question');
  });

  await ok('the range cap holds; before migration 161 runs: 503 ANALYTICS_NOT_READY (not a 500)', async () => {
    reset([S.A]);
    const long = await call(`/api/analytics/item-times?from=2025-10-01&to=2026-10-02`, T.owner);
    assert.deepEqual([long.status, long.body.code], [400, 'RANGE_TOO_LONG']);
    const real = supabase.rpc;
    supabase.rpc = async (name, args) => (name === 'analytics_item_times' ? { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } } : real(name, args));
    try {
      const r = await call(IT(), T.owner);
      assert.deepEqual([r.status, r.body.code], [503, 'ANALYTICS_NOT_READY']);
      const rec = await call(REC(), T.owner);
      assert.equal(rec.status, 503);
    } finally { supabase.rpc = real; }
    assert.equal((await call(IT(), T.owner)).status, 200, 'a failure is never kept');
  });
  // ── A560: what to stock ─────────────────────────────────────────────────────
  // Tusker sells 10 every day of the period at Westlands (20:00 EAT) and 40 on each Friday — Friday is its busy day.
  for (const d of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21']) {
    const fri = new Date(`2026-10-${d}T12:00:00Z`).getUTCDay() === 5;
    await sale({ total: (fri ? 40 : 10) * 300, created_at: `2026-10-${d}T17:00:00Z` }, [[TUSKER, 'Tusker', fri ? 40 : 10, (fri ? 40 : 10) * 300]]);
  }
  const stockDb = () => {
    db.products = [{ id: TUSKER, business_id: S.A, name: 'Tusker', track_stock: true }, { id: PILAU, business_id: S.A, name: 'Pilau', track_stock: true }];
    db.recipes = [{ id: id(), business_id: S.A, product_id: PILAU, ingredient_id: id(), quantity_per_serving: 1 }];
    db.stock_levels = [{ product_id: TUSKER, branch_id: S.W, quantity: '5.00' }, { product_id: PILAU, branch_id: S.W, quantity: '0.00' },
      { product_id: TUSKER, branch_id: S.K, quantity: '900.00' }];
  };

  await ok('A560: the week at a glance — each weekday\'s top 3 with its typical sales', async () => {
    reset([S.A]);
    const r = await call(IT(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.week.length, 7, '1–21 October holds every weekday');
    const fri = r.body.week.find((d) => d.day === 'Friday');
    assert.deepEqual([fri.count, fri.top[0].name, fri.top[0].qty], [3, 'Tusker', 40]);
    assert.ok(r.body.week.every((d) => d.top.length <= 3));
    assert.equal(r.body.weekdays.length, 7);
  });

  await ok('A560: stock levels — the branch in view, tracked items without a recipe; stock up for Friday; never a price', async () => {
    reset([S.A]); stockDb();
    const r = await call(REC(), T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const recs = r.body.recommendations;
    const low = recs.filter((x) => x.kind === 'stock_low');
    assert.equal(low.length, 1, JSON.stringify(recs.map((x) => x.title)));
    assert.match(low[0].title, /^Order about \d+ more Tusker/);
    assert.equal(low[0].stock.items[0].onHand, 5, 'the branch in view (Westlands 5), not Kilimani (900)');
    assert.equal(low[0].impactKind, 'at_risk');
    assert.ok(!recs.some((x) => x.kind === 'stock_low' && /Pilau/.test(x.title)), 'Pilau goes through a recipe: no level read for it');
    assert.equal(recs[0].kind, 'stock_low', 'a stock-out risk ranks first');
    const up = recs.find((x) => x.kind === 'stock_up');
    assert.equal(up.title, 'Stock up for Friday: 45 Tusker');
    assert.equal(up.why, 'Fridays: you sell about 40 Tusker (vs 15 on an average day).');
    assert.equal(recs[1].kind, 'stock_up');
    assert.equal(r.body.stockNote, null);
    assert.ok(r.body.found.line.includes('stock up for 1 busy day') && r.body.found.line.includes('1 item running low'), r.body.found.line);
    for (const x of recs) assert.ok(!/price|raise|re-price/i.test(`${x.title} ${x.why} ${x.assumption}`), x.title);
    // Tusker sold through a recipe: its stock is the ingredients', so no level is read and no running-low card comes
    reset([S.A]); stockDb();
    db.recipes.push({ id: id(), business_id: S.A, product_id: TUSKER, ingredient_id: id(), quantity_per_serving: 1 });
    const viaRecipe = await call(REC(), T.mgr);
    assert.ok(!viaRecipe.body.recommendations.some((x) => x.kind === 'stock_low'), 'a recipe item: no running-low card');
    // nor when the product does not track stock
    reset([S.A]); stockDb();
    db.products[0].track_stock = false;
    assert.ok(!(await call(REC(), T.mgr)).body.recommendations.some((x) => x.kind === 'stock_low'), 'track_stock off: no card');
  });

  await ok('A560: every branch in view with two branches — no stock level read, and the page is told why', async () => {
    reset([S.A]); stockDb();
    const r = await call(REC(), T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!r.body.recommendations.some((x) => x.kind === 'stock_low'));
    assert.equal(r.body.stockNote, 'Pick a branch to see what is running low — stock is counted per branch.');
    assert.ok(r.body.recommendations.some((x) => x.kind === 'stock_up'), 'stocking up needs no stock level');
    const one = await call(REC(`&branch=${S.K}`), T.owner);
    assert.ok(!one.body.recommendations.some((x) => x.kind === 'stock_low'), 'Kilimani holds 900 Tusker');
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
