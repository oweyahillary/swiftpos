/**
 * kitchen-voids.test.mjs — 0.6.28: the cloud's side of kitchen voids. Runs the BUILT server routes (apps/server/dist)
 * against an in-memory stand-in for the database.
 *
 * Owner, 2026-10-01: a sent order could be cancelled after the customer paid in cash — "the cashier pockets the money".
 * On the web a sent order is an OPEN order on the cloud; its items leave it only through POST /api/orders/:id/kitchen-void
 * (a reason, made or not, a manager with 'kitchen_void_approval'); the till pushes its own voids through /api/sync/push;
 * a web shift with an unpaid sent order is not closed (switch on); the Z-report (EOD) lists the voids.
 *
 *   node tests/kitchen-voids.test.mjs          (build apps/server first — this runs its dist/)
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - the route skips the approver with the switch on               → "a cashier alone cannot void (switch on)" fails
 *   - the route accepts a paid order                                 → "a paid sale is not kitchen-voided" fails
 *   - the order's money is not recomputed                            → "the open order's total drops by the void" fails
 *   - sync stores a void under the till's business_id                → "the business is forced from the token" fails
 *   - sync omits upserted.kitchenVoids                               → "the push says how many it stored" fails
 *   - the close skips the unpaid-order check                         → "a web shift with an unpaid sent order is not closed" fails
 *   - the migration's reason list drifts from the shared one         → "the cloud admits exactly the shared reasons" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'routes/orders.js'))) {
  console.log('\nCannot load apps/server/dist/routes/orders.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const KL = require(path.join(DIST, 'lib/kitchenLines.js'));
const bcrypt = require('bcrypt');

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const T1 = 'ed377ee4-bbe6-46c1-8fd7-e851d9edadb9';
const CASHIER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', MANAGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S1 = '33333333-3333-4333-8333-333333333333';
const O1 = '55555555-5555-4555-8555-555555555555', O2 = '66666666-6666-4666-8666-666666666666';
const I1 = '77777777-7777-4777-8777-777777777777', I2 = '88888888-8888-4888-8888-888888888888';
const KV = '99999999-9999-4999-8999-999999999999';
const pinHash = (p) => bcrypt.hashSync(p, 4);
const role = (name, keys) => ({ name, role_permissions: keys.map((k) => ({ permissions: { key: k } })) });

let db;
const reset = (switchOn = true) => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, vat_rate: 16, ctl_rate: 0 }],
    feature_flags: switchOn ? [{ business_id: BZ, key: 'kitchen_void_approval', enabled: true }] : [],
    users: [
      { id: CASHIER, business_id: BZ, status: 'active', name: 'Amy', pin_hash: pinHash('1111'), roles: role('Cashier', ['orders.create']), user_permissions: [] },
      { id: MANAGER, business_id: BZ, status: 'active', name: 'Mary', pin_hash: pinHash('2222'), roles: role('Manager', ['orders.void', 'shifts.manage']), user_permissions: [] },
      { id: OWNER, business_id: BZ, status: 'active', name: 'Eugene', pin_hash: pinHash('3333'), roles: role('Owner', []), user_permissions: [] },
    ],
    shifts: [{ id: S1, business_id: BZ, branch_id: BR, device_id: T1, terminal_code: 'T1', cashier_id: CASHIER, opened_by: CASHIER,
               status: 'open', opening_float: 0, opened_at: '2026-10-01T06:00:00Z' }],
    orders: [
      { id: O1, business_id: BZ, branch_id: BR, shift_id: S1, order_number: 'ORD-1', status: 'open', subtotal: 2300, total: 2300 },
      { id: O2, business_id: BZ, branch_id: BR, shift_id: S1, order_number: 'ORD-2', status: 'completed', subtotal: 1000, total: 1000 },
    ],
    order_items: [
      { id: I1, order_id: O1, product_id: null, product_name: 'Chicken', unit_price: 1000, quantity: 2, subtotal: 2000 },
      { id: I2, order_id: O1, product_id: null, product_name: 'Soda', unit_price: 300, quantity: 1, subtotal: 300 },
    ],
    payments: [], float_transactions: [], expenses: [], kitchen_voids: [],
  };
};
const embed = (table, r) => (table === 'orders' ? { ...r, order_items: db.order_items.filter((i) => i.order_id === r.id) } : r);

// In-memory stand-in: filters, update, insert, delete, upsert, maybeSingle/single, and orders' embedded order_items.
supabase.from = (table) => {
  const f = []; let patch = null; let ins = null; let del = false; let up = null; let lim = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const run = () => {
    if (patch) { const hit = rows(); for (const r of hit) Object.assign(r, patch); return { data: hit, error: null }; }
    if (ins) { const list = (db[table] ??= []); for (const r of [].concat(ins)) list.push({ id: r.id ?? `gen-${list.length}`, ...r }); return { data: ins, error: null }; }
    if (del) { const hit = new Set(rows()); db[table] = db[table].filter((r) => !hit.has(r)); return { data: null, error: null }; }
    if (up) { const list = (db[table] ??= []); const i = list.findIndex((x) => x.id === up.id); if (i >= 0) list[i] = { ...list[i], ...up }; else list.push({ ...up }); return { data: null, error: null }; }
    const all = rows().map((r) => embed(table, r));
    return { data: lim ? all.slice(0, lim) : all, error: null };
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'insert') return (r) => { ins = r; return q; };
      if (prop === 'delete') return () => { del = true; return q; };
      if (prop === 'upsert') return (r) => { up = r; return q; };
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'neq') return (k, v) => { f.push([k, (x) => x !== v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'is') return (k, v) => { f.push([k, (x) => (v === null ? x == null : x === v)]); return q; };
      if (prop === 'limit') return (n) => { lim = n; return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run().data[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run(); return Promise.resolve(r.data[0] ? { data: r.data[0], error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/orders', require(path.join(DIST, 'routes/orders.js')).default);
app.use('/api/sync', require(path.join(DIST, 'routes/sync.js')).default);
app.use('/api/shifts', require(path.join(DIST, 'routes/shifts.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const tok = (userId, surface, keys) => jwt.sign({ userId, businessId: BZ, branchId: BR, isOwner: userId === OWNER, permissionKeys: keys,
  permissionsVersion: 0, sessionId: 's', surface }, process.env.JWT_SECRET);
const call = async (p, body, { user = CASHIER, surface = 'web', keys = ['orders.create'], headers = {} } = {}) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok(user, surface, keys)}`, 'content-type': 'application/json', 'x-device-id': T1, ...headers },
    body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const kv = (body, opts) => call(`/api/orders/${O1}/kitchen-void`, body, opts);
const order = (id) => db.orders.find((o) => o.id === id);

try {
  await ok('the cloud admits exactly the shared reasons (migration 112 = shared/kitchenLines.ts)', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/112_kitchen_voids.sql'), 'utf8');
    const list = /CHECK \(reason IN \(([^)]*)\)\)/.exec(sql)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(list, KL.KITCHEN_VOID_REASONS.map((r) => r.code));
  });

  await ok('a reason and "made or not" are required', async () => {
    reset();
    assert.equal((await kv({ lines: [{ order_item_id: I1, qty: 1 }], cooked: false })).status, 400);
    assert.equal((await kv({ lines: [{ order_item_id: I1, qty: 1 }], reason: 'changed_mind' })).status, 400);
    assert.equal(db.kitchen_voids.length, 0);
  });
  await ok('a cashier alone cannot void (switch on) — a manager\'s PIN is needed; a cashier\'s PIN is not one', async () => {
    reset();
    const r = await kv({ lines: [{ order_item_id: I1, qty: 1 }], reason: 'changed_mind', cooked: false });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'KITCHEN_VOID_APPROVAL_REQUIRED');
    const r2 = await kv({ lines: [{ order_item_id: I1, qty: 1 }], reason: 'changed_mind', cooked: false, pin: '1111' });
    assert.equal(r2.status, 403); assert.equal(r2.body.code, 'INVALID_CONFIRMER_PIN');
    assert.equal(db.kitchen_voids.length, 0); assert.equal(db.order_items.find((i) => i.id === I1).quantity, 2);
  });
  await ok('a manager\'s PIN: the item is reduced, the open order\'s total drops by the void, the void is recorded', async () => {
    reset();
    const r = await kv({ lines: [{ order_item_id: I1, qty: 1 }], reason: 'changed_mind', cooked: true, note: ' table  left ', pin: '2222' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.total, r.body.remaining, r.body.orderVoided, r.body.approvedBy], [1000, 1300, false, 'Mary']);
    const it = db.order_items.find((i) => i.id === I1);
    assert.deepEqual([it.quantity, it.subtotal], [1, 1000]);
    assert.deepEqual([order(O1).subtotal, order(O1).total, order(O1).status], [1300, 1300, 'open']);
    const v = db.kitchen_voids[0];
    assert.deepEqual([v.business_id, v.shift_id, v.order_id, v.order_number, v.product_name, v.quantity, v.amount, v.reason, v.cooked, v.note,
      v.cashier_id, v.cashier_name, v.approved_by, v.approved_by_name],
      [BZ, S1, O1, 'ORD-1', 'Chicken', 1, 1000, 'changed_mind', true, 'table left', CASHIER, 'Amy', MANAGER, 'Mary']);
  });
  await ok('voiding what is left voids the order (nothing to charge)', async () => {
    const r = await kv({ lines: [{ order_item_id: I1, qty: 1 }, { order_item_id: I2, qty: 1 }], reason: 'wrong_item', cooked: false },
      { user: MANAGER, keys: ['orders.void'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.orderVoided, true); assert.equal(r.body.approvedBy, 'Mary', 'a manager signed in approves as themselves');
    assert.equal(order(O1).status, 'voided'); assert.match(order(O1).void_reason, /Kitchen void: Wrong item punched/);
    assert.equal(db.order_items.filter((i) => i.order_id === O1).length, 0);
  });
  await ok('switch off: the cashier may void — still recorded, no approver', async () => {
    reset(false);
    const r = await kv({ lines: [{ order_item_id: I2, qty: 1 }], reason: 'out_of_stock', cooked: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(db.kitchen_voids.length, 1); assert.equal(db.kitchen_voids[0].approved_by, null);
  });
  await ok('more than the order holds, or an item not on it, is refused', async () => {
    reset(false);
    assert.equal((await kv({ lines: [{ order_item_id: I1, qty: 3 }], reason: 'wrong_quantity', cooked: false })).status, 400);
    assert.equal((await kv({ lines: [{ order_item_id: 'nope', qty: 1 }], reason: 'wrong_quantity', cooked: false })).status, 400);
    assert.equal(db.kitchen_voids.length, 0);
  });
  await ok('a paid sale is not kitchen-voided (it is voided or refunded)', async () => {
    reset(false);
    const r = await call(`/api/orders/${O2}/kitchen-void`, { lines: [{ order_item_id: I1, qty: 1 }], reason: 'wrong_item', cooked: false });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'ORDER_NOT_OPEN');
  });

  // ── The till's push ──
  const tillVoid = (over = {}) => ({ id: KV, business_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', branch_id: BR, shift_id: S1, order_number: 'T1-100',
    product_name: 'Chicken', quantity: 1, unit_price: 1000, amount: 1000, reason: 'changed_mind', cooked: 1, cashier_id: CASHIER,
    cashier_name: 'Amy', approved_by: MANAGER, approved_by_name: 'Mary', device_id: T1, created_at: '2026-10-01T08:00:00Z', ...over });
  const push = (body) => call('/api/sync/push', body, { user: OWNER, surface: 'desktop', keys: ['*'], headers: { 'X-Schema-Version': '999' } });
  await ok('the push says how many it stored — 0 when there were none (the till waits for a count)', async () => {
    reset();
    const r = await push({});
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.upserted.kitchenVoids, 0);
  });
  await ok('the business is forced from the token; made is a boolean', async () => {
    reset();
    const r = await push({ kitchen_voids: [tillVoid()] });
    assert.equal(r.body.upserted.kitchenVoids, 1, JSON.stringify(r.body));
    assert.deepEqual([db.kitchen_voids[0].business_id, db.kitchen_voids[0].cooked], [BZ, true]);
  });
  await ok('a reason we do not offer is refused by name (the till parks it, never loses it silently)', async () => {
    reset();
    const r = await push({ kitchen_voids: [tillVoid({ reason: 'because' })] });
    assert.equal(r.body.upserted.kitchenVoids, 0);
    assert.deepEqual([r.body.rejected[0].table, r.body.rejected[0].code], ['kitchen_voids', 'invalid_reason']);
  });

  // ── The web's shift close ──
  await ok('a web shift with an unpaid sent order is not closed (switch on), naming it', async () => {
    reset();
    const r = await call(`/api/shifts/${S1}/close`, { closing_float: 0 });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'UNPAID_KITCHEN_ORDERS');
    assert.match(r.body.error, /#ORD-1/);
    assert.equal(db.shifts[0].status, 'open');
  });
  await ok('switch off, or the till\'s own replay: not refused for it', async () => {
    reset(false);
    const r = await call(`/api/shifts/${S1}/close`, { closing_float: 0 });
    assert.notEqual(r.body?.code, 'UNPAID_KITCHEN_ORDERS', JSON.stringify(r.body));
    reset(true);
    const r2 = await call(`/api/shifts/${S1}/close`, { closing_float: 0 }, { surface: 'desktop' });
    assert.notEqual(r2.body?.code, 'UNPAID_KITCHEN_ORDERS', JSON.stringify(r2.body));
  });

  // ── The web POS (source) ──
  const cs = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/CashierScreen.tsx'), 'utf8');
  await ok('the web: a sent line is reduced or removed only through a kitchen void; a sent tab is not dropped', () => {
    assert.match(cs, /onClick=\{\(\) => changeQty\(index, -1\)\}/);
    assert.match(cs, /onClick=\{\(\) => removeLine\(index\)\}/);
    assert.match(cs, /if \(activeSentId && it\?\.order_item_id && delta < 0\) \{\s*setKitchenVoid\(/);
    assert.match(cs, /function clearTable\(table: Table\) \{\s*if \(!sentTabGuard\(table\.id\)\)/);
    assert.match(cs, /function clearActiveOrder\(\) \{\s*if \(!sentTabGuard\(activeKey\)\) return;/);
    assert.match(cs, /`\/api\/orders\/\$\{activeSentId\}\/kitchen-void`/);
  });
  await ok('the web: the VOID ticket prints at the kitchen and dispatch; pay before kitchen hides Send', () => {
    assert.match(cs, /kinds: \['kitchen', 'dispatch'\], voided: \{ by: r\.approvedBy \?\? '', reason: voidReasonLabel\(v\.reason\) \},/);
    assert.match(cs, /\{maySendBeforePay\(posFeatures\.pay_before_kitchen, getOrderType\(\)\) && <button/);
  });
  await ok('the EOD Z-report carries the kitchen voids (lines, total, made)', () => {
    const rep = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/reports.ts'), 'utf8');
    assert.match(rep, /kitchenVoids: \{ summary: summariseKitchenVoids\(kitchenVoidLines\), lines: kitchenVoidLines \},/);
    const zm = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/ZReportModal.tsx'), 'utf8');
    assert.match(zm, /Kitchen voids \(\{data\.kitchenVoids!\.lines\.length\}\)/);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
