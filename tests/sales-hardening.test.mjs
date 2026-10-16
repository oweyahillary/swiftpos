// A494 — the sales, drawer, sync and device routes hardened after the internal access-control audit (owner, 2026-10-15:
// fix the gaps before onboarding more clients).
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/sales-hardening.test.mjs
//
// RUNS the COMPILED routers (pos, changes, orders, shifts, sync, notifications, day-close, devices) behind the REAL auth
// middleware over HTTP; the database in memory (tests/lib-memdb.mjs).
//
// One section per audit item:
//   1 branch-staff: a till's own session, for itself; never an override PIN hash
//   2 /pos/init: no cost prices to the till or to a person without menu.costs / reports.costs
//   3 till changes: a person's made_by never believed; a till session's maker proven (else held / sent again); generic PIN clash
//   4 orders: replay only from the till's own session; branch access; orders.create; whatsapp; /pay customer + points;
//     GET /:id own-history + costs; discount gate; shift branch; approver PIN limiter + no self-approval
//   5 shifts: figures; branch access; open; confirmer PIN limiter
//   6 sync push: desktop sessions only; branch of rows; telemetry by business
//   7 notifications: branch + addressee; mark-read own only; owner complete
//   8 day-close: overview scope; instruct by the device's branch; pending own till only
//   9 devices: GET needs devices.approve; writes by branch
//  10 holds(): a till's session holds nothing that widens data
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-15):
//   - pos.ts branch-staff `!req.isTill` check removed            → "a person's sign-in gets no PIN hashes" fails
//   - changeApply.ts made_by override for a person removed       → "a manager naming the owner as maker" fails
//   - orders.ts isTillReplay back to req.surface === 'desktop'   → "a person's desktop token cannot replay" fails
//   - historyScope.holds without the isTill line                  → "a till token's History is not every cashier's" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/orders.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const pinAttempts = require(path.join(DIST, 'lib/pinAttempts.js'));
const historyScope = require(path.join(DIST, 'lib/historyScope.js'));
const bcrypt = require('bcrypt');

const B = '11111111-1111-4111-8111-111111111111', B2 = '19999999-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-3333-4333-8333-333333333333';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MGR = 'aaaaaaaa-0000-4000-8000-000000000002',
  CASH = 'aaaaaaaa-0000-4000-8000-000000000003', MGR2 = 'aaaaaaaa-0000-4000-8000-000000000004',
  BOSS = 'aaaaaaaa-0000-4000-8000-000000000005';
const perms = (...keys) => ({ name: 'Role', role_permissions: keys.map((key) => ({ permissions: { key } })) });
const PIN_MGR = '4321', PIN_BOSS = '8765', PIN_CASH = '1111';
const H = { mgr: bcrypt.hashSync(PIN_MGR, 4), boss: bcrypt.hashSync(PIN_BOSS, 4), cash: bcrypt.hashSync(PIN_CASH, 4) };
// user_branches: [] = works at every branch (lib/branchAccess.ts); lib/approver.ts refuses a row without the field.
const person = (id, name, extra = {}) => ({ id, name, status: 'active', business_id: B, permissions_version: 0, user_permissions: [], user_branches: [], ...extra });

