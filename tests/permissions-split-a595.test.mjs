/**
 * permissions-split-a595.test.mjs — A595 (owner, 2026-10-26: "implement the changes and break down any right that you feel
 * is too big and exposes data — some can be broken down to view and edit etc."): 36 narrower rights (shared/permissions.ts
 * SPLITS, docs/PERMISSIONS-AUDIT.md), the cloud's checks of them, the masking of personal data, and the gaps the audit found.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/permissions-split-a595.test.mjs
 *
 * RUNS the COMPILED routers behind the REAL requireAuth (JWTs signed with a per-run secret), over HTTP, against an
 * in-memory database (supabase.from stubbed). For every route a part guards (the table below):
 *   - a token holding the PART (and the route's other keys) is not refused for a permission;
 *   - a token made from A595 on (`parts: true`) holding the PARENT but not the part is refused once migration 176 is
 *     recorded — the owner's untick works;
 *   - an OLDER token (no `parts`) holding the parent passes — it was made before the split (broad-key compatibility);
 *   - any token holding the parent passes while migration 176 is not recorded yet (splitsPending);
 *   - neither: refused.
 * Then the masking (customers' and staff's phones and e-mails), the closed gaps (GET /api/pos/credit-customers, GET
 * /api/staff/roles, GET /api/staff/authorizers, the customer search filter), credit limits by key, the staff parts, the
 * roles' save from an older screen, the approvals and the catalogue.
 *
 * MUTATIONS TO CONFIRM BITE (made in the compiled dist, seen to fail, reverted — the A595 register entry lists them):
 *   - loyalty /customers answering without shown()                   → "masked: the customer list" fails
 *   - pos /credit-customers without the person-key check              → "credit customers: a person with no customer key" fails
 *   - loyalty /customers with the raw search pasted into or()         → "the search is one quoted literal" fails
 *   - requireAuth giving every token its parts (ignoring `parts`)     → every "parent alone is refused after 176" row fails
 *   - routes/staff.ts GET /roles without its gate                     → "GET /api/staff/roles needs a staff or roles key" fails
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
const P = require(path.join(DIST, 'lib/permissions.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const PD = require(path.join(DIST, 'lib/personalData.js'));
const SC = require(path.join(DIST, 'lib/shiftConfirm.js'));
const RK = require(path.join(DIST, 'lib/roleKeys.js'));
const BT = require(path.join(DIST, 'lib/businessTerms.js'));
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

console.log('\nA595 — the split rights, the masking of personal data, the closed gaps\n');

// ── the catalogue ─────────────────────────────────────────────────────────────
const NEW = [...new Set([...Object.values(P.SPLITS).flat(), 'customers.credit_limit'])];
await ok('36 new rights, every part a catalogue key with exactly one entry, no part a parent, every parent a catalogue key', () => {
  assert.equal(NEW.length, 36);
  for (const k of NEW) assert.equal(P.PERMISSIONS.filter((p) => p.key === k).length, 1, k);
  for (const [parent, parts] of Object.entries(P.SPLITS)) {
    assert.ok(P.isPermissionKey(parent), parent);
    for (const c of parts) { assert.ok(P.isPermissionKey(c), c); assert.ok(!P.SPLITS[c], `${c} is also a parent`); }
  }
  assert.equal(P.PERMISSION_KEYS.length, 106);
});
await ok('personal data: the badge keys; the built-in Auditor (VIEW_KEYS) holds none of them, and no write key', () => {
  assert.deepEqual([...P.PERSONAL_KEYS].sort(), ['customers.contacts', 'customers.history', 'staff.contacts', 'staff.pay', 'staff.pins']);
  const aud = P.BUILT_IN_ROLES.find((r) => r.name === 'Auditor').keys;
  for (const k of P.PERSONAL_KEYS) assert.ok(!aud.includes(k), k);
  for (const k of aud) assert.ok(P.PERMISSIONS.find((p) => p.key === k).view, k);
  for (const k of ['reports.analytics', 'reports.audit', 'devices.view']) assert.ok(aud.includes(k), k);
  assert.ok(!aud.includes('menu.costs_edit'), 'the Auditor never changes cost prices');
});
await ok('new built-in defaults: the audit\'s least-privilege ones, with the owner\'s decisions of 2026-10-27 (D1 no, D3, D6, D9)', () => {
  const r = (n) => new Set(P.BUILT_IN_ROLES.find((x) => x.name === n).keys);
  for (const k of ['customers.delete', 'fuel.deliveries', 'fuel.setup', 'parking.void']) assert.ok(!r('Cashier').has(k), `Cashier ${k}`);
  for (const k of ['customers.contacts', 'customers.history', 'customers.edit']) assert.ok(r('Cashier').has(k) && r('Waiter').has(k), `D1: ${k}`);
  assert.ok(!r('Cashier').has('sales.discount') && r('Cashier').has('sales.discount_preset'), 'D6: set-up discounts only');
  assert.ok(r('Waiter').has('sales.discount') && r('Supervisor').has('sales.discount'));
  assert.ok(!r('Fuel attendant').has('fuel.deliveries') && !r('Fuel attendant').has('fuel.setup'));
  assert.ok(!r('Storekeeper').has('menu.costs_edit') && !r('Storekeeper').has('suppliers.manage') && r('Storekeeper').has('inventory.reorder'));
  assert.ok(!r('Supervisor').has('reports.analytics') && r('Supervisor').has('shifts.approve_payout'));
  assert.ok(!r('Finance Manager').has('sales.approve_kitchen_void') && r('Finance Manager').has('payables.pay'));
  for (const k of ['customers.credit_adjust', 'staff.access', 'staff.pay', 'devices.retire', 'expenses.edit', 'expenses.monthly', 'settings.mpesa'])
    assert.ok(!r('Manager').has(k), `D9: Manager ${k}`);
  assert.ok(r('Manager').has('customers.credit_limit'));
  assert.deepEqual([...r('General Manager')].sort(), P.PERMISSION_KEYS.filter((k) => k !== 'settings.webhooks' && k !== 'settings.report_emails').sort(), 'D3');
});
await ok('a cashier holding every part of their keys is still not back office (the floor takes the parts too)', () => {
  assert.equal(P.isBackOffice(P.withParts(P.defaultKeysFor('cashier'))), false);
  assert.equal(P.isBackOffice(P.withParts(['orders.create', 'customers.view', 'customers.edit', 'customers.credit', 'parking.manage', 'fuel.manage', 'staff.view', 'sales.discount'])), false);
});
await ok('broad keys and old maps keep their meaning: a LEGACY key brings its parts; legacyKeysFor unchanged (parents only)', () => {
  assert.ok(P.expandKeys(['settings.manage']).has('devices.retire'));
  assert.ok(P.expandKeys(['customers.manage']).has('customers.credit_adjust'));
  const held = P.expandKeys(['staff.view', 'staff.edit', 'staff.roles']);
  assert.ok(P.legacyKeysFor(held).includes('staff.manage'), 'an older POS still sees staff.manage');
  assert.ok(!P.expandMap({ 'customers.view': true, [P.MAP_MARKER]: true }).has('customers.contacts'), 'after the split a map is read as it is');
  const before = P.expandMap({ 'staff.view': true, 'staff.edit': false, [P.MAP_MARKER]: true }, false, true);
  assert.ok(before.has('staff.contacts') && !before.has('staff.pins'), 'before the split: a taken-away parent takes only what it alone brought');
});
await ok('display words (businessTerms.permissionWords): a split parent reads what is left of it; a part reads the shop words; never "till"', () => {
  assert.equal(BT.permissionWords('restaurant', 'customers.view', 'See customers', 'x').label, 'See customers (phone numbers masked)');
  assert.equal(BT.permissionWords('retail', 'menu.edit', 'Edit the menu', 'x').label, 'Add and change the products');
  assert.match(BT.permissionWords('retail', 'menu.delete', 'Delete products, categories and menus', 'x').label, /departments/);
  for (const k of NEW) { const p = P.PERMISSIONS.find((x) => x.key === k); assert.ok(!/\btills?\b/i.test(`${p.label} ${p.description}`), k); }
});

// ── the matrix: [method, path, part, base keys, body] ─────────────────────────
const ROUTES = [
  ['POST', '/api/discounts/apply', 'sales.discount_preset', [], { order_total: 100, discount_id: X }],
  ['GET', '/api/analytics/overview', 'reports.analytics', []],
  ['GET', '/api/reports/export/audit', 'reports.audit', ['reports.export']],
  ['DELETE', `/api/categories/${X}`, 'menu.delete', []],
  ['DELETE', `/api/products/${X}`, 'menu.delete', []],
  ['DELETE', `/api/combos/${X}`, 'menu.delete', []],
  ['DELETE', `/api/menus/${X}`, 'menu.delete', []],
  ['DELETE', `/api/modifiers/groups/${X}`, 'menu.delete', []],
  ['DELETE', `/api/modifiers/options/${X}`, 'menu.delete', []],
  ['DELETE', `/api/variants/groups/${X}`, 'menu.delete', []],
  ['DELETE', `/api/variants/options/${X}`, 'menu.delete', []],
  ['POST', '/api/products/bulk', 'menu.bulk', [], { rows: [] }],
  ['PATCH', '/api/products/bulk-tax/by-ids', 'menu.bulk', [], {}],
  ['PATCH', '/api/products/bulk-tax/by-category', 'menu.bulk', [], {}],
  ['PATCH', '/api/products/bulk-track/by-ids', 'menu.bulk', [], {}],
  ['POST', '/api/products/barcodes/generate', 'menu.bulk', [], { dry_run: true }],
  ['POST', '/api/variants/bulk', 'menu.bulk', [], { rows: [] }],
  ['PATCH', '/api/products/bulk-cost/by-ids', 'menu.costs_edit', [], {}],
  ['POST', '/api/stock/suppliers', 'suppliers.manage', [], {}],
  ['PATCH', `/api/stock/suppliers/${X}`, 'suppliers.manage', [], {}],
  ['DELETE', `/api/stock/suppliers/${X}`, 'suppliers.manage', []],
  ['POST', '/api/stock/purchase-orders', 'inventory.order', [], {}],
  ['PATCH', `/api/stock/purchase-orders/${X}`, 'inventory.order', [], {}],
  ['POST', `/api/stock/purchase-orders/${X}/cancel`, 'inventory.order', [], {}],
  ['DELETE', `/api/stock/purchase-orders/${X}`, 'inventory.order', []],
  ['POST', `/api/stock-takes/${X}/recount`, 'inventory.count_review', [], {}],
  ['POST', `/api/stock-takes/${X}/post`, 'inventory.count_review', [], {}],
  ['PATCH', `/api/inventory/${X}/threshold`, 'inventory.reorder', [], { branch_id: BR, low_stock_threshold: 3 }],
  ['PATCH', `/api/stock/ingredients/${X}/reorder`, 'inventory.reorder', ['inventory.adjust'], { branch_id: BR, reorder_level: 3 }],
  ['POST', '/api/payables/payments', 'payables.pay', [], {}],
  ['POST', `/api/payables/payments/${X}/void`, 'payables.pay', [], {}],
  ['GET', `/api/loyalty/customer/${C1}/transactions`, 'customers.history', []],
  ['GET', `/api/loyalty/customer/${C1}/insights`, 'customers.history', []],
  ['DELETE', `/api/loyalty/customer/${C1}`, 'customers.delete', ['customers.edit']],
  ['POST', `/api/credit/customer/${C1}/payment`, 'customers.credit_payment', [], { amount: 10 }],
  ['POST', `/api/credit/customer/${C1}/adjustment`, 'customers.credit_adjust', [], { amount: 10, notes: 'x' }],
  ['PATCH', `/api/expenses/${X}`, 'expenses.edit', [], {}],
  ['DELETE', `/api/expenses/${X}`, 'expenses.edit', []],
  ['POST', '/api/expenses/categories', 'expenses.types', [], { name: 'Gas' }],
  ['PATCH', `/api/expenses/categories/${X}`, 'expenses.types', [], {}],
  ['DELETE', `/api/expenses/categories/${X}`, 'expenses.types', []],
  ['POST', '/api/reports/monthly/movements', 'expenses.monthly', [], {}],
  ['DELETE', `/api/reports/monthly/movements/${X}`, 'expenses.monthly', []],
  ['POST', `/api/parking-sessions/${X}/void`, 'parking.void', ['parking.manage'], { reason: 'x' }],
  ['POST', `/api/fuel-tanks/${X}/delivery`, 'fuel.deliveries', [], {}],
  ['POST', '/api/fuel-tanks', 'fuel.setup', [], {}],
  ['PATCH', `/api/fuel-tanks/${X}`, 'fuel.setup', [], {}],
  ['DELETE', `/api/fuel-tanks/${X}`, 'fuel.setup', []],
  ['POST', '/api/pumps', 'fuel.setup', [], {}],
  ['PATCH', `/api/pumps/${X}`, 'fuel.setup', [], {}],
  ['DELETE', `/api/pumps/${X}`, 'fuel.setup', []],
  ['GET', '/api/webhooks', 'settings.webhooks', []],
  ['POST', '/api/webhooks', 'settings.webhooks', [], {}],
  ['GET', '/api/business/settings/report-schedule', 'settings.report_emails', []],
  ['POST', '/api/business/settings', 'settings.report_emails', [], { key: 'report_schedule', value: { enabled: false } }],
  ['POST', '/api/business/settings', 'settings.sales_rules', [], { key: 'continuous_operation', value: 'true' }],
  ['PATCH', '/api/business', 'settings.tax', [], { vat_rate: 16 }],
  ['GET', '/api/devices', 'devices.view', []],
  ['GET', '/api/devices/fleet', 'devices.view', []],
  ['PATCH', `/api/devices/${X}/retire`, 'devices.retire', [], {}],
  ['PATCH', `/api/devices/${X}/unretire`, 'devices.retire', [], {}],
  ['DELETE', `/api/devices/${X}`, 'devices.retire', []],
  ['POST', `/api/devices/${X}/authorise-handover`, 'devices.retire', [], {}],
  ['POST', `/api/changes/${CH_STAFF}/decide`, 'changes.approve_staff', [], { approve: false }],
];
await ok('the table covers every part a cloud route checks (approvals, personal-data reads and staff fields have their own cases below)', () => {
  const covered = new Set(ROUTES.map((r) => r[2]));
  const ownCases = ['shifts.approve_payout', 'sales.approve_kitchen_void', 'customers.contacts', 'staff.contacts', 'staff.pins', 'staff.access', 'staff.pay', 'customers.credit_limit'];
  for (const k of NEW) assert.ok(covered.has(k) || ownCases.includes(k), `no case for ${k}`);
});
for (const [method, p, part, baseKeys, body] of ROUTES) {
  const parent = P.PARENTS_OF[part][0];
  await ok(`${method} ${p.replace(/[0-9a-f-]{36}/g, ':id')} — ${part}: the part passes; the parent alone is refused after 176; an older token or 176 pending passes`, async () => {
    reset();
    assert.ok(!refused(await call(method, p, holding([part, ...baseKeys]), body)), 'the part');
    assert.ok(refusedFor(await call(method, p, holding([parent, ...baseKeys]), body), part), 'parent alone, after 176');
    assert.ok(!refused(await call(method, p, oldToken([parent, ...baseKeys]), body)), 'an older token holding the parent');
    state._setSplitsMigrated(false);
    try { assert.ok(!refused(await call(method, p, holding([parent, ...baseKeys]), body)), 'before 176'); }
    finally { state._setSplitsMigrated(true); }
    assert.equal((await call(method, p, holding(baseKeys.length ? baseKeys : ['orders.create']), body)).status, 403, 'neither');
  });
}
await ok('a menu change still needs changes.approve: approve_staff alone decides staff changes only (and counts only them)', async () => {
  reset();
  assert.ok(refusedFor(await call('POST', `/api/changes/${CH_MENU}/decide`, holding(['changes.approve_staff']), { approve: false }), 'changes.approve'));
  const n = await call('GET', '/api/changes/count', holding(['changes.approve_staff']));
  assert.equal(n.body.count, 1);
  const list = await call('GET', '/api/changes', holding(['changes.approve_staff']));
  assert.deepEqual(list.body.map((c) => c.entity), ['staff']);
});
await ok('the ingredient reorder level still needs inventory.adjust: receiving gains nothing (reorder without adjust is refused)', async () => {
  reset();
  assert.ok(refusedFor(await call('PATCH', `/api/stock/ingredients/${X}/reorder`, holding(['inventory.receive', 'inventory.reorder']), { branch_id: BR, reorder_level: 1 }), 'inventory.adjust'));
});

// ── masking ───────────────────────────────────────────────────────────────────
const MASKED = '07•• ••• 678';
await ok('maskPhone / maskEmail / isMasked: the last three digits kept; a masked value is recognised', () => {
  assert.equal(PD.maskPhone(PHONE), MASKED);
  assert.equal(PD.maskPhone('+254712345678'), '+25•• ••• 678');
  assert.equal(PD.maskEmail(EMAIL), 'm•••@gmail.com');
  assert.equal(PD.isMasked(MASKED), true); assert.equal(PD.isMasked(PHONE), false);
});
await ok('masked: the customer list without customers.contacts; full with it', async () => {
  reset();
  const without = await call('GET', '/api/loyalty/customers', holding(['customers.view']));
  assert.equal(without.body.customers[0].phone, MASKED); assert.equal(without.body.customers[0].email, 'm•••@gmail.com');
  const withIt = await call('GET', '/api/loyalty/customers', holding(['customers.view', 'customers.contacts']));
  assert.equal(withIt.body.customers[0].phone, PHONE); assert.equal(withIt.body.customers[0].email, EMAIL);
  assert.equal((await call('GET', '/api/loyalty/customers', OWNER_T)).body.customers[0].phone, PHONE, 'the owner');
});
await ok('masked: looking a customer up by the number typed keeps that number (the POS puts it on the sale); the e-mail is masked', async () => {
  reset();
  const r = await call('GET', `/api/loyalty/customer?phone=${PHONE}`, holding(['orders.create']));
  assert.equal(r.body.customer.phone, PHONE); assert.equal(r.body.customer.email, 'm•••@gmail.com');
});
await ok('masked: credit accounts, a credit account, Analytics, M-Pesa status — with the key, full', async () => {
  reset();
  const list = await call('GET', '/api/credit/customers', holding(['customers.view']));
  assert.equal(list.body[0].phone, MASKED);
  assert.equal((await call('GET', '/api/credit/customers', holding(['customers.view', 'customers.contacts']))).body[0].phone, PHONE);
  assert.equal((await call('GET', `/api/credit/customer/${C1}`, holding(['customers.credit']))).body.customer.phone, MASKED);
  const st = await call('GET', '/api/mpesa/status/ck-1', holding(['orders.create']));
  assert.equal(st.body.phone, '25•• ••• 678');
  assert.equal((await call('GET', '/api/mpesa/status/ck-1', holding(['orders.create', 'customers.contacts']))).body.phone, '254712345678');
});
await ok('masked: an order\'s customer number and its M-Pesa payer for a person without customers.contacts; the POS\'s own session as it is', async () => {
  reset();
  const r = await call('GET', `/api/orders/${X}`, holding(['orders.create', 'sales.history_all']));
  assert.equal(r.body.customer_phone, MASKED); assert.equal(r.body.payments[0].mpesa_phone, '25•• ••• 678');
  const full = await call('GET', `/api/orders/${X}`, holding(['orders.create', 'sales.history_all', 'customers.contacts']));
  assert.equal(full.body.customer_phone, PHONE);
});
await ok('masked: a customer edit by someone without customers.contacts never writes the phone or e-mail (a masked value from the form included)', async () => {
  reset();
  await call('PATCH', `/api/loyalty/customer/${C1}`, holding(['customers.edit']), { name: 'Mary K', phone: MASKED, email: 'x@y.z' });
  assert.equal(db.customers[0].phone, PHONE); assert.equal(db.customers[0].email, EMAIL); assert.equal(db.customers[0].name, 'Mary K');
  await call('PATCH', `/api/loyalty/customer/${C1}`, holding(['customers.edit', 'customers.contacts']), { phone: '0799000111' });
  assert.equal(db.customers[0].phone, '0799000111');
});
await ok('staff contacts: masked on the staff list and a branch\'s staff without staff.contacts (their own row shown); full with it', async () => {
  reset();
  const r = await call('GET', '/api/staff', holding(['staff.view']));
  const josh = r.body.find((u) => u.id === MGR), pat = r.body.find((u) => u.id === USER);
  assert.equal(josh.phone, '07•• ••• 222'); assert.equal(josh.email, 'j•••@shop.test'); assert.equal(josh.contacts_masked, true);
  assert.equal(pat.email, 'pat@shop.test', 'their own row');
  assert.equal((await call('GET', '/api/staff', holding(['staff.view', 'staff.contacts']))).body.find((u) => u.id === MGR).phone, '0733000222');
  const b = await call('GET', `/api/branches/${BR}/staff`, holding(['staff.view']));
  assert.equal(b.body.find((u) => u.id === MGR).phone, '07•• ••• 222');
});

// ── closed gaps ───────────────────────────────────────────────────────────────
const desk = (keys) => holding(keys, { surface: 'desktop', pinSignIn: true });
await ok('credit customers (GET /api/pos/credit-customers): a person with no customer key is refused; with customers.view masked; with contacts full', async () => {
  reset();
  const no = await call('GET', '/api/pos/credit-customers', desk(['orders.create']));
  assert.equal(no.status, 403, JSON.stringify(no.body)); assert.equal(no.body.code, 'NO_CUSTOMER_ACCESS');
  const v = await call('GET', '/api/pos/credit-customers', desk(['orders.create', 'customers.view']));
  assert.equal(v.status, 200); assert.equal(v.body.customers[0].phone, MASKED);
  assert.equal(v.body.customers[0].name, 'Mary'); assert.equal(v.body.customers[0].credit_limit, 1000); assert.equal(v.body.customers[0].credit_balance, 200);
  assert.equal((await call('GET', '/api/pos/credit-customers', desk(['customers.credit', 'customers.contacts']))).body.customers[0].phone, PHONE);
});
await ok('credit customers: the POS\'s own session (offline credit sales for every seller) gets names, limits and balances, phones masked', async () => {
  reset();
  const r = await call('GET', '/api/pos/credit-customers', TILL_T);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.customers[0].name, 'Mary'); assert.equal(r.body.customers[0].phone, MASKED);
  assert.equal(r.body.customers[0].credit_limit, 1000);
});
await ok('GET /api/staff/roles needs a staff or roles key (it showed every role\'s rights to any session)', async () => {
  reset();
  assert.ok(refused(await call('GET', '/api/staff/roles', holding(['orders.create']))));
  for (const k of ['staff.view', 'staff.edit', 'staff.roles']) assert.equal((await call('GET', '/api/staff/roles', holding([k]))).status, 200, k);
});
await ok('GET /api/staff/authorizers: ids and names for the POS PIN prompt; their roles only with a staff key', async () => {
  reset();
  const r = await call('GET', '/api/staff/authorizers', holding(['orders.create']));
  assert.equal(r.status, 200);
  for (const a of r.body) assert.deepEqual(Object.keys(a).sort(), ['id', 'name']);
  const s = await call('GET', '/api/staff/authorizers', holding(['staff.view']));
  assert.ok('role' in s.body[0]);
});
await ok('the customer search is one quoted PostgREST literal — a comma or bracket adds no filter; LIKE wildcards are literal', async () => {
  assert.equal(PD.customerSearchFilter('Mary', true), 'name.ilike."%Mary%",phone.ilike."%Mary%"');
  assert.equal(PD.customerSearchFilter('a,status.eq.inactive', true), 'name.ilike."%a,status.eq.inactive%",phone.ilike."%a,status.eq.inactive%"');
  // LIKE's escape (\%) inside a PostgREST quoted literal, whose own backslash is escaped too (\\%).
  assert.equal(PD.customerSearchFilter('50%_off', true), 'name.ilike."%50\\\\%\\\\_off%",phone.ilike."%50\\\\%\\\\_off%"');
  assert.equal(PD.customerSearchFilter('say "hi"\\', true).startsWith('name.ilike."%say \\"hi\\"\\\\\\\\%"'), true);
  assert.equal(PD.customerSearchFilter('', true), null);
  reset(); orCalls.length = 0;
  await call('GET', `/api/loyalty/customers?search=${encodeURIComponent('x),or(status.eq.inactive')}`, holding(['customers.view', 'customers.contacts']));
  const expr = orCalls.find((c) => c.table === 'customers')?.expr;
  assert.equal(expr, PD.customerSearchFilter('x),or(status.eq.inactive', true));
  assert.ok(expr.startsWith('name.ilike."%x),or('), expr);
});
await ok('without customers.contacts a phone matches only when typed in full (no reading masked numbers back digit by digit)', async () => {
  assert.equal(PD.customerSearchFilter('0712', false), 'name.ilike."%0712%"');
  assert.equal(PD.customerSearchFilter('0712 345 678', false), 'name.ilike."%0712 345 678%",phone.eq."0712345678"');
  reset(); orCalls.length = 0;
  await call('GET', '/api/loyalty/customers?search=0712', holding(['customers.view']));
  assert.ok(!orCalls.find((c) => c.table === 'customers').expr.includes('phone'));
});

// ── credit limits by key ──────────────────────────────────────────────────────
await ok('credit limits: customers.credit_limit sets them (any role holding it); without it refused; never a PIN holder of the owner\'s role', async () => {
  reset();
  const lim = (t) => call('PATCH', `/api/credit/customer/${C1}/limit`, t, { credit_limit: 500 });
  assert.notEqual((await lim(holding(['customers.credit_limit']))).status, 403);
  assert.equal((await lim(holding(['customers.credit', 'customers.view']))).body?.code, 'OWNER_SETS_LIMITS');
  assert.equal((await lim(sign({ userId: USER, isOwner: true, permissionKeys: ['*'], pinSignIn: true, surface: 'desktop', roleId: ROLE }))).status, 403);
  assert.notEqual((await lim(OWNER_T)).status, 403, 'the owner');
});
await ok('credit limits before 176 (or an older token): the built-in Manager by name, as A585 / A587', async () => {
  reset();
  const lim = (t) => call('PATCH', `/api/credit/customer/${C1}/limit`, t, { credit_limit: 500 });
  const mgrOld = (() => { const t = jwt.decode(holding(['customers.view'], { userId: MGR })); delete t.parts; delete t.iat; delete t.exp; return jwt.sign(t, process.env.JWT_SECRET, { expiresIn: '15m' }); })();
  assert.notEqual((await lim(mgrOld)).status, 403, 'an older token of the built-in Manager');
  assert.equal((await lim(holding(['customers.view'], { userId: MGR }))).status, 403, 'a new token: the key decides (176 gave it to the Manager role)');
  state._setSplitsMigrated(false);
  try { assert.notEqual((await lim(holding(['customers.view'], { userId: MGR }))).status, 403, 'before 176'); }
  finally { state._setSplitsMigrated(true); }
});

// ── staff parts ───────────────────────────────────────────────────────────────
await ok('staff: a PIN needs staff.pins, own rights staff.access, a pay rate staff.pay — and staff.pay alone sets only the rate', async () => {
  reset();
  const edit = (keys, body) => call('PATCH', `/api/staff/${MGR}`, holding(keys), body);
  const r1 = await edit(['staff.edit', 'staff.view'], { pin: '4321' });
  assert.ok(refusedFor(r1, 'staff.pins'), JSON.stringify(r1));
  assert.ok(refusedFor(await edit(['staff.edit', 'staff.view'], { override_keys: { 'reports.sales': true } }), 'staff.access'));
  assert.ok(refusedFor(await edit(['staff.edit', 'staff.view'], { hourly_rate: 200 }), 'staff.pay'));
  assert.ok(refusedFor(await edit(['staff.pay'], { name: 'Josh' }), 'staff.edit'), 'pay alone edits nothing else');
  assert.ok(!refused(await edit(['staff.pay'], { hourly_rate: 200 })), 'pay alone sets the rate');
  assert.ok(refusedFor(await call('POST', `/api/staff/${MGR}/reset-otp`, holding(['staff.edit'])), 'staff.pins'));
});
await ok('roles saved by an older screen: a parent ticked for the first time brings its parts (within the caller\'s keys); `parts: true` saves exactly', () => {
  assert.deepEqual(RK.withNewParentParts(['customers.view'], new Set(), new Set(['*'])).sort(), ['customers.contacts', 'customers.history', 'customers.view']);
  assert.deepEqual(RK.withNewParentParts(['customers.view'], new Set(['customers.view']), new Set(['*'])), ['customers.view'], 'held before: an untick stays');
  assert.deepEqual(RK.withNewParentParts(['customers.view', 'customers.history'], new Set(), new Set(['*'])).sort(), ['customers.history', 'customers.view'], 'a part named: as sent');
  assert.deepEqual(RK.withNewParentParts(['customers.view'], new Set(), new Set(['customers.view', 'customers.history'])).sort(), ['customers.history', 'customers.view'], 'the ceiling');
  const o = RK.overridePartsOf(new Map([['fuel.manage', false], ['staff.view', true]]));
  assert.equal(o.get('fuel.setup'), false); assert.equal(o.get('staff.contacts'), true);
});

// ── approvals ─────────────────────────────────────────────────────────────────
await ok('approvals: a pay-out needs shifts.approve_payout, a kitchen removal sales.approve_kitchen_void, a drawer shifts.confirm', () => {
  const row = (keys) => ({ id: 'p', roles: { name: 'Shift lead', role_permissions: keys.map((key) => ({ permissions: { key } })) }, user_permissions: [] });
  assert.equal(SC.mayApproveWith('shifts.approve_payout')(row(['shifts.approve_payout']), null), true);
  assert.equal(SC.mayApproveWith('shifts.approve_payout')(row(['shifts.confirm']), null), false, 'after 176: the parent alone no longer approves a pay-out');
  assert.equal(SC.mayApproveWith('shifts.approve_payout', true)(row(['shifts.confirm']), null), true, 'before 176');
  assert.equal(SC.mayApproveWith('sales.approve_kitchen_void')(row(['shifts.approve_payout']), null), false);
  assert.equal(SC.mayConfirm(row(['shifts.confirm']), null), true);
  assert.equal(SC.mayConfirm(row(['shifts.approve_payout']), null), false);
  assert.equal(SC.callerMayApprove({ permissionKeys: ['sales.approve_kitchen_void'] }, 'sales.approve_kitchen_void'), true);
  assert.equal(SC.callerMayApprove({ permissionKeys: ['shifts.confirm'] }, 'sales.approve_kitchen_void'), false);
  assert.equal(SC.callerMayApprove({ isTill: true, isOwner: true }, 'shifts.approve_payout'), false, 'never the POS\'s own session');
});

await ok('a pay-out or drawer expense: a person signed in approves as themselves with shifts.approve_payout — shifts.confirm alone (after 176) needs a PIN', async () => {
  reset();
  const PA = require(path.join(DIST, 'lib/payoutApproval.js'));
  const asMe = (keys) => PA.payoutApprover({ businessId: BZ, userId: MGR, isOwner: false, permissionKeys: keys, body: {} }, BR);
  assert.equal((await asMe(['shifts.approve_payout'])).ok, true);
  const r = await asMe(['shifts.confirm']);
  assert.equal(r.ok, false); assert.equal(r.code, 'PAYOUT_APPROVAL_REQUIRED');
});

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
