/**
 * analytics-a565.test.mjs — A565: GET /api/analytics/branches and what /recommendations adds (the stock moves to consider
 * and the falling-branch card, the Branches tile), over HTTP. The COMPILED analytics router behind the REAL requireAuth
 * (the A549 / A558 / A561 harness); supabase.rpc answered by the REAL migration-158/160/161/162 functions in PGlite, on
 * the A549 + A561 scenario plus a few A565 rows:
 *   Tusker lager — Westlands sells about 10 a day and has 20 left; Kilimani sold 50 in 21 days and holds 500;
 *   Mandazi — Westlands sold 30 and has 2 left; Kilimani never sold it and holds 100 (only a plain level read sees it);
 *   Kilimani rang 40 bills in September and 1 in October (it falls; Westlands grew).
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/analytics-a565.test.mjs
 *
 *   - the flag off; the scope: a manager and a partner of one branch 403 BRANCH_SCOPE (nothing run) and get no branch
 *     card, no other branch's aggregate and a hidden tile; the owner and a partner of every branch see it;
 *   - /branches: the comparison (Kilimani flagged, in words), the move Kilimani → Westlands naming both items — no
 *     quantity, no score, no stock count in the answer; the margin only with costs;
 *   - /recommendations: the move card with the stock-out risks, the falling-branch card, the tile's hook, the value line;
 *     with Westlands in view the move replaces Westlands' run-out card for Tusker lager;
 *   - one active branch: nothing; before 162: the comparison stands, no moves; the cache: a repeat runs nothing, and the
 *     per-branch answers are shared with that branch's own view.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A565 report):
 *   - /branches without the allBranchAccess check                       → "scope" fails
 *   - /recommendations calling branchWork for every viewer              → "scope" fails
 *   - forPage not dropping the internal score                           → "recommendations" fails
 *   - branchLevels never reading (the plain level read skipped)         → "branches" fails (no Mandazi)
 *   - activeBranches keeping an inactive branch                         → "one active branch" fails
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
// ── A565 rows ──
const MANDAZI = (await pg.put('products', { business_id: S.A, name: 'Mandazi', base_price: 20, cost_price: 8, track_stock: true })).id;
for (const [n, at] of [[-10, '2026-10-04T10:00:00Z'], [-10, '2026-10-11T10:00:00Z'], [-10, '2026-10-18T10:00:00Z']]) {
  await pg.put('stock_movements', { product_id: MANDAZI, branch_id: S.W, movement_type: 'sale', quantity_change: n, quantity_after: 0, created_at: at, notes: 'Order X', reference_type: 'order' });
}
await pg.put('stock_levels', { product_id: MANDAZI, branch_id: S.W, quantity: 2, qty_pieces: 0 });
await pg.put('stock_levels', { product_id: MANDAZI, branch_id: S.K, quantity: 100, qty_pieces: 0 });
for (let i = 0; i < 40; i++) {
  await pg.put('orders', { business_id: S.A, branch_id: S.K, order_number: `K-${i}`, status: 'completed', subtotal: 100, total: 100, discount_amount: 0, created_at: `2026-09-${String(10 + (i % 20)).padStart(2, '0')}T09:00:00Z`, cashier_id: S.EVE });
}

const id = () => randomUUID();
const OWNER = id(), OWNER_B = id(), MGR = S.MGR, PART_ALL = id(), PART_W = id();
const R_MGR = id();
const KEYS = ['reports.sales', 'reports.costs', 'customers.view'];
const PID = Object.fromEntries(KEYS.map((k) => [k, id()]));
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });

let db; let rpcs = [];
const reset = (flags = [], kStatus = 'active') => {
  invalidateDayCutoff(S.A);
  db = {
    businesses: [{ id: S.A, owner_id: OWNER, name: 'Test Grill' }, { id: S.B, owner_id: OWNER_B, name: 'Other' }],
    branches: [{ id: S.W, business_id: S.A, name: 'Westlands', status: 'active' }, { id: S.K, business_id: S.A, name: 'Kilimani', status: kStatus },
      { id: S.BB, business_id: S.B, name: 'Theirs', status: 'active' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [{ id: R_MGR, business_id: S.A, name: 'Manager' }],
    role_permissions: KEYS.map((k) => grant(R_MGR, k)),
    users: [
      { id: OWNER, business_id: S.A, name: 'Olga', role_id: null, status: 'active', permissions_version: 1 },
      { id: OWNER_B, business_id: S.B, name: 'Bea', role_id: null, status: 'active', permissions_version: 1 },
      { id: MGR, business_id: S.A, name: 'Max', role_id: R_MGR, status: 'active', permissions_version: 1 },
      { id: PART_ALL, business_id: S.A, name: 'Pat', role_id: R_MGR, status: 'active', permissions_version: 1 },
      { id: PART_W, business_id: S.A, name: 'Wes', role_id: R_MGR, status: 'active', permissions_version: 1 },
    ],
    user_branches: [{ user_id: MGR, branch_id: S.W }, { user_id: PART_ALL, branch_id: S.W }, { user_id: PART_ALL, branch_id: S.K }, { user_id: PART_W, branch_id: S.W }],
    user_permissions: [], branch_settings: [], business_settings: [],
    feature_flags: flags.map((business_id) => ({ id: id(), business_id, key: 'analytics', enabled: true })),
    // the plain reads go to PGlite's own tables (the levels)
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
const PG_TABLES = new Set(['stock_levels', 'ingredient_stock_levels', 'products', 'recipes']);
let reads = [];
supabase.from = (table) => {
  const f = []; const sql = [];
  const pgRows = async () => {
    const all = await pg.q(`SELECT * FROM public.${table}`);
    return all.filter((r) => sql.every((fn) => fn(r))).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && k !== 'name' ? Number(v) : v])));
  };
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => (k.includes('.') ? true : r[k] === v)); sql.push((r) => r[k] === v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => (k.includes('.') ? true : a.includes(r[k]))); sql.push((r) => a.includes(r[k])); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: rows().map((r) => view(table, r))[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = rows()[0]; return Promise.resolve(r ? { data: view(table, r), error: null } : { data: null, error: { message: 'none', code: 'PGRST116' } }); };
      if (prop === 'then') {
        if (PG_TABLES.has(table)) { reads.push(table); return (res, rej) => pgRows().then((data) => ({ data, error: null })).then(res, rej); }
        return (res, rej) => Promise.resolve({ data: rows().map((r) => view(table, r)), error: null }).then(res, rej);
      }
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
  mgr: sign({ userId: MGR, permissionKeys: KEYS }),
  partAll: sign({ userId: PART_ALL, branchId: null, webPartner: true, allBranches: true, partnerBranches: [S.W, S.K], permissionKeys: ['reports.sales', 'customers.view'] }),
  partW: sign({ userId: PART_W, branchId: S.W, webPartner: true, allBranches: false, partnerBranches: [S.W], permissionKeys: KEYS }),
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/analytics', ROUTE.default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (p, token) => {
  const r = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const PERIOD = `from=${S.FROM}&to=${S.TO}`;
const BR = (q = '') => `/api/analytics/branches?${PERIOD}${q}`;
const REC = (q = '') => `/api/analytics/recommendations?${PERIOD}${q}`;
const numbersOutsideRate = (t) => t.replace(/about \d+ a day/g, '').match(/\d|KES/g);
const ofK = () => rpcs.filter((x) => x.args.p_branch === S.K);

try {
  state._setPermissionsMigrated(true);
  console.log('\nA565 — between branches over HTTP, the SQL in PGlite\n');

  await ok('the flag off: /branches 403 ANALYTICS_OFF, nothing run', async () => {
    reset([]);
    const r = await call(BR(), T.owner);
    assert.deepEqual([r.status, r.body.code], [403, 'ANALYTICS_OFF']);
    assert.equal(rpcs.length, 0);
  });

  await ok('scope: a manager and a partner of one branch 403 and get no branch card, no other branch read, the tile hidden', async () => {
    reset([S.A]);
    for (const t of [T.mgr, T.partW]) {
      const r = await call(BR(), t);
      assert.deepEqual([r.status, r.body.code], [403, 'BRANCH_SCOPE']);
    }
    assert.equal(rpcs.length, 0, 'nothing run');
    for (const t of [T.mgr, T.partW]) {
      const rec = await call(REC(), t);
      assert.equal(rec.status, 200, JSON.stringify(rec.body));
      assert.ok(!rec.body.recommendations.some((x) => ['stock_move', 'branch_drop'].includes(x.kind)));
      assert.equal(rec.body.hooks.branches.hidden, true);
    }
    assert.deepEqual(ofK(), [], 'Kilimani is never read for someone held to Westlands');
    const p = await call(BR(), T.partAll);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.available, true);
    assert.equal(p.body.compare.marginHidden, true, 'a partner without reports.costs: no margin');
  });

  await ok('branches: the comparison in words and numbers; the move Kilimani → Westlands naming both items, no quantity', async () => {
    reset([S.A]);
    const r = await call(BR(), T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body.compare;
    assert.deepEqual(c.rows.map((x) => x.name), ['Westlands', 'Kilimani']);
    const k = c.rows.find((x) => x.name === 'Kilimani');
    assert.deepEqual([k.flagged, k.prevOrders, k.orders, k.sales], [true, 40, 1, 200]);
    assert.equal(k.reason, 'Sales fell 95% against the previous 21 days, while the other branches together sold 461% more.');
    assert.equal(c.marginHidden, false);
    assert.ok(typeof c.rows[0].margin === 'number', 'the owner sees the margin');
    assert.equal(r.body.moves.length, 1);
    const m = r.body.moves[0];
    assert.deepEqual([m.move.from, m.move.to, m.move.items.map((x) => x.name)], ['Kilimani', 'Westlands', ['Tusker lager', 'Mandazi']]);
    assert.equal(m.title, 'Consider moving some stock from Kilimani to Westlands');
    assert.equal(m.why, 'Tusker lager and Mandazi are moving slowly at Kilimani but sell fast at Westlands, where they are running low — consider moving some across.');
    assert.equal(numbersOutsideRate(`${m.title} ${m.why}`), null);
    assert.ok(!JSON.stringify(r.body.moves).match(/"qty"|quantity|"score"|onHand|cover/), 'no quantity sent');
    assert.ok(reads.includes('stock_levels'), 'Mandazi at Kilimani comes from a plain level read');
    assert.equal(rpcs.filter((x) => x.name === 'analytics_stock_use').length, 2, 'one stock call per branch');
    assert.ok(rpcs.filter((x) => x.name === 'analytics_stock_use').every((x) => x.args.p_branch), 'each at its own branch');
  });

  await ok('recommendations: the move card with the stock-out risks, the falling-branch card, the hook, the value line', async () => {
    reset([S.A]);
    const r = await call(REC(), T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const recs = r.body.recommendations;
    const mv = recs.find((x) => x.kind === 'stock_move');
    assert.ok(mv, recs.map((x) => x.kind).join(','));
    assert.equal(recs[0].kind, 'stock_move', 'with every branch in view no run-out card exists; the move ranks first');
    assert.deepEqual([mv.impact, mv.impactKind, mv.evidence, mv.move.toId], [null, null, 'branches', S.W]);
    assert.ok(!JSON.stringify(r.body).includes('"score"'), 'the internal score stays in the cloud');
    const drop = recs.find((x) => x.kind === 'branch_drop');
    assert.equal(drop.title, 'Sales at Kilimani fell 95% against the previous 21 days');
    assert.match(drop.why, /Its stock is moving slowly — some of it may sell faster at Westlands\./);
    assert.equal(drop.branchId, S.K);
    assert.deepEqual([r.body.hooks.branches.hidden, r.body.hooks.branches.text, r.body.hooks.branches.alert], [false, '1 stock move to consider', true]);
    assert.equal(r.body.found.moves, 1);
    assert.match(r.body.found.line, /1 stock move between branches to consider/);
    for (const x of recs) assert.ok(!/\bprices?\b|\brais(e|es|ing)\b|re-?pric/i.test(`${x.title} ${x.why} ${x.assumption}`), x.title);
  });

  await ok('Westlands in view: the move replaces its run-out card for Tusker lager (merged); Kilimani in view keeps the move', async () => {
    reset([S.A]);
    const w = await call(REC(`&branch=${S.W}`), T.owner);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.ok(!w.body.recommendations.some((x) => x.kind === 'stock_out' && /Tusker/.test(x.title)), w.body.recommendations.map((x) => x.title).join(' | '));
    const mv = w.body.recommendations.find((x) => x.kind === 'stock_move');
    assert.match(mv.why, / If Kilimani cannot spare enough, order the rest\.$/);
    assert.ok(!w.body.recommendations.some((x) => x.kind === 'branch_drop'), 'Kilimani\'s fall is not about Westlands');
    const k = await call(REC(`&branch=${S.K}`), T.owner);
    assert.ok(k.body.recommendations.some((x) => x.kind === 'stock_move'), 'the move touches Kilimani too');
    assert.ok(k.body.recommendations.some((x) => x.kind === 'branch_drop'));
  });

  await ok('one active branch: nothing to compare, the tile hidden', async () => {
    reset([S.A], 'inactive');
    const r = await call(BR(), T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.available, r.body.compare, r.body.moves, r.body.note], [false, null, null, 'Comparing branches needs two or more active branches.']);
    const rec = await call(REC(), T.owner);
    assert.equal(rec.body.hooks.branches.hidden, true);
    assert.ok(!rec.body.recommendations.some((x) => ['stock_move', 'branch_drop'].includes(x.kind)));
  });

  await ok('before migration 162: the comparison stands, no moves and the note; /recommendations still answers', async () => {
    reset([S.A]);
    const real = supabase.rpc;
    supabase.rpc = async (name, args) => (name === 'analytics_stock_use' ? { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } } : real(name, args));
    try {
      const r = await call(BR(), T.owner);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.compare.rows.length === 2);
      assert.equal(r.body.moves, null);
      assert.match(r.body.movesNote, /being set up/);
      const rec = await call(REC(), T.owner);
      assert.equal(rec.status, 200);
      assert.ok(!rec.body.recommendations.some((x) => x.kind === 'stock_move'));
      assert.ok(rec.body.recommendations.some((x) => x.kind === 'branch_drop'));
    } finally { supabase.rpc = real; }
  });

  await ok('the cache: a repeat runs nothing; /recommendations after /branches runs no branch aggregate again; shared per branch', async () => {
    reset([S.A]);
    await call(BR(), T.owner);
    const n = rpcs.length;
    await call(BR(), T.owner);
    assert.equal(rpcs.length, n, 'kept 5 minutes');
    await call(`/api/analytics/stock?${PERIOD}&branch=${S.K}`, T.owner);
    assert.equal(rpcs.length, n, "Kilimani's own stock view shares the per-branch answer");
    await call(REC(), T.owner);
    assert.ok(!rpcs.slice(n).some((x) => (x.name === 'analytics_stock_use' || x.name === 'analytics_daily_sales') && x.args.p_branch), rpcs.slice(n).map((x) => x.name).join(','));
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