const reset = () => {
  mem.fail = () => null; mem.calls = [];
  pinAttempts._resetAttempts();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Pollo', currency: 'KES' }, { id: B2, owner_id: 'x', name: 'Other' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true },
      { id: BR2, business_id: B, name: 'Kilimani', desktop_licensed: true }],
    users: [
      person(OWNER, 'Owner', { roles: { name: 'Admin' }, pin_hash: null }),
      person(MGR, 'Mary', { roles: perms('orders.create', 'sales.void', 'sales.refund', 'shifts.confirm', 'menu.edit', 'menu.prices', 'staff.edit'), pin_hash: H.mgr, override_pin_hash: '$2b$04$secretoverridehash' }),
      person(CASH, 'Joe', { roles: perms('orders.create'), pin_hash: H.cash }),
      person(MGR2, 'Kim', { roles: perms('orders.create', 'sales.void'), pin_hash: bcrypt.hashSync('5555', 4), user_branches: [{ branch_id: BR2 }] }),
      person(BOSS, 'Boss', { roles: perms('orders.create', 'sales.void', 'sales.refund', 'shifts.confirm'), pin_hash: H.boss }),
    ],
    user_branches: [{ user_id: MGR2, branch_id: BR2 }],
    user_devices: [
      { id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR },
      { id: 'ud-2', business_id: B, device_id: 'dev-T2', status: 'approved', retired_at: null, branch_id: BR2 },
      { id: 'ud-3', business_id: B2, device_id: 'dev-X', status: 'approved', retired_at: null, branch_id: null, last_sync_at: null },
    ],
    business_settings: [], branch_settings: [], feature_flags: [], notifications: [], refresh_tokens: [], change_requests: [],
    products: [], categories: [], orders: [], shifts: [], customers: [], day_close_instructions: [], business_days: [],
    float_transactions: [], expenses: [], payments: [], kitchen_tickets: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
