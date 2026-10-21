/**
 * credit-confirm-a545.test.mjs — A545: a credit sale a till already took is RECORDED (awaiting a manager), never refused;
 * every sale on account is confirmed or disputed by a manager; the live web POS still needs the manager's PIN (A511).
 *
 * Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that it
 * was done."
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/credit-confirm-a545.test.mjs
 *
 * RUNS the COMPILED orders and credit routers behind the REAL requireAuth over HTTP, with TILL_SCOPE_ENFORCE=true, against
 * an in-memory database (supabase.from / .rpc stubbed).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A545 report):
 *   - creditApproval without the isTillOwnSalePush / tillMadeSale branch  → "the till's own push … recorded, awaiting" fails (403)
 *   - TILL_EXEMPTIONS emptied                                            → "the exemption is precise" fails
 *   - creditRow born confirmed regardless (bornState → 'confirmed')      → "awaiting" cases fail
 *   - decisionRefusal without the ALREADY_DECIDED rule                   → "a manager cannot overturn" fails
 *   - the replay's worksAtBranch check removed                           → "a manager of another branch named as by" fails
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
if (!fs.existsSync(path.join(DIST, 'lib/creditConfirm.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.TILL_SCOPE_ENFORCE = 'true';   // A545: everything here runs with the till scope ENFORCED
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const TS = require(path.join(DIST, 'lib/tillScope.js'));
const CC = require(path.join(DIST, 'lib/creditConfirm.js'));

const id = () => randomUUID();
const BZ = id(), BR = id(), BR2 = id(), OWNER = id(), MGR = id(), MGR2 = id(), CASH = id(), CUST = id(), PROD = id();
const R_MGR = id(), R_CASH = id();
const PID = Object.fromEntries(['orders.create', 'customers.view', 'customers.credit', 'sales.void', 'shifts.close_day'].map((k) => [k, id()]));

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
    customers: [{ id: CUST, business_id: BZ, name: 'Acme Ltd', credit_limit: 1000, credit_balance: 0, status: 'active' }],
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
  const f = []; let patch = null; let inserted = null; let del = false;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (inserted) return inserted;
    if (del) { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return hit; }
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    return rows().map((r) => view(table, r));
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => (k.includes('.') ? true : r[k] === v)); return q; };
      if (prop === 'neq') return (k, v) => { f.push((r) => r[k] !== v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => (k.includes('.') ? true : a.includes(r[k]))); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
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
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'] }),
  mgr: sign({ userId: MGR, permissionKeys: ['orders.create', 'customers.view', 'customers.credit'] }),
  mgr2: sign({ userId: MGR2, branchId: BR2, permissionKeys: ['orders.create', 'customers.view', 'customers.credit'] }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create', 'customers.view'] }),
  closer: sign({ userId: MGR, permissionKeys: ['shifts.close_day'] }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
  cashOnTill: sign({ userId: CASH, permissionKeys: ['orders.create', 'customers.view'], surface: 'desktop', pinSignIn: true }),
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/orders', require(path.join(DIST, 'routes/orders.js')).default);
app.use('/api/credit', require(path.join(DIST, 'routes/credit.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const sale = (n, extra = {}) => ({
  branch_id: BR, order_number: `T1-${n}`, order_type: 'retail', customer_id: CUST, total: 200, subtotal: 200,
  items: [{ product: { id: PROD, name: 'Chips' }, quantity: 1, unit_price: 200, subtotal: 200 }],
  payments: [{ method: 'credit', amount: 200 }], ...extra,
});
const warnings = async (fn) => {
  const lines = []; const w = console.warn; console.warn = (...a) => { lines.push(a.join(' ')); };
  try { return { r: await fn(), lines }; } finally { console.warn = w; }
};
const row = (orderId) => db.credit_confirmations.find((c) => c.order_id === orderId);

try {
  state._setPermissionsMigrated(true);
  console.log('\nA545 — credit sales: recorded, then confirmed by a manager (TILL_SCOPE_ENFORCE=true)\n');

  await ok('the exemption is precise: customers.credit only on the till\'s own push of a sale it took (POST /api/orders + its time)', () => {
    assert.equal(TS.TILL_SCOPE_ENFORCE, true);
    assert.ok(!TS.TILL_KEYS.has('customers.credit'), 'never a blanket key');
    const req = (o) => ({ isTill: true, deviceId: 'dev-T1', method: 'POST', originalUrl: '/api/orders', body: { created_at: '2026-10-21T09:00:00Z' }, ...o });
    const quiet = () => {};
    assert.equal(TS.tillMay(req({}), ['customers.credit'], quiet), true);
    assert.equal(TS.tillMay(req({ body: {} }), ['customers.credit'], quiet), false, 'a live sale (no till time)');
    assert.equal(TS.tillMay(req({ originalUrl: '/api/orders/x/pay' }), ['customers.credit'], quiet), false, 'a payment at a counter');
    assert.equal(TS.tillMay(req({ originalUrl: '/api/credit/customer/x/limit', method: 'PATCH' }), ['customers.credit'], quiet), false, 'managing credit');
    assert.equal(TS.tillMay(req({ deviceId: null }), ['customers.credit'], quiet), false, 'no device in the token');
    assert.equal(TS.tillMay(req({}), ['customers.edit'], quiet), false, 'only the one key');
  });

  await ok('the till\'s own push of a credit sale it took: 201, recorded AWAITING a manager (source till) — never 403, nothing refused', async () => {
    reset();
    const { r, lines } = await warnings(() => call('POST', '/api/orders', T.till, sale(1, { created_at: '2026-10-21T09:00:00Z' })));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = row(r.body.orderId);
    assert.ok(c, 'a confirmation row');
    assert.deepEqual([c.state, c.source, c.decided_by, c.approved_at_sale_by, c.amount, c.branch_id], ['awaiting', 'till', null, null, 200, BR]);
    assert.ok(!lines.some((l) => /\[tillScope\] REFUSED/.test(l)), lines.join('\n'));
    const ledger = rpcs.find((x) => x.name === 'apply_credit_transaction');
    assert.match(ledger.args.p_notes, /awaiting a manager's confirmation/);
  });

  await ok('…a person\'s sign-in on the till pushing it (A505 tillMadeSale) — recorded awaiting too, not refused for their keys', async () => {
    reset();
    const r = await call('POST', '/api/orders', T.cashOnTill, sale(2, { created_at: '2026-10-21T09:05:00Z' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(row(r.body.orderId).state, 'awaiting');
  });

  await ok('…past the customer\'s limit (the goods are gone): recorded, flagged over_limit, the ledger not limit-enforced', async () => {
    reset();
    db.customers[0].credit_balance = 950;
    const r = await call('POST', '/api/orders', T.till, sale(3, { created_at: '2026-10-21T09:10:00Z' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(row(r.body.orderId).over_limit, true);
    assert.equal(rpcs.find((x) => x.name === 'apply_credit_transaction').args.p_enforce_limit, false);
  });

  await ok('the live web POS is A511 as it was: a cashier without customers.credit → 403 CREDIT_APPROVAL_REQUIRED, nothing recorded', async () => {
    reset();
    const r = await call('POST', '/api/orders', T.cash, sale(4));
    assert.equal(r.status, 403); assert.equal(r.body.code, 'CREDIT_APPROVAL_REQUIRED');
    assert.equal(db.credit_confirmations.length, 0);
    db.customers[0].credit_balance = 950;
    const over = await call('POST', '/api/orders', T.mgr, sale(5));
    assert.equal(over.status, 400, 'a live sale past the limit is still refused');
  });

  await ok('a sale approved at the moment of sale (the seller holds customers.credit) is BORN confirmed by them', async () => {
    reset();
    const r = await call('POST', '/api/orders', T.mgr, sale(6));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = row(r.body.orderId);
    assert.deepEqual([c.state, c.source, c.decided_by, c.approved_at_sale_by], ['confirmed', 'web', MGR, MGR]);
    assert.ok(c.decided_at);
  });

  const seed = (o) => { const orderId = id(); db.orders.push({ id: orderId, business_id: BZ, branch_id: o.branch_id ?? BR, order_number: o.n ?? 'X-1', status: 'completed' });
    db.credit_confirmations.push({ order_id: orderId, business_id: BZ, branch_id: BR, customer_id: CUST, amount: 300, state: 'awaiting', source: 'till', over_limit: false,
      cashier_id: CASH, approved_at_sale_by: null, decided_by: null, decided_by_name: null, decided_at: null, dispute_reason: null, sold_at: '2026-10-21T08:00:00Z', ...o });
    return orderId; };

  await ok('the list: a manager sees their branch\'s open credit sales with names; a cashier may not; the till\'s token may not', async () => {
    reset();
    const a = seed({ n: 'A-1' }); seed({ n: 'B-1', branch_id: BR2 }); seed({ n: 'C-1', state: 'confirmed', decided_at: 'x' });
    const r = await call('GET', '/api/credit/sales', T.mgr);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rows.map((x) => x.order_id), [a]);
    assert.equal(r.body.rows[0].customer_name, 'Acme Ltd'); assert.equal(r.body.rows[0].cashier_name, 'Cate');
    assert.equal(r.body.counts.awaiting, 1); assert.match(r.body.notice, /^1 credit sale awaits a manager's confirmation$/);
    const own = await call('GET', '/api/credit/sales', T.owner);
    assert.equal(own.body.rows.length, 2, 'the owner: every branch');
    assert.equal((await call('GET', '/api/credit/sales', T.cash)).status, 403);
    const { r: t } = await warnings(() => call('GET', '/api/credit/sales', T.till));
    assert.equal(t.status, 403, 'the till\'s own token never reads or manages credit');
  });

  await ok('the count for Close Day: whoever closes the day reads it; it says how many — never a block', async () => {
    reset();
    seed({}); seed({});
    const r = await call('GET', '/api/credit/sales/count', T.closer);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.awaiting, 2); assert.equal(r.body.notice, '2 credit sales await a manager\'s confirmation');
  });

  await ok('confirm / dispute: a manager as themselves, own branch only; a dispute needs a reason; a decided sale only the owner changes', async () => {
    reset();
    const a = seed({}), b = seed({}), other = seed({ branch_id: BR2 });
    const c = await call('POST', `/api/credit/sales/${a}/confirm`, T.mgr, {});
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.deepEqual([row(a).state, row(a).decided_by, row(a).decided_by_name], ['confirmed', MGR, 'Max']);
    assert.equal((await call('POST', `/api/credit/sales/${other}/confirm`, T.mgr, {})).body.code, 'OTHER_BRANCH');
    assert.equal((await call('POST', `/api/credit/sales/${b}/dispute`, T.mgr, { reason: '  ' })).body.code, 'REASON_REQUIRED');
    assert.equal((await call('POST', `/api/credit/sales/${b}/confirm`, T.cash, {})).status, 403, 'a cashier');
    const d = await call('POST', `/api/credit/sales/${b}/dispute`, T.mgr, { reason: 'Customer says not theirs' });
    assert.equal(d.status, 200); assert.deepEqual([row(b).state, row(b).dispute_reason], ['disputed', 'Customer says not theirs']);
    const again = await call('POST', `/api/credit/sales/${a}/dispute`, T.mgr, { reason: 'changed my mind' });
    assert.equal(again.status, 409); assert.equal(again.body.code, 'ALREADY_DECIDED');
    const owner = await call('POST', `/api/credit/sales/${b}/confirm`, T.owner, {});
    assert.equal(owner.status, 200, 'the owner may change a decided sale'); assert.equal(row(b).state, 'confirmed');
    assert.equal(row(b).dispute_reason, null);
    const repeat = await call('POST', `/api/credit/sales/${b}/confirm`, T.mgr, {});
    assert.equal(repeat.body.duplicate, true, 'the same decision again is a repeat');
  });

  await ok('the till\'s offline replay: its own token, naming who (by) — a manager at the sale\'s branch; never a cashier or a manager elsewhere', async () => {
    reset();
    const a = seed({}), b = seed({});
    const at = new Date(Date.now() - 3_600_000).toISOString();   // decided an hour ago, offline
    const { r, lines } = await warnings(() => call('POST', `/api/credit/sales/${a}/replay`, T.till, { decision: 'confirm', by: MGR, at }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([row(a).state, row(a).decided_by, row(a).decided_at], ['confirmed', MGR, at]);
    assert.ok(!lines.some((l) => /\[tillScope\] REFUSED/.test(l)), lines.join('\n'));
    assert.equal((await call('POST', `/api/credit/sales/${b}/replay`, T.till, { decision: 'confirm', by: CASH })).body.code, 'NOT_A_CREDIT_APPROVER');
    assert.equal((await call('POST', `/api/credit/sales/${b}/replay`, T.till, { decision: 'confirm', by: MGR2 })).body.code, 'NOT_A_CREDIT_APPROVER', 'Mo works at Kilimani');
    assert.equal((await call('POST', `/api/credit/sales/${b}/replay`, T.till, { decision: 'dispute', by: MGR })).body.code, 'REASON_REQUIRED');
    assert.equal((await call('POST', `/api/credit/sales/${b}/replay`, T.mgr, { decision: 'confirm', by: MGR })).body.code, 'REPLAY_IS_THE_TILLS');
    assert.equal((await call('POST', `/api/credit/sales/${b}/confirm`, T.till, {})).body.code, 'TILL_SENDS_REPLAY');
    const late = await call('POST', `/api/credit/sales/${a}/replay`, T.till, { decision: 'dispute', by: MGR, reason: 'x' });
    assert.equal(late.body.code, 'ALREADY_DECIDED', 'a replay never overturns');
  });

  await ok('the customer\'s ledger marks a disputed sale (it stays on the balance)', async () => {
    reset();
    const a = seed({ state: 'disputed', decided_at: 'x', dispute_reason: 'Not theirs', decided_by_name: 'Max' });
    db.customer_credit_transactions.push({ id: id(), business_id: BZ, customer_id: CUST, type: 'charge', amount: 300, balance_after: 300, order_id: a, created_at: 'x' },
      { id: id(), business_id: BZ, customer_id: CUST, type: 'payment', amount: -100, balance_after: 200, order_id: null, created_at: 'y' });
    const r = await call('GET', `/api/credit/customer/${CUST}`, T.mgr);
    assert.equal(r.status, 200);
    const charge = r.body.ledger.find((l) => l.type === 'charge');
    assert.deepEqual([charge.confirm_state, charge.dispute_reason, charge.amount], ['disputed', 'Not theirs', 300]);
    assert.equal(r.body.ledger.find((l) => l.type === 'payment').confirm_state, undefined);
  });

  await ok('the rules (pure): born state, the decision\'s time, the words, the e-mail block', () => {
    assert.equal(CC.bornState(true), 'confirmed'); assert.equal(CC.bornState(false), 'awaiting');
    const r = CC.creditRow({ businessId: BZ, orderId: 'o', branchId: BR, customerId: CUST, amount: -12.345, source: 'web', approvedAtSale: true, approvedBy: null, approverName: 'Owner', cashierId: null, soldAt: '2026-10-21T09:00:00Z' });
    assert.deepEqual([r.state, r.decided_by_name, r.decided_at, r.amount], ['confirmed', 'Owner', '2026-10-21T09:00:00.000Z', 12.35]);
    const now = Date.parse('2026-10-21T12:00:00Z');
    assert.equal(CC.decisionTime('2026-10-21T11:00:00Z', now), '2026-10-21T11:00:00.000Z');
    assert.equal(CC.decisionTime('2027-01-01T00:00:00Z', now), new Date(now).toISOString(), 'never in the future');
    assert.equal(CC.awaitingSentence(0), '');
    const html = CC.creditEmailBlock({ awaiting: 2, awaiting_amount: 500, disputed: 1, disputed_amount: 300 },
      [{ order_id: 'o', order_number: 'A-1', customer_name: '<b>Acme</b>', amount: 300, decided_by_name: 'Max', dispute_reason: 'Not theirs' }], 'KES');
    assert.match(html, /2 credit sales await a manager&#39;s confirmation/); assert.match(html, /Disputed credit sales: <strong>1<\/strong>/);
    assert.match(html, /&lt;b&gt;Acme/); assert.equal(CC.creditEmailBlock({ awaiting: 0, awaiting_amount: 0, disputed: 0, disputed_amount: 0 }, [], 'KES'), '');
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
