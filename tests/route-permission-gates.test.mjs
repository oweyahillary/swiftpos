/**
 * route-permission-gates.test.mjs — audit 2026-10-14: the writes that were auth-only now need their key, and every id a
 * request names is checked against the caller's business (and, for a non-owner, their branch).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/route-permission-gates.test.mjs
 *
 * The COMPILED routes (branches, discounts, promotions, recipes, webhooks, qr, printers, loyalty, flags, stock GRN,
 * branch-prices, shifts GET /:id) behind the REAL requireAuth (JWTs signed with a per-run secret), over HTTP, against an
 * in-memory database (supabase.from stubbed). And the REAL lib/changeApply.js for a till's staff PIN change.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - branches PUT /:id/stock/:productId without requireAnyPermission('inventory.adjust') → "a cashier cannot set stock" fails
 *   - changeApply staff_pin without staffEditRefusal                                        → "a manager cannot reset the owner's PIN" fails
 *   - flags.ts CLIENT_SETTABLE_FLAGS check removed                                          → "web_hosting / themes are ZapTill's" fails
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
if (!fs.existsSync(path.join(DIST, 'routes/branches.js'))) {
  console.log('\nBuild the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));

// ── ids ───────────────────────────────────────────────────────────────────────
const id = () => randomUUID();
const BZ = id(), BZ2 = id(), BR_A = id(), BR_B = id(), BR_X = id();          // BR_X is another business's
const OWNER = id(), ADMIN = id(), MGR = id(), CASHIER = id(), CASHIER_B = id(), ORDERS_ONLY = id();
const R_OWNER = id(), R_ADMIN = id(), R_MGR = id(), R_CASH = id();
const P1 = id(), P_X = id(), ING = id(), ING_X = id(), PO_X = id(), SH_A = id(), SH_B = id(), SH_X = id();

// ── an in-memory database ─────────────────────────────────────────────────────
let db;
const reset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, name: 'Pollo', menu_slug: 'pollo', qr_ordering: true, vat_rate: 16, ctl_rate: 0 },
                 { id: BZ2, owner_id: id(), name: 'Other' }],
    branches: [{ id: BR_A, business_id: BZ, name: 'A', is_main: true, status: 'active' },
               { id: BR_B, business_id: BZ, name: 'B', is_main: false, status: 'active' },
               { id: BR_X, business_id: BZ2, name: 'X', is_main: true, status: 'active' }],
    roles: [{ id: R_OWNER, name: 'owner' }, { id: R_ADMIN, name: 'admin' }, { id: R_MGR, name: 'manager' }, { id: R_CASH, name: 'cashier' }],
    users: [
      { id: OWNER, business_id: BZ, name: 'Olga', role_id: R_OWNER, status: 'active', permissions_version: 1 },
      { id: ADMIN, business_id: BZ, name: 'Ada', role_id: R_ADMIN, status: 'active', permissions_version: 1 },
      { id: MGR, business_id: BZ, name: 'Max', role_id: R_MGR, status: 'active', permissions_version: 1 },
      { id: CASHIER, business_id: BZ, name: 'Cate', role_id: R_CASH, status: 'active', permissions_version: 1 },
      { id: CASHIER_B, business_id: BZ, name: 'Bea', role_id: R_CASH, status: 'active', permissions_version: 1 },
      { id: ORDERS_ONLY, business_id: BZ, name: 'Ola', role_id: R_CASH, status: 'active', permissions_version: 1 },
    ],
    user_branches: [{ user_id: MGR, branch_id: BR_A }, { user_id: CASHIER, branch_id: BR_A }, { user_id: CASHIER_B, branch_id: BR_B }],
    user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null }],
    products: [{ id: P1, business_id: BZ, name: 'Chips', base_price: 200, status: 'active' },
               { id: P_X, business_id: BZ2, name: 'Theirs', base_price: 1, status: 'active' }],
    categories: [],
    ingredients: [{ id: ING, business_id: BZ, name: 'Oil' }, { id: ING_X, business_id: BZ2, name: 'Their oil' }],
    purchase_orders: [{ id: PO_X, business_id: BZ2, status: 'ordered' }],
    shifts: [{ id: SH_A, business_id: BZ, branch_id: BR_A, cashier_id: CASHIER, status: 'closed', opening_float: 0, opened_at: '2026-10-14T06:00:00Z' },
             { id: SH_B, business_id: BZ, branch_id: BR_B, cashier_id: CASHIER_B, status: 'closed', opening_float: 0, opened_at: '2026-10-14T06:00:00Z' },
             { id: SH_X, business_id: BZ2, branch_id: BR_X, cashier_id: id(), status: 'closed', opening_float: 0, opened_at: '2026-10-14T06:00:00Z' }],
    stock_levels: [{ id: id(), branch_id: BR_A, product_id: P1, quantity: 10 }],
    stock_movements: [], discounts: [], promotions: [], recipes: [], product_packaging: [], webhooks: [], branch_printers: [],
    customers: [{ id: 'cust-1', business_id: BZ, name: 'Kim', phone: '0700', loyalty_points: 0, status: 'active' }],
    feature_flags: [], branch_prices: [], change_requests: [], notifications: [], goods_received_notes: [], grn_items: [],
    orders: [], order_items: [], kitchen_tickets: [], float_transactions: [], business_settings: [], branch_settings: [],
  };
};
let nextId = 1;
const conflictKeys = (opts) => String(opts?.onConflict ?? 'id').split(',').map((s) => s.trim());
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null; let del = false; let one = false;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (inserted) return inserted;
    if (del) { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return hit; }
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    return rows();
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => { const key = k.includes('.') ? k.split('.').pop() : k; return k.includes('.') ? true : r[key] === v; }); return q; };
      if (prop === 'neq') return (k, v) => { f.push((r) => r[k] !== v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'ilike') return (k, v) => { f.push((r) => String(r[k] ?? '').toLowerCase() === String(v).toLowerCase()); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'delete') return () => { del = true; return q; };
      if (prop === 'insert') return (r) => {
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: x.id ?? `row-${nextId++}`, created_at: new Date().toISOString(), ...x }));
        (db[table] ??= []).push(...inserted); return q;
      };
      if (prop === 'upsert') return (r, opts) => {
        const keys = conflictKeys(opts);
        inserted = (Array.isArray(r) ? r : [r]).map((x) => {
          const hit = (db[table] ??= []).find((row) => keys.every((k) => row[k] === x[k]));
          if (hit) { Object.assign(hit, x); return hit; }
          const row = { id: `row-${nextId++}`, ...x }; db[table].push(row); return row;
        });
        return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none', code: 'PGRST116' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null, count: run().length }).then(res, rej);
      return () => q;   // select, order, limit, range, gte, lte, or, ...
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

// ── tokens ────────────────────────────────────────────────────────────────────
const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', ...p }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const T = {
  owner:   sign({ userId: OWNER, businessId: BZ, branchId: null, isOwner: true, permissionKeys: ['*'] }),
  manager: sign({ userId: MGR, businessId: BZ, branchId: BR_A, isOwner: false,
    permissionKeys: ['products.manage', 'inventory.adjust', 'inventory.receive', 'settings.manage', 'customers.manage', 'staff.manage', 'orders.create'] }),
  cashier: sign({ userId: CASHIER, businessId: BZ, branchId: BR_A, isOwner: false,
    permissionKeys: ['orders.create', 'products.view', 'inventory.view', 'customers.view'] }),
  ordersOnly: sign({ userId: ORDERS_ONLY, businessId: BZ, branchId: BR_A, isOwner: false, permissionKeys: ['orders.create', 'customers.view'] }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, businessId: BZ, branchId: BR_A, isOwner: false, permissionKeys: ['*'], surface: 'desktop' }),
};

// ── the app ───────────────────────────────────────────────────────────────────
const express = require('express');
const app = express(); app.use(express.json());
const mount = (p, mod) => app.use(p, require(path.join(DIST, mod)).default);
mount('/api/branches', 'routes/branches.js');
mount('/api/discounts', 'routes/discounts.js');
mount('/api/promotions', 'routes/promotions.js');
mount('/api/recipes', 'routes/recipes.js');
mount('/api/webhooks', 'routes/webhooks.js');
mount('/api/qr', 'routes/qr.js');
mount('/api/printers', 'routes/printers.js');
mount('/api/loyalty', 'routes/loyalty.js');
mount('/api/flags', 'routes/flags.js');
mount('/api/stock', 'routes/stock.js');
mount('/api/branch-prices', 'routes/branch-prices.js');
mount('/api/shifts', 'routes/shifts.js');
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  console.log('\n1. Branches\n');
  await ok('a cashier cannot set stock (PUT /:id/stock/:productId needs inventory.adjust)', async () => {
    reset();
    const r = await call('PUT', `/api/branches/${BR_A}/stock/${P1}`, T.cashier, { quantity: 0 });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(db.stock_levels[0].quantity, 10, 'stock untouched');
  });
  await ok('stock: another business\'s branch → 404 (owner); another branch of ours → 403 (manager); their product → 404', async () => {
    reset();
    assert.equal((await call('PUT', `/api/branches/${BR_X}/stock/${P1}`, T.owner, { quantity: 1 })).status, 404);
    assert.equal((await call('PUT', `/api/branches/${BR_B}/stock/${P1}`, T.manager, { quantity: 1 })).status, 403);
    assert.equal((await call('PUT', `/api/branches/${BR_A}/stock/${P_X}`, T.owner, { quantity: 1 })).status, 404);
    assert.equal(db.stock_levels.length, 1); assert.equal(db.stock_movements.length, 0);
  });
  await ok('stock: the body is validated (a number) and the row is answered, the movement records the real change', async () => {
    reset();
    assert.equal((await call('PUT', `/api/branches/${BR_A}/stock/${P1}`, T.manager, { quantity: '7' })).status, 400);
    assert.equal((await call('PUT', `/api/branches/${BR_A}/stock/${P1}`, T.manager, { quantity: 4, low_stock_threshold: -1 })).status, 400);
    const r = await call('PUT', `/api/branches/${BR_A}/stock/${P1}`, T.manager, { quantity: 4 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.quantity, 4);
    assert.equal(db.stock_movements[0].quantity_change, -6); assert.equal(db.stock_movements[0].quantity_after, 4);
  });
  await ok('update / deactivate / set-main need settings.manage; another business\'s branch → 404', async () => {
    reset();
    assert.equal((await call('PUT', `/api/branches/${BR_A}`, T.cashier, { name: 'Mine now' })).status, 403);
    assert.equal((await call('DELETE', `/api/branches/${BR_B}`, T.cashier)).status, 403);
    assert.equal((await call('PUT', `/api/branches/${BR_B}/set-main`, T.cashier, {})).status, 403);
    assert.equal((await call('PUT', `/api/branches/${BR_X}`, T.owner, { name: 'Taken' })).status, 404);
    assert.equal(db.branches.find((b) => b.id === BR_A).name, 'A');
    const r = await call('PUT', `/api/branches/${BR_A}`, T.manager, { name: 'Town' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(db.branches.find((b) => b.id === BR_A).name, 'Town');
    assert.equal((await call('PUT', `/api/branches/${BR_B}`, T.manager, { name: 'Not mine' })).status, 403, 'a manager: their own branch only');
    assert.equal((await call('PUT', `/api/branches/${BR_A}`, T.owner, { status: 'inactive' })).status, 400, 'the main branch is never closed');
  });
  await ok('set-main with an unknown id leaves the main branch alone (404), a real one moves it', async () => {
    reset();
    assert.equal((await call('PUT', `/api/branches/${BR_X}/set-main`, T.owner, {})).status, 404);
    assert.equal(db.branches.find((b) => b.id === BR_A).is_main, true, 'still the main branch');
    assert.equal((await call('PUT', `/api/branches/${BR_B}/set-main`, T.owner, {})).status, 200);
    assert.equal(db.branches.find((b) => b.id === BR_B).is_main, true);
  });
  await ok('another business\'s branch staff list → 404; branch overrides: a manager writes their own branch only', async () => {
    reset();
    assert.equal((await call('GET', `/api/branches/${BR_X}/staff`, T.owner)).status, 404);
    assert.equal((await call('POST', `/api/branches/${BR_B}/settings`, T.manager, { key: 'receipt_header', value: 'x' })).status, 403);
    assert.equal((await call('POST', `/api/branches/${BR_A}/settings`, T.manager, { key: 'receipt_header', value: 'x' })).status, 200);
  });

  console.log('\n2. Discounts, promotions, recipes, webhooks, QR, printers, customers\n');
  await ok('discounts: a cashier cannot create / edit / delete; a products.manage holder can; /apply stays open', async () => {
    reset();
    assert.equal((await call('POST', '/api/discounts', T.cashier, { name: 'All free', type: 'percentage', value: 100 })).status, 403);
    const r = await call('POST', '/api/discounts', T.manager, { name: 'Ten', type: 'percentage', value: 10 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const did = r.body.id;
    assert.equal((await call('PUT', `/api/discounts/${did}`, T.cashier, { value: 100 })).status, 403);
    assert.equal((await call('PATCH', `/api/discounts/${did}/toggle`, T.cashier, {})).status, 403);
    assert.equal((await call('DELETE', `/api/discounts/${did}`, T.cashier)).status, 403);
    assert.equal((await call('PUT', `/api/discounts/${did}`, T.manager, { type: 'percentage', value: 1000 })).status, 400, 'an edit keeps the 1-100 rule');
    assert.notEqual((await call('POST', '/api/discounts/apply', T.cashier, { discount_id: did, order_total: 100 })).status, 403);
  });
  await ok('promotions: products.manage, and every product / category it names is ours', async () => {
    reset();
    assert.equal((await call('POST', '/api/promotions', T.cashier, { name: 'x', promo_type: 'discount' })).status, 403);
    // A494: a promotion runs at every branch — a manager's menu.offers no longer writes one (OWNER_ONLY); the owner's
    // ids are still checked.
    assert.equal((await call('POST', '/api/promotions', T.manager, { name: 'x', promo_type: 'discount', product_ids: [P1] })).status, 403);
    assert.equal((await call('POST', '/api/promotions', T.owner, { name: 'x', promo_type: 'discount', product_ids: [P_X] })).status, 400);
    assert.equal((await call('POST', '/api/promotions', T.owner, { name: 'x', promo_type: 'discount', product_ids: [P1] })).status, 201);
  });
  await ok('recipes: products.manage, and a line\'s ingredient must be ours', async () => {
    reset();
    const line = (i) => ({ lines: [{ ingredient_id: i, quantity_per_serving: 1 }] });
    assert.equal((await call('POST', `/api/recipes/${P1}`, T.cashier, line(ING))).status, 403);
    assert.equal((await call('DELETE', `/api/recipes/${P1}`, T.cashier)).status, 403);
    assert.equal((await call('POST', `/api/recipes/${P1}/packaging`, T.cashier, { lines: [] })).status, 403);
    assert.equal((await call('POST', `/api/recipes/${P1}`, T.manager, line(ING_X))).status, 400);
    assert.equal((await call('POST', `/api/recipes/${P1}`, T.manager, line(ING))).status, 200);
  });
  await ok('webhooks: settings.manage for every write and the list (A494)', async () => {
    reset();
    assert.equal((await call('POST', '/api/webhooks', T.cashier, { url: 'https://evil.example/x' })).status, 403);
    assert.equal(db.webhooks.length, 0);
    // A494: the list (where the business's orders are sent) is settings.integrations too — not a cashier's.
    assert.equal((await call('GET', '/api/webhooks', T.cashier)).status, 403);
    assert.equal((await call('GET', '/api/webhooks', T.manager)).status, 200);
    assert.equal((await call('POST', '/api/webhooks', T.manager, { url: 'https://ok.example/x' })).status, 201);
    const wid = db.webhooks[0].id;
    assert.equal((await call('PATCH', `/api/webhooks/${wid}`, T.cashier, { url: 'https://evil.example' })).status, 403);
    assert.equal((await call('DELETE', `/api/webhooks/${wid}`, T.cashier)).status, 403);
    assert.equal((await call('POST', `/api/webhooks/${wid}/test`, T.cashier, {})).status, 403);
  });
  // A495: the cloud now derives the QR order's branch (the table's, else the business's main branch) — another business's
  // branch_id sent by the page is never used: the order lands in this business's own branch instead of a 404.
  await ok('QR: settings need settings.manage; a public order never lands in another business\'s branch, bad quantities → 400', async () => {
    reset();
    assert.equal((await call('PATCH', '/api/qr/settings', T.cashier, { qr_ordering: false })).status, 403);
    assert.equal((await call('PATCH', '/api/qr/settings', T.manager, { qr_ordering: false })).status, 200);
    db.businesses[0].qr_ordering = true;
    assert.equal((await call('POST', '/api/qr/pollo/order', null, { branch_id: BR_A, items: [{ product_id: P1, quantity: -3 }] })).status, 400);
    assert.equal(db.orders.length, 0);
    const foreign = await call('POST', '/api/qr/pollo/order', null, { branch_id: BR_X, items: [{ product_id: P1, quantity: 1 }] });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
    assert.ok(db.orders.every((o) => o.branch_id !== BR_X) && db.orders.at(-1).branch_id === BR_A, 'never the other business\'s branch');
    assert.equal((await call('POST', '/api/qr/pollo/order', null, { branch_id: BR_A, items: [{ product_id: P1, quantity: 2 }] })).status, 201);
  });
  await ok('printers: stations.manage or settings.manage; a new printer\'s branch must be ours', async () => {
    reset();
    assert.equal((await call('POST', '/api/printers', T.cashier, { branch_id: BR_A, name: 'Bar' })).status, 403);
    assert.equal((await call('POST', '/api/printers', T.owner, { branch_id: BR_X, name: 'Bar' })).status, 404);
    assert.equal((await call('POST', '/api/printers', T.manager, { branch_id: BR_A, name: 'Bar' })).status, 201);
    const pid = db.branch_printers[0].id;
    assert.equal((await call('PATCH', `/api/printers/${pid}`, T.cashier, { name: 'x' })).status, 403);
    assert.equal((await call('DELETE', `/api/printers/${pid}`, T.cashier)).status, 403);
  });
  await ok('customers: editing / deactivating needs customers.manage; adding stays the POS\'s (customers.view)', async () => {
    reset();
    assert.equal((await call('PATCH', '/api/loyalty/customer/cust-1', T.ordersOnly, { name: 'x' })).status, 403);
    assert.equal((await call('DELETE', '/api/loyalty/customer/cust-1', T.ordersOnly)).status, 403);
    assert.equal(db.customers[0].status, 'active');
    assert.equal((await call('POST', '/api/loyalty/customer', T.ordersOnly, { name: 'New', phone: '0711' })).status, 201);
    assert.equal((await call('PATCH', '/api/loyalty/customer/cust-1', T.manager, { name: 'Kimani' })).status, 200);
  });

  console.log('\n3. Feature flags\n');
  await ok('web_hosting / themes / loyalty are ZapTill\'s: a settings.manage holder (and the owner) → 403 ADMIN_ONLY_FEATURE', async () => {
    reset();
    for (const key of ['web_hosting', 'themes', 'loyalty_enabled']) {
      for (const t of [T.manager, T.owner]) {
        const r = await call('PUT', `/api/flags/${key}`, t, { enabled: true });
        assert.equal(r.status, 403, `${key}: ${JSON.stringify(r.body)}`); assert.equal(r.body.code, 'ADMIN_ONLY_FEATURE');
      }
    }
    assert.equal(db.feature_flags.length, 0);
  });

  console.log('\n5. Shifts GET /:id\n');
  await ok('a cashier reads their branch\'s shift, not another branch\'s or another business\'s; the owner reads any of theirs', async () => {
    reset();
    assert.equal((await call('GET', `/api/shifts/${SH_A}`, T.cashier)).status, 200);
    assert.equal((await call('GET', `/api/shifts/${SH_B}`, T.cashier)).status, 404);
    assert.equal((await call('GET', `/api/shifts/${SH_X}`, T.owner)).status, 404);
    assert.equal((await call('GET', `/api/shifts/${SH_B}`, T.owner)).status, 200);
  });

  console.log('\n6. Stock GRN\n');
  await ok('a GRN into another branch → 403; into another business\'s branch → 404; against another business\'s PO → 404', async () => {
    reset();
    const item = [{ ingredient_id: ING, quantity_received: 5 }];
    assert.equal((await call('POST', '/api/stock/grn', T.manager, { branch_id: BR_B, items: item })).status, 403);
    assert.equal((await call('POST', '/api/stock/grn', T.owner, { branch_id: BR_X, items: item })).status, 404);
    assert.equal((await call('POST', '/api/stock/grn', T.owner, { branch_id: BR_A, purchase_order_id: PO_X, items: item })).status, 404);
    assert.equal(db.goods_received_notes.length, 0);
  });

  console.log('\n7. Branch prices\n');
  await ok('prices: a cashier → 403; a products.manage holder and the till\'s own session → 200; another business\'s branch → 404', async () => {
    reset();
    const body = (b) => ({ branch_id: b, edits: [{ product_id: P1, price: 250 }] });
    assert.equal((await call('POST', '/api/branch-prices/sync', T.cashier, body(BR_A))).status, 403);
    assert.equal(db.branch_prices.length, 0);
    assert.equal((await call('POST', '/api/branch-prices/sync', T.manager, body(BR_A))).status, 200);
    assert.equal((await call('POST', '/api/branch-prices/sync', T.till, body(BR_A))).status, 200);
    assert.equal((await call('POST', '/api/branch-prices/sync', T.owner, body(BR_X))).status, 404);
  });

  console.log('\n4. A staff PIN changed on a till (lib/changeApply)\n');
  const { applyChange } = require(path.join(DIST, 'lib/changeApply.js'));
  const pinChange = (target, by = MGR) => ({ id: id(), entity: 'staff_pin', entity_id: target, op: 'update', base: null,
    data: { pin: '4321' }, made_by: by, made_by_name: 'Max', made_at: new Date().toISOString() });
  // A490: callerKeys are what the route passes — req.permissionKeys, already FINE keys (requireAuth expands a token's
  // staff.manage into staff.view / staff.edit / staff.roles). A broad key is never handed to changeApply as such.
  const ctx = { businessId: BZ, branchId: BR_A, deviceId: 'dev-T1', callerKeys: ['staff.view', 'staff.edit', 'staff.roles'], callerIsOwner: false, callerUserId: MGR };
  await ok('a manager cannot reset the owner\'s PIN, or an admin\'s, from a till', async () => {
    reset();
    const a = await applyChange(ctx, pinChange(OWNER));
    assert.equal(a.status, 'refused', JSON.stringify(a)); assert.match(a.message, /only the owner/);
    const b = await applyChange(ctx, pinChange(ADMIN));
    assert.equal(b.status, 'refused', JSON.stringify(b));
    assert.equal(db.users.find((u) => u.id === OWNER).pin_hash, undefined, 'the owner\'s PIN untouched');
    assert.equal(db.users.find((u) => u.id === ADMIN).pin_hash, undefined);
  });
  await ok('…nor a PIN of someone at another branch; a cashier of their own branch: applied', async () => {
    reset();
    const other = await applyChange(ctx, pinChange(CASHIER_B));
    assert.equal(other.status, 'refused', JSON.stringify(other)); assert.match(other.message, /another branch/);
    const mine = await applyChange(ctx, pinChange(CASHIER));
    assert.equal(mine.status, 'applied', JSON.stringify(mine));
    assert.ok(db.users.find((u) => u.id === CASHIER).pin_hash, 'the cashier\'s PIN set');
  });
  await ok('the owner (made on a till) may set an admin\'s PIN', async () => {
    reset();
    const r = await applyChange({ ...ctx, callerKeys: ['*'], callerUserId: OWNER }, pinChange(ADMIN, OWNER));
    assert.equal(r.status, 'applied', JSON.stringify(r));
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
