/**
 * till-scope-enforce-a545.test.mjs — A545: with TILL_SCOPE_ENFORCE=true the cloud refuses NOTHING a 1.0.19 / 1.0.20 till
 * sends with its own sign-in in normal operation.
 *
 * A534's audit left one refusal (a credit sale pushed under the till's token → 403 CREDIT_APPROVAL_REQUIRED) and two
 * "would refuse" lines (POST /api/wastage asked menu.costs; a till-session void / refund fell to sales.void / sales.refund).
 * A545 fixed all three. This test replays EVERY till write path of lib/terminalWrites.ts TILL_WRITES (the A159 table) — and
 * the reads the till makes with its own sign-in (the A541 route table) — through the REAL API router (routes/index.js)
 * behind the REAL requireAuth, with the till's own token, TILL_SCOPE_ENFORCE=true, against an in-memory database. A request
 * may fail for its data (an empty stub answers 400 / 404 / 500); what must never happen is a till-scope refusal:
 * a "[tillScope] REFUSED" line, or a 403 "Missing permission". The paths that reach deep permission checks (a credit sale,
 * wastage with a typed cost, a live void / refund under the till's session, an offline replay) are seeded so they do.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/till-scope-enforce-a545.test.mjs
 *
 * Coverage is checked, not assumed: every TILL_WRITES pattern has a case here, and every write the till's source makes
 * with its own token (the scan of tests/desktop-writes-allowed.test.mjs) falls in a pattern that has one.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A545 report):
 *   - tillScope TILL_EXEMPTIONS emptied and creditApproval's till branch removed → "every till write…" fails (the credit sale)
 *   - wastage.ts back to can(req, 'menu.costs') for the till                        → fails (REFUSED menu.costs)
 *   - reversalGate without the till-session line                                    → fails (REFUSED sales.void / sales.refund)
 *   - a TILL_WRITES pattern added with no case                                      → "every TILL_WRITES pattern has a case" fails
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
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message.split('\n').slice(0, 30).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/index.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
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
const TW = require(path.join(DIST, 'lib/terminalWrites.js'));
const TS = require(path.join(DIST, 'lib/tillScope.js'));

const id = () => randomUUID();
const BZ = id(), BR = id(), OWNER = id(), MGR = id(), CASH = id(), CUST = id(), PROD = id(), ING = id(), SHIFT = id(), PAID = id(), OPEN = id(), STATION = id();
const R_MGR = id(), R_CASH = id();
const KEYS = ['orders.create', 'customers.view', 'customers.credit', 'sales.void', 'sales.refund', 'menu.costs', 'inventory.waste'];
const PID = Object.fromEntries(KEYS.map((k) => [k, id()]));
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });
let db;
const reset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, name: 'Pollo' }],
    branches: [{ id: BR, business_id: BZ, name: 'Westlands', status: 'active' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [{ id: R_MGR, business_id: BZ, name: 'Manager' }, { id: R_CASH, business_id: BZ, name: 'Cashier' }],
    role_permissions: [...['orders.create', 'customers.credit', 'sales.void', 'sales.refund', 'menu.costs', 'inventory.waste'].map((k) => grant(R_MGR, k)), grant(R_CASH, 'orders.create')],
    users: [
      { id: MGR, business_id: BZ, name: 'Max', role_id: R_MGR, status: 'active', pin_hash: null, permissions_version: 1 },
      { id: CASH, business_id: BZ, name: 'Cate', role_id: R_CASH, status: 'active', permissions_version: 1 },
    ],
    user_branches: [{ user_id: MGR, branch_id: BR }, { user_id: CASH, branch_id: BR }],
    user_permissions: [],
    user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null, terminal_code: 'T1', branch_id: BR, device_role: 'till' }],
    customers: [{ id: CUST, business_id: BZ, name: 'Acme Ltd', credit_limit: 1000, credit_balance: 0, status: 'active' }],
    products: [{ id: PROD, business_id: BZ, name: 'Chips', base_price: 200, cost_price: 80, status: 'active', track_stock: false, sold_by: 'unit' }],
    ingredients: [{ id: ING, business_id: BZ, name: 'Oil', unit_cost: 300, status: 'active' }],
    ingredient_stock_levels: [{ ingredient_id: ING, branch_id: BR, current_stock: 50 }],
    shifts: [{ id: SHIFT, business_id: BZ, branch_id: BR, device_id: 'dev-T1', status: 'open', opened_at: new Date().toISOString() }],
    orders: [
      { id: PAID, business_id: BZ, branch_id: BR, device_id: 'dev-T1', shift_id: SHIFT, order_number: 'T1-90', status: 'completed', total: 200,
        created_at: new Date().toISOString(), payments: [{ id: id(), status: 'completed', amount: 200, method: 'cash' }], order_items: [] },
      { id: OPEN, business_id: BZ, branch_id: BR, device_id: 'dev-T1', shift_id: SHIFT, order_number: 'T1-91', status: 'open', total: 200,
        created_at: new Date().toISOString(), payments: [], order_items: [] },
    ],
    stations: [{ id: STATION, business_id: BZ, branch_id: BR, name: 'Kitchen' }],
    credit_confirmations: [{ order_id: PAID, business_id: BZ, branch_id: BR, state: 'awaiting', amount: 200 }],
    business_settings: [], feature_flags: [],
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
      if (prop === 'in') return (k, a) => { f.push((r) => (k.includes('.') ? true : a.includes(r[k]))); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'delete') return () => { del = true; return q; };
      if (prop === 'insert' || prop === 'upsert') return (r) => { inserted = (Array.isArray(r) ? r : [r]).map((x) => { const row = { id: x.id ?? id(), ...x }; (db[table] ??= []).push(row); return row; }); return q; };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none', code: 'PGRST116' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null, count: run().length }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async (name, args) => {
  if (name === 'create_order_atomic') {
    const o = { id: id(), ...args.p_order }; db.orders.push(o);
    return { data: [{ id: o.id, order_number: o.order_number, created_at: new Date().toISOString() }], error: null };
  }
  return { data: null, error: null };
};

const TILL = jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'desktop', businessId: BZ, branchId: BR, isOwner: false,
  userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'] }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const now = () => new Date().toISOString();

// ── what a 1.0.19 / 1.0.20 till sends with its OWN sign-in ─────────────────────────────────────────────────────────────
const sale = (n, extra = {}) => ({ branch_id: BR, order_number: `T1-${n}`, order_type: 'retail', shift_id: SHIFT, created_at: now(), cashier_id: CASH,
  total: 200, subtotal: 200, items: [{ product: { id: PROD, name: 'Chips' }, quantity: 1, unit_price: 200, subtotal: 200 }],
  payments: [{ method: 'cash', amount: 200, status: 'completed' }], ...extra });
const WRITES = [
  ['POST', '/api/orders', sale(1)],
  ['POST', '/api/orders', sale(2, { customer_id: CUST, payments: [{ method: 'credit', amount: 200 }] })],                 // A545: credit, no PIN
  ['POST', `/api/orders/${PAID}/void`, { reason: 'wrong item', offline_approved_by: MGR, approved_at: now(), offline_by: CASH }],   // 0.6.30 replay
  ['POST', `/api/orders/${PAID}/refund`, { reason: 'returned', offline_approved_by: MGR, approved_at: now() }],
  ['POST', `/api/orders/${PAID}/void`, { reason: 'wrong item', supervisor_pin: '1234' }],                                // live, the till's session (A545)
  ['POST', `/api/orders/${PAID}/refund`, { reason: 'returned', override_pin: '1234', authorizer_id: MGR }],
  ['POST', `/api/orders/${OPEN}/void`, { reason: 'customer left' }],                                                    // unpaid, the holding till
  ['POST', '/api/sync/push', { business_days: [], shifts: [], float_transactions: [], expenses: [], kitchen_voids: [] }],
  // A602: the sales history in bulk — each sale through the same rules as POST /api/orders (a credit sale included)
  ['POST', '/api/sync/backfill', { orders: [{ id: id(), body: sale(3) }, { id: id(), body: sale(4, { customer_id: CUST, payments: [{ method: 'credit', amount: 200 }] }) }] }],
  ['POST', '/api/branch-prices/sync', { branch_id: BR, prices: [] }],
  ['POST', `/api/shifts/${SHIFT}/close`, { closing_float: 0, counted: {} }],
  ['POST', `/api/shifts/${SHIFT}/force-close`, { reason: 'end of day' }],
  ['POST', `/api/shifts/${SHIFT}/foreign-cash`, {}],
  ['POST', `/api/shifts/${SHIFT}/foreign-orders`, { order_ids: [] }],
  ['POST', `/api/shifts/${SHIFT}/confirm`, { confirmed_by: MGR, confirmed_methods: { cash: 0 } }],
  ['POST', '/api/shifts/confirmer', { pin: '1234' }],
  ['POST', '/api/day-close/ack', { id: id(), outcome: 'closed' }],
  ['PUT', '/api/business/branding', { logo_url: null }],
  ['PUT', `/api/stations/${STATION}/categories`, { category_ids: [] }],
  ['POST', '/api/wastage', { branch_id: BR, reason: 'spoiled', note: '', client_id: id(), recorded_by_name: 'Max', recorded_by: MGR, recorded_at: now(),
    items: [{ kind: 'ingredient', id: ING, quantity: 1, unit_cost: 310 }] }],                                           // A545: a typed cost
  ['POST', '/api/wastage', { branch_id: BR, reason: 'spoiled', note: '', client_id: id(), recorded_by_name: 'Cate', recorded_at: now(),
    items: [{ kind: 'ingredient', id: ING, quantity: 1 }] }],                                                           // what 1.0.19 sends
  ['POST', '/api/changes', { changes: [] }],
  ['POST', '/api/pos/join-code', { device_id: 'dev-T2' }],
  ['POST', '/api/support/logs', { text: 'log' }],
  ['POST', '/api/desktop-update/state', { state: 'idle', version: '1.0.20' }],
  ['POST', `/api/credit/sales/${PAID}/replay`, { decision: 'confirm', by: MGR, at: now() }],                            // A545
  ['POST', '/api/auth/refresh', { refreshToken: 'x' }],
  ['POST', '/api/tech/audit', { action: 'x' }],
];
// The reads a till makes with its own sign-in (the A541 table's GETs, less the manager screens' manageFetch reads).
const READS = ['/api/pos/init', '/api/pos/changes', '/api/pos/branch-drawers', '/api/pos/branch-staff', '/api/pos/catalogue-version',
  '/api/pos/test-data-clears', '/api/pos/branch', '/api/changes/state', '/api/day-close/pending', '/api/shifts/current', '/api/shifts/state',
  `/api/orders/${PAID}`, '/api/support/log-requests/mine', '/api/desktop-update/status', '/api/health',
  '/api/pos/credit-customers'];   // A552: the customers a till sells to on account

const send = async (method, p, body) => {
  const lines = [];
  const w = console.warn, e = console.error, l = console.log;
  console.warn = (...a) => { lines.push(a.join(' ')); }; console.error = (...a) => { lines.push(a.join(' ')); }; console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TILL}`, 'x-device-id': 'dev-T1' },
      ...(body !== undefined && method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, text, lines };
  } finally { console.warn = w; console.error = e; console.log = l; }
};
const refusal = (r) => {
  const scope = r.lines.filter((x) => /\[tillScope\] REFUSED/.test(x));
  if (scope.length) return scope.join(' | ');
  if (r.status === 403 && /Missing permission/i.test(r.text)) return r.text.slice(0, 200);
  return null;
};

try {
  state._setPermissionsMigrated(true);
  console.log('\nA545 — TILL_SCOPE_ENFORCE=true refuses nothing a till sends with its own sign-in\n');

  await ok('enforce is on for this run', () => assert.equal(TS.TILL_SCOPE_ENFORCE, true));

  await ok(`every TILL_WRITES pattern has a case here (${TW.TILL_WRITES.length} patterns)`, () => {
    const missing = TW.TILL_WRITES.filter((re) => !WRITES.some(([, p]) => re.test(p))).map(String);
    assert.deepEqual(missing, []);
  });

  await ok('every write the till makes with its own sign-in (src/main, the shared packages) falls in a pattern with a case', () => {
    const concrete = (p) => p.replace(/\$\{(?:[^{}]|\{[^}]*\})*\}/g, 'x').split('?')[0];
    const out = [];
    // D10: + src/main/ipc. Shared-components batch E: the desktop's src/shared moved into packages/core and packages/ui.
    for (const d of ['apps/desktop/src/main', 'apps/desktop/src/main/ipc', 'packages/core/src', 'packages/ui/src']) {
      for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => /\.tsx?$/.test(x))) {
        const lines = fs.readFileSync(path.join(ROOT, d, f), 'utf8').split('\n');
        lines.forEach((ln, i) => {
          if (/^\s*(\/\/|\*)/.test(ln) || /manageFetch\(/.test(ln)) return;
          for (const m of ln.matchAll(/[\x60'](?:\$\{[^}]*\})?(\/api\/[^\x60'\s]*)[\x60']/g)) {
            const win = (/fetch\(/i.test(ln) ? lines.slice(i, i + 4) : lines.slice(i, i + 30)).join('\n');
            if (/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(win)) out.push({ at: `${d}/${f}:${i + 1}`, path: concrete(m[1]) });
          }
        });
      }
    }
    assert.ok(out.length > 10, `the scan found ${out.length}`);
    const uncovered = out.filter((w) => { const re = TW.TILL_WRITES.find((r) => r.test(w.path)); return !re || !WRITES.some(([, p]) => re.test(p)); });
    assert.deepEqual(uncovered.map((w) => `${w.path} (${w.at})`), []);
  });

  await ok(`every till write (${WRITES.length}) under TILL_SCOPE_ENFORCE=true: no till-scope refusal`, async () => {
    const bad = [];
    for (const [m, p, body] of WRITES) {
      reset();
      const r = await send(m, p, body);
      const why = refusal(r);
      if (why) bad.push(`${m} ${p} → ${r.status}: ${why}`);
    }
    assert.deepEqual(bad, []);
  });

  await ok('…and the deep cases did reach their checks: the credit sale recorded awaiting, the wastage cost kept for a manager', async () => {
    reset();
    const c = await send('POST', '/api/orders', WRITES[1][2]);
    assert.equal(c.status, 201, c.text);
    assert.equal(db.credit_confirmations.at(-1).state, 'awaiting');
    reset();
    const w = await send('POST', '/api/wastage', WRITES.find(([, p, b]) => p === '/api/wastage' && b.recorded_by)[2]);
    assert.equal(w.status, 201, w.text);
    assert.equal(db.wastage_entries.at(-1).unit_cost, 310, 'Max holds menu.costs — the typed cost is kept');
    reset();
    const w2 = await send('POST', '/api/wastage', { ...WRITES.find(([, p, b]) => p === '/api/wastage' && b.recorded_by)[2], client_id: id(), recorded_by: CASH });
    assert.equal(w2.status, 201, w2.text);
    assert.equal(db.wastage_entries.at(-1).unit_cost, 300, 'Cate does not — the catalogue cost');
    reset();
    const v = await send('POST', `/api/orders/${OPEN}/void`, { reason: 'customer left' });
    assert.equal(v.status, 200, v.text);
    assert.equal(db.orders.find((o) => o.id === OPEN).status, 'voided');
    reset();
    const pv = await send('POST', `/api/orders/${PAID}/void`, { reason: 'wrong item' });
    assert.notEqual(pv.status, 200, 'a paid void from the till\'s session still needs the approver\'s PIN');
    assert.match(pv.text, /INVALID_APPROVER_PIN|NO_OVERRIDE_CONFIGURED/);
  });

  await ok(`the reads a till makes with its own sign-in (${READS.length}): no till-scope refusal`, async () => {
    const bad = [];
    for (const p of READS) {
      reset();
      const r = await send('GET', p);
      const why = refusal(r);
      if (why) bad.push(`GET ${p} → ${r.status}: ${why}`);
    }
    assert.deepEqual(bad, []);
  });

  // A564: another branch's stock and the requests between branches are a PERSON's (the till sends the signed-in person's
  // own sign-in — ipc/branchStock.ts manageFetch). The till's own sign-in is refused them: TILL_KEYS stays as it was.
  await ok('A564: the till\'s own sign-in never reads another branch\'s stock or the requests, nor asks (tillScope refuses)', async () => {
    assert.ok(!TS.TILL_KEYS.has('inventory.view') && !TS.TILL_KEYS.has('inventory.transfer'), 'TILL_KEYS widened');
    for (const [m, p, b] of [['GET', '/api/stock/other-branches?q=tusker'], ['GET', '/api/stock/requests'],
      ['POST', '/api/stock/requests', { from_branch_id: 'x', product_id: 'y', quantity: 1 }]]) {
      reset();
      const r = await send(m, p, b);
      assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    }
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