for (const [mount, file] of [['pos', 'pos'], ['changes', 'changes'], ['orders', 'orders'], ['shifts', 'shifts'], ['sync', 'sync'],
  ['notifications', 'notifications'], ['day-close', 'day-close'], ['devices', 'devices']]) {
  app.use(`/api/${mount}`, require(path.join(DIST, `routes/${file}.js`)).default);
}
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const desk = { surface: 'desktop', pinSignIn: true };
const T = {
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'] }),
  mgr: sign({ userId: MGR, permissionKeys: ['orders.create', 'sales.void', 'sales.refund', 'shifts.confirm', 'menu.edit', 'menu.prices', 'staff.edit', 'devices.approve', 'shifts.close_day'], ...desk }),
  mgrWeb: sign({ userId: MGR, permissionKeys: ['orders.create', 'sales.void', 'shifts.confirm', 'devices.approve'], surface: 'dashboard' }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create'], ...desk }),
  cashWeb: sign({ userId: CASH, permissionKeys: ['orders.create'], surface: 'pos' }),
  costs: sign({ userId: MGR, permissionKeys: ['orders.create', 'menu.costs'], ...desk }),
  mgr2: sign({ userId: MGR2, branchId: BR2, permissionKeys: ['orders.create', 'sales.void'], ...desk }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  till2: sign({ userId: null, deviceId: 'dev-T2', till: true, branchId: BR2, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tick = () => new Promise((r) => setTimeout(r, 30));

try {
  state._setPermissionsMigrated(true);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n1. The staff list with PIN hashes: a till\'s own session, for itself\n');
  reset();
  await ok('a person\'s sign-in on a till gets no PIN hashes (403 TILL_ONLY)', async () => {
    const r = await call('GET', '/api/pos/branch-staff', T.mgr, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'TILL_ONLY');
  });
  await ok('a till asking for ANOTHER device\'s list is refused (NOT_THIS_TILL)', async () => {
    const r = await call('GET', '/api/pos/branch-staff', T.till, undefined, { 'x-device-id': 'dev-T2' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'NOT_THIS_TILL');
  });
  await ok('the till\'s own list: its branch\'s staff with sign-in hashes, never an override PIN hash', async () => {
    const r = await call('GET', '/api/pos/branch-staff', T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.branch_id, BR);
    const mary = r.body.staff.find((s) => s.staff_id === MGR);
    assert.ok(mary && mary.pin_hash === H.mgr, 'Mary is on the list with her sign-in hash');
    assert.equal(mary.override_pin_hash, null);
    assert.ok(!r.body.staff.some((s) => s.staff_id === MGR2), 'Kim works at Kilimani only');
    assert.ok(!JSON.stringify(r.body).includes('secretoverridehash'));
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n2. /api/pos/init: cost prices only to who may see them\n');
  reset();
  mem.db.products = [{ id: 'p1', business_id: B, name: 'Burger', base_price: 700, cost_price: 310, status: 'active', categories: { name: 'Food' } }];
  const initProducts = async (tok) => {
    const r = await call('GET', `/api/pos/init?branch_id=${BR}`, tok);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    return r.body.products;
  };
  await ok('the till\'s own session: no cost_price (the till stores none from here)', async () => {
    const [p] = await initProducts(T.till);
    assert.equal(p.name, 'Burger'); assert.equal(p.base_price, 700); assert.ok(!('cost_price' in p));
  });
  await ok('a cashier: no cost_price; a person with menu.costs: the cost price', async () => {
    assert.ok(!('cost_price' in (await initProducts(T.cash))[0]));
    assert.equal((await initProducts(T.costs))[0].cost_price, 310);
    assert.equal((await initProducts(T.owner))[0].cost_price, 310);
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Changes from a till: who made it is proven\n');
  const P1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const resetChanges = () => {
    reset();
    mem.db.products = [{ id: P1, business_id: B, name: 'Burger', base_price: 700, status: 'active' }];
  };
  const chg = (entity, op, entity_id, data, made_by, base = null) => ({ id: randomUUID(), entity, op, entity_id, data, base, made_by, made_by_name: 'Named', made_at: new Date().toISOString() });
  const send = async (tok, c, headers) => (await call('POST', '/api/changes', tok, { changes: [c] }, headers)).body?.results?.[0];
  resetChanges();
  await ok('a cashier\'s session naming the owner as maker is refused — their own keys decide', async () => {
    const r = await send(T.cash, chg('product', 'update', P1, { base_price: 1 }, OWNER, { base_price: 700 }));
    assert.equal(r.status, 'refused', JSON.stringify(r));
    assert.equal(mem.db.products[0].base_price, 700);
  });
  await ok('a manager naming the owner as maker: recorded as made by the manager (the owner\'s exemptions never apply)', async () => {
    const c = chg('product', 'update', P1, { base_price: 750 }, OWNER, { base_price: 700 });
    const r = await send(T.mgr, c);
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.equal(mem.db.change_requests.find((x) => x.id === c.id).made_by, MGR);
  });
  await ok('a manager changing the owner\'s PIN while naming the owner as maker is refused', async () => {
    const r = await send(T.mgr, chg('staff_pin', 'update', OWNER, { pin: '2468' }, OWNER, {}));
    assert.equal(r.status, 'refused', JSON.stringify(r)); assert.match(r.message, /owner/);
  });
  resetChanges();
  await ok('the till\'s session, maker never signed in online at the branch: a price waits for the owner (not applied)', async () => {
    const r = await send(T.till, chg('product', 'update', P1, { base_price: 1 }, OWNER, { base_price: 700 }));
    assert.equal(r.status, 'awaiting', JSON.stringify(r));
    assert.equal(mem.db.products[0].base_price, 700);
    assert.ok(mem.db.notifications.some((n) => n.user_id === OWNER && n.type === 'change_approval'));
  });
  await ok('…and a PIN change is sent again (retry), never applied', async () => {
    const r = await send(T.till, chg('staff_pin', 'update', CASH, { pin: '2468' }, MGR, {}));
    assert.equal(r.status, 'refused'); assert.equal(r.retry, true);
    assert.equal(mem.db.users.find((u) => u.id === CASH).pin_hash, H.cash);
  });
  await ok('the owner approves a held change: applied', async () => {
    const held = mem.db.change_requests.find((x) => x.status === 'awaiting');
    const r = await call('POST', `/api/changes/${held.id}/decide`, T.owner, { approve: true });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(mem.db.products[0].base_price, 1);
  });
  await ok('once the maker signed in with their PIN on a till of the branch, the till\'s change applies', async () => {
    mem.db.refresh_tokens.push({ id: 'rt1', business_id: B, user_id: MGR, device_hint: 'dev-T1', session_kind: 'pin', created_at: new Date().toISOString() });
    const r = await send(T.till, chg('product', 'update', P1, { base_price: 800 }, MGR, { base_price: 1 }));
    assert.equal(r.status, 'applied', JSON.stringify(r)); assert.equal(mem.db.products[0].base_price, 800);
  });
  await ok('a sign-in on ANOTHER branch\'s till proves nothing here', async () => {
    mem.db.refresh_tokens = [{ id: 'rt2', business_id: B, user_id: MGR, device_hint: 'dev-T2', session_kind: 'pin', created_at: new Date().toISOString() }];
    const r = await send(T.till, chg('product', 'update', P1, { base_price: 900 }, MGR, { base_price: 800 }));
    assert.equal(r.status, 'awaiting', JSON.stringify(r));
  });
  await ok('a PIN someone else has: refused without naming them', async () => {
    mem.db.refresh_tokens = [{ id: 'rt3', business_id: B, user_id: MGR, device_hint: 'dev-T1', session_kind: 'pin', created_at: new Date().toISOString() }];
    const r = await send(T.till, chg('staff_pin', 'update', CASH, { pin: PIN_BOSS }, MGR, {}));
    assert.equal(r.status, 'refused', JSON.stringify(r));
    assert.doesNotMatch(r.message, /Boss/); assert.match(r.message, /already in use/);
  });
  await ok('a manager\'s X-Branch-Id is ignored (their token\'s branch); the owner\'s must be one of the business\'s', async () => {
    const c = chg('product', 'update', P1, { base_price: 905 }, MGR, { base_price: 800 });
    mem.db.products[0].base_price = 800;
    await send(T.mgr, c, { 'x-branch-id': BR2 });
    assert.equal(mem.db.change_requests.find((x) => x.id === c.id).branch_id, BR);
    const bad = await call('POST', '/api/changes', T.owner, { changes: [chg('product', 'update', P1, { base_price: 5 }, OWNER, { base_price: 905 })] }, { 'x-branch-id': randomUUID() });
    assert.equal(bad.status, 400);
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n4. Orders\n');
  const O1 = 'cccccccc-0000-4000-8000-000000000001', O2 = 'cccccccc-0000-4000-8000-000000000002', O3 = 'cccccccc-0000-4000-8000-000000000003';
  const resetOrders = () => {
    reset();
    const now = new Date().toISOString();
    mem.db.orders = [
      { id: O1, business_id: B, branch_id: BR, order_number: 'T1-1', status: 'completed', total: 500, created_at: now, device_id: 'dev-T1', cashier_id: CASH,
        order_items: [{ product_id: null, quantity: 1, unit_cost: 200, product_name: 'Burger' }], payments: [{ id: 'pay1', status: 'completed', amount: 500, method: 'cash' }], customer_phone: '0700000001' },
      { id: O2, business_id: B, branch_id: BR2, order_number: 'T2-1', status: 'completed', total: 300, created_at: now, device_id: 'dev-T2', cashier_id: MGR2,
        order_items: [], payments: [{ id: 'pay2', status: 'completed', amount: 300, method: 'cash' }] },
      { id: O3, business_id: B, branch_id: BR, order_number: 'T1-2', status: 'open', subtotal: 1000, total: 1000, order_type: 'dine_in', created_at: now, cashier_id: CASH, order_items: [] },
    ];
    mem.db.customers = [{ id: 'cust-1', business_id: B, loyalty_points: 50 }, { id: 'cust-x', business_id: B2, loyalty_points: 9999 }];
    mem.db.shifts = [{ id: 'sh-2', business_id: B, branch_id: BR2, status: 'open' }];
  };
  resetOrders();
  await ok('(a) a person\'s desktop token cannot replay an offline void — 409, the till sends it again with its own session', async () => {
    const r = await call('POST', `/api/orders/${O1}/void`, T.cash, { reason: 'x', offline_approved_by: MGR }, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'REPLAY_NEEDS_TILL_SESSION');
    assert.equal(mem.db.orders[0].status, 'completed');
  });
  await ok('(a) a till naming another till in X-Device-Id is not that till (its token decides)', async () => {
    const r = await call('POST', `/api/orders/${O2}/void`, T.till, { reason: 'x', offline_approved_by: MGR }, { 'x-device-id': 'dev-T2' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(mem.db.orders[1].status, 'completed');
  });
  await ok('(a) the till\'s own replay of its own sale, approved by a manager: voided', async () => {
    const r = await call('POST', `/api/orders/${O1}/void`, T.till, { reason: 'x', offline_approved_by: MGR });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(mem.db.orders[0].status, 'voided');
  });
  resetOrders();
  await ok('(b) a manager voiding another branch\'s sale is refused', async () => {
    const r = await call('POST', `/api/orders/${O2}/void`, T.mgr, { reason: 'x', override_pin: PIN_BOSS });
    assert.equal(r.status, 403); assert.equal(mem.db.orders[1].status, 'completed');
  });
  await ok('(b) POST /, /open, /:id/pay and /:id/fire-course need orders.create', async () => {
    const none = sign({ userId: CASH, permissionKeys: ['customers.view'] });
    for (const [m, p] of [['POST', '/api/orders'], ['POST', '/api/orders/open'], ['POST', `/api/orders/${O3}/pay`], ['POST', `/api/orders/${O3}/fire-course`]]) {
      const r = await call(m, p, none, {});
      assert.equal(r.status, 403, `${p}: ${r.status}`); assert.match(r.body.detail, /orders\.create/);
    }
  });
  await ok('(b) fire-course on another branch\'s bill is refused', async () => {
    const r = await call('POST', `/api/orders/${O3}/fire-course`, T.mgr2, { course: 'mains' });
    assert.equal(r.status, 403);
  });
  await ok('(b) WhatsApp receipt: another person\'s sale needs sales.reprint; another number needs customers.edit', async () => {
    assert.equal((await call('POST', `/api/orders/${O1}/whatsapp-receipt`, T.mgr, {})).status, 403, 'Mary did not ring O1');
    assert.equal((await call('POST', `/api/orders/${O1}/whatsapp-receipt`, T.cash, { phone: '0799999999' })).status, 403);
    const reprint = sign({ userId: CASH, permissionKeys: ['orders.create', 'sales.reprint'] });
    const r = await call('POST', `/api/orders/${O1}/whatsapp-receipt`, reprint, { phone: '0799999999' });
    assert.equal(r.status, 403); assert.match(r.body.detail, /customers\.edit/);
  });
  await ok('(c) /pay: another business\'s customer is refused; points beyond the balance are refused', async () => {
    let r = await call('POST', `/api/orders/${O3}/pay`, T.mgr, { payments: [{ method: 'cash', amount: 1000 }], customer_id: 'cust-x', points_redeemed: 10 });
    assert.equal(r.status, 400); assert.match(r.body.error, /Invalid customer/);
    r = await call('POST', `/api/orders/${O3}/pay`, T.mgr, { payments: [{ method: 'cash', amount: 1000 }], customer_id: 'cust-1', points_redeemed: 51 });
    assert.equal(r.status, 400); assert.match(r.body.error, /Insufficient loyalty points/);
  });
  await ok('(d) GET /:id — without sales.history_all only their own sale; costs never to them', async () => {
    const other = await call('GET', `/api/orders/${O1}`, T.mgr);
    assert.equal(other.status, 404, 'Mary did not ring O1 and lacks sales.history_all');
    const mine = await call('GET', `/api/orders/${O1}`, T.cash);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.ok(!('unit_cost' in mine.body.order_items[0]));
    const all = await call('GET', `/api/orders/${O1}`, T.owner);
    assert.equal(all.body.order_items[0].unit_cost, 200);
  });
  await ok('(e) a manual discount from a person\'s DESKTOP sign-in without sales.discount is refused; the till\'s own session is not', async () => {
    let r = await call('POST', `/api/orders/${O3}/pay`, T.cash, { payments: [{ method: 'cash', amount: 900 }], discount_amount: 100 });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'DISCOUNT_NOT_ALLOWED');
    r = await call('POST', `/api/orders/${O3}/pay`, T.till, { payments: [{ method: 'cash', amount: 1 }], discount_amount: 100 });
    assert.notEqual(r.body?.code, 'DISCOUNT_NOT_ALLOWED');
  });
  await ok('(f) /open with a drawer of another branch is refused', async () => {
    const r = await call('POST', '/api/orders/open', T.mgr, { branch_id: BR, order_number: 'X1', items: [{ product: { id: 'p', name: 'x' }, quantity: 1 }], shift_id: 'sh-2' });
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.code, 'INVALID_SHIFT');
  });
  resetOrders();
  await ok('(g) the requester\'s own PIN does not approve their void (SELF_APPROVAL); another manager\'s does', async () => {
    let r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: PIN_MGR });
    // lib/approver.ts leaves the asker out (A494), so their own PIN matches nobody; SELF_APPROVAL is the backstop.
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.ok(['SELF_APPROVAL', 'INVALID_APPROVER_PIN'].includes(r.body.code));
    assert.equal(mem.db.orders[0].status, 'completed');
    r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: PIN_BOSS });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(mem.db.orders[0].authorized_by, BOSS);
  });
  resetOrders();
  await ok('(g) wrong approver PINs lock PIN entry (429 PIN_LOCKED) — the right PIN too', async () => {
    let last;
    for (let i = 0; i < pinAttempts.PIN_MAX_FAILS; i++) last = await call('POST', `/api/orders/${O1}/refund`, T.mgr, { reason: 'x', override_pin: '0000' });
    assert.equal(last.status, 403);
    const r = await call('POST', `/api/orders/${O1}/refund`, T.mgr, { reason: 'x', override_pin: PIN_BOSS });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'PIN_LOCKED');
    assert.ok(!mem.db.orders[0].refunded_at);
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n5. Drawers\n');
  const resetShifts = () => {
    reset();
    const t = new Date().toISOString();
    mem.db.shifts = [
      { id: 'sh-1', business_id: B, branch_id: BR, status: 'closed', cashier_id: MGR, opened_by: MGR, opening_float: 100, expected_cash: 900, cash_variance: -50, closing_float: 850, declared_methods: { cash: 850 }, opened_at: t },
      { id: 'sh-o', business_id: B, branch_id: BR, status: 'open', cashier_id: MGR, opened_by: MGR, opening_float: 100, opened_at: t },
      { id: 'sh-k', business_id: B, branch_id: BR2, status: 'open', cashier_id: MGR2, opened_by: MGR2, opening_float: 100, opened_at: t },
    ];
  };
  resetShifts();
  const cashier = sign({ userId: CASH, permissionKeys: ['orders.create', 'shifts.cash_movements'], surface: 'pos' });
  await ok('GET /api/shifts: a cashier sees another\'s drawer without expected cash, the difference or the count', async () => {
    const r = await call('GET', '/api/shifts', cashier);
    assert.equal(r.status, 200);
    const s1 = r.body.find((s) => s.id === 'sh-1');
    for (const k of ['expected_cash', 'cash_variance', 'closing_float', 'declared_methods', 'expected_cash_live']) assert.ok(!(k in s1), k);
    const m = await call('GET', '/api/shifts', T.mgrWeb);
    assert.equal(m.body.find((s) => s.id === 'sh-1').cash_variance, -50);
  });
  await ok('GET /api/shifts/:id: another\'s drawer is blind to a cashier; full to a manager', async () => {
    const r = await call('GET', '/api/shifts/sh-1', cashier);
    assert.equal(r.status, 200); assert.equal(r.body.blind, true); assert.ok(!('expected_cash' in r.body));
    const m = await call('GET', '/api/shifts/sh-1', T.mgrWeb);
    assert.equal(m.body.expected_cash, 900);
  });
  await ok('close / force-close / float / expense / confirm on another branch\'s drawer: refused', async () => {
    assert.equal((await call('POST', '/api/shifts/sh-k/close', T.mgr, { closing_float: 0 })).status, 403);
    const fc = sign({ userId: MGR, permissionKeys: ['shifts.force_close'] });
    assert.equal((await call('POST', '/api/shifts/sh-k/force-close', fc, { reason: 'x' })).status, 403);
    const mm = sign({ userId: MGR, permissionKeys: ['shifts.cash_movements', 'shifts.confirm'] });
    assert.equal((await call('POST', '/api/shifts/sh-k/float', mm, { type: 'float_in', amount: 5 })).status, 403);
    assert.equal((await call('POST', '/api/shifts/sh-k/expense', mm, { description: 'x', amount: 5 })).status, 403);
    mem.db.shifts.find((s) => s.id === 'sh-k').status = 'closed';
    assert.equal((await call('POST', '/api/shifts/sh-k/confirm', mm, { confirmed_methods: { cash: 1 } })).status, 403);
    assert.equal(mem.db.float_transactions.length + mem.db.expenses.length, 0);
  });
  await ok('POST /open: another branch, or one not of the business, is refused', async () => {
    assert.equal((await call('POST', '/api/shifts/open', T.mgr, { branch_id: BR2, opening_float: 0 })).status, 403);
    assert.equal((await call('POST', '/api/shifts/open', T.owner, { branch_id: randomUUID(), opening_float: 0 })).status, 400);
  });
  resetShifts();
  await ok('the confirmer PIN lookup is behind the PIN limiter', async () => {
    for (let i = 0; i < pinAttempts.PIN_MAX_FAILS; i++) await call('POST', '/api/shifts/confirmer', T.cash, { pin: '0000' });
    const r = await call('POST', '/api/shifts/confirmer', T.cash, { pin: PIN_BOSS });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'PIN_LOCKED');
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n6. Sync push\n');
  reset();
  await ok('a browser session cannot push drawers and days (403 TILL_ONLY)', async () => {
    const r = await call('POST', '/api/sync/push', T.mgrWeb, { shifts: [] });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'TILL_ONLY');
  });
  await ok('a person\'s till sign-in: a row of another branch is rejected alone (branch_not_allowed); a branch of another business too', async () => {
    const r = await call('POST', '/api/sync/push', T.cash, {
      floats: [{ id: randomUUID(), branch_id: BR2, shift_id: 'x', type: 'float_in', amount: 1 }],
      business_days: [{ id: randomUUID(), branch_id: randomUUID(), business_date: '2026-10-15', opened_at: new Date().toISOString() }],
    }, { 'x-schema-version': '999' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const codes = (r.body.rejected ?? []).map((x) => x.code);
    assert.deepEqual(codes.sort(), ['branch_not_allowed', 'branch_not_allowed']);
    assert.equal(mem.db.business_days.length, 0);
  });
  await ok('telemetry only touches a device of THIS business', async () => {
    await call('POST', '/api/sync/push', T.till, {}, { 'x-device-id': 'dev-X', 'x-schema-version': '999' });
    await tick();
    assert.equal(mem.db.user_devices.find((d) => d.device_id === 'dev-X').last_sync_at, null);
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n7. Notifications\n');
  const resetNotes = () => {
    reset();
    mem.db.notifications = [
      { id: 'n1', business_id: B, branch_id: BR, user_id: null, title: 'Low stock', read_at: null, created_at: '2026-10-15T10:00:00Z' },
      { id: 'n2', business_id: B, branch_id: BR, user_id: OWNER, title: 'Approve a change', read_at: null, created_at: '2026-10-15T10:01:00Z' },
      { id: 'n3', business_id: B, branch_id: BR2, user_id: null, title: 'Kilimani', read_at: null, created_at: '2026-10-15T10:02:00Z' },
      { id: 'n4', business_id: B, branch_id: BR, user_id: MGR, title: 'For Mary', read_at: null, created_at: '2026-10-15T10:03:00Z' },
      { id: 'n5', business_id: B, branch_id: BR, user_id: CASH, title: 'For Joe', read_at: null, created_at: '2026-10-15T10:04:00Z' },
    ];
  };
  resetNotes();
  await ok('a manager sees their branch\'s, addressed to nobody or to them — never the owner\'s, another\'s or another branch\'s', async () => {
    const r = await call('GET', `/api/notifications?branch=${BR2}`, T.mgrWeb);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.notifications.map((n) => n.id).sort(), ['n1', 'n4']);
  });
  await ok('the owner sees every one', async () => {
    const r = await call('GET', '/api/notifications', T.owner);
    assert.equal(r.body.notifications.length, 5);
  });
  await ok('mark-read: the owner\'s notification is not the manager\'s to mark; read-all marks only their own', async () => {
    assert.equal((await call('PATCH', '/api/notifications/n2/read', T.mgrWeb)).status, 404);
    assert.equal(mem.db.notifications.find((n) => n.id === 'n2').read_at, null);
    assert.equal((await call('PATCH', '/api/notifications/n4/read', T.mgrWeb)).status, 204);
    resetNotes();
    await call('PATCH', '/api/notifications/read-all', T.mgrWeb);
    // memdb ignores .or(): the branch filter is what the in-memory database can show here.
    assert.equal(mem.db.notifications.find((n) => n.id === 'n3').read_at, null, 'another branch untouched');
  });

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n8. Day close\n');
  reset();
  await ok('/instruct for another branch\'s till is refused; its branch is the device\'s, not the body\'s', async () => {
    const bad = await call('POST', '/api/day-close/instruct', T.mgr, { device_id: 'dev-T2', business_date: '2026-10-15', counted_cash: 5 });
    assert.equal(bad.status, 403);
    const r = await call('POST', '/api/day-close/instruct', T.mgr, { device_id: 'dev-T1', business_date: '2026-10-15', counted_cash: 5, branch_id: BR2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mem.db.day_close_instructions[0].branch_id, BR);
    assert.equal((await call('POST', '/api/day-close/instruct', T.mgr, { device_id: 'dev-X', business_date: '2026-10-15', counted_cash: 5 })).status, 404);
  });
  await ok('/pending: a person\'s token is refused; a till naming another device is refused; its own gets its own', async () => {
    assert.equal((await call('GET', '/api/day-close/pending', T.mgr, undefined, { 'x-device-id': 'dev-T1' })).status, 403);
    assert.equal((await call('GET', '/api/day-close/pending', T.till2, undefined, { 'x-device-id': 'dev-T1' })).status, 403);
    const r = await call('GET', '/api/day-close/pending', T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200); assert.equal(r.body.length, 1);
  });
  await ok('/overview: a manager is held to their own branch', async () => {
    mem.db.business_days = [{ business_id: B, branch_id: BR, device_id: 'dev-T1', status: 'open' }, { business_id: B, branch_id: BR2, device_id: 'dev-T2', status: 'open' }];
    const r = await call('GET', `/api/day-close/overview?branch_id=${BR2}`, T.mgr);
    assert.equal(r.status, 200); assert.deepEqual(r.body.tills.map((t) => t.device_id), ['dev-T1']);
  });

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n9. Devices\n');
  reset();
  await ok('GET /api/devices needs devices.approve, and shows a manager their branch\'s', async () => {
    assert.equal((await call('GET', '/api/devices', T.cashWeb)).status, 403);
    const r = await call('GET', '/api/devices', T.mgrWeb);
    assert.equal(r.status, 200); assert.deepEqual(r.body.map((d) => d.device_id), ['dev-T1']);
  });
  await ok('approve / retire / remove a device of another branch: refused', async () => {
    for (const [m, p] of [['PATCH', '/api/devices/ud-2/approve'], ['PATCH', '/api/devices/ud-2/retire'], ['DELETE', '/api/devices/ud-2'], ['PATCH', '/api/devices/ud-2/label']]) {
      const r = await call(m, p, T.mgrWeb, { label: 'x' });
      assert.equal(r.status, 403, `${p}: ${r.status}`);
    }
    assert.ok(mem.db.user_devices.some((d) => d.id === 'ud-2' && !d.retired_at));
    assert.equal((await call('PATCH', '/api/devices/ud-1/label', T.mgrWeb, { label: 'Front' })).status, 200);
  });

  // ── 10 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n10. holds(): a till\'s own session widens nothing\n');
  await ok('holds() is false for a till token whatever it carries; true for the owner', async () => {
    assert.equal(historyScope.holds({ isTill: true, permissionKeys: ['*'] }, 'sales.history_all'), false);
    assert.equal(historyScope.holds({ isOwner: true }, 'sales.history_all'), true);
    assert.equal(historyScope.ownHistoryOnly({ isTill: true, permissionKeys: ['*'] }, {}), true);
  });
  resetOrders();
  await ok('a till token\'s History is not every cashier\'s sales, and it may not reprint', async () => {
    const r = await call('GET', '/api/orders', T.till);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.own_only, true); assert.equal(r.body.orders.length, 0); assert.equal(r.body.can_reprint, false);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
