// A494 — access-control hardening of the stock, report, menu and settings routes (internal audit, 2026-10-15): before
// onboarding more clients, the owner asked for every id a request names to be checked against the business, every
// branch-held record against the caller's branch, no cost sent to someone who may not see costs, no blind-count figure
// leaked beside the count screen, and the open data routes gated.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/stock-reports-hardening.test.mjs
//
// RUNS the COMPILED routers behind the REAL requireAuth over HTTP; the database in memory (tests/lib-memdb.mjs).
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — 2026-10-15):
//   - inventory.ts threshold: the idsOfBusiness('products', …) check removed      → "1. threshold: another business's product" fails
//   - stock.ts transfers: the NOT_DESTINATION check removed                       → "2. a transfer is received by the receiving branch" fails
//   - wastage.ts: 'cost' dropped from the router's strip list                       → "3. wastage /items: no cost" fails
//   - stockTakeAccess.may's till line removed (a till's '*' unblinds, as holds())   → "11. a till's own sign-in sees a count blind" fails
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
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/branchGuard.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const { neutralise, csvCell } = require(path.join(DIST, 'lib/csvSafe.js'));

const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = u(1), BX = u(2), BR = u(11), BR2 = u(12), BRX = u(13);
const OWNER = u(21), MGR = u(22), MGR2 = u(23), CASH = u(24), ADJ = u(25), OUT = u(26);
const P1 = u(31), PX = u(32), PF = u(33), C1 = u(41), CX = u(42), I1 = u(51), IX = u(52), S1 = u(61), SX = u(62);
const person = (id, name, branch = BR, biz = B) => ({ id, name, status: 'active', business_id: biz, permissions_version: 0, branch_id: branch });

const reset = () => {
  mem.fail = () => null; mem.calls = []; mem.rpc = async () => ({ data: null, error: null });
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Pollo' }, { id: BX, owner_id: OUT, name: 'Other' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', tech_reveal_code: 'SECRET1' }, { id: BR2, business_id: B, name: 'Kilimani' },
      { id: BRX, business_id: BX, name: 'Elsewhere' }],
    users: [person(OWNER, 'Owner'), person(MGR, 'Mary'), person(MGR2, 'Kim', BR2), person(CASH, 'Joe'), person(ADJ, 'Ada'), person(OUT, 'Out', BRX, BX)],
    user_devices: [{ business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null }],
    products: [
      { id: P1, business_id: B, name: 'Soda', status: 'active', track_stock: true, sold_by: 'each', cost_price: 40, base_price: 100, is_fuel: false },
      { id: PX, business_id: BX, name: 'Theirs', status: 'active', track_stock: true, cost_price: 1, base_price: 2 },
      { id: PF, business_id: B, name: 'Diesel', status: 'active', track_stock: true, is_fuel: true, cost_price: 150, base_price: 180 },
    ],
    categories: [{ id: C1, business_id: B, name: 'Drinks' }, { id: CX, business_id: BX, name: 'Theirs' }],
    ingredients: [{ id: I1, business_id: B, name: 'Flour', unit: 'kg', unit_cost: 10, status: 'active' },
      { id: IX, business_id: BX, name: 'Theirs', unit: 'kg', unit_cost: 1, status: 'active' }],
    suppliers: [{ id: S1, business_id: B, name: 'Supa', status: 'active' }, { id: SX, business_id: BX, name: 'Theirs', status: 'active' }],
    stock_levels: [{ product_id: P1, branch_id: BR, quantity: 7, qty_pieces: 0, low_stock_threshold: 5 }],
    ingredient_stock_levels: [{ business_id: B, ingredient_id: I1, branch_id: BR, current_stock: 9 }],
    stock_movements: [], ingredient_stock_movements: [], stock_takes: [], stock_take_lines: [], stock_batches: [],
    purchase_orders: [], purchase_order_items: [], goods_received_notes: [], grn_items: [], stock_transfers: [], stock_transfer_items: [],
    business_settings: [], feature_flags: [], wastage_entries: [], supplier_returns: [], supplier_return_items: [],
    fuel_tanks: [], pumps: [], parking_sessions: [], tables: [], expenses: [], expense_categories: [], customers: [], webhooks: [],
    discounts: [], promotions: [], etims_branch_config: [], etims_invoices: [], shifts: [], orders: [], order_items: [],
    variant_groups: [], variant_options: [], modifier_groups: [], modifier_options: [], combo_items: [], loyalty_transactions: [],
    customer_credit_transactions: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
const mount = (p, mod, name = 'default') => app.use(p, require(path.join(DIST, mod))[name]);
mount('/api/stock', 'routes/stock.js'); mount('/api/inventory', 'routes/inventory.js'); mount('/api/wastage', 'routes/wastage.js');
mount('/api/batches', 'routes/batches.js'); mount('/api/stock-takes', 'routes/stockTakes.js'); mount('/api/payables', 'routes/payables.js');
mount('/api/etims', 'routes/etims.js'); mount('/api/reports/export', 'routes/reports-export.js'); mount('/api/reports', 'routes/reports.js');
mount('/api/fuel-tanks', 'routes/fueltanks.js', 'fuelTanksRouter'); mount('/api/pumps', 'routes/fueltanks.js', 'pumpsRouter');
mount('/api/parking-sessions', 'routes/parking.js'); mount('/api/credit', 'routes/credit.js'); mount('/api/loyalty', 'routes/loyalty.js');
mount('/api/business', 'routes/business.js'); mount('/api/controls', 'routes/controls.js'); mount('/api/combos', 'routes/combos.js');
mount('/api/variants', 'routes/variants.js'); mount('/api/modifiers', 'routes/modifiers.js'); mount('/api/products', 'routes/products.js');
mount('/api/discounts', 'routes/discounts.js'); mount('/api/promotions', 'routes/promotions.js'); mount('/api/webhooks', 'routes/webhooks.js');
mount('/api/branches', 'routes/branches.js'); mount('/api/expenses', 'routes/expenses.js'); mount('/api/tables', 'routes/tables.js');
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });

const tok = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, surface: 'web', businessId: B, branchId: BR, isOwner: false, ...p },
  process.env.JWT_SECRET, { expiresIn: '5m' });
const MGR_KEYS = ['orders.create', 'products.view', 'inventory.view', 'inventory.receive', 'inventory.transfer', 'inventory.waste', 'inventory.count',
  'ingredients.manage', 'menu.edit', 'menu.offers', 'expenses.view', 'expenses.manage', 'fuel.manage', 'reports.fuel', 'reports.shifts',
  'reports.export', 'settings.business', 'settings.pos', 'parking.manage', 'tables.manage', 'customers.view', 'sales.discount', 'settings.integrations'];
const T = {
  owner: tok({ userId: OWNER, isOwner: true, branchId: null, ownerLogin: true, permissionKeys: ['*'] }),
  mgr: tok({ userId: MGR, permissionKeys: MGR_KEYS }),
  mgr2: tok({ userId: MGR2, branchId: BR2, permissionKeys: MGR_KEYS }),
  adj: tok({ userId: ADJ, permissionKeys: [...MGR_KEYS, 'inventory.adjust'] }),
  costs: tok({ userId: ADJ, permissionKeys: [...MGR_KEYS, 'menu.costs', 'menu.prices'] }),
  cash: tok({ userId: CASH, permissionKeys: ['orders.create', 'products.view', 'sales.discount'] }),
  till: tok({ userId: null, deviceId: 'dev-T1', till: true, surface: 'desktop', permissionKeys: ['*'] }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, body: json, text };
};
const has = (o, k) => JSON.stringify(o).includes(`"${k}"`);
/** An open count at BR, counting P1 and I1. */
const openCount = () => {
  mem.db.stock_takes.push({ id: 'take-1', business_id: B, branch_id: BR, ref: 'SC-0001', status: 'counting', freeze_sales: false });
  mem.db.stock_take_lines.push({ id: 'l1', stock_take_id: 'take-1', item_kind: 'product', product_id: P1, ingredient_id: null, name: 'Soda', counted_qty: null },
    { id: 'l2', stock_take_id: 'take-1', item_kind: 'ingredient', product_id: null, ingredient_id: I1, name: 'Flour', counted_qty: null });
};

