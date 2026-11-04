/**
 * permissions-a490-routes.test.mjs — A490: every cloud route checks its FINE key (docs/PERMISSIONS-A490.md "Cloud routes →
 * keys"), an old token (broad keys) still passes exactly the routes it passed, and what had no check before is open to
 * everybody until migration 134 has run.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/permissions-a490-routes.test.mjs
 *
 * RUNS the COMPILED routers behind the REAL requireAuth (JWTs signed with a per-run secret), over HTTP, against an
 * in-memory database (supabase.from stubbed). Table-driven: for each route, a person holding EVERY fine key but that one
 * (and its alternatives) is refused with 403, and a person holding only that key is not refused for a permission.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A490 report):
 *   - orders.ts reversalGate('refund') checks sales.void                    → "POST /api/orders/:id/refund needs sales.refund" fails
 *   - reports-export.ts /pnl without requirePermission('reports.costs')     → "export: pnl needs reports.costs too" fails
 *   - discounts.ts /apply without requirePermission('sales.discount')       → the sales.discount row fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/controls.js'))) {
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
const P = require('@zaptill/core/permissions');
const state = require(path.join(DIST, 'lib/permissionsState.js'));

const id = () => randomUUID();
const BZ = id(), BR = id(), USER = id(), OWNER = id(), X = id(), ADMIN = id();

// ── an in-memory database (the route-permission-gates shape) ──────────────────
let db;
const reset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, name: 'Pollo', desktop_approved_version: null }],
    branches: [{ id: BR, business_id: BZ, name: 'A', is_main: true, status: 'active' }],
    users: [{ id: USER, business_id: BZ, name: 'Pat', status: 'active', permissions_version: 1, role_id: null }],
    user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null, terminal_code: 'T1' }],
    business_settings: [], feature_flags: [], branch_settings: [],
    admin_users: [{ id: ADMIN, email: 'a@zaptill.test', role: 'super_admin', is_active: true }],   // A495: requireAdmin re-reads it
  };
};
reset();
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

// ── tokens ────────────────────────────────────────────────────────────────────
const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', userId: USER, businessId: BZ, branchId: BR, isOwner: false, ...p },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const holding = (keys) => sign({ permissionKeys: keys });
// A595: a token made from A595 on (`parts: true`) — an older one would give the parent's parts back (the part refused here).
const allBut = (...keys) => sign({ permissionKeys: P.PERMISSION_KEYS.filter((k) => !keys.includes(k)), parts: true });
const OWNER_T = sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'] });

// ── the app ───────────────────────────────────────────────────────────────────
const express = require('express');
const app = express(); app.use(express.json());
const mount = (p, mod, exp = 'default') => app.use(p, require(path.join(DIST, mod))[exp]);
for (const [p, m] of [
  ['/api/categories', 'categories'], ['/api/combos', 'combos'], ['/api/modifiers', 'modifiers'], ['/api/variants', 'variants'],
  ['/api/offers', 'offers'], ['/api/discounts', 'discounts'], ['/api/promotions', 'promotions'], ['/api/recipes', 'recipes'],
  ['/api/stations', 'stations'], ['/api/payment-methods', 'payment-methods'], ['/api/printers', 'printers'], ['/api/tables', 'tables'],
  ['/api/devices', 'devices'], ['/api/etims', 'etims'], ['/api/webhooks', 'webhooks'], ['/api/qr', 'qr'], ['/api/credit', 'credit'],
  ['/api/loyalty', 'loyalty'], ['/api/mpesa', 'mpesa'], ['/api/day-close', 'day-close'], ['/api/branch-prices', 'branch-prices'],
  ['/api/reservations', 'reservations'], ['/api/parking-sessions', 'parking'], ['/api/products', 'products'],
  ['/api/reports/monthly', 'reports-monthly'], ['/api/reports/export', 'reports-daily'], ['/api/reports/export', 'reports-export'],
  ['/api/reports', 'reports'], ['/api/staff', 'staff'], ['/api/branches', 'branches'], ['/api/business', 'business'],
  ['/api/changes', 'changes'], ['/api/orders', 'orders'], ['/api/shifts', 'shifts'], ['/api/controls', 'controls'],
  ['/api/expenses', 'expenses'], ['/api/flags', 'flags'],
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
const refusedFor = (r) => r.status === 403 && /Missing permission|MANAGER_ONLY|Only the owner decides/.test(JSON.stringify(r.body ?? ''));

// ── the table: [method, path, key, body?, alternatives that also open it] ─────
// A595: a row names the PART of a split key where the route now checks the part (shared/permissions.ts SPLITS).
const ROUTES = [
  ['POST', '/api/categories', 'menu.edit', { name: 'x' }],
  ['PATCH', `/api/categories/${X}`, 'menu.edit', {}],
  ['DELETE', `/api/categories/${X}`, 'menu.delete'],   // A595
  ['POST', '/api/combos', 'menu.edit', {}],
  ['POST', '/api/modifiers/groups', 'menu.edit', {}],
  ['POST', '/api/variants/groups', 'menu.edit', {}],
  ['POST', '/api/variants/bulk', 'menu.bulk', { rows: [] }],   // A595
  ['POST', '/api/products', 'menu.edit', {}],
  ['DELETE', `/api/products/${X}`, 'menu.delete'],   // A595
  ['PATCH', '/api/products/bulk-tax/by-ids', 'menu.bulk', {}],   // A595
  ['PATCH', '/api/products/bulk-track/by-ids', 'menu.bulk', {}],   // A595
  ['POST', '/api/products/bulk', 'menu.bulk', { rows: [] }],   // A595
  ['PATCH', '/api/products/bulk-cost/by-ids', 'menu.costs_edit', {}],   // A595
  ['POST', '/api/products/bulk-price', 'menu.prices', {}],
  ['POST', '/api/branch-prices/sync', 'menu.prices', {}],
  ['POST', '/api/recipes/bulk', 'menu.recipes', {}],
  ['POST', `/api/recipes/${X}`, 'menu.recipes', {}],
  ['POST', `/api/recipes/${X}/packaging`, 'menu.recipes', {}],
  ['POST', '/api/offers', 'menu.offers', {}],
  ['POST', '/api/discounts', 'menu.offers', {}],
  ['POST', '/api/promotions', 'menu.promotions', {}],   // A502: its own key (a promotion runs at every branch)
  ['POST', '/api/discounts/apply', 'sales.discount_preset', {}],   // A595
  ['POST', '/api/payment-methods', 'settings.payments', {}],
  ['POST', '/api/stations', 'stations.manage', {}],
  ['POST', '/api/printers', 'stations.manage', {}],
  ['GET', '/api/tables/all', 'tables.manage'],
  ['POST', '/api/tables', 'tables.manage', {}],
  ['GET', '/api/devices/fleet', 'devices.view'],   // A595
  ['PATCH', `/api/devices/${X}/approve`, 'devices.approve', {}],
  ['GET', '/api/etims/config', 'etims.manage'],
  ['GET', '/api/etims/invoices', 'reports.tax'],
  ['POST', '/api/webhooks', 'settings.webhooks', {}],   // A595
  ['PATCH', '/api/qr/settings', 'settings.integrations', {}],
  // A585: PATCH /api/credit/customer/:id/limit is the OWNER's alone now (no key opens it) — tests/credit-owner-a585.test.mjs.
  ['POST', `/api/credit/customer/${X}/payment`, 'customers.credit_payment', {}],   // A595
  ['PATCH', `/api/loyalty/customer/${X}`, 'customers.edit', {}],
  ['POST', '/api/loyalty/customer', 'customers.edit', {}, ['customers.view']],
  ['GET', '/api/mpesa/exceptions', 'reports.payments'],
  ['POST', '/api/day-close/instruct', 'shifts.close_day', {}],
  ['GET', '/api/day-close/overview', 'shifts.close_day'],
  ['POST', `/api/shifts/${X}/force-close`, 'shifts.force_close', {}],
  ['GET', `/api/shifts/branch-report?branch_id=${BR}`, 'reports.shifts', undefined, ['shifts.confirm']],
  ['GET', `/api/shifts/${X}/zreport`, 'reports.shifts', undefined, ['shifts.confirm']],
  ['GET', '/api/reservations', 'reservations.manage'],
  ['POST', '/api/reservations', 'reservations.manage', {}],
  ['GET', '/api/parking-sessions', 'parking.manage'],
  ['POST', '/api/fuel-tanks', 'fuel.setup', {}],   // A595
  ['PATCH', `/api/pumps/${X}/idle`, 'fuel.manage', {}],
  ['GET', '/api/pumps', 'fuel.manage', undefined, ['reports.fuel', 'orders.create']],
  // reports — one key each (the Overview's three also admit reports.overview)
  ['GET', '/api/reports/sales', 'reports.sales', undefined, ['reports.overview']],
  ['GET', '/api/reports/master', 'reports.sales'],
  ['GET', '/api/reports/hourly', 'reports.sales'],
  ['GET', '/api/reports/products', 'reports.items', undefined, ['reports.overview']],
  ['GET', '/api/reports/products-v2', 'reports.items'],
  ['GET', '/api/reports/staff', 'reports.staff'],
  ['GET', '/api/reports/shifts', 'reports.shifts'],
  ['GET', '/api/reports/voids', 'reports.voids'],
  ['GET', '/api/reports/refunds', 'reports.voids'],
  ['GET', '/api/reports/inventory', 'reports.inventory'],
  ['GET', '/api/reports/fuel-sales', 'reports.fuel'],
  ['GET', '/api/reports/wet-stock', 'reports.fuel'],
  ['GET', '/api/reports/pump-monitor', 'reports.fuel', undefined, ['reports.overview']],
  ['GET', '/api/reports/tax', 'reports.tax'],
  ['GET', '/api/reports/food-cost', 'reports.costs'],
  ['GET', '/api/reports/splh', 'reports.labour'],
  ['GET', `/api/reports/monthly?month=2026-10&branch_id=${BR}`, 'reports.monthly_pack', undefined, ['expenses.monthly']],   // A595
  ['GET', `/api/reports/monthly/movements?month=2026-10&branch_id=${BR}`, 'reports.monthly_pack', undefined, ['expenses.monthly', 'expenses.view']],   // A595
  ['GET', '/api/orders/turnover', 'orders.view_all'],
  ['GET', '/api/orders/turnover/report', 'reports.sales'],
  ['POST', `/api/orders/${X}/void`, 'sales.void', { reason: 'x' }],
  ['POST', `/api/orders/${X}/refund`, 'sales.refund', { reason: 'x' }],
  // staff and roles
  ['GET', '/api/staff', 'staff.view'],
  ['GET', `/api/branches/${BR}/staff`, 'staff.view'],
  ['POST', '/api/staff', 'staff.edit', {}],
  ['PATCH', `/api/staff/${X}`, 'staff.edit', {}, ['staff.pay']],   // A595: the pay rate alone is staff.pay
  ['DELETE', `/api/staff/${X}`, 'staff.edit'],
  ['PUT', `/api/staff/roles/${X}/permissions`, 'staff.roles', { keys: [] }],
  ['POST', '/api/staff/roles', 'staff.roles', {}],
  ['PATCH', `/api/staff/roles/${X}`, 'staff.roles', {}],
  ['DELETE', `/api/staff/roles/${X}`, 'staff.roles'],
  // settings
  ['PATCH', '/api/business', 'settings.business', {}, ['settings.tax']],   // A595: the tax rates alone
  ['PUT', `/api/branches/${BR}`, 'settings.branches', {}],
  ['DELETE', `/api/branches/${X}`, 'settings.branches'],
  ['GET', '/api/changes', 'changes.approve', undefined, ['changes.approve_staff']],   // A595: staff changes alone
  ['POST', `/api/changes/${X}/decide`, 'changes.approve', { approve: true }, ['changes.approve_staff']],   // A595
  ['PUT', '/api/controls/pos/delivery_fee', 'settings.pos', { enabled: true }],
  ['PUT', '/api/controls/loyalty', 'settings.pos', { enabled: true }],
  ['PUT', '/api/flags/anything', 'settings.business', { enabled: true }],
];

try {
  state._setPermissionsMigrated(true);   // after migration 134: the open keys are the roles' own
  state._setSplitsMigrated?.(true);      // A595: and after 176 — a part is checked as itself

  console.log('\n1. Each route refuses without its fine key, and is not refused with it\n');
  for (const [method, p, key, body, alts = []] of ROUTES) {
    await ok(`${method} ${p.split('?')[0]} needs ${key}${alts.length ? ` (or ${alts.join(' / ')})` : ''}`, async () => {
      reset();
      const no = await call(method, p, allBut(key, ...alts), body);
      assert.ok(refusedFor(no), `without ${key}: ${no.status} ${JSON.stringify(no.body)}`);
      reset();
      const yes = await call(method, p, holding([key]), body);
      assert.ok(!refusedFor(yes), `with only ${key}: ${yes.status} ${JSON.stringify(yes.body)}`);
      for (const a of alts) {
        reset();
        const alt = await call(method, p, holding([a]), body);
        assert.ok(!refusedFor(alt), `with only ${a}: ${alt.status} ${JSON.stringify(alt.body)}`);
      }
      reset();
      const owner = await call(method, p, OWNER_T, body);
      assert.ok(!refusedFor(owner), `the owner: ${owner.status} ${JSON.stringify(owner.body)}`);
    });
  }

  console.log('\n2. A download needs reports.export AND the report it copies\n');
  for (const [p, key] of [['sales', 'reports.sales'], ['products', 'reports.items'], ['pnl', 'reports.costs'], ['shifts', 'reports.shifts'],
    ['expenses', 'expenses.view'], ['daily', 'reports.sales'], ['hourly', 'reports.sales'], ['audit', 'reports.voids']]) {
    await ok(`export: ${p} needs reports.export and ${key}`, async () => {
      reset();
      assert.ok(refusedFor(await call('GET', `/api/reports/export/${p}`, holding([key]))), 'the report alone is not a download');
      assert.ok(refusedFor(await call('GET', `/api/reports/export/${p}`, holding(['reports.export']))), 'reports.export alone is not every report');
      const both = await call('GET', `/api/reports/export/${p}`, holding(['reports.export', key]));
      assert.ok(!refusedFor(both), `${both.status} ${JSON.stringify(both.body)}`);
    });
  }

  console.log('\n3. An old token (broad keys) passes exactly what it passed\n');
  const legacy = [
    ['reports.view', 'GET', '/api/reports/sales', true], ['reports.view', 'GET', '/api/reports/voids', true],
    ['reports.view', 'GET', '/api/reports/tax', false], ['reports.financial', 'GET', '/api/reports/tax', true],
    ['reports.financial', 'GET', '/api/reports/food-cost', true], ['reports.financial', 'GET', '/api/reports/sales', false],
    ['reports.financial', 'GET', '/api/reports/export/pnl', false],   // a download of P&L needs the export AND costs: both in reports.financial
    ['orders.void', 'POST', `/api/orders/${X}/void`, true], ['orders.void', 'POST', `/api/orders/${X}/refund`, true],
    ['products.manage', 'POST', '/api/products', true], ['products.manage', 'POST', '/api/discounts', true],
    ['products.manage', 'POST', '/api/payment-methods', true], ['products.manage', 'PATCH', '/api/business', false],
    ['settings.manage', 'GET', '/api/devices/fleet', true], ['settings.manage', 'PATCH', '/api/business', true],
    ['settings.manage', 'POST', `/api/shifts/${X}/force-close`, true], ['settings.manage', 'POST', '/api/products', false],
    ['staff.manage', 'POST', '/api/staff/roles', true], ['customers.manage', 'POST', `/api/credit/customer/${X}/payment`, true],   // A585: the limit is the owner's; repayments keep customers.credit
  ];
  for (const [k, method, p, passes] of legacy) {
    await ok(`a token holding ${k} ${passes ? 'passes' : 'is refused'} ${method} ${p}`, async () => {
      reset();
      const r = await call(method, p, holding([k]), method === 'GET' ? undefined : { reason: 'x' });
      if (k === 'reports.financial' && p.endsWith('/pnl')) { assert.ok(!refusedFor(r), `${r.status} ${JSON.stringify(r.body)}`); return; }
      assert.equal(refusedFor(r), !passes, `${r.status} ${JSON.stringify(r.body)}`);
    });
  }

  console.log('\n4. Before migration 134: what had no check is open to everyone; after: the role decides\n');
  const open = [['POST', '/api/discounts/apply', 'sales.discount', {}], ['GET', '/api/staff', 'staff.view'], ['GET', '/api/reservations', 'reservations.manage'],
    ['GET', '/api/parking-sessions', 'parking.manage'], ['POST', '/api/fuel-tanks', 'fuel.manage', {}]];
  for (const [method, p, key, body] of open) {
    await ok(`${method} ${p} (${key}): open to a plain cashier before 134, refused after`, async () => {
      reset();
      state._setPermissionsMigrated(false);
      const before = await call(method, p, holding(['orders.create']), body);
      state._setPermissionsMigrated(true);
      const after = await call(method, p, holding(['orders.create']), body);
      assert.ok(!refusedFor(before), `before 134: ${before.status} ${JSON.stringify(before.body)}`);
      assert.ok(refusedFor(after), `after 134: ${after.status} ${JSON.stringify(after.body)}`);
    });
  }

  console.log('\n5. Admin portal: the owner sets these now\n');
  const adminT = jwt.sign({ adminId: ADMIN, email: 'a@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
  const adminApp = express(); adminApp.use(express.json());
  adminApp.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
  const adminServer = await new Promise((r) => { const s = adminApp.listen(0, () => r(s)); });
  const adminCall = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${adminServer.address().port}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminT}` },
      body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  for (const key of ['delivery_fee', 'pay_later_tabs', 'pay_before_kitchen', 'login_codes', 'loyalty_enabled', 'cashier_own_history', 'cashier_no_money_out', 'cashier_no_reprint']) {
    await ok(`PATCH /api/admin/clients/:id/features/${key} → 403 OWNER_SETS (nothing written)`, async () => {
      reset();
      const r = await adminCall('PATCH', `/api/admin/clients/${BZ}/features/${key}`, { enabled: true });
      assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWNER_SETS');
      assert.ok(!db.feature_flags.some((f) => f.key === key), 'no flag written');
    });
  }
  await ok('…but the portal still sets what stays ZapTill\'s (web_hosting, themes)', async () => {
    reset();
    const r = await adminCall('PATCH', `/api/admin/clients/${BZ}/features/web_hosting`, { enabled: true });
    // A584: web_hosting stays ZapTill's — never OWNER_SETS — but a bare enable is refused: it is turned on by the cloud plan.
    assert.notEqual(r.body?.code, 'OWNER_SETS', JSON.stringify(r.body));
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'WEB_ACCESS_BY_PLAN');
    assert.equal((await adminCall('PATCH', `/api/admin/clients/${BZ}/features/web_hosting`, { enabled: false })).status, 200, 'switching it off still goes');
  });
  // A493 (owner, 2026-10-15): till update approval is the admin portal's — never the client's.
  await ok('A493: PATCH /api/admin/clients/:id/desktop-version — the admin holds (and approves) a client\'s till version', async () => {
    reset();
    const r = await adminCall('PATCH', `/api/admin/clients/${BZ}/desktop-version`, { version: null });
    assert.notEqual(r.status, 403, JSON.stringify(r.body)); assert.notEqual(r.body?.code, 'OWNER_SETS');
  });
  await ok('A493: the owner may not approve a till version — PUT /api/controls/updates → 403 ADMIN_SETS', async () => {
    const r = await call('PUT', '/api/controls/updates', OWNER_T, { version: null });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'ADMIN_SETS');
  });
  adminServer.close();
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
