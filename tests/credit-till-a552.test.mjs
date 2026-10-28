/**
 * credit-till-a552.test.mjs — A552: sales on account at the desktop till, the cloud's side.
 *
 * Owner, 2026-10-21: "for credit sales we need them on desktop app since its the one used by most clients".
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/credit-till-a552.test.mjs
 *
 * RUNS the COMPILED orders and pos routers behind the REAL requireAuth over HTTP, with TILL_SCOPE_ENFORCE=true, against an
 * in-memory database (supabase.from / .rpc stubbed) — the shape the till's push carries (peerRelay.buildCloudOrderPayload,
 * run here as compiled from apps/desktop/dist/main when it is built).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A552 report):
 *   - creditApproval's till branch ignoring credit_approved_by                → "born confirmed by the manager" fails
 *   - tillCreditApprover without the mayApprove(…'credit') check              → "a cashier named → awaiting" fails
 *   - tillCreditApprover without the worksAtBranch check                     → "another branch's manager named → awaiting" fails
 *   - GET /api/pos/credit-customers without the desktop-surface check         → "the web is refused" fails
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
if (!fs.existsSync(path.join(DIST, 'routes/orders.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.TILL_SCOPE_ENFORCE = 'true';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));

const id = () => randomUUID();
const BZ = id(), BR = id(), BR2 = id(), OWNER = id(), MGR = id(), MGR2 = id(), CASH = id(), CUST = id(), CUST2 = id(), LOYAL = id(), PROD = id();
const R_MGR = id(), R_CASH = id();
const PID = Object.fromEntries(['orders.create', 'customers.view', 'customers.credit'].map((k) => [k, id()]));
let db; let rpcs;
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });
const reset = () => {
  rpcs = [];
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, name: 'Pollo' }],
    branches: [{ id: BR, business_id: BZ, name: 'Westlands', status: 'active' }, { id: BR2, business_id: BZ, name: 'Kilimani', status: 'active' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [{ id: R_MGR, business_id: BZ, name: 'Manager' }, { id: R_CASH, business_id: BZ, name: 'Cashier' }],
    role_permissions: [grant(R_MGR, 'orders.create'), grant(R_MGR, 'customers.view'), grant(R_MGR, 'customers.credit'), grant(R_CASH, 'orders.create'), grant(R_CASH, 'customers.view')],
    users: [
      { id: OWNER, business_id: BZ, name: 'Olga', role_id: null, status: 'active', permissions_version: 1 },
      { id: MGR, business_id: BZ, name: 'Max', role_id: R_MGR, status: 'active', permissions_version: 1 },
      { id: MGR2, business_id: BZ, name: 'Mo', role_id: R_MGR, status: 'active', permissions_version: 1 },
      { id: CASH, business_id: BZ, name: 'Cate', role_id: R_CASH, status: 'active', permissions_version: 1 },
    ],
    user_branches: [{ user_id: MGR, branch_id: BR }, { user_id: MGR2, branch_id: BR2 }, { user_id: CASH, branch_id: BR }],
    user_permissions: [],
    user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null, terminal_code: 'T1', branch_id: BR }],
    customers: [
      { id: CUST, business_id: BZ, name: 'Acme Ltd', phone: '0712 000 111', credit_limit: 1000, credit_balance: 300, status: 'active' },
      { id: CUST2, business_id: BZ, name: 'Owes Only', phone: null, credit_limit: 0, credit_balance: 50, status: 'active' },
      { id: LOYAL, business_id: BZ, name: 'Loyalty only', phone: '0700', credit_limit: 0, credit_balance: 0, status: 'active' },
    ],
    products: [{ id: PROD, business_id: BZ, name: 'Chips', base_price: 200, status: 'active', track_stock: false }],
    orders: [], credit_confirmations: [], customer_credit_transactions: [], business_settings: [], feature_flags: [],
  };
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
  if (table === 'orders') return { ...r, payments: r.payments ?? [], order_items: r.order_items ?? [] };
  return r;
};
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null; let del = false; let range = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (inserted) return inserted;
    if (del) { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return hit; }
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    const all = rows().map((r) => view(table, r));
    return range ? all.slice(range[0], range[1] + 1) : all;
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => (k.includes('.') ? true : r[k] === v)); return q; };
      if (prop === 'neq') return (k, v) => { f.push((r) => r[k] !== v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => (k.includes('.') ? true : a.includes(r[k]))); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'or') return (expr) => {
        // 'credit_limit.gt.0,credit_balance.gt.0'
        const parts = String(expr).split(',').map((x) => x.split('.'));
        f.push((r) => parts.some(([k, op, v]) => (op === 'gt' ? Number(r[k]) > Number(v) : false)));
        return q;
      };
      if (prop === 'range') return (a, b) => { range = [a, b]; return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'delete') return () => { del = true; return q; };
      if (prop === 'insert' || prop === 'upsert') return (r, opts) => {
        inserted = [];
        for (const x of (Array.isArray(r) ? r : [r])) {
          const keys = String(opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          const hit = keys.length ? (db[table] ??= []).find((row) => keys.every((k) => row[k] === x[k])) : null;
          if (hit) { if (!opts?.ignoreDuplicates) Object.assign(hit, x); inserted.push(hit); continue; }
          const row = { id: x.id ?? id(), ...x }; (db[table] ??= []).push(row); inserted.push(row);
        }
        return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none', code: 'PGRST116' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null, count: run().length }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async (name, args) => {
  rpcs.push({ name, args });
  if (name === 'create_order_atomic') {
    const o = { id: id(), ...args.p_order, payments: (args.p_payments ?? []).map((p) => ({ id: id(), ...p })) };
    db.orders.push(o);
    return { data: [{ id: o.id, order_number: o.order_number, created_at: new Date().toISOString() }], error: null };
  }
  return { data: null, error: null };
};

const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', businessId: BZ, branchId: BR, isOwner: false, ...p },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const T = {
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  cashOnTill: sign({ userId: CASH, permissionKeys: ['orders.create', 'customers.view'], surface: 'desktop', pinSignIn: true }),
  cashWeb: sign({ userId: CASH, permissionKeys: ['orders.create', 'customers.view'] }),
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/orders', require(path.join(DIST, 'routes/orders.js')).default);
app.use('/api/pos', require(path.join(DIST, 'routes/pos.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': 'dev-T1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const warnings = async (fn) => {
  const lines = []; const w = console.warn; console.warn = (...a) => { lines.push(a.join(' ')); };
  try { return { r: await fn(), lines }; } finally { console.warn = w; }
};

// The till's own payload builder, when the desktop is built (the shape it really pushes); else the same fields by hand.
const relayPath = path.join(ROOT, 'apps/desktop/dist/main/peerRelay.js');
const build = fs.existsSync(relayPath) ? createRequire(relayPath)(relayPath).buildCloudOrderPayload : null;
let n = 0;
const tillSale = (approvedBy, extra = {}) => {
  n++;
  const orderPayload = {
    branch_id: BR, order_number: `T1-${n}`, order_type: 'retail', customer_id: CUST, customer_name: 'Acme Ltd', total: 200, subtotal: 200,
    vat_amount: 27.59, items: [{ product: { id: PROD, name: 'Chips' }, quantity: 1, unitPrice: 200, lineTotal: 200 }],
    payments: [{ method: 'credit', amount: 200, amount_tendered: 200, change_given: 0, reference: null }],
    ...(approvedBy !== undefined ? { credit_approved_by: approvedBy } : {}),
    on_account: { customer: 'Acme Ltd', balance_owed: 500 }, kot_sent: false, receipt_copies: 1, ...extra,
  };
  const ctx = { shiftId: null, deviceId: 'dev-T1', orderId: id(), createdAt: new Date().toISOString(), cashierId: CASH };
  return build ? build(orderPayload, ctx) : { ...orderPayload, device_id: 'dev-T1', cashier_id: CASH, idempotency_key: ctx.orderId, created_at: ctx.createdAt };
};
const rowOf = (orderId) => db.credit_confirmations.find((c) => c.order_id === orderId);

try {
  state._setPermissionsMigrated(true);
  console.log(`\nA552 — sales on account at the till: the cloud's side (TILL_SCOPE_ENFORCE=true; payload ${build ? 'built by the till\'s own peerRelay' : 'by hand'})\n`);

  await ok('the push carries who approved it, never the PIN or the receipt\'s lines', () => {
    const p = tillSale(MGR, { credit_pin: '1234' });
    assert.equal(p.credit_approved_by, MGR);
    if (build) { assert.equal(p.credit_pin, undefined); assert.equal(p.on_account, undefined); }
  });

  await ok('approved at the till by a manager of the branch (their PIN, or signed in with customers.credit): 201, BORN CONFIRMED by them', async () => {
    reset();
    const { r, lines } = await warnings(() => call('POST', '/api/orders', T.till, tillSale(MGR)));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = rowOf(r.body.orderId);
    assert.deepEqual([c.state, c.source, c.decided_by, c.approved_at_sale_by, c.decided_by_name], ['confirmed', 'till', MGR, MGR, 'Max']);
    assert.ok(!lines.some((l) => /\[tillScope\] REFUSED/.test(l)), lines.join('\n'));
    assert.match(rpcs.find((x) => x.name === 'apply_credit_transaction').args.p_notes, /approved by Max at the POS/);
  });

  await ok('…the same under a person\'s sign-in on the till (A505 tillMadeSale): born confirmed by the manager named', async () => {
    reset();
    const r = await call('POST', '/api/orders', T.cashOnTill, tillSale(MGR));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rowOf(r.body.orderId).state, 'confirmed');
  });

  await ok('the owner named: born confirmed (the owner approves at any branch)', async () => {
    reset();
    const r = await call('POST', '/api/orders', T.till, tillSale(OWNER));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([rowOf(r.body.orderId).state, rowOf(r.body.orderId).decided_by], ['confirmed', OWNER]);
  });

  await ok('a cashier named (no customers.credit) → recorded AWAITING a manager — never refused', async () => {
    reset();
    const r = await call('POST', '/api/orders', T.till, tillSale(CASH));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = rowOf(r.body.orderId);
    assert.deepEqual([c.state, c.decided_by, c.approved_at_sale_by], ['awaiting', null, null]);
  });

  await ok('another branch\'s manager named → awaiting (an approver must work at the sale\'s branch)', async () => {
    reset();
    const r = await call('POST', '/api/orders', T.till, tillSale(MGR2));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rowOf(r.body.orderId).state, 'awaiting');
  });

  await ok('nobody named (a 1.0.19 till), an unknown id or junk → awaiting, as A545', async () => {
    for (const who of [undefined, id(), 'drop table', 42]) {
      reset();
      const r = await call('POST', '/api/orders', T.till, tillSale(who));
      assert.equal(r.status, 201, `${who}: ${JSON.stringify(r.body)}`);
      assert.equal(rowOf(r.body.orderId).state, 'awaiting', String(who));
    }
  });

  await ok('past the limit (another till\'s sale got there first): still recorded, flagged over_limit, approved as named', async () => {
    reset();
    db.customers[0].credit_balance = 950;
    const r = await call('POST', '/api/orders', T.till, tillSale(MGR));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([rowOf(r.body.orderId).over_limit, rowOf(r.body.orderId).state], [true, 'confirmed']);
  });

  await ok('split: part on account, part cash — only the account part is charged and confirmed', async () => {
    reset();
    const p = tillSale(MGR, { payments: [{ method: 'credit', amount: 120, amount_tendered: 120, change_given: 0, reference: null }, { method: 'cash', amount: 80, amount_tendered: 100, change_given: 20, reference: null }] });
    const r = await call('POST', '/api/orders', T.till, p);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rowOf(r.body.orderId).amount, 120);
    assert.equal(rpcs.find((x) => x.name === 'apply_credit_transaction').args.p_amount, 120);
  });

  await ok('a live web sale naming credit_approved_by is NOT approved by it — the web still needs the PIN (A511)', async () => {
    reset();
    const p = { ...tillSale(MGR) }; delete p.created_at; delete p.client_created_at;
    const r = await call('POST', '/api/orders', T.cashWeb, p);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'CREDIT_APPROVAL_REQUIRED');
  });

  await ok('GET /api/pos/credit-customers: the till\'s own sign-in gets every customer with a limit or a balance (not loyalty-only ones)', async () => {
    reset();
    const { r, lines } = await warnings(() => call('GET', '/api/pos/credit-customers', T.till));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!Number.isNaN(Date.parse(r.body.at)));
    assert.deepEqual(r.body.customers.map((c) => c.id).sort(), [CUST, CUST2].sort());
    const a = r.body.customers.find((c) => c.id === CUST);
    // A595 (docs/PERMISSIONS-AUDIT.md F4): the POS's own session gets names, limits and balances — the phone masked.
    assert.deepEqual([a.name, a.phone, a.credit_limit, a.credit_balance, a.status], ['Acme Ltd', '07•• ••• 111', 1000, 300, 'active']);
    assert.ok(!lines.some((l) => /\[tillScope\] REFUSED/.test(l)), lines.join('\n'));
  });

  await ok('…a person on a till too; the web is refused (desktop only)', async () => {
    reset();
    assert.equal((await call('GET', '/api/pos/credit-customers', T.cashOnTill)).status, 200);
    assert.equal((await call('GET', '/api/pos/credit-customers', T.cashWeb)).status, 403);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