try {
  state._setPermissionsMigrated(true);

  console.log('\n1. Ids from the request are this business\'s\n');
  reset();
  await ok('1. threshold: another business\'s product → 404; the owner naming another business\'s branch → 404; another branch → 403', async () => {
    assert.equal((await call('PATCH', `/api/inventory/${PX}/threshold`, T.mgr, { branch_id: BR, low_stock_threshold: 3 })).status, 404);
    assert.equal((await call('PATCH', `/api/inventory/${P1}/threshold`, T.owner, { branch_id: BRX, low_stock_threshold: 3 })).status, 404);
    assert.equal((await call('PATCH', `/api/inventory/${P1}/threshold`, T.mgr, { branch_id: BR2, low_stock_threshold: 3 })).status, 403);
    assert.equal((await call('PATCH', `/api/inventory/${P1}/threshold`, T.mgr, { branch_id: BR, low_stock_threshold: -1 })).status, 400);
    assert.equal(mem.db.stock_levels.length, 1, 'no row made for a refused request');
    assert.equal((await call('PATCH', `/api/inventory/${P1}/threshold`, T.mgr, { branch_id: BR, low_stock_threshold: 3 })).status, 200);
    assert.equal(mem.db.stock_levels[0].low_stock_threshold, 3);
  });
  await ok('1. ingredient adjust / reorder: another business\'s ingredient or branch → 404', async () => {
    assert.equal((await call('POST', `/api/stock/ingredients/${IX}/adjust`, T.owner, { branch_id: BR, type: 'add', quantity: 1 })).status, 404);
    assert.equal((await call('POST', `/api/stock/ingredients/${I1}/adjust`, T.owner, { branch_id: BRX, type: 'add', quantity: 1 })).status, 404);
    assert.equal((await call('PATCH', `/api/stock/ingredients/${IX}/reorder`, T.owner, { branch_id: BR, reorder_level: 2 })).status, 404);
    assert.equal((await call('PATCH', `/api/stock/ingredients/${I1}/reorder`, T.owner, { branch_id: BRX, reorder_level: 2 })).status, 404);
    assert.equal(mem.db.ingredient_stock_movements.length, 0);
  });
  await ok('1. transfers: another business\'s product → 400, the owner\'s source in another business → 404', async () => {
    assert.equal((await call('POST', '/api/stock/transfers', T.mgr, { from_branch_id: BR, to_branch_id: BR2, items: [{ product_id: PX, quantity: 1 }] })).status, 400);
    assert.equal((await call('POST', '/api/stock/transfers', T.owner, { from_branch_id: BRX, to_branch_id: BR2, items: [{ product_id: P1, quantity: 1 }] })).status, 404);
    assert.equal(mem.db.stock_transfers.length, 0);
  });
  await ok('1. purchase orders: another business\'s supplier / ingredient / (the owner\'s) branch refused', async () => {
    const po = (o) => ({ branch_id: BR, supplier_id: S1, items: [{ ingredient_id: I1, quantity_ordered: 2, unit_cost: 10 }], ...o });
    assert.equal((await call('POST', '/api/stock/purchase-orders', T.mgr, po({ supplier_id: SX }))).status, 400);
    assert.equal((await call('POST', '/api/stock/purchase-orders', T.mgr, po({ items: [{ ingredient_id: IX, quantity_ordered: 1 }] }))).status, 400);
    assert.equal((await call('POST', '/api/stock/purchase-orders', T.owner, po({ branch_id: BRX }))).status, 404);
    assert.equal(mem.db.purchase_orders.length, 0);
  });
  await ok('1. combos, products, variants: another business\'s product / category refused', async () => {
    assert.equal((await call('POST', '/api/combos', T.mgr, { name: 'Meal', combo_price: 300, items: [{ product_id: PX }] })).status, 400);
    assert.equal((await call('POST', '/api/combos', T.mgr, { name: 'Meal', combo_price: 300, category_id: CX, items: [{ product_id: P1 }] })).status, 400);
    assert.equal((await call('POST', '/api/products', T.mgr, { name: 'New', base_price: 10, category_id: CX })).status, 400);
    assert.equal((await call('PATCH', `/api/products/${P1}`, T.mgr, { category_id: CX })).status, 400);
    assert.equal((await call('POST', '/api/variants/groups', T.mgr, { product_id: P1, name: 'Size', options: [{ name: 'L', linked_product_id: PX }] })).status, 400);
    assert.equal(mem.db.variant_groups.length, 0);
  });
  await ok('1. fuel: another business\'s grade, branch or tank refused', async () => {
    assert.equal((await call('POST', '/api/fuel-tanks', T.owner, { name: 'T', fuel_product_id: PX, capacity_litres: 100 })).status, 400);
    assert.equal((await call('POST', '/api/fuel-tanks', T.owner, { name: 'T', fuel_product_id: PF, capacity_litres: 100, branch_id: BRX })).status, 404);
    mem.db.fuel_tanks.push({ id: 'tank-x', business_id: BX, name: 'Theirs', fuel_product_id: PX });
    assert.equal((await call('POST', '/api/pumps', T.owner, { name: 'P', tank_id: 'tank-x' })).status, 400);
    assert.equal(mem.db.pumps.length, 0);
  });
  await ok('1. expenses: another business\'s category or payer refused', async () => {
    mem.db.expense_categories.push({ id: 'cat-x', business_id: BX, name: 'Theirs' });
    const e = (o) => ({ branch_id: BR, description: 'Gas', amount: 50, ...o });
    assert.equal((await call('POST', '/api/expenses', T.mgr, e({ expense_category_id: 'cat-x' }))).status, 400);
    assert.equal((await call('POST', '/api/expenses', T.mgr, e({ paid_by: OUT }))).status, 400);
    assert.equal(mem.db.expenses.length, 0);
  });
  await ok('1. eTIMS: the owner\'s X-Branch-Id / body / path branch must be this business\'s', async () => {
    mem.db.etims_branch_config.push({ id: 'cfg-x', business_id: BX, branch_id: BRX, bhf_id: '00' });
    assert.equal((await call('GET', '/api/etims/config', T.owner, undefined, { 'x-branch-id': BRX })).status, 404);
    assert.equal((await call('GET', '/api/etims/invoices', T.owner, undefined, { 'x-branch-id': BRX })).status, 404);
    assert.equal((await call('PUT', '/api/etims/config', T.owner, { branch_id: BRX, bhf_id: '99' })).status, 404);
    assert.equal((await call('POST', `/api/etims/branches/${BRX}/register`, T.owner, {})).status, 404);
    assert.equal(mem.db.etims_branch_config[0].bhf_id, '00', 'another business\'s fiscal config untouched');
    assert.equal((await call('GET', '/api/etims/config', T.owner, undefined, { 'x-branch-id': BR })).status, 200);
  });

  console.log('\n2. Branch scoping\n');
  reset();
  await ok('2. a transfer is despatched / cancelled by the SENDING branch, received by the RECEIVING branch', async () => {
    mem.db.stock_transfers.push({ id: 'tr1', business_id: B, from_branch_id: BR, to_branch_id: BR2, status: 'pending', transfer_number: 'TRF-1', stock_transfer_items: [{ product_id: P1, quantity: 1 }] });
    assert.equal((await call('PATCH', '/api/stock/transfers/tr1/status', T.mgr2, { status: 'in_transit' })).status, 403, 'the destination may not despatch');
    assert.equal((await call('PATCH', '/api/stock/transfers/tr1/status', T.mgr2, { status: 'cancelled', reason: 'x' })).status, 403, 'nor cancel');
    assert.equal((await call('PATCH', '/api/stock/transfers/tr1/status', T.mgr, { status: 'in_transit' })).status, 200);
    assert.equal((await call('PATCH', '/api/stock/transfers/tr1/status', T.mgr, { status: 'received' })).status, 403, 'the source may not receive');
    assert.equal(mem.db.stock_transfers[0].status, 'in_transit');
    assert.equal((await call('PATCH', '/api/stock/transfers/tr1/status', T.mgr2, { status: 'cancelled', reason: 'x' })).status, 403, 'in transit: the source or the owner');
  });
  await ok('2. GET /stock/transfers: inventory.transfer, and only the caller\'s branch\'s', async () => {
    mem.db.stock_transfers.push({ id: 'tr2', business_id: B, from_branch_id: BR2, to_branch_id: u(14), status: 'pending' });
    assert.equal((await call('GET', '/api/stock/transfers', T.cash)).status, 403);
    const r = await call('GET', '/api/stock/transfers', T.mgr);
    assert.deepEqual(r.body.map((t) => t.id), ['tr1']);
  });
  await ok('2. purchase orders: another branch\'s PO is not readable, editable, cancellable or deletable; the list is the branch\'s', async () => {
    mem.db.purchase_orders.push({ id: 'po2', business_id: B, branch_id: BR2, status: 'ordered', deleted_at: null, purchase_order_items: [] },
      { id: 'po1', business_id: B, branch_id: BR, status: 'draft', deleted_at: null, purchase_order_items: [] });
    assert.equal((await call('GET', '/api/stock/purchase-orders/po2', T.mgr)).status, 404);
    assert.equal((await call('PATCH', '/api/stock/purchase-orders/po2', T.mgr, { notes: 'x' })).status, 403);
    assert.equal((await call('POST', '/api/stock/purchase-orders/po2/cancel', T.mgr, {})).status, 403);
    assert.equal((await call('DELETE', '/api/stock/purchase-orders/po2', T.mgr)).status, 403);
    assert.deepEqual((await call('GET', '/api/stock/purchase-orders', T.mgr)).body.map((p) => p.id), ['po1']);
    assert.equal((await call('POST', '/api/stock/grn', T.mgr, { branch_id: BR, purchase_order_id: 'po2', items: [{ ingredient_id: I1, quantity_received: 1 }] })).status, 403,
      'a GRN against another branch\'s PO');
  });
  await ok('2. GET /stock/grn: inventory.receive, the branch\'s', async () => {
    mem.db.goods_received_notes.push({ id: 'g1', business_id: B, branch_id: BR }, { id: 'g2', business_id: B, branch_id: BR2 });
    assert.equal((await call('GET', '/api/stock/grn', T.cash)).status, 403);
    assert.deepEqual((await call('GET', '/api/stock/grn', T.mgr)).body.map((g) => g.id), ['g1']);
  });
  await ok('2. movements: inventory.view; the branch\'s', async () => {
    mem.db.stock_movements.push({ id: 'm1', product_id: P1, branch_id: BR, quantity_after: 7, 'products.business_id': B },
      { id: 'm2', product_id: P1, branch_id: BR2, quantity_after: 3, 'products.business_id': B });
    mem.db.ingredient_stock_movements.push({ id: 'im1', business_id: B, ingredient_id: I1, branch_id: BR, quantity_after: 9 },
      { id: 'im2', business_id: B, ingredient_id: I1, branch_id: BR2, quantity_after: 4 });
    assert.equal((await call('GET', '/api/inventory/movements', T.cash)).status, 403);
    assert.equal((await call('GET', `/api/stock/ingredients/${I1}/movements`, T.cash)).status, 403);
    assert.deepEqual((await call('GET', '/api/inventory/movements', T.mgr)).body.map((m) => m.id), ['m1']);
    assert.deepEqual((await call('GET', `/api/stock/ingredients/${I1}/movements`, T.mgr)).body.map((m) => m.id), ['im1']);
  });
  await ok('2. fuel: the reports, the tank / pump lists and writes are the branch\'s (and the business-wide ones)', async () => {
    mem.db.pumps.push({ id: 'pA', business_id: B, branch_id: BR, name: 'A', fuel_product_id: PF }, { id: 'pB', business_id: B, branch_id: BR2, name: 'B' },
      { id: 'pAll', business_id: B, branch_id: null, name: 'Shared' });
    mem.db.fuel_tanks.push({ id: 'tA', business_id: B, branch_id: BR, name: 'TA', fuel_product_id: PF, current_level: 10, capacity_litres: 100 },
      { id: 'tB', business_id: B, branch_id: BR2, name: 'TB', fuel_product_id: PF, current_level: 5, capacity_litres: 100 });
    const mon = await call('GET', '/api/reports/pump-monitor', T.mgr);
    assert.equal(mon.status, 200, JSON.stringify(mon.body));
    assert.deepEqual(mon.body.pumps.map((p) => p.pump_id).sort(), ['pA', 'pAll']);
    const wet = await call('GET', '/api/reports/wet-stock', T.mgr);
    assert.deepEqual(wet.body.tanks.map((t) => t.id), ['tA']);
    const fs_ = await call('GET', `/api/reports/fuel-sales?branch_id=${BR2}`, T.mgr);
    assert.deepEqual(fs_.body.pumps.map((p) => p.pump_id).sort(), ['pA', 'pAll'], 'a manager naming another branch still gets theirs');
    assert.deepEqual((await call('GET', '/api/fuel-tanks', T.mgr)).body.map((t) => t.id), ['tA']);
    assert.deepEqual((await call('GET', `/api/pumps?branch_id=${BR2}`, T.mgr)).body.map((p) => p.id).sort(), ['pA', 'pAll']);
    assert.equal((await call('PATCH', '/api/fuel-tanks/tB', T.mgr, { name: 'x' })).status, 403);
    assert.equal((await call('POST', '/api/fuel-tanks/tB/delivery', T.mgr, { litres: 5 })).status, 403);
    assert.equal((await call('PATCH', '/api/pumps/pB/activate', T.mgr, {})).status, 403);
  });
  await ok('2. a fuel delivery is booked at the TANK\'s branch, whatever ?branch_id= says', async () => {
    assert.equal((await call('POST', `/api/fuel-tanks/tA/delivery?branch_id=${BRX}`, T.mgr, { litres: 5 })).status, 200);
    const m = mem.db.stock_movements.find((x) => x.reference_type === 'delivery');
    assert.equal(m.branch_id, BR);
  });
  await ok('2. reports-export /shifts is the branch\'s', async () => {
    mem.db.shifts.push({ id: 's1', business_id: B, branch_id: BR, opened_at: '2026-10-10T08:00:00Z' }, { id: 's2', business_id: B, branch_id: BR2, opened_at: '2026-10-10T08:00:00Z' });
    const r = await call('GET', '/api/reports/export/shifts?format=csv&from=2026-10-01&to=2026-10-31', T.mgr);
    assert.equal(r.status, 200, r.text);
    assert.equal(mem.calls.filter((c) => c.table === 'shifts').at(-1).filters.branch_id, BR);
  });
  await ok('2. parking: a staff member cannot read another branch by ?branch_id=; nor its session by id', async () => {
    mem.db.parking_sessions.push({ id: 'ps2', business_id: B, branch_id: BR2, status: 'open' }, { id: 'ps1', business_id: B, branch_id: BR, status: 'open' });
    assert.deepEqual((await call('GET', `/api/parking-sessions?branch_id=${BR2}`, T.mgr)).body.map((s) => s.id), ['ps1']);
    assert.equal((await call('GET', '/api/parking-sessions/ps2', T.mgr)).status, 404);
    assert.equal((await call('POST', '/api/parking-sessions/ps2/void', T.mgr, {})).status, 404);
    assert.equal(mem.db.parking_sessions[0].status, 'open');
  });
  await ok('2. expenses: another branch\'s expense is not editable or deletable', async () => {
    mem.db.expenses.push({ id: 'ex2', business_id: B, branch_id: BR2, amount: 10 });
    assert.equal((await call('PATCH', '/api/expenses/ex2', T.mgr, { amount: 1 })).status, 403);
    assert.equal((await call('DELETE', '/api/expenses/ex2', T.mgr)).status, 403);
    assert.equal(mem.db.expenses.length, 1);
    assert.equal(mem.db.expenses[0].amount, 10);
  });
  await ok('2. a branch\'s stock and its full table list are its own (the owner any)', async () => {
    assert.equal((await call('GET', `/api/branches/${BR2}/stock`, T.mgr)).status, 403);
    assert.equal((await call('GET', `/api/tables/all?branch_id=${BR2}`, T.mgr)).status, 403);
    assert.equal((await call('GET', `/api/tables/all?branch_id=${BR}`, T.mgr)).status, 200);
    assert.equal((await call('GET', `/api/branches/${BR2}/stock`, T.owner)).status, 200);
  });

  console.log('\n3. Costs\n');
  reset();
  await ok('3. wastage /items: no cost without menu.costs; with it, the cost', async () => {
    const r = await call('GET', `/api/wastage/items?branch_id=${BR}`, T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!has(r.body, 'cost'), JSON.stringify(r.body));
    assert.equal((await call('GET', `/api/wastage/items?branch_id=${BR}`, T.costs)).body.find((i) => i.id === P1).cost, 40);
  });
  await ok('3. returns to supplier: no unit cost or credit to a receiver without costs', async () => {
    mem.db.supplier_returns.push({ id: 'r1', business_id: B, branch_id: BR, credit_amount: 400, supplier_return_items: [{ name: 'Soda', unit_cost: 40, quantity: 10 }] });
    const r = await call('GET', '/api/payables/returns', T.mgr);
    assert.equal(r.status, 200);
    assert.ok(!has(r.body, 'credit_amount') && !has(r.body, 'unit_cost'), JSON.stringify(r.body));
    assert.equal((await call('GET', '/api/payables/returns', T.costs)).body[0].credit_amount, 400);
  });
  await ok('3. batches: the expired / soon values are not sent without costs', async () => {
    mem.db.stock_batches.push({ id: 'b1', business_id: B, branch_id: BR, item_kind: 'product', product_id: P1, expiry_date: '2020-01-01', quantity_received: 5, received_at: '2020-01-01', closed_at: null });
    const r = await call('GET', '/api/batches', T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!has(r.body, 'expiredValue') && !has(r.body, 'soonValue') && !has(r.body, 'value'), JSON.stringify(r.body.summary));
    assert.equal(r.body.summary.expired, 1, 'the count stays');
    assert.ok(has((await call('GET', '/api/batches', T.costs)).body, 'expiredValue'));
  });
  await ok('3. a stock count\'s short / over / net value need costs (inventory.adjust sees the summary, not its money)', async () => {
    mem.db.stock_takes.push({ id: 'tk9', business_id: B, branch_id: BR, ref: 'SC-9', status: 'posted', summary: { items: 1, counted: 1, shortValue: -40, overValue: 0, netValue: -40 } });
    const r = await call('GET', '/api/stock-takes', T.adj);
    assert.equal(r.status, 200);
    assert.equal(r.body[0].summary.items, 1);
    assert.ok(!has(r.body, 'shortValue') && !has(r.body, 'netValue') && !has(r.body, 'overValue'));
  });
  await ok('3. a PO / GRN cost typed without menu.costs is dropped: the stored cost stands, the catalogue unchanged', async () => {
    const r = await call('POST', '/api/stock/purchase-orders', T.mgr, { branch_id: BR, supplier_id: S1, items: [{ ingredient_id: I1, quantity_ordered: 2, unit_cost: 999 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(mem.db.purchase_order_items[0].unit_cost, 10, 'the ingredient\'s own cost');
    const g = await call('POST', '/api/stock/grn', T.mgr, { branch_id: BR, items: [{ ingredient_id: I1, quantity_received: 1, unit_cost: 999 }] });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    assert.equal(mem.db.grn_items[0].unit_cost, null);
    assert.equal(mem.db.ingredients.find((i) => i.id === I1).unit_cost, 10, 'the catalogue cost is not rewritten');
  });
  await ok('3. an ingredient\'s cost: create / edit need menu.costs (an empty or unchanged value is no change)', async () => {
    assert.equal((await call('POST', '/api/stock/ingredients', T.mgr, { name: 'Oil', unit: 'l', unit_cost: 5 })).status, 403);
    assert.equal((await call('POST', '/api/stock/ingredients', T.mgr, { name: 'Oil', unit: 'l', unit_cost: '' })).status, 201);
    assert.equal((await call('PATCH', `/api/stock/ingredients/${I1}`, T.mgr, { unit_cost: 3 })).status, 403);
    assert.equal((await call('PATCH', `/api/stock/ingredients/${I1}`, T.mgr, { name: 'Flour', unit_cost: 10 })).status, 200);
    assert.equal((await call('PATCH', `/api/stock/ingredients/${I1}`, T.costs, { unit_cost: 3 })).status, 200);
    assert.equal(mem.db.ingredients.find((i) => i.id === I1).unit_cost, 3);
  });
  await ok('3. prices: a combo\'s price, a variant\'s and a modifier\'s need menu.prices; never negative', async () => {
    mem.db.products.push({ id: 'combo1', business_id: B, name: 'Meal', is_combo: true, combo_price: 300, base_price: 300 });
    assert.equal((await call('PATCH', '/api/combos/combo1', T.mgr, { combo_price: 1 })).status, 403);
    assert.equal((await call('PATCH', '/api/combos/combo1', T.mgr, { name: 'Meal', combo_price: 300 })).status, 200, 'unchanged is fine');
    assert.equal((await call('PATCH', '/api/combos/combo1', T.costs, { combo_price: 250 })).status, 200);
    mem.db.variant_groups.push({ id: 'vg1', product_id: P1, name: 'Size' });
    mem.db.variant_options.push({ id: 'vo1', variant_group_id: 'vg1', name: 'L', price_adjustment: 20 });
    assert.equal((await call('PATCH', '/api/variants/options/vo1', T.mgr, { name: 'L', price_adjustment: 0 })).status, 403);
    assert.equal((await call('PATCH', '/api/variants/options/vo1', T.costs, { price_adjustment: -5 })).status, 400);
    assert.equal((await call('POST', '/api/variants/options', T.mgr, { variant_group_id: 'vg1', name: 'XL', price_adjustment: 50 })).status, 403);
    assert.equal((await call('PATCH', '/api/variants/options/vo1', T.mgr, { name: 'Large', price_adjustment: 20 })).status, 200);
    mem.db.modifier_groups.push({ id: 'mg1', product_id: P1, name: 'Extras' });
    mem.db.modifier_options.push({ id: 'mo1', modifier_group_id: 'mg1', name: 'Cheese', price: 30 });
    assert.equal((await call('PATCH', '/api/modifiers/options/mo1', T.mgr, { price: 0 })).status, 403);
    assert.equal((await call('POST', '/api/modifiers/options', T.costs, { modifier_group_id: 'mg1', name: 'Bad', price: -10 })).status, 400);
    assert.equal((await call('PATCH', '/api/modifiers/options/mo1', T.costs, { price: 35 })).status, 200);
    assert.equal(mem.db.modifier_options[0].price, 35);
  });

  console.log('\n4. A blind count stays blind beside the count screen\n');
  reset(); openCount();
  mem.db.stock_movements.push({ id: 'm1', product_id: P1, branch_id: BR, quantity_after: 7, 'products.business_id': B, movement_type: 'sale' },
    { id: 'mf', product_id: PF, branch_id: BR, quantity_after: 70, 'products.business_id': B, movement_type: 'sale' });
  mem.db.ingredient_stock_movements.push({ id: 'im1', business_id: B, ingredient_id: I1, branch_id: BR, quantity_after: 9 });
  mem.db.stock_batches.push({ id: 'b1', business_id: B, branch_id: BR, item_kind: 'product', product_id: P1, expiry_date: '2099-01-01', quantity_received: 5, received_at: '2026-01-01', closed_at: null });
  await ok('4. wastage /items: what is held of a counted item is not sent', async () => {
    const r = await call('GET', `/api/wastage/items?branch_id=${BR}`, T.mgr);
    assert.equal(r.body.find((i) => i.id === P1).held, null);
    assert.equal(r.body.find((i) => i.id === I1).held, null);
    assert.equal((await call('GET', `/api/wastage/items?branch_id=${BR}`, T.adj)).body.find((i) => i.id === P1).held, 7, 'inventory.adjust sees it');
  });
  await ok('4. "only N at this branch" leaves the figure out while counting (wastage and returns)', async () => {
    const w = await call('POST', '/api/wastage', T.mgr, { branch_id: BR, reason: 'expired', note: 'x', items: [{ kind: 'product', id: P1, quantity: 50 }] });
    assert.equal(w.status, 409, JSON.stringify(w.body));
    assert.doesNotMatch(w.body.error, /7/); assert.match(w.body.error, /not enough stock/);
    const r = await call('POST', '/api/payables/returns', T.mgr, { supplier_id: S1, branch_id: BR, reason: 'bad', items: [{ kind: 'ingredient', id: I1, quantity: 50 }] });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.doesNotMatch(r.body.error, /9/);
    const a = await call('POST', '/api/payables/returns', T.adj, { supplier_id: S1, branch_id: BR, reason: 'bad', items: [{ kind: 'ingredient', id: I1, quantity: 50 }] });
    assert.match(a.body.error, /only 9/, 'inventory.adjust is told the figure');
  });
  await ok('4. batches: what is left (worked out from the level) and the unbatched line are not sent', async () => {
    const r = await call('GET', '/api/batches', T.mgr);
    assert.equal(r.body.batches[0].remaining, null);
    assert.equal(r.body.unbatched.length, 0);
    const a = await call('GET', '/api/batches', T.adj);
    assert.equal(a.body.batches[0].remaining, 5);
    assert.equal(a.body.unbatched[0].quantity, 2);
  });
  await ok('4. movements: the level after each movement of a counted item is not sent', async () => {
    assert.equal((await call('GET', '/api/inventory/movements', T.mgr)).body.find((m) => m.id === 'm1').quantity_after, null);
    assert.equal((await call('GET', `/api/stock/ingredients/${I1}/movements`, T.mgr)).body[0].quantity_after, null);
    assert.equal((await call('GET', '/api/inventory/movements', T.adj)).body.find((m) => m.id === 'm1').quantity_after, 7);
  });
  await ok('4. fuel-tank movements list fuel products only', async () => {
    const r = await call('GET', '/api/fuel-tanks/movements', T.mgr);
    assert.deepEqual(r.body.map((m) => m.id), ['mf']);
  });

  console.log('\n5. Data routes gated\n');
  reset();
  mem.db.customers.push({ id: 'cu1', business_id: B, name: 'Ann', phone: '0700', credit_limit: 100, credit_balance: 50, loyalty_points: 0 });
  await ok('5. credit accounts and ledger: customers.view (or customers.credit)', async () => {
    assert.equal((await call('GET', '/api/credit/customers', T.cash)).status, 403);
    assert.equal((await call('GET', '/api/credit/customer/cu1', T.cash)).status, 403);
    assert.equal((await call('GET', '/api/credit/customer/cu1', T.mgr)).status, 200);
  });
  await ok('5. loyalty: the list, history and insights need customers.view; the exact-phone lookup stays the POS\'s', async () => {
    assert.equal((await call('GET', '/api/loyalty/customers', T.cash)).status, 403);
    assert.equal((await call('GET', '/api/loyalty/customer/cu1/transactions', T.cash)).status, 403);
    assert.equal((await call('GET', '/api/loyalty/customer/cu1/insights', T.cash)).status, 403);
    assert.equal((await call('GET', '/api/loyalty/customer?phone=0700', T.cash)).status, 200);
    assert.equal((await call('GET', '/api/loyalty/customers', T.mgr)).status, 200);
  });
  await ok('5. webhooks: the list and deliveries need settings.integrations', async () => {
    mem.db.webhooks.push({ id: 'wh1', business_id: B, url: 'https://x.example' });
    assert.equal((await call('GET', '/api/webhooks', T.cash)).status, 403);
    assert.equal((await call('GET', '/api/webhooks/wh1/deliveries', T.cash)).status, 403);
    assert.equal((await call('GET', '/api/webhooks', T.mgr)).status, 200);
  });
  await ok('5. branches are read with an explicit column list — never the reveal code', async () => {
    const cols = [];
    mem.fail = (table, op, _f, _p, c) => { if (table === 'branches' && op === 'select') cols.push(c); return null; };
    assert.equal((await call('GET', '/api/branches', T.cash)).status, 200);
    assert.equal((await call('GET', `/api/branches/${BR}`, T.cash)).status, 200);
    mem.fail = () => null;
    assert.equal(cols.length, 2);
    for (const c of cols) { assert.doesNotMatch(c, /\*|tech_reveal_code|_by\b/); assert.match(c, /\bname\b/); }
  });

  console.log('\n6. The owner\'s own settings\n');
  reset();
  await ok('6. supervisor PIN, M-Pesa credentials and unknown keys: the owner only; a known option: settings.business', async () => {
    for (const key of ['supervisor_pin', 'mpesa_consumer_key', 'mpesa_passkey', 'mpesa_shortcode', 'some_new_key']) {
      const r = await call('POST', '/api/business/settings', T.mgr, { key, value: '1234' });
      assert.equal(r.status, 403, key); assert.equal(r.body.code, 'OWNER_ONLY', key);
    }
    // A502: the void / refund rules and the count freeze are their own rights (no role starts with them) — a manager
    // without them is refused; someone the owner gave settings.reversals / inventory.count_freeze may set them.
    for (const [key, right, value] of [['void_window_minutes', 'settings.reversals', '30'], ['stock_count_freeze', 'inventory.count_freeze', 'true']]) {
      const no = await call('POST', '/api/business/settings', T.mgr, { key, value });
      assert.equal(no.status, 403, key); assert.match(String(no.body.detail), new RegExp(right.replace('.', '\.')), key);
    }
    assert.equal(mem.db.business_settings.length, 0);
    for (const [key, right, value] of [['void_window_minutes', 'settings.reversals', 30], ['stock_count_freeze', 'inventory.count_freeze', true]]) {
      const yes = await call('POST', '/api/business/settings', tok({ userId: MGR, permissionKeys: [...MGR_KEYS, right] }), { key, value });
      assert.equal(yes.status, 200, `${key} with ${right}: ${yes.status} ${JSON.stringify(yes.body)}`);
    }
    mem.db.business_settings.length = 0;
    assert.equal((await call('POST', '/api/business/settings', T.mgr, { key: 'scanner_beep', value: 'true' })).status, 200);
    assert.equal((await call('POST', '/api/business/settings', T.mgr, { key: 'parking_rate_suv', value: '300' })).status, 200);
    assert.equal((await call('POST', '/api/business/settings', T.owner, { key: 'supervisor_pin', value: '1234' })).status, 200);
    assert.equal((await call('POST', '/api/business/settings', T.owner, { key: 'mpesa_shortcode', value: '174379' })).status, 200);
  });
  await ok('6. sign-in codes: the real owner only (not settings.pos, not a till)', async () => {
    assert.equal((await call('PUT', '/api/controls/pos/login_codes', T.mgr, { enabled: false })).status, 403);
    assert.equal((await call('PUT', '/api/controls/pos/delivery_fee', T.mgr, { enabled: true })).status, 200, 'the other options stay settings.pos');
    assert.equal((await call('PUT', '/api/controls/pos/login_codes', T.owner, { enabled: false })).status, 200);
  });

  console.log('\n7. Discounts\n');
  reset();
  mem.db.discounts.push({ id: 'd1', business_id: B, name: 'Ten', type: 'percentage', value: 10, promo_code: 'VIP', min_order_value: 500, max_uses: 3, used_count: 0, expires_at: '2099-01-01', status: 'active' },
    { id: 'd2', business_id: B, name: 'Auto', type: 'fixed', value: 50, promo_code: null, min_order_value: 0, max_uses: null, used_count: 0, expires_at: null, status: 'active' });
  await ok('7. an edit checks the value against the type it will have; absent fields are kept', async () => {
    assert.equal((await call('PUT', '/api/discounts/d1', T.mgr, { value: 500 })).status, 400);
    mem.db.discounts.push({ id: 'd3', business_id: B, name: 'Big', type: 'fixed', value: 500, promo_code: 'BIG', status: 'inactive' });
    assert.equal((await call('PUT', '/api/discounts/d3', T.mgr, { type: 'percentage' })).status, 400, 'a fixed 500 may not become 500%');
    mem.db.discounts.pop();
    assert.equal((await call('PUT', '/api/discounts/d1', T.mgr, { name: 'Ten off' })).status, 200);
    const d = mem.db.discounts[0];
    assert.equal(d.promo_code, 'VIP'); assert.equal(d.min_order_value, 500); assert.equal(d.max_uses, 3); assert.equal(d.expires_at, '2099-01-01');
    assert.equal((await call('PUT', '/api/discounts/d1', T.mgr, { promo_code: null })).status, 200);
    assert.equal(mem.db.discounts[0].promo_code, null, 'sent as null still clears');
    mem.db.discounts[0].promo_code = 'VIP';
  });
  await ok('7. the list: a cashier gets the no-code discounts only, without codes; apply by id needs the code', async () => {
    const r = await call('GET', '/api/discounts', T.cash);
    assert.deepEqual(r.body.map((d) => d.id), ['d2']);
    assert.ok(!has(r.body, 'promo_code'));
    assert.equal((await call('GET', '/api/discounts', T.mgr)).body.length, 2);
    assert.equal((await call('POST', '/api/discounts/apply', T.cash, { discount_id: 'd1', order_total: 1000 })).status, 404);
    assert.equal((await call('POST', '/api/discounts/apply', T.cash, { code: 'VIP', order_total: 1000 })).status, 200);
    assert.equal((await call('POST', '/api/discounts/apply', T.cash, { discount_id: 'd2', order_total: 1000 })).status, 200);
  });

  console.log('\n8. Promotions\n');
  await ok('8. a promotion runs at every branch — the owner sets it, a manager with menu.offers may not', async () => {
    assert.equal((await call('POST', '/api/promotions', T.mgr, { name: 'HH', promo_type: 'happy_hour' })).status, 403);
    assert.equal((await call('POST', '/api/promotions', T.owner, { name: 'HH', promo_type: 'happy_hour' })).status, 201);
    const id = mem.db.promotions[0].id;
    assert.equal((await call('PATCH', `/api/promotions/${id}`, T.mgr, { name: 'x' })).status, 403);
    assert.equal((await call('DELETE', `/api/promotions/${id}`, T.mgr)).status, 403);
    assert.equal((await call('GET', '/api/promotions', T.mgr)).status, 200, 'reading stays');
  });

  console.log('\n9 / 10. Exports\n');
  reset();
  await ok('9. CSV cells a spreadsheet would run are neutralised; a negative amount is still a number', async () => {
    assert.equal(neutralise('=HYPERLINK("http://x")'), '\'=HYPERLINK("http://x")');
    for (const s of ['+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) assert.equal(neutralise(s)[0], '\'', s);
    assert.equal(neutralise('-1,250.00'), '-1,250.00'); assert.equal(neutralise(-3), '-3'); assert.equal(neutralise('Soda'), 'Soda');
    assert.equal(csvCell('a"b'), '"a""b"');
    mem.db.expenses.push({ id: 'e1', business_id: B, branch_id: BR, expense_date: '2026-10-10', description: '=cmd|\' /C calc\'!A0', amount: 10 });
    const r = await call('GET', '/api/reports/export/expenses?format=csv&from=2026-10-01&to=2026-10-31', T.owner);
    assert.equal(r.status, 200, r.text);
    assert.match(r.text, /"'=cmd/); assert.doesNotMatch(r.text, /"=cmd/);
  });
  await ok('9. the daily / hourly / audit CSV goes through the same cell', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/reports-daily.ts'), 'utf8');
    assert.match(src, /const lines = rows\.map\(r => r\.map\(v => csvCell\(v\)\)\.join\(','\)\);/);
  });
  await ok('10. P&L: the cost of goods sold is counted (the orders\' ids are read)', async () => {
    mem.db.orders.push({ id: 'o1', business_id: B, branch_id: BR, status: 'completed', total: 1160, subtotal: 1000, vat_amount: 160, created_at: '2026-10-10T09:00:00.000Z' });
    mem.db.order_items.push({ id: 'oi1', order_id: 'o1', quantity: 10, unit_price: 100, subtotal: 1000, products: { cost_price: 40 } });
    const r = await call('GET', '/api/reports/export/pnl?format=csv&from=2026-10-01&to=2026-10-31', T.owner);
    assert.equal(r.status, 200, r.text);
    assert.match(r.text, /"COGS","400\.00"/);
  });

  console.log('\n11. A till\'s own sign-in never sees unblinded data\n');
  reset(); openCount();
  await ok('11. a till\'s own sign-in sees a count blind and is not offered closing batches', async () => {
    mem.db.stock_levels[0]['products.business_id'] = B;   // the products!inner filter, as lib-memdb reads it
    const r = await call('GET', '/api/inventory', T.till);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.find((x) => x.product_id === P1).quantity, null);
    mem.db.stock_batches.push({ id: 'b1', business_id: B, branch_id: BR, item_kind: 'product', product_id: P1, expiry_date: '2099-01-01', quantity_received: 5, received_at: '2026-01-01', closed_at: null });
    const b = await call('GET', '/api/batches', T.till);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.can_close, false);
    assert.equal(b.body.batches[0].remaining, null);
    const owner = await call('GET', '/api/inventory', T.owner, undefined, { 'x-branch-id': BR });
    assert.equal(owner.body.find((x) => x.product_id === P1).quantity, 7, 'the owner sees it');
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
