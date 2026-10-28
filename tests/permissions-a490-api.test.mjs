/**
 * permissions-a490-api.test.mjs — A490 on the cloud, beyond the route gates (permissions-a490-routes.test.mjs):
 *   the roles API (fine keys stored, the ceiling by keys, the owner's role untouchable, delete in use, copy_from),
 *   a person's own overrides by key, the owner's controls (each section's key, validation), cost figures NOT SENT to
 *   someone who may not see them, the History / cash-movement switches before and after migration 134, the permission
 *   maps the clients are sent (the till's roster, sign-in), the cashier's own Z-report, report e-mail recipients, and the
 *   till's own sign-in logged (dry-run) when it asks for what a till does not do.
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/permissions-a490-api.test.mjs
 *
 * RUNS the COMPILED routers behind the REAL requireAuth over HTTP, against an in-memory database (supabase.from stubbed;
 * the embeds the routes read — a grant's permission, a role's grants — are joined by the stub).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A490 report):
 *   - roleCeiling.roleEditRefusal without the keysBeyond check            → "a manager cannot give a role more than they hold" fails
 *   - costAccess.seesCosts always true                                    → "GET /api/products: no cost_price …" fails
 *   - historyScope.ownHistoryOnly ignoring openBefore                     → "after 134: the switch no longer narrows …" fails
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
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.TILL_SCOPE_ENFORCE;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const P = require(path.join(DIST, 'lib/permissions.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const EP = require(path.join(DIST, 'lib/effectivePermissions.js'));
const HS = require(path.join(DIST, 'lib/historyScope.js'));
const OA = require(path.join(DIST, 'jobs/ownerAlertsData.js'));

const id = () => randomUUID();
const BZ = id(), BR = id(), OWNER = id(), MGR = id(), CASH = id(), CASH2 = id();
const R_OWNER = id(), R_MGR = id(), R_CASH = id(), R_EMPTY = id();
const PID = Object.fromEntries(['orders.create', 'products.view', 'sales.void', 'staff.edit', 'staff.roles', 'staff.view', 'settings.business', 'reports.view']
  .map((k) => [k, id()]));

// ── an in-memory database, with the embeds the routes read ────────────────────
let db;
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });
const reset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, name: 'Pollo', desktop_approved_version: null }],
    branches: [{ id: BR, business_id: BZ, name: 'A', is_main: true, status: 'active' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [{ id: R_OWNER, business_id: BZ, name: 'Owner' }, { id: R_MGR, business_id: BZ, name: 'Manager' },
            { id: R_CASH, business_id: BZ, name: 'Cashier' }, { id: R_EMPTY, business_id: BZ, name: 'Spare' }],
    role_permissions: [grant(R_MGR, 'orders.create'), grant(R_MGR, 'sales.void'), grant(R_MGR, 'staff.edit'), grant(R_MGR, 'staff.roles'),
      grant(R_MGR, 'staff.view'), grant(R_MGR, 'products.view'), grant(R_CASH, 'orders.create'), grant(R_CASH, 'products.view'), grant(R_OWNER, 'orders.create')],
    users: [
      { id: OWNER, business_id: BZ, name: 'Olga', role_id: R_OWNER, status: 'active', permissions_version: 1 },
      { id: MGR, business_id: BZ, name: 'Max', role_id: R_MGR, status: 'active', permissions_version: 1 },
      { id: CASH, business_id: BZ, name: 'Cate', role_id: R_CASH, status: 'active', permissions_version: 1 },
      { id: CASH2, business_id: BZ, name: 'Cid', role_id: R_CASH, status: 'active', permissions_version: 1 },
    ],
    user_branches: [{ user_id: MGR, branch_id: BR }, { user_id: CASH, branch_id: BR }, { user_id: CASH2, branch_id: BR }],
    user_permissions: [],
    user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null, terminal_code: 'T1', device_label: 'Front', app_version: '1.0.15', branch_id: BR }],
    products: [{ id: id(), business_id: BZ, name: 'Chips', base_price: 200, cost_price: 80, status: 'active' }],
    ingredients: [{ id: id(), business_id: BZ, name: 'Oil', unit_cost: 300, status: 'active' }],
    business_settings: [], feature_flags: [], orders: [], shifts: [], expenses: [], kitchen_voids: [], float_transactions: [],
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
  if (table === 'user_branches') { const u = db.users.find((x) => x.id === r.user_id); return { ...r, users: u ? view('users', u) : null }; }
  return r;
};
let nextId = 1;
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
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'delete') return () => { del = true; return q; };
      if (prop === 'insert' || prop === 'upsert') return (r, opts) => {
        const list = (Array.isArray(r) ? r : [r]);
        inserted = [];
        for (const x of list) {
          const keys = String(opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          const hit = keys.length ? (db[table] ??= []).find((row) => keys.every((k) => row[k] === x[k])) : null;
          if (hit) { if (!opts?.ignoreDuplicates) Object.assign(hit, x); inserted.push(hit); continue; }
          const row = { id: x.id ?? `row-${nextId++}`, ...x }; (db[table] ??= []).push(row); inserted.push(row);
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
supabase.rpc = async () => ({ data: null, error: null });

// ── tokens ────────────────────────────────────────────────────────────────────
const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', businessId: BZ, branchId: BR, isOwner: false, ...p },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'] }),
  mgr: sign({ userId: MGR, permissionKeys: ['orders.create', 'products.view', 'sales.void', 'staff.edit', 'staff.roles', 'staff.view'] }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create', 'products.view'] }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const as = (keys, userId = CASH) => sign({ userId, permissionKeys: keys });

// ── the app ───────────────────────────────────────────────────────────────────
const express = require('express');
const app = express(); app.use(express.json());
for (const [p, m] of [['/api/staff', 'staff'], ['/api/controls', 'controls'], ['/api/products', 'products'], ['/api/stock', 'stock'],
  ['/api/reports', 'reports'], ['/api/orders', 'orders'], ['/api/devices', 'devices'], ['/api/pos', 'pos']]) app.use(p, require(path.join(DIST, `routes/${m}.js`)).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const roleKeys = (rid) => db.role_permissions.filter((g) => g.role_id === rid).map((g) => db.permissions.find((p) => p.id === g.permission_id)?.key).sort();

try {
  state._setPermissionsMigrated(true);

  console.log('\n1. The catalogue and the roles API\n');
  await ok('GET /permissions: fine keys only, in catalogue order, with words and group — a key with no row yet is registered', async () => {
    reset();
    const r = await call('GET', '/api/staff/permissions', T.mgr);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((p) => p.key), [...P.PERMISSION_KEYS]);
    assert.ok(r.body.every((p) => p.id && p.label && p.description && p.group && p.surface), 'every field');
    assert.ok(!r.body.some((p) => P.isLegacyKey(p.key)), 'no broad key');
    assert.ok(db.permissions.some((p) => p.key === 'reports.costs'), 'registered on the way');
    const g = await call('GET', '/api/staff/permission-groups', T.mgr);
    assert.deepEqual(g.body.map((x) => x.id), P.PERMISSION_GROUPS.map((x) => x.id));
  });
  await ok('GET /roles: keys (fine), is_owner_role, assignable, editable, members — for a manager', async () => {
    reset();
    db.role_permissions.push(grant(R_CASH, 'reports.view'));   // a broad grant from before 134: shown as its fine keys
    db.role_permissions.push(grant(R_EMPTY, 'settings.business'));
    const r = await call('GET', '/api/staff/roles', T.mgr);
    const by = Object.fromEntries(r.body.map((x) => [x.name, x]));
    assert.equal(by.Owner.is_owner_role, true); assert.deepEqual(by.Owner.keys, ['*']);
    assert.equal(by.Owner.assignable, false); assert.equal(by.Owner.editable, false);
    assert.ok(by.Cashier.keys.includes('reports.sales') && !by.Cashier.keys.includes('reports.view'), JSON.stringify(by.Cashier.keys));
    assert.equal(by.Cashier.members, 2); assert.equal(by.Manager.members, 1);
    assert.equal(by.Cashier.assignable, false, 'holds reports Max does not');
    assert.equal(by.Spare.assignable, false); assert.equal(by.Spare.editable, false, 'settings.business is beyond Max');
    assert.equal(by.Manager.assignable, true); assert.equal(by.Manager.editable, true);
  });
  await ok('PUT /roles/:id/permissions { keys }: stores FINE keys only (a broad key expanded, \'*\' and unknown dropped)', async () => {
    reset();
    const r = await call('PUT', `/api/staff/roles/${R_CASH}/permissions`, T.owner, { keys: ['orders.create', 'customers.manage', '*', 'nope.nope'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // A595: a broad key stood for its fine keys' parts too (customers.delete, the credit parts).
    assert.deepEqual(roleKeys(R_CASH), ['customers.credit', 'customers.credit_adjust', 'customers.credit_payment', 'customers.delete', 'customers.edit', 'orders.create']);
    const back = await call('GET', '/api/staff/roles', T.owner);
    assert.deepEqual(back.body.find((x) => x.id === R_CASH).keys.sort(), ['customers.credit', 'customers.credit_adjust', 'customers.credit_payment', 'customers.delete', 'customers.edit', 'orders.create']);
  });
  await ok('…the old { permission_ids } still works (a broad id stored as its fine keys)', async () => {
    reset();
    const r = await call('PUT', `/api/staff/roles/${R_CASH}/permissions`, T.owner, { permission_ids: [PID['orders.create'], PID['reports.view']] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(roleKeys(R_CASH).includes('reports.sales') && !roleKeys(R_CASH).includes('reports.view'));
  });
  await ok('a manager cannot give a role more than they hold (403 with the keys), nor change a role holding more', async () => {
    reset();
    const r = await call('PUT', `/api/staff/roles/${R_CASH}/permissions`, T.mgr, { keys: ['orders.create', 'settings.business'] });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.deepEqual(r.body.missing, ['settings.business']);
    db.role_permissions.push(grant(R_EMPTY, 'settings.business'));
    const r2 = await call('PUT', `/api/staff/roles/${R_EMPTY}/permissions`, T.mgr, { keys: [] });
    assert.equal(r2.status, 403, JSON.stringify(r2.body));
    const r3 = await call('PUT', `/api/staff/roles/${R_CASH}/permissions`, T.mgr, { keys: ['orders.create', 'sales.void'] });
    assert.equal(r3.status, 200, JSON.stringify(r3.body)); assert.deepEqual(roleKeys(R_CASH), ['orders.create', 'sales.void']);
    // a role holding a key the manager lacks is not theirs to change (Max lacks reports.sales)
    db.role_permissions.push(grant(R_CASH, 'reports.view'));
    assert.equal((await call('PUT', `/api/staff/roles/${R_CASH}/permissions`, T.mgr, { keys: [] })).status, 403);
  });
  await ok('the owner\'s role is never edited, renamed or deleted — not even by the owner', async () => {
    reset();
    assert.equal((await call('PUT', `/api/staff/roles/${R_OWNER}/permissions`, T.owner, { keys: [] })).status, 403);
    assert.equal((await call('PATCH', `/api/staff/roles/${R_OWNER}`, T.owner, { name: 'Boss' })).status, 403);
    assert.equal((await call('DELETE', `/api/staff/roles/${R_OWNER}`, T.owner)).status, 403);
    assert.equal(db.roles.find((r) => r.id === R_OWNER).name, 'Owner');
  });
  await ok('POST /roles { name, keys, copy_from }: the copy\'s keys plus the extra; a name of the owner\'s role refused', async () => {
    reset();
    const r = await call('POST', '/api/staff/roles', T.owner, { name: 'Shift lead', copy_from: R_MGR, keys: ['reports.shifts'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const nid = r.body.id;
    // A595: before migration 176 the copied role's staff.edit / staff.view still bring their parts (what they meant).
    assert.deepEqual(roleKeys(nid), ['orders.create', 'products.view', 'reports.shifts', 'sales.void', 'staff.access', 'staff.contacts', 'staff.edit', 'staff.pay',
      'staff.pins', 'staff.roles', 'staff.view']);
    assert.equal((await call('POST', '/api/staff/roles', T.owner, { name: 'admin' })).status, 403);
    assert.equal((await call('POST', '/api/staff/roles', T.mgr, { name: 'Lead', keys: ['settings.business'] })).status, 403, 'ceiling on create');
  });
  await ok('PATCH /roles/:id renames; DELETE refuses a role in use (409 ROLE_IN_USE with members) and removes an unused one', async () => {
    reset();
    assert.equal((await call('PATCH', `/api/staff/roles/${R_CASH}`, T.owner, { name: 'Till' })).status, 200);
    assert.equal(db.roles.find((r) => r.id === R_CASH).name, 'Till');
    const d = await call('DELETE', `/api/staff/roles/${R_CASH}`, T.owner);
    assert.equal(d.status, 409); assert.equal(d.body.code, 'ROLE_IN_USE'); assert.equal(d.body.members, 2);
    const e = await call('DELETE', `/api/staff/roles/${R_EMPTY}`, T.owner);
    assert.equal(e.status, 200, JSON.stringify(e.body)); assert.ok(!db.roles.some((r) => r.id === R_EMPTY));
  });

  console.log('\n2. A person\'s own overrides by key\n');
  await ok('PATCH /staff/:id { override_keys } replaces the set (fine keys; a broad key expanded); GET /staff answers override_keys', async () => {
    reset();
    const r = await call('PATCH', `/api/staff/${CASH}`, T.owner, { override_keys: { 'reports.sales': true, 'customers.manage': false } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = await call('GET', '/api/staff', T.owner);
    const cate = list.body.find((u) => u.id === CASH);
    // A595: an older screen (no `parts: true`): a parent's override is carried to its parts, given or taken.
    assert.deepEqual(cate.override_keys, { 'reports.sales': true, 'reports.analytics': true, 'customers.edit': false, 'customers.credit': false,
      'customers.delete': false, 'customers.credit_payment': false, 'customers.credit_adjust': false });
    await call('PATCH', `/api/staff/${CASH}`, T.owner, { override_keys: {} });
    assert.equal(db.user_permissions.filter((u) => u.user_id === CASH).length, 0, '{} clears');
    await call('PATCH', `/api/staff/${CASH}`, T.owner, { name: 'Cate B' });
    assert.equal(db.user_permissions.filter((u) => u.user_id === CASH).length, 0, 'absent leaves them');
  });
  await ok('…a manager grants only what they hold (taking away is always allowed)', async () => {
    reset();
    const no = await call('PATCH', `/api/staff/${CASH}`, T.mgr, { override_keys: { 'settings.business': true } });
    assert.equal(no.status, 403, JSON.stringify(no.body)); assert.deepEqual(no.body.missing, ['settings.business']);
    const yes = await call('PATCH', `/api/staff/${CASH}`, T.mgr, { override_keys: { 'sales.void': true, 'reports.sales': false } });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    const created = await call('POST', '/api/staff', T.mgr, { name: 'Neo', role_id: R_CASH, pin: '4321', override_keys: { 'reports.sales': true } });
    assert.equal(created.status, 403, 'on create too');
  });
  await ok('a manager cannot manage someone holding more than them (by keys, not the role\'s name), nor the owner\'s account', async () => {
    reset();
    db.user_permissions.push({ id: id(), user_id: CASH2, permission_id: PID['settings.business'], granted: true });
    assert.equal((await call('PATCH', `/api/staff/${CASH2}`, T.mgr, { name: 'X' })).status, 403);
    assert.equal((await call('DELETE', `/api/staff/${CASH2}`, T.mgr)).status, 403);
    assert.equal((await call('PATCH', `/api/staff/${OWNER}`, T.mgr, { name: 'X' })).status, 403);
    assert.equal((await call('PATCH', `/api/staff/${CASH}`, T.mgr, { name: 'Cathy' })).status, 200);
  });

  console.log('\n3. The owner\'s controls\n');
  await ok('GET /api/controls: each section only with its key', async () => {
    reset();
    const all = await call('GET', '/api/controls', T.owner);
    // A493: no `updates` section — ZapTill approves till updates (admin portal), never the client.
    assert.deepEqual(Object.keys(all.body).sort(), ['loyalty', 'payments', 'pos', 'stock']);   // A563: + stock (when stock reaches zero)
    assert.deepEqual(Object.keys(all.body.pos).sort(), ['approval_pin', 'delivery_fee', 'login_codes', 'pay_before_kitchen', 'pay_later_tabs']);   // A594: + approval_pin (the owner's now)
    assert.deepEqual(Object.keys((await call('GET', '/api/controls', as(['settings.pos']))).body).sort(), ['loyalty', 'pos', 'stock']);
    assert.deepEqual(Object.keys((await call('GET', '/api/controls', as(['settings.payments']))).body), ['payments']);
    assert.deepEqual((await call('GET', '/api/controls', T.cash)).body, {});
  });
  await ok('PUT /pos/:key: one of the four, a real boolean; written as the flag the tills read', async () => {
    reset();
    assert.equal((await call('PUT', '/api/controls/pos/cashier_own_history', T.owner, { enabled: true })).status, 400, 'a retired switch is not an option');
    assert.equal((await call('PUT', '/api/controls/pos/delivery_fee', T.owner, { enabled: 'yes' })).status, 400);
    assert.equal((await call('PUT', '/api/controls/pos/delivery_fee', T.owner, { enabled: true })).status, 200);
    assert.equal(db.feature_flags.find((f) => f.key === 'delivery_fee').enabled, true);
    assert.equal((await call('GET', '/api/controls', T.owner)).body.pos.delivery_fee, true);
  });
  await ok('PUT /loyalty: enabled and earn_rate validated and stored', async () => {
    reset();
    assert.equal((await call('PUT', '/api/controls/loyalty', T.owner, {})).status, 400);
    assert.equal((await call('PUT', '/api/controls/loyalty', T.owner, { earn_rate: -1 })).status, 400);
    assert.equal((await call('PUT', '/api/controls/loyalty', T.owner, { earn_rate: 'x' })).status, 400);
    const r = await call('PUT', '/api/controls/loyalty', as(['settings.pos']), { enabled: true, earn_rate: 2.5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(db.feature_flags.find((f) => f.key === 'loyalty_enabled').enabled, true);
    assert.equal(db.business_settings.find((s) => s.key === 'loyalty_earn_rate').value, '2.5');
    assert.deepEqual((await call('GET', '/api/controls', T.owner)).body.loyalty, { enabled: true, earn_rate: 2.5 });
  });
  await ok('A493: PUT /updates is refused for everyone, the owner included (ADMIN_SETS) — nothing written', async () => {
    reset();
    const before = JSON.stringify(db.businesses);
    for (const t of [T.owner, T.mgr, T.cash]) {
      const r = await call('PUT', '/api/controls/updates', t, { version: null });
      assert.equal(r.status, 403); assert.equal(r.body.code, 'ADMIN_SETS');
    }
    assert.equal(JSON.stringify(db.businesses), before);
  });

  console.log('\n4. Cost figures are not SENT to someone who may not see them\n');
  await ok('GET /api/products: no cost_price without menu.costs / reports.costs; with either (or the owner) it is there', async () => {
    reset();
    assert.ok(!('cost_price' in (await call('GET', '/api/products', T.cash)).body[0]));
    assert.equal((await call('GET', '/api/products', as(['menu.costs']))).body[0].cost_price, 80);
    assert.equal((await call('GET', '/api/products', as(['reports.costs']))).body[0].cost_price, 80);
    assert.equal((await call('GET', '/api/products', T.owner)).body[0].cost_price, 80);
  });
  await ok('GET /api/stock/ingredients: no unit_cost without it', async () => {
    reset();
    const r = await call('GET', '/api/stock/ingredients', T.cash);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.length && !('unit_cost' in r.body[0]), JSON.stringify(r.body));
    assert.equal((await call('GET', '/api/stock/ingredients', as(['menu.costs']))).body[0].unit_cost, 300);
  });
  await ok('editing a product: a price is menu.prices, a cost menu.costs; a field sent unchanged needs nothing; an empty cost is ignored', async () => {
    reset();
    const pid = db.products[0].id;
    assert.equal((await call('PATCH', `/api/products/${pid}`, as(['menu.edit']), { base_price: 250 })).status, 403);
    assert.equal((await call('PATCH', `/api/products/${pid}`, as(['menu.edit']), { cost_price: 90 })).status, 403);
    const r = await call('PATCH', `/api/products/${pid}`, as(['menu.edit']), { name: 'Fries', base_price: 200, cost_price: '' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(db.products[0].cost_price, 80, 'the cost was not cleared'); assert.equal(db.products[0].name, 'Fries');
    assert.ok(!('cost_price' in r.body), 'and the answer carries no cost');
    assert.equal((await call('PATCH', `/api/products/${pid}`, as(['menu.prices']), { base_price: 260 })).status, 200, 'a price alone');
    assert.equal(db.products[0].base_price, 260);
  });
  await ok('/reports/master: net profit only with reports.costs; the expense lines with reports.costs or expenses.view', async () => {
    reset();
    const plain = (await call('GET', '/api/reports/master', as(['reports.sales']))).body;
    assert.ok(!('netProfit' in plain.summary) && !('totalExpenses' in plain.summary) && !('expenses' in plain), JSON.stringify(plain.summary));
    const exp = (await call('GET', '/api/reports/master', as(['reports.sales', 'expenses.view']))).body;
    assert.ok(!('netProfit' in exp.summary) && 'totalExpenses' in exp.summary && exp.expenses);
    const full = (await call('GET', '/api/reports/master', as(['reports.sales', 'reports.costs']))).body;
    assert.ok('netProfit' in full.summary && full.expenses);
  });

  console.log('\n5. History and cash movements — the switches before migration 134, the permission after\n');
  await ok('before 134: cashier_own_history narrows anyone without shifts.confirm; after: only sales.history_all decides', () => {
    const cashier = { permissionKeys: ['orders.create', 'sales.history_all'] };
    const manager = { permissionKeys: ['orders.create', 'sales.history_all', 'shifts.confirm'] };
    const on = { cashier_own_history: true }, off = { cashier_own_history: false };
    assert.equal(HS.ownHistoryOnly(cashier, on, true), true);
    assert.equal(HS.ownHistoryOnly(manager, on, true), false);
    assert.equal(HS.ownHistoryOnly(cashier, off, true), false);
    assert.equal(HS.ownHistoryOnly(cashier, on, false), false, 'after 134: the switch no longer narrows someone holding sales.history_all');
    assert.equal(HS.ownHistoryOnly({ permissionKeys: ['orders.create'] }, off, false), true, 'after 134: without it, own sales only');
    assert.equal(HS.ownHistoryOnly({ isOwner: true }, on, true), false);
  });
  await ok('before 134: cashier_no_money_out stops anyone without shifts.confirm; after: only shifts.cash_movements decides', () => {
    const cashier = { permissionKeys: ['orders.create', 'shifts.cash_movements'] };
    assert.equal(HS.mayMoveMoney(cashier, { cashier_no_money_out: true }, true), false);
    assert.equal(HS.mayMoveMoney({ permissionKeys: [...cashier.permissionKeys, 'shifts.confirm'] }, { cashier_no_money_out: true }, true), true);
    assert.equal(HS.mayMoveMoney(cashier, { cashier_no_money_out: true }, false), true);
    assert.equal(HS.mayMoveMoney({ permissionKeys: ['orders.create'] }, { cashier_no_money_out: false }, false), false);
  });
  await ok('GET /api/orders over HTTP: own_only and can_reprint follow the keys (before and after 134)', async () => {
    reset();
    db.feature_flags.push({ business_id: BZ, key: 'cashier_own_history', enabled: true });
    state._setPermissionsMigrated(false);
    const before = (await call('GET', '/api/orders', T.cash)).body;
    state._setPermissionsMigrated(true);
    const after = (await call('GET', '/api/orders', T.cash)).body;
    const allowed = (await call('GET', '/api/orders', as(['orders.create', 'sales.history_all', 'sales.reprint']))).body;
    assert.equal(before.own_only, true, 'before 134: the switch narrows a cashier');
    assert.equal(after.own_only, true, 'after 134: no sales.history_all');
    assert.equal(allowed.own_only, false); assert.equal(allowed.can_reprint, true); assert.equal(after.can_reprint, false);
  });

  console.log('\n6. The maps the clients are sent\n');
  await ok('clientPermissionMap: fine keys + a broad key only when EVERY fine key behind it is held + the marker; the owner {\'*\': true}', () => {
    const all = new Set(P.LEGACY['reports.view']);
    const m = EP.clientPermissionMap(all);
    assert.equal(m['reports.view'], true); assert.equal(m['reports.sales'], true); assert.equal(m[P.MAP_MARKER], true);
    const some = EP.clientPermissionMap(new Set(['reports.sales']));
    assert.ok(!('reports.view' in some), 'an older till never shows more than the person may do');
    assert.deepEqual(EP.clientPermissionMap(new Set(['*'])), { '*': true });
    assert.deepEqual(EP.tokenKeys(new Set(['reports.sales', 'reports.view'])), ['reports.sales']);
  });
  await ok('GET /api/pos/branch-staff: each person\'s permissions is clientPermissionMap (a broad grant expanded, the owner \'*\')', async () => {
    reset();
    for (const u of db.users) u.pin_hash = `$2a$04$${'x'.repeat(53)}`;
    db.role_permissions.push(grant(R_CASH, 'reports.view'));
    const r = await call('GET', '/api/pos/branch-staff', T.till, undefined, { 'x-device-id': 'dev-T1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const by = Object.fromEntries(r.body.staff.map((s) => [s.name, s.permissions]));
    assert.equal(by.Cate['reports.sales'], true); assert.equal(by.Cate['reports.view'], true); assert.equal(by.Cate[P.MAP_MARKER], true);
    assert.deepEqual(by.Olga, { '*': true });
    assert.ok(!by.Max['reports.view']);
  });
  await ok('POST /api/auth/refresh answers a person\'s permissions (source: the renewal sends clientPermissionMap, never for the till)', () => {
    const a = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/auth.ts'), 'utf8');
    assert.match(a, /personPermissions = clientPermissionMap\(held\);/);
    assert.match(a, /\.\.\.\(personPermissions \? \{ permissions: personPermissions \} : \{\}\)/);
    // The till's block ends at the next branch — `} else if` (A550: the partner's renewal) or `} else {` (a person's).
    const till = a.slice(a.indexOf('newPayload = buildDeviceTokenPayload'), a.indexOf('} else', a.indexOf('newPayload = buildDeviceTokenPayload')));
    assert.doesNotMatch(till, /personPermissions/, 'the till\'s own renewal carries none');
  });

  console.log('\n7. The cashier\'s own Z-report, report e-mails, the till\'s own sign-in\n');
  await ok('/reports/eod without reports.sales: only their own (asking for another cashier → 403), no expected cash / variance', async () => {
    reset();
    db.shifts.push({ id: id(), business_id: BZ, branch_id: BR, status: 'closed', opening_float: 100, closing_float: 90, expected_cash: 100, cash_variance: -10, opened_by: CASH, cashier_id: CASH, opened_at: new Date().toISOString() },
      { id: id(), business_id: BZ, branch_id: BR, status: 'closed', opening_float: 50, expected_cash: 50, cash_variance: 0, opened_by: CASH2, cashier_id: CASH2, opened_at: new Date().toISOString() });
    assert.equal((await call('GET', `/api/reports/eod?cashier_id=${CASH2}`, T.cash)).status, 403);
    const own = await call('GET', '/api/reports/eod', T.cash);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.shifts.length, 1, 'only the drawer they opened');
    assert.ok(!('expected_cash' in own.body.shifts[0]) && !('cash_variance' in own.body.shifts[0]));
    assert.ok(!('netProfit' in own.body.summary) && !('expenses' in own.body));
    const mgr = await call('GET', '/api/reports/eod', as(['reports.sales', 'shifts.confirm']));
    assert.equal(mgr.body.shifts.length, 2); assert.equal(mgr.body.shifts[0].expected_cash != null, true);
  });
  await ok('report e-mails: staff whose keys hold reports.overview, whatever the role is called; never the owner\'s role', () => {
    const r = (name, keys, ups = []) => ({ roles: { name, role_permissions: keys.map((key) => ({ permissions: { key } })) }, user_permissions: ups });
    assert.equal(OA.receivesBranchReports(r('Shift lead', ['reports.overview'])), true);
    assert.equal(OA.receivesBranchReports(r('Manager', ['orders.create'])), false, 'a name decides nothing');
    assert.equal(OA.receivesBranchReports(r('Supervisor', ['reports.view'])), true, 'a broad grant counts');
    assert.equal(OA.receivesBranchReports(r('Owner', ['reports.overview'])), false);
    assert.equal(OA.receivesBranchReports(r('Manager', ['reports.overview'], [{ granted: false, permissions: { key: 'reports.overview' } }])), false);
  });
  await ok('the till\'s own sign-in asking for what a till does not do: logged "DRY-RUN would refuse", allowed (TILL_SCOPE_ENFORCE off)', async () => {
    reset();
    const lines = [];
    const warn = console.warn; console.warn = (...a) => { lines.push(a.join(' ')); };
    let r;
    try { r = await call('GET', '/api/devices/fleet', T.till); } finally { console.warn = warn; }
    assert.notEqual(r.status, 403, JSON.stringify(r.body));
    assert.ok(lines.some((l) => /\[tillScope\] DRY-RUN would refuse: a till's own sign-in \(device dev-T1\) asked for devices\.view on GET \/api\/devices\/fleet/.test(l)), lines.join('\n'));
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
