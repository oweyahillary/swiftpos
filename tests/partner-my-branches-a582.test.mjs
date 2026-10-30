/**
 * partner-my-branches-a582.test.mjs — A582: "All my branches". A partner (A550) who works at SOME branches (two or more,
 * not every one) reads their branches COMBINED — never any other branch.
 *
 *   cd apps/server && npm run build && cd ../.. && NODE_PATH=$(pwd)/node_modules node --no-warnings tests/partner-my-branches-a582.test.mjs
 *
 * Owner, 2026-10-23: "assume i have partner a and they fully own shop x,y and z they should never see general sales for
 * all stores only their store" … "yes i want all my branch feature".
 *
 * RUNS the COMPILED cloud (routes/index.js — every router — behind the REAL requireAuth, rbac and every guard) on a real
 * Express server over HTTP with real signed tokens. The database: tests/lib-memdb.mjs (an in-memory PostgREST); the
 * analytics aggregates: the REAL SQL functions (every migration through 171 replayed into PGlite — scripts/lib/analytics-pg),
 * so p_branches is answered by Postgres itself.
 *
 * The business has four branches — Xenon, Yarrow, Zephyr (the partner's) and Westgate (W, not theirs) — and W is seeded with
 * distinctive data in every table a read touches: the name "Westgate", the product "Wakanda special", the cashier "Wanda",
 * the customer "Wilma", the amount 99999. A response carrying any of them, or W's id, is a leak.
 *
 *   M  the mode: X-Branch-Id 'mine' → exactly their list (branchFilter 'set', branchScope NO_BRANCH, never null / all);
 *      forged values (W's id, 'all', '', NO_BRANCH, another business's branch) never reach W or every branch; a partner of
 *      every branch, of one branch, a manager and the owner exactly as before; ?branch_id= one of theirs narrows to it.
 *   S  the sweep: ~90 reads (reports, the dashboard's overview, orders and search, shifts and Z-reports, day close, tills,
 *      stock, counts, wastage, batches, expenses, payables, credit, notifications, the watch list, staff, branches, offers,
 *      devices, parking, printers, reservations, fuel, labels, recipes, approvals, eTIMS, the till's reads, loyalty, exports
 *      as CSV, every analytics area) in set mode AND with W forged in ?branch_id= / ?branch= — never a W marker.
 *   C  combined: the totals and lists are X + Y + Z exactly (sales, orders, shifts, expenses, credit, notifications, watch
 *      list, staff, analytics menu and the Branches comparison of their three).
 *   O  one-branch-only reads answer 400 PICK_ONE_BRANCH "Pick one of your branches for this" (never an empty page).
 *   W  writes in a set: refused 400 PICK_ONE_BRANCH before any route (orders, staff, expenses, stock, settings) — sign-in
 *      housekeeping and marking their own notifications read still go; picking one branch writes as before.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A582 entry):
 *   - branchFilter answering { kind: 'all' } for a set                          → S and C fail (W everywhere)
 *   - requireAuth leaving branchId null in a set (no NO_BRANCH)                  → M "branchScope NO_BRANCH" and S fail
 *   - partnerBranchSet taking 'mine' for a partner of every branch / of one     → M "only for some branches" fails
 *   - assertBranchAccess admitting any branch in a set                           → S "forged W" (branches/:id/stock …) fails
 *   - analytics scopeArgs not sending p_branches (every branch)                  → S analytics and C "analytics menu" fail
 *   - the set-mode write refusal removed                                         → W fails
 *   - compareWithin refusing a partner of some branches                          → C "the Branches comparison" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';
import { openSchema } from '../scripts/lib/analytics-pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.message).slice(0, 2500)}\n      ${String(e.stack).split('\n').slice(1, 3).join(' ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/webPartners.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.SUPABASE_ANON_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const AC = require(path.join(DIST, 'lib/authCache.js'));
const rbac = require(path.join(DIST, 'middleware/rbac.js'));
const { requireAuth } = require(path.join(DIST, 'middleware/auth.js'));
const WP = require(path.join(DIST, 'lib/webPartners.js'));
const ANALYTICS = require(path.join(DIST, 'routes/analytics.js'));
const P = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {}; console.error = () => {};

// ── ids ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = u(900), B2 = u(910);
const X = u(901), Y = u(902), Z = u(903), W = u(904), BB = u(911);
const OWNER = u(1), PAT = u(2), PALL = u(3), PONE = u(4), MGRX = u(5), WANDA = u(6), XAVI = u(7), YARA = u(8), ZED = u(9);
const NO_BRANCH = '00000000-0000-0000-0000-000000000000';
const GM_KEYS = [...P.BUILT_IN_ROLES.find((r) => r.name === 'General Manager').keys];
const MGR_KEYS = ['reports.sales', 'reports.overview', 'orders.view_all', 'inventory.view', 'staff.view'];
const MARKS = [W, 'Westgate', 'Wakanda', 'Wanda', 'Wilma', '99999'];
const leaks = (text) => MARKS.filter((m) => text.includes(m));
const AT = '2026-10-20T09:00:00Z';
const RANGE = 'from=2026-10-01&to=2026-10-22';

// ── PGlite: the analytics SQL for real (through 171) ─────────────────────────────────────────────────────────────────
const pg = await openSchema({ through: 171 });
{
  const { put } = pg;
  await put('businesses', { id: B, name: 'Pollo', type: 'restaurant' });
  await put('businesses', { id: B2, name: 'Kuku', type: 'restaurant' });
  for (const [id, name] of [[X, 'Xenon'], [Y, 'Yarrow'], [Z, 'Zephyr'], [W, 'Westgate']]) await put('branches', { id, business_id: B, name });
  await put('branches', { id: BB, business_id: B2, name: 'Elsewhere' });
  for (const [id, name] of [[XAVI, 'Xavi'], [YARA, 'Yara'], [ZED, 'Zed'], [WANDA, 'Wanda']]) await put('users', { id, business_id: B, name, email: `${name.toLowerCase()}@t` });
  const prod = async (name, price) => (await put('products', { business_id: B, name, base_price: price, cost_price: Math.round(price / 3) })).id;
  const PX = await prod('Xenon wrap', 100), PY = await prod('Yarrow tea', 200), PZ = await prod('Zephyr cake', 300), PW = await prod('Wakanda special', 99999);
  const sale = async (branch, cashier, pid, name, total, extra = {}) => {
    const o = await put('orders', { business_id: B, branch_id: branch, order_number: `A-${Math.random().toString(36).slice(2, 8)}`, status: 'completed',
      total, subtotal: total, discount_amount: 0, cashier_id: cashier, created_at: AT, order_type: 'dine_in', ...extra });
    await put('order_items', { order_id: o.id, product_id: pid, product_name: name, quantity: 1, unit_price: total, subtotal: total });
    await put('order_items', { order_id: o.id, product_id: PX, product_name: 'Xenon wrap', quantity: 1, unit_price: 0.01, subtotal: 0.01 });
  };
  for (let i = 0; i < 2; i++) await sale(X, XAVI, PX, 'Xenon wrap', 100);
  await sale(Y, YARA, PY, 'Yarrow tea', 200);
  await sale(Z, ZED, PZ, 'Zephyr cake', 300);
  for (let i = 0; i < 3; i++) await sale(W, WANDA, PW, 'Wakanda special', 99999, { discount_amount: 999 });
  await put('orders', { business_id: B, branch_id: W, order_number: 'W-VOID', status: 'voided', total: 99999, subtotal: 99999, discount_amount: 0, cashier_id: WANDA, created_at: AT });
  await put('wastage_entries', { business_id: B, branch_id: W, ref: 'W-1', item_kind: 'product', product_id: PW, name: 'Wakanda special', quantity: 1, unit_cost: 99999, value: 99999, reason: 'spoiled', recorded_by: WANDA, created_at: AT });
  await put('shifts', { business_id: B, branch_id: W, cashier_id: WANDA, opened_at: '2026-10-20T05:00:00Z', closed_at: '2026-10-20T15:00:00Z', status: 'closed', cash_variance: -99999 });
  const WILMA = (await put('customers', { business_id: B, name: 'Wilma', phone: '0799', credit_limit: 999999, credit_balance: 99999 })).id;
  await put('customer_credit_transactions', { business_id: B, customer_id: WILMA, branch_id: W, type: 'charge', amount: 99999, balance_after: 99999, created_at: AT });
}
mem.rpc = (name, args) => pg.rpc(name, args);

// ── memdb: everything else ───────────────────────────────────────────────────────────────────────────────────────────
const roleOf = (name, keys) => ({ id: `role-${name}`, name, role_permissions: keys.map((key) => ({ permissions: { key } })) });
const person = (id, name, role, branches, extra = {}) => ({ id, business_id: B, name, email: `${name.toLowerCase().replace(/\W/g, '')}@pollo.test`, status: 'active',
  permissions_version: 0, role_id: role?.id ?? null, roles: role, user_permissions: [], user_branches: branches.map((b) => ({ branch_id: b, branches: { id: b, name: BNAME[b] } })), ...extra });
const BNAME = { [X]: 'Xenon', [Y]: 'Yarrow', [Z]: 'Zephyr', [W]: 'Westgate', [BB]: 'Elsewhere' };
const orderRow = (id, branch, cashier, total, extra = {}) => ({ id, business_id: B, branch_id: branch, order_number: `${BNAME[branch]?.[0] ?? 'Q'}-${id.slice(-4)}`, status: 'completed',
  order_type: 'dine_in', subtotal: total, vat_amount: 0, discount_amount: 0, total, refunded_amount: 0, created_at: AT, cashier_id: cashier,
  branches: { name: BNAME[branch] }, payments: [{ method: 'cash', amount: total, status: 'completed' }], customer_name: null, ...extra });
const O = { x1: u(501), x2: u(502), y1: u(503), z1: u(504), w1: u(505), w2: u(506) };
const SH = { x: u(601), w: u(602) };
const reset = () => {
  mem.fail = () => null; mem.calls = []; AC._resetAuthCache(); ANALYTICS._analyticsCache().clear();
  const GM = roleOf('General Manager', GM_KEYS), MGR = roleOf('Manager', MGR_KEYS), CASH = roleOf('Cashier', ['orders.create']);
  const users = [
    person(OWNER, 'Owner', roleOf('Admin', []), [X]),
    person(PAT, 'Patty', GM, [X, Y, Z]), person(PALL, 'Allie', GM, []), person(PONE, 'Oneil', GM, [X]),
    person(MGRX, 'Max', MGR, [X]), person(XAVI, 'Xavi', CASH, [X]), person(YARA, 'Yara', CASH, [Y]), person(ZED, 'Zed', CASH, [Z]),
    person(WANDA, 'Wanda', CASH, [W], { email: 'wanda@westgate.test', phone: '0799999990' }),
  ];
  const ub = users.flatMap((p) => p.user_branches.map((b) => ({ user_id: p.id, branch_id: b.branch_id, users: p, 'users.business_id': B })));   // the embed's filter, as PostgREST applies it
  const lvl = (id, product, branch, qty, name) => ({ id, product_id: product, branch_id: branch, quantity: qty, qty_pieces: 0, low_stock_threshold: 5,
    'products.business_id': B, products: { id: product, name, business_id: B, status: 'active', track_stock: true } });
  mem.db = {
    businesses: [{ id: B, owner_id: 'auth-owner', name: 'Pollo', status: 'active', type: 'restaurant', currency: 'KES' },
      { id: B2, owner_id: 'auth-o2', name: 'Kuku', status: 'active', type: 'restaurant', currency: 'KES' }],
    branches: [X, Y, Z, W].map((id, i) => ({ id, business_id: B, name: BNAME[id], status: 'active', is_main: i === 0, address: `${BNAME[id]} road`, phone: null, created_at: `2026-01-0${i + 1}` }))
      .concat([{ id: BB, business_id: B2, name: 'Elsewhere', status: 'active', is_main: true }]),
    users, user_branches: ub, roles: [], role_permissions: [], user_permissions: [],
    permissions: P.PERMISSION_KEYS.map((k, i) => ({ id: `perm-${i}`, key: k })),
    feature_flags: [{ business_id: B, key: 'analytics', enabled: true }, { business_id: B, key: 'web_hosting', enabled: true }],
    business_settings: [], branch_settings: [], refresh_tokens: [], audit_log: [], sync_versions: [], sync_changes: [],
    orders: [orderRow(O.x1, X, XAVI, 100), orderRow(O.x2, X, XAVI, 100), orderRow(O.y1, Y, YARA, 200), orderRow(O.z1, Z, ZED, 300),
      orderRow(O.w1, W, WANDA, 99999, { customer_name: 'Wilma', order_number: 'W-99999' }),
      orderRow(O.w2, W, WANDA, 99999, { status: 'open', order_type: 'dine_in', table_number: 'Westgate 9', seated_at: AT, covers: 2 })],
    order_items: [
      { id: 'oi-x', order_id: O.x1, product_id: 'p-x', product_name: 'Xenon wrap', quantity: 1, subtotal: 100, unit_price: 100 },
      { id: 'oi-w', order_id: O.w1, product_id: 'p-w', product_name: 'Wakanda special', quantity: 1, subtotal: 99999, unit_price: 99999 }],
    payments: [],
    shifts: [
      { id: SH.x, business_id: B, branch_id: X, cashier_id: XAVI, opened_by: XAVI, status: 'closed', opened_at: AT, closed_at: AT, opening_float: 0, closing_float: 100, cash_variance: 0, device_id: 'dev-x', branches: { name: 'Xenon' } },
      { id: SH.w, business_id: B, branch_id: W, cashier_id: WANDA, opened_by: WANDA, status: 'closed', opened_at: AT, closed_at: AT, opening_float: 0, closing_float: 99999, cash_variance: -99999, expected_cash: 99999, device_id: 'dev-w', branches: { name: 'Westgate' } }],
    float_transactions: [], kitchen_voids: [], price_overrides: [],
    expenses: [
      { id: 'ex-x', business_id: B, branch_id: X, description: 'Xenon gas', amount: 50, expense_date: '2026-10-20', created_at: AT, branches: { name: 'Xenon' }, expense_categories: { name: 'Fuel' } },
      { id: 'ex-w', business_id: B, branch_id: W, description: 'Wakanda rent', amount: 99999, expense_date: '2026-10-20', created_at: AT, branches: { name: 'Westgate' }, expense_categories: { name: 'Rent' } }],
    credit_confirmations: [
      { order_id: O.x1, business_id: B, branch_id: X, customer_id: 'c-x', amount: 100, state: 'awaiting', source: 'web', sold_at: AT },
      { order_id: O.w1, business_id: B, branch_id: W, customer_id: 'c-w', amount: 99999, state: 'disputed', source: 'web', sold_at: AT, dispute_reason: 'Wilma says no' }],
    customers: [{ id: 'c-x', business_id: B, name: 'Xena', credit_limit: 500, credit_balance: 100, status: 'active' }],
    notifications: [
      { id: 'n-x', business_id: B, branch_id: X, user_id: null, type: 'low_stock', title: 'Xenon alert', message: 'low', created_at: AT, read_at: null },
      { id: 'n-w', business_id: B, branch_id: W, user_id: null, type: 'low_stock', title: 'Westgate alert', message: 'Wakanda low', created_at: AT, read_at: null },
      { id: 'n-none', business_id: B, branch_id: null, user_id: null, type: 'system', title: 'Business notice', message: 'all', created_at: AT, read_at: null }],
    loss_alerts: [
      { id: 'la-x', business_id: B, branch_id: X, kind: 'voids', period: 'day', business_date: '2026-10-22', staff_id: XAVI, count: 3, amount: 300, score: 2, message: 'Xavi voids', dismissed_at: null },
      { id: 'la-w', business_id: B, branch_id: W, kind: 'voids', period: 'day', business_date: '2026-10-22', staff_id: WANDA, count: 9, amount: 99999, score: 9, message: 'Wanda voids', dismissed_at: null }],
    stock_levels: [lvl('sl-x', 'p-x', X, 5, 'Xenon wrap'), lvl('sl-w', 'p-w', W, 99999, 'Wakanda special')],
    stock_movements: [
      { id: 'sm-x', product_id: 'p-x', branch_id: X, movement_type: 'restock', quantity_change: 5, quantity_after: 5, created_at: AT, 'products.business_id': B, products: { name: 'Xenon wrap', business_id: B } },
      { id: 'sm-w', product_id: 'p-w', branch_id: W, movement_type: 'restock', quantity_change: 99999, quantity_after: 99999, created_at: AT, 'products.business_id': B, products: { name: 'Wakanda special', business_id: B } }],
    stock_adjustments: [],
    // the catalogue is the business's (every branch sells from it): no W marker in it — W's are in W's own rows
    products: [{ id: 'p-x', business_id: B, name: 'Xenon wrap', status: 'active', track_stock: true, base_price: 100 },
      { id: 'p-w', business_id: B, name: 'Catalogue item', status: 'active', track_stock: true, base_price: 50 }],
    ingredients: [{ id: 'ing-1', business_id: B, name: 'Flour', unit: 'kg', status: 'active', category: 'dry',
      ingredient_stock_levels: [{ branch_id: X, current_stock: 5, reorder_level: 1 }, { branch_id: W, current_stock: 99999, reorder_level: 1 }] }],
    ingredient_stock_movements: [{ id: 'ism-w', ingredient_id: 'ing-1', business_id: B, branch_id: W, quantity_change: 99999, quantity_after: 99999, created_at: AT }],
    recipes: [{ id: 'r-1', business_id: B, product_id: 'p-x', ingredient_id: 'ing-1', quantity_per_serving: 1, unit: 'kg', products: { id: 'p-x', name: 'Xenon wrap' },
      ingredients: { id: 'ing-1', name: 'Flour', unit: 'kg', ingredient_stock_levels: [{ branch_id: X, current_stock: 5 }, { branch_id: W, current_stock: 99999 }] } }],
    purchase_orders: [{ id: 'po-w', business_id: B, branch_id: W, po_number: 'PO-Westgate', status: 'draft', deleted_at: null, created_at: AT, purchase_order_items: [] }],
    goods_received_notes: [{ id: 'grn-w', business_id: B, branch_id: W, grn_number: 'GRN-Westgate', created_at: AT, grn_items: [] }],
    stock_transfers: [{ id: 'tr-w', business_id: B, from_branch_id: W, to_branch_id: BB, status: 'pending', created_at: AT, stock_transfer_items: [] }],
    stock_transfer_requests: [{ id: 'rq-w', business_id: B, from_branch_id: W, to_branch_id: W, product_id: 'p-w', quantity: 99999, status: 'requested', requested_at: AT, requested_by_name: 'Wanda' }],
    stock_takes: [{ id: 'st-w', business_id: B, branch_id: W, ref: 'ST-Westgate', status: 'counting', started_at: AT, branches: { name: 'Westgate' } }],
    stock_take_lines: [],
    wastage_entries: [{ id: 'we-w', business_id: B, branch_id: W, ref: 'WS-Westgate', item_kind: 'product', product_id: 'p-w', name: 'Wakanda special', quantity: 1, value: 99999, created_at: AT, recorded_by_name: 'Wanda' }],
    stock_batches: [{ id: 'sb-w', business_id: B, branch_id: W, item_kind: 'product', product_id: 'p-w', batch_no: 'B-Westgate', quantity_received: 99999, received_at: AT, closed_at: null, source: 'grn' }],
    supplier_returns: [{ id: 'sr-w', business_id: B, branch_id: W, supplier_id: 's-1', created_at: AT, suppliers: { name: 'Wakanda supplies' }, supplier_return_items: [] }],
    user_devices: [
      { id: 'ud-x', business_id: B, device_id: 'dev-x', device_label: 'Xenon till', branch_id: X, status: 'approved', retired_at: null, user_id: null, last_sync_at: AT },
      { id: 'ud-w', business_id: B, device_id: 'dev-w', device_label: 'Westgate till', terminal_code: 'W1', branch_id: W, status: 'approved', retired_at: null, user_id: null, last_sync_at: AT }],
    business_days: [{ id: 'bd-w', business_id: B, branch_id: W, device_id: 'dev-w', business_date: '2026-10-20', status: 'open', opened_at: AT }],
    day_close_instructions: [],
    parking_sessions: [{ id: 'pk-w', business_id: B, branch_id: W, vehicle_plate: 'WAKANDA 1', status: 'active', started_at: AT }],
    branch_printers: [{ id: 'pr-w', business_id: B, branch_id: W, name: 'Westgate printer', type: 'receipt' }],
    reservations: [{ id: 'rs-w', business_id: B, branch_id: W, customer_name: 'Wilma', reserved_date: new Date().toISOString().slice(0, 10), reserved_time: '19:00' }],
    waitlist: [{ id: 'wl-w', business_id: B, branch_id: W, customer_name: 'Wilma', status: 'waiting', added_at: AT }],
    fuel_tanks: [{ id: 'ft-w', business_id: B, branch_id: W, name: 'Westgate tank', fuel_product_id: 'p-w', capacity_litres: 99999, current_level: 99999 }],
    pumps: [{ id: 'pm-w', business_id: B, branch_id: W, name: 'Westgate pump', sort_order: 1, status: 'active' }],
    tables: [{ id: 'tb-w', business_id: B, branch_id: W, name: 'Westgate 9', status: 'active', sort_order: 1 }],
    change_requests: [{ id: 'cr-w', business_id: B, branch_id: W, entity: 'product', op: 'update', status: 'awaiting', made_by_name: 'Wanda', proposed: { name: 'Wakanda special' }, received_at: AT }],
    offers: [{ id: 'of-w', business_id: B, name: 'Westgate deal', kind: 'percent', branch_ids: [W], deleted_at: null, created_at: AT, active: true },
      { id: 'of-x', business_id: B, name: 'Xenon deal', kind: 'percent', branch_ids: [X], deleted_at: null, created_at: AT, active: true }],
    branch_branding: [], business_branding: [], etims_branch_config: [], etims_invoices: [], loyalty_transactions: [], payment_exceptions: [],
    money_movements: [], suppliers: [], supplier_bills: [], supplier_payments: [], kitchen_tickets: [], customer_credit_transactions: [],
  };
};

// ── the real cloud, and a probe of what the middleware decided ──────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const express = require('express');
const app = express();
app.use(express.json());
const probe = express.Router();
probe.get('/who', requireAuth, (req, res) => res.json({
  branchId: req.branchId, branchSet: req.branchSet ?? null, scope: rbac.branchScope(req), filter: rbac.branchFilter(req),
  atW: rbac.assertBranchAccess(req, W), atX: rbac.assertBranchAccess(req, X), full: rbac.allBranchAccess(req),
}));
app.use('/api/probe', probe);
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, isOwner: false, surface: 'web', ...p }, process.env.JWT_SECRET, { expiresIn: '10m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'] }),
  pat: sign({ userId: PAT, branchId: null, webPartner: true, partnerBranches: [X, Y, Z], allBranches: false, permissionKeys: GM_KEYS }),
  pall: sign({ userId: PALL, branchId: null, webPartner: true, partnerBranches: [X, Y, Z, W], allBranches: true, permissionKeys: GM_KEYS }),
  pone: sign({ userId: PONE, branchId: null, webPartner: true, partnerBranches: [X], allBranches: false, permissionKeys: GM_KEYS }),
  mgr: sign({ userId: MGRX, branchId: X, permissionKeys: MGR_KEYS }),
};
const call = async (method, p, token, { headers = {}, body } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, text, body: json };
};
const MINE = { 'x-branch-id': 'mine' };
const get = (p, token = T.pat, headers = MINE) => call('GET', p, token, { headers });
const who = async (token, headers) => (await get('/api/probe/who', token, headers)).body;

// ═══ M — the mode ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nM. the mode\n');
reset();
await ok("'mine' → exactly their three branches: filter 'set', branchScope NO_BRANCH (never null, never every branch)", async () => {
  const w = await who(T.pat, MINE);
  assert.deepEqual(w.branchSet, [X, Y, Z]);
  assert.equal(w.branchId, NO_BRANCH);
  assert.equal(w.scope, NO_BRANCH);
  assert.deepEqual(w.filter, { kind: 'set', ids: [X, Y, Z] });
  assert.equal(w.atW, false); assert.equal(w.atX, true); assert.equal(w.full, false);
});
await ok('…case and spaces aside; the pure rule only for a partner of two or more branches, never of every one', async () => {
  assert.deepEqual((await who(T.pat, { 'x-branch-id': ' Mine ' })).branchSet, [X, Y, Z]);
  assert.deepEqual(WP.partnerBranchSet({ branchIds: [X, Y], allBranches: false }, 'mine'), [X, Y]);
  assert.equal(WP.partnerBranchSet({ branchIds: [X, Y, Z, W], allBranches: true }, 'mine'), null);
  assert.equal(WP.partnerBranchSet({ branchIds: [X], allBranches: false }, 'mine'), null);
  assert.equal(WP.partnerBranchSet({ branchIds: [X, Y], allBranches: false }, 'all'), null);
  assert.equal(WP.partnerBranchSet({ branchIds: [X, Y], allBranches: false }, W), null);
});
await ok('forged X-Branch-Id: W, another business\'s branch, \'all\', \'\', \'null\', NO_BRANCH — never W, never every branch', async () => {
  for (const h of [W, BB, 'all', '', 'null', NO_BRANCH, `${W},mine`, `mine,${W}`]) {
    const w = await who(T.pat, { 'x-branch-id': h });
    assert.ok([X, Y, Z].includes(w.branchId), `${JSON.stringify(h)} → ${w.branchId}`);
    assert.equal(w.branchSet, null, `${JSON.stringify(h)} is not the set`);
    assert.notEqual(w.scope, null);
    assert.equal(w.atW, false, `${JSON.stringify(h)} reaches W`);
  }
  const none = await who(T.pat, {});
  assert.ok([X, Y, Z].includes(none.branchId), 'no header: one of theirs, as before');
});
await ok('?branch_id= in a set: one of theirs narrows to it; W, \'all\', NO_BRANCH never', async () => {
  assert.deepEqual((await get(`/api/probe/who?branch_id=${Y}`)).body.filter, { kind: 'one', id: Y });
  for (const q of [W, 'all', NO_BRANCH, BB, '']) {
    const w = (await get(`/api/probe/who?branch_id=${encodeURIComponent(q)}`)).body;
    assert.deepEqual(w.filter, { kind: 'set', ids: [X, Y, Z] }, q);
    assert.equal(w.scope, NO_BRANCH, q);
  }
});
await ok('everyone else exactly as before: a partner of every branch (all), of one branch, a manager, the owner', async () => {
  const all = await who(T.pall, MINE);
  assert.equal(all.branchSet, null); assert.equal(all.branchId, null); assert.equal(all.scope, null); assert.deepEqual(all.filter, { kind: 'all' });
  const one = await who(T.pone, MINE);
  assert.equal(one.branchSet, null); assert.equal(one.branchId, X); assert.deepEqual(one.filter, { kind: 'one', id: X });
  const m = await who(T.mgr, MINE);
  assert.equal(m.branchSet, null); assert.equal(m.branchId, X); assert.equal(m.scope, X);
  const o = await who(T.owner, {});
  assert.equal(o.scope, null); assert.deepEqual(o.filter, { kind: 'all' }); assert.equal(o.full, true);
  const ox = await who(T.owner, { 'x-branch-id': W });
  assert.equal(ox.scope, W, 'the owner picks any branch');
});
await ok('the picker\'s lists: /api/branches is their three (no W), /api/auth/session says partner of some', async () => {
  const b = await get('/api/branches');
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.map((x) => x.id).sort(), [X, Y, Z].sort());
  assert.deepEqual(leaks(b.text), []);
  const s = await get('/api/auth/session');
  assert.equal(s.body.partner, true); assert.equal(s.body.allBranches, false);
  assert.deepEqual([...s.body.branchIds].sort(), [X, Y, Z].sort());
});

// ═══ S — the sweep ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nS. the sweep — every read, in a set and with W forged\n');
const READS = [
  // reports, exports (CSV), the overview's reads
  `/api/reports/sales?${RANGE}`, `/api/reports/products?${RANGE}`, `/api/reports/staff?${RANGE}`, `/api/reports/inventory?${RANGE}`,
  `/api/reports/eod?${RANGE}`, `/api/reports/shifts?${RANGE}`, `/api/reports/master?${RANGE}`, `/api/reports/hourly?${RANGE}`,
  `/api/reports/voids?${RANGE}`, `/api/reports/refunds?${RANGE}`, `/api/reports/tax?${RANGE}`, `/api/reports/products-v2?${RANGE}`,
  `/api/reports/food-cost?${RANGE}`, `/api/reports/splh?${RANGE}`, `/api/reports/fuel-sales?${RANGE}`, `/api/reports/pump-monitor?${RANGE}`,
  `/api/reports/wet-stock?${RANGE}`,
  `/api/reports/export/sales?format=csv&${RANGE}`, `/api/reports/export/products?format=csv&${RANGE}`, `/api/reports/export/pnl?format=csv&${RANGE}`,
  `/api/reports/export/shifts?format=csv&${RANGE}`, `/api/reports/export/expenses?format=csv&${RANGE}`,
  `/api/reports/export/daily?format=csv&${RANGE}`, `/api/reports/export/hourly?format=csv&${RANGE}`, `/api/reports/export/audit?format=csv&${RANGE}`,
  '/api/reports/monthly?month=2026-10', '/api/reports/monthly/movements?month=2026-10',
  // orders, search, one sale
  '/api/orders', '/api/orders?search=W', '/api/orders?with_totals=1', `/api/orders/${O.w1}`, '/api/orders/turnover', '/api/orders/turnover/report',
  // shifts, Z-reports, tills, day close
  '/api/shifts', `/api/shifts/${SH.w}`, `/api/shifts/${SH.w}/zreport`, `/api/shifts/${SH.w}/confirm-view`, `/api/shifts/state?ids=${SH.w}`,
  `/api/shifts/branch-report?from=${encodeURIComponent('2026-10-01T00:00:00Z')}&to=${encodeURIComponent('2026-10-22T00:00:00Z')}`,
  '/api/shifts/terminals', '/api/shifts/terminals/open', '/api/day-close/overview', '/api/tills-days/overview',
  // stock
  '/api/inventory', '/api/inventory/movements', '/api/stock/ingredients', '/api/stock/ingredients/ing-1/movements', '/api/stock/purchase-orders',
  '/api/stock/grn', '/api/stock/transfers', '/api/stock/other-branches?q=Wak', '/api/stock/requests', '/api/stock/requests/count',
  '/api/stock-takes', '/api/stock-takes/active', '/api/stock-takes/st-w', '/api/wastage', '/api/wastage/items', '/api/batches',
  '/api/products/labels/restocked?since=2026-10-01', '/api/recipes', '/api/recipes/p-x',
  // money
  '/api/expenses', '/api/expenses/summary', '/api/payables/summary', '/api/payables/returns', '/api/credit/sales?state=all', '/api/credit/sales/count',
  '/api/mpesa/exceptions', '/api/loyalty/customer/c-w/insights',
  // people, places, things
  '/api/notifications', '/api/loss-alerts', '/api/staff', '/api/staff/authorizers', '/api/branches', `/api/branches/${W}`, `/api/branches/${W}/staff`,
  `/api/branches/${W}/stock`, `/api/branches/${W}/settings`, `/api/branches/${W}/mpesa`, '/api/offers', '/api/devices', '/api/devices/fleet',
  '/api/parking-sessions', '/api/printers', '/api/reservations', '/api/reservations/waitlist', '/api/tables', '/api/tables/all',
  '/api/fuel-tanks', '/api/fuel-tanks/movements', '/api/pumps', '/api/changes', '/api/changes/count', '/api/business/branding/branches',
  `/api/business/branding/branches/${W}/served`, '/api/etims/config', '/api/etims/status', '/api/etims/invoices', `/api/etims/order/${O.w1}`,
  '/api/kitchen/tickets', '/api/pos/init', '/api/pos/changes', '/api/pos/stock-view', `/api/support/terminal-codes`, `/api/tech/branch-config/${W}`,
  // analytics, every area
  ...['overview', 'menu-engineering', 'heatmap', 'money-leaks', 'credit-ageing', 'item-times', 'recommendations', 'stock', 'customers', 'costs',
    'branches', 'together', 'insights'].map((a) => `/api/analytics/${a}?${RANGE}`),
];
const FORGE = (p) => {
  const sep = p.includes('?') ? '&' : '?';
  return [`${p}${sep}branch_id=${W}`, `${p}${sep}branch=${W}`];
};
const OKSTATUS = new Set([200, 204, 400, 403, 404, 503]);
reset();
await ok(`set mode: ${READS.length} reads — never a row, total, count or name of W (and never a 500)`, async () => {
  const bad = [];
  for (const p of READS) {
    const r = await get(p);
    const l = leaks(r.text);
    if (l.length || !OKSTATUS.has(r.status)) bad.push(`${p} → ${r.status} ${l.join(',')} ${r.text.slice(0, 160)}`);
  }
  assert.deepEqual(bad, []);
});
await ok('set mode with W forged in ?branch_id= and ?branch= — never W', async () => {
  const bad = [];
  for (const p of READS) for (const f of FORGE(p)) {
    const r = await get(f);
    const l = leaks(r.text.split(`branch_id=${W}`).join('').split(`branch=${W}`).join(''));
    if (l.length || !OKSTATUS.has(r.status)) bad.push(`${f} → ${r.status} ${l.join(',')} ${r.text.slice(0, 160)}`);
  }
  assert.deepEqual(bad, []);
});
await ok('forged headers (W\'s id, \'all\', \'\', NO_BRANCH): the same reads never carry W either', async () => {
  const bad = [];
  for (const h of [W, 'all', '', NO_BRANCH]) for (const p of READS) {
    const r = await get(p, T.pat, { 'x-branch-id': h });
    const l = leaks(r.text);
    if (l.length || !OKSTATUS.has(r.status)) bad.push(`[${h}] ${p} → ${r.status} ${l.join(',')} ${r.text.slice(0, 120)}`);
  }
  assert.deepEqual(bad, []);
});
await ok('the scenario is real: the owner\'s "All branches" does carry W (sales, orders, staff, analytics menu, watch list)', async () => {
  for (const p of [`/api/reports/sales?${RANGE}`, '/api/orders', '/api/staff', '/api/notifications', '/api/loss-alerts', `/api/analytics/menu-engineering?${RANGE}`]) {
    const r = await get(p, T.owner, {});
    assert.equal(r.status, 200, `${p} ${r.text.slice(0, 200)}`);
    assert.ok(leaks(r.text).length, `${p} shows W to the owner`);
  }
});

// ═══ C — combined ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nC. combined — their branches, together\n');
reset();
await ok('sales: X + Y + Z exactly (700 over 4 orders), each branch in the breakdown, no other', async () => {
  const r = await get(`/api/reports/sales?${RANGE}`);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.body.summary.totalOrders, 4);
  assert.equal(Math.round(r.body.branchBreakdown.reduce((a, b) => a + b.revenue, 0)), 700);
  assert.deepEqual(r.body.branchBreakdown.map((b) => b.branch_id).sort(), [X, Y, Z].sort());
});
await ok('one of theirs picked (?branch_id=Y) narrows to Y; the partner picking X in the picker sees X only (as before)', async () => {
  const y = await get(`/api/reports/sales?${RANGE}&branch_id=${Y}`);
  assert.deepEqual(y.body.branchBreakdown.map((b) => b.branch_id), [Y]);
  const x = await get(`/api/reports/sales?${RANGE}`, T.pat, { 'x-branch-id': X });
  assert.deepEqual(x.body.branchBreakdown.map((b) => b.branch_id), [X]);
});
await ok('orders: their four, a search across them; W\'s sale by id is not found', async () => {
  const r = await get('/api/orders');
  assert.deepEqual(r.body.orders.map((o) => o.branch_id).sort(), [X, X, Y, Z].sort());
  assert.equal((await get(`/api/orders/${O.w1}`)).status, 404);
  assert.equal((await get(`/api/orders/${O.y1}`)).status, 200);
});
await ok('shifts, expenses, credit sales, notifications, the watch list, staff: theirs, combined', async () => {
  assert.deepEqual((await get('/api/shifts')).body.map((s) => s.id), [SH.x]);
  assert.equal((await get(`/api/shifts/${SH.x}`)).status, 200);
  const ex = await get(`/api/expenses?${RANGE}`);
  assert.equal(ex.body.total, 50);
  const cr = await get('/api/credit/sales?state=all');
  assert.deepEqual(cr.body.rows.map((x) => x.branch_id), [X]);
  assert.equal(cr.body.counts.awaiting, 1); assert.equal(cr.body.counts.disputed, 0);
  const n = await get('/api/notifications');
  assert.deepEqual(n.body.notifications.map((x) => x.id), ['n-x']);
  const la = await get('/api/loss-alerts');
  assert.deepEqual(la.body.alerts.map((x) => x.id), ['la-x']);
  const st = await get('/api/staff');
  const names = st.body.map((p) => p.name).sort();
  assert.ok(['Patty', 'Xavi', 'Yara', 'Zed'].every((x) => names.includes(x)), names.join());
  assert.ok(!names.includes('Owner'), 'never the owner');
  assert.equal(new Set(st.body.map((p) => p.id)).size, st.body.length, 'each person once');
});
await ok('analytics: the menu is X + Y + Z (the real SQL, p_branches) — and the Branches comparison is their three', async () => {
  const m = await get(`/api/analytics/menu-engineering?${RANGE}`);
  assert.equal(m.status, 200, m.text.slice(0, 300));
  const items = m.body.items.map((i) => i.name);
  assert.ok(['Xenon wrap', 'Yarrow tea', 'Zephyr cake'].every((x) => items.includes(x)), items.join());
  const b = await get(`/api/analytics/branches?${RANGE}`);
  assert.equal(b.status, 200, b.text.slice(0, 300));
  assert.equal(b.body.branchCount, 3);
  assert.deepEqual(leaks(b.text), []);
  for (const n of ['Xenon', 'Yarrow', 'Zephyr']) assert.ok(b.text.includes(n), n);
  const one = await get(`/api/analytics/branches?${RANGE}`, T.pone, {});
  assert.equal(one.status, 403, 'a partner of one branch has nothing to compare');
  const mgr = await get(`/api/analytics/branches?${RANGE}`, T.mgr, {});
  assert.equal(mgr.status, 403, 'a manager: as before');
});
await ok('analytics: one of theirs (?branch=Y) is Y alone; W named is refused (403 BRANCH_SCOPE)', async () => {
  const y = await get(`/api/analytics/menu-engineering?${RANGE}&branch=${Y}`);
  assert.deepEqual(y.body.items.map((i) => i.name).filter((n) => n !== 'Xenon wrap'), ['Yarrow tea']);
  const w = await get(`/api/analytics/menu-engineering?${RANGE}&branch=${W}`);
  assert.equal(w.status, 403); assert.equal(w.body.code, 'BRANCH_SCOPE');
});

// ═══ O — one branch only ════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nO. one branch at a time — said plainly\n');
reset();
await ok('the monthly pack, tables, turnover, the kitchen, eTIMS, wastage items, other branches, authorizers, the branch report: "Pick one of your branches"', async () => {
  for (const p of ['/api/reports/monthly?month=2026-10', '/api/tables', '/api/orders/turnover', '/api/kitchen/tickets', '/api/etims/config',
    '/api/wastage/items', '/api/stock/other-branches?q=Xen', '/api/staff/authorizers', '/api/payables/summary', '/api/mpesa/exceptions',
    `/api/shifts/branch-report?from=${encodeURIComponent('2026-10-01T00:00:00Z')}&to=${encodeURIComponent('2026-10-22T00:00:00Z')}`]) {
    const r = await get(p);
    assert.equal(r.status, 400, `${p} → ${r.status} ${r.text.slice(0, 120)}`);
    assert.equal(r.body.code, 'PICK_ONE_BRANCH', p);
    assert.match(r.body.error, /^Pick one of your branches/, p);
  }
});
await ok('…and with one of theirs named they answer (the monthly pack for Y)', async () => {
  const r = await get(`/api/reports/monthly?month=2026-10&branch_id=${Y}`);
  assert.notEqual(r.body?.code, 'PICK_ONE_BRANCH', r.text.slice(0, 200));
});

// ═══ W — writes ═════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nW. a set is never a write target\n');
reset();
await ok('every write in a set is refused 400 PICK_ONE_BRANCH before any route — nothing written', async () => {
  const before = JSON.stringify(mem.db);
  for (const [m, p, body] of [['POST', '/api/orders', { branch_id: X, items: [] }], ['POST', '/api/expenses', { branch_id: X, amount: 1, description: 'x' }],
    ['PATCH', `/api/staff/${XAVI}`, { name: 'X' }], ['POST', '/api/stock/transfers', { from_branch_id: X, to_branch_id: Y, items: [] }],
    ['POST', '/api/business/settings', { key: 'x', value: 'y' }], ['POST', '/api/shifts/open', { branch_id: X }], ['DELETE', `/api/offers/of-x`, undefined],
    ['PUT', `/api/branches/${X}/mpesa`, { clear: true }], ['PATCH', '/api/loss-alerts/la-x/dismiss', {}]]) {
    const r = await call(m, p, T.pat, { headers: MINE, body });
    assert.equal(r.status, 400, `${m} ${p} → ${r.status} ${r.text.slice(0, 120)}`);
    assert.equal(r.body.code, 'PICK_ONE_BRANCH', p);
  }
  assert.equal(JSON.stringify(mem.db), before, 'nothing written');
});
await ok('…their own notifications can still be marked read (only theirs: W\'s stays unread); sign-in housekeeping goes', async () => {
  const r = await call('PATCH', '/api/notifications/read-all', T.pat, { headers: MINE });
  assert.equal(r.status, 204, r.text);
  assert.ok(mem.db.notifications.find((n) => n.id === 'n-x').read_at);
  assert.equal(mem.db.notifications.find((n) => n.id === 'n-w').read_at, null, 'W\'s untouched');
  const one = await call('PATCH', '/api/notifications/n-w/read', T.pat, { headers: MINE });
  assert.equal(one.status, 404, 'W\'s notification is not theirs');
  const lo = await call('POST', '/api/auth/logout', T.pat, { headers: MINE, body: {} });
  assert.notEqual(lo.body?.code, 'PICK_ONE_BRANCH');
});
await ok('one branch picked: the same write is not refused as a set (it reaches the route)', async () => {
  const r = await call('PATCH', '/api/loss-alerts/la-x/dismiss', T.pat, { headers: { 'x-branch-id': X }, body: {} });
  assert.notEqual(r.body?.code, 'PICK_ONE_BRANCH', r.text.slice(0, 160));
});

server.close();
console.warn = quiet.warn; console.error = quiet.error;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
