/**
 * credit-owner-a585.test.mjs — A585: only the owner sets credit limits; the owner may choose who approves sales on account.
 *
 * Owner, 2026-10-23: "credit limit — the owner for now; they can assign to branch manager for approval but they set the
 * limit".
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/credit-owner-a585.test.mjs
 *
 * RUNS the COMPILED credit and pos routers behind the REAL requireAuth over HTTP (TILL_SCOPE_ENFORCE=true), against an
 * in-memory database; the compiled orders.ts creditApproval / tillCreditApprover (the web POS's and the till's push's
 * approval) with real bcrypt PINs; lib/creditApprovers.ts as it is; the dashboard's own rules and screens' wiring.
 *
 * OWNER CHANGE (2026-10-23, the same day: "add the credit rights to the manager"): the owner OR staff on the BUILT-IN
 * Manager role (roles.is_default, still named Manager) set limits — a custom role named "Manager", General Manager,
 * Finance Manager, Supervisor, partners, the owner's role by PIN, tills and ZapTill stay refused. A manager's change is
 * audited with who and the branch they acted at, and the Credit history shows it.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, put back):
 *   - PATCH /limit back to requirePermission('customers.credit')            → "a General Manager … is refused" fails
 *   - isBuiltInManagerRole without the is_default check                     → "a custom role named Manager is refused" fails
 *   - maySetCreditLimits without isBuiltInManager                           → "the built-in Manager sets …" fails
 *   - the audit without the branch                                          → "…recorded with the branch" fails
 *   - GET /candidates back to requirePermission('customers.credit')         → "…and the picker" fails
 *   (isTheOwner's webPartner check survives removal: requireAuth never makes a partner isOwner — defence in depth only)
 *   - isTheOwner accepting any PIN sign-in of the owner's role              → "someone holding the owner's role by PIN" fails
 *   - creditApproval's sellerApproves ignoring the rule                     → "ON: a manager not on the list needs a PIN" fails
 *   - approverByPin not given the list's `may`                              → "ON: a manager's PIN not on the list" fails
 *   - tillCreditApprover ignoring the rule                                  → "ON: the till names a manager not on the list" fails
 *   - cleanRule without the worksAtBranch check                             → "someone who does not work there" fails
 *   - supabaseOwnerShape without the session-id check                       → "…by PIN is refused" (the web POS's PIN session) fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/creditApprovers.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.TILL_SCOPE_ENFORCE = 'true';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const CA = require(path.join(DIST, 'lib/creditApprovers.js'));
const LA = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/creditApprovers.ts')).href);

const id = () => randomUUID();
const BZ = id(), BR = id(), BR2 = id(), OWNER = id(), MGR = id(), GM = id(), FM = id(), SUP = id(), CASH = id(), ADMIN = id(), MGR2 = id(), GONE = id(), FAKE = id();
const CUST = id(), ORD = id();
const R = Object.fromEntries(['Manager', 'General Manager', 'Finance Manager', 'Supervisor', 'Cashier', 'Admin'].map((n) => [n, id()]));
const R_FAKE = id();   // a custom role the business made and named "Manager" (is_default false)
const PID = Object.fromEntries(['orders.create', 'customers.view', 'customers.credit'].map((k) => [k, id()]));
const hash = (pin) => bcrypt.hashSync(pin, 4);
let db;
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });
const reset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, name: 'Pollo' }],
    branches: [{ id: BR, business_id: BZ, name: 'Westlands', status: 'active' }, { id: BR2, business_id: BZ, name: 'Karen', status: 'active' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [...Object.entries(R).map(([name, rid]) => ({ id: rid, business_id: BZ, name, is_default: true })),
      { id: R_FAKE, business_id: BZ, name: 'Manager', is_default: false }],
    role_permissions: [
      ...['Manager', 'General Manager', 'Finance Manager', 'Supervisor'].flatMap((n) => [grant(R[n], 'customers.view'), grant(R[n], 'customers.credit'), grant(R[n], 'orders.create')]),
      grant(R.Cashier, 'orders.create'), grant(R.Cashier, 'customers.view'),
    ],
    users: [
      { id: OWNER, business_id: BZ, name: 'Olga', role_id: null, status: 'active', permissions_version: 1, pin_hash: hash('9999') },
      { id: MGR, business_id: BZ, name: 'Max', role_id: R.Manager, status: 'active', permissions_version: 1, pin_hash: hash('1111') },
      { id: GM, business_id: BZ, name: 'Gina', role_id: R['General Manager'], status: 'active', permissions_version: 1 },
      { id: FM, business_id: BZ, name: 'Fred', role_id: R['Finance Manager'], status: 'active', permissions_version: 1 },
      { id: SUP, business_id: BZ, name: 'Ann', role_id: R.Supervisor, status: 'active', permissions_version: 1, pin_hash: hash('5555') },
      { id: CASH, business_id: BZ, name: 'Cate', role_id: R.Cashier, status: 'active', permissions_version: 1, pin_hash: hash('2222') },
      { id: ADMIN, business_id: BZ, name: 'Adam', role_id: R.Admin, status: 'active', permissions_version: 1 },
      { id: FAKE, business_id: BZ, name: 'Faye', role_id: R_FAKE, status: 'active', permissions_version: 1 },
      { id: MGR2, business_id: BZ, name: 'Mo', role_id: R.Manager, status: 'active', permissions_version: 1, pin_hash: hash('3333') },
      { id: GONE, business_id: BZ, name: 'Gone', role_id: R.Manager, status: 'inactive', permissions_version: 1 },
    ],
    user_branches: [{ user_id: MGR, branch_id: BR }, { user_id: SUP, branch_id: BR }, { user_id: CASH, branch_id: BR }, { user_id: MGR2, branch_id: BR2 }],
    user_permissions: [],
    user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null, terminal_code: 'T1', branch_id: BR }],
    customers: [{ id: CUST, business_id: BZ, name: 'Acme Ltd', phone: '0712 000 111', credit_limit: 1000, credit_balance: 300, status: 'active' }],
    orders: [{ id: ORD, business_id: BZ, order_number: 'T1-0042' }],
    credit_confirmations: [{ order_id: ORD, business_id: BZ, branch_id: BR, customer_id: CUST, amount: 250, state: 'confirmed', source: 'till', over_limit: false,
      cashier_id: CASH, approved_at_sale_by: SUP, decided_by: SUP, decided_by_name: 'Ann', sold_at: '2026-10-23T08:00:00.000Z' }],
    audit_log: [], business_settings: [], feature_flags: [],
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
  const f = []; let patch = null; let inserted = null; let lim = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (inserted) return inserted;
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    const all = rows().map((r) => view(table, r));
    return lim === null ? all : all.slice(0, lim);
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push((r) => (k.includes('.') ? true : r[k] === v)); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => (k.includes('.') ? true : a.includes(r[k]))); return q; };
      if (prop === 'or') return (expr) => {
        const parts = String(expr).split(',').map((x) => { const [k, op, ...v] = x.split('.'); return [k, op, v.join('.')]; });
        f.push((r) => parts.some(([k, op, v]) => (op === 'gt' ? Number(r[k]) > Number(v) : true)));
        return q;
      };
      if (prop === 'limit') return (n) => { lim = n; return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'insert' || prop === 'upsert') return (r) => {
        inserted = (Array.isArray(r) ? r : [r]).map((x) => { const row = { id: x.id ?? id(), created_at: new Date().toISOString(), ...x }; (db[table] ??= []).push(row); return row; });
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

const CREDIT_KEYS = ['orders.create', 'customers.view', 'customers.credit'];
const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', businessId: BZ, branchId: BR, isOwner: false, ...p },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const T = {
  owner: sign({ userId: OWNER, branchId: null, isOwner: true, ownerLogin: true, permissionKeys: ['*'], surface: undefined }),
  ownerPin: sign({ userId: OWNER, isOwner: true, pinSignIn: true, permissionKeys: ['*'] }),
  adminPin: sign({ userId: ADMIN, roleId: R.Admin, isOwner: true, pinSignIn: true, permissionKeys: ['*'] }),
  adminWebPin: sign({ userId: ADMIN, roleId: R.Admin, roleName: 'Admin', isOwner: true, permissionKeys: ['*'] }),   // the web POS's PIN session
  mgr: sign({ userId: MGR, roleId: R.Manager, permissionKeys: CREDIT_KEYS }),
  fake: sign({ userId: FAKE, roleId: R_FAKE, roleName: 'Manager', permissionKeys: CREDIT_KEYS }),
  partnerMgr: sign({ userId: MGR, webPartner: true, partnerBranches: [BR], permissionKeys: CREDIT_KEYS, surface: undefined }),
  gm: sign({ userId: GM, roleId: R['General Manager'], permissionKeys: CREDIT_KEYS }),
  fm: sign({ userId: FM, roleId: R['Finance Manager'], permissionKeys: CREDIT_KEYS }),
  sup: sign({ userId: SUP, roleId: R.Supervisor, permissionKeys: CREDIT_KEYS }),
  partner: sign({ userId: GM, webPartner: true, partnerBranches: [BR], allBranches: true, permissionKeys: ['*'], surface: undefined }),
  cash: sign({ userId: CASH, roleId: R.Cashier, permissionKeys: ['orders.create', 'customers.view'] }),
  nobody: sign({ userId: CASH, roleId: R.Cashier, permissionKeys: ['orders.create'] }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/credit', require(path.join(DIST, 'routes/credit.js')).default);
app.use('/api/pos', require(path.join(DIST, 'routes/pos.js')).default);
const O = require(path.join(DIST, 'routes/orders.js'));
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': 'dev-T1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const limitOf = () => db.customers.find((c) => c.id === CUST).credit_limit;
const LIMIT = `/api/credit/customer/${CUST}/limit`;
const setRule = (rule) => { db.business_settings = [{ id: id(), business_id: BZ, key: CA.CREDIT_APPROVERS_KEY, value: rule }]; };
// A web POS sale's approval, as POST /api/orders calls it (orders.ts creditApproval).
const webReq = (userId, keys, extra = {}) => ({ businessId: BZ, userId, isOwner: false, isTill: false, surface: 'web', pinSignIn: true,
  permissionKeys: keys, method: 'POST', path: '/', originalUrl: '/api/orders', body: {}, ip: '1.2.3.4', ...extra });
const approve = (req, body = {}) => quiet(() => O.creditApproval({ ...req, body }, body, BR));

try {
  state._setPermissionsMigrated(true);
  reset();
  console.log('\nA585 — only the owner sets credit limits (every route that writes one)\n');
  for (const [who, tok] of [['a custom role named "Manager" (not the built-in one)', T.fake], ['a General Manager', T.gm], ['a Finance Manager', T.fm], ['a Supervisor', T.sup]]) {
    await ok(`${who} holding customers.credit is refused the limit (grant, change, remove) and the picker`, async () => {
      for (const v of [5000, 2000, 0]) {
        const r = await call('PATCH', LIMIT, tok, { credit_limit: v });
        assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OWNER_SETS_LIMITS'); assert.equal(r.body.error, 'Only the owner or a manager sets credit limits.');
      }
      assert.equal((await call('GET', '/api/credit/candidates?search=acme', tok)).status, 403);
      assert.equal(limitOf(), 1000); assert.equal(db.audit_log.length, 0);
    });
  }
  await ok('a partner (A550) holding \'*\' is refused — and a partner whose staff role is the built-in Manager too', async () => {
    const r = await call('PATCH', LIMIT, T.partner, { credit_limit: 5000 });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(limitOf(), 1000);
    assert.equal((await call('PATCH', LIMIT, T.partnerMgr, { credit_limit: 5000 })).status, 403); assert.equal(limitOf(), 1000);
  });
  await ok('someone holding the owner\'s role ("Admin") by PIN is refused', async () => {
    assert.equal((await call('PATCH', LIMIT, T.adminPin, { credit_limit: 5000 })).status, 403); assert.equal(limitOf(), 1000);
    // the web POS's PIN session carries no pinSignIn flag (routes/auth.ts: desktop only) — refused all the same
    assert.equal((await call('PATCH', LIMIT, T.adminWebPin, { credit_limit: 5000 })).status, 403); assert.equal(limitOf(), 1000);
  });
  await ok('ZapTill itself cannot set a client\'s credit limit: an admin-portal token is refused; no admin route writes one', async () => {
    const adminTok = jwt.sign({ adminId: id(), role: 'super_admin', email: 'staff@zaptill.test' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const r = await call('PATCH', LIMIT, adminTok, { credit_limit: 5000 });
    assert.ok(r.status === 401 || r.status === 403, JSON.stringify(r)); assert.equal(limitOf(), 1000);
    for (const f of fs.readdirSync(path.join(ROOT, 'apps/server/src/routes')).filter((x) => /admin/i.test(x) || /^(support|tech|ops)/i.test(x))) {
      assert.ok(!/credit_limit/.test(read(`apps/server/src/routes/${f}`)), `${f} touches credit_limit`);
    }
    assert.ok(!/credit_limit/.test(read('apps/admin/src/AdminPortal.tsx')), 'the admin portal shows no credit-limit editor');
  });
  await ok('the owner\'s Supabase session (no ZapTill session id, web) counts as the owner; a PIN session never does', () => {
    assert.equal(CA.supabaseOwnerShape({ isOwner: true, surface: 'web', sessionId: null }), true);
    assert.equal(CA.supabaseOwnerShape({ isOwner: true, surface: 'web', sessionId: 's-1' }), false);
    assert.equal(CA.supabaseOwnerShape({ isOwner: true, surface: 'web', sessionId: null, pinSignIn: true }), false);
    assert.equal(CA.supabaseOwnerShape({ isOwner: true, surface: 'web', sessionId: null, webPartner: true }), false);
  });
  await ok('a till\'s own session is refused', async () => {
    assert.equal((await quiet(() => call('PATCH', LIMIT, T.till, { credit_limit: 5000 }))).status, 403); assert.equal(limitOf(), 1000);
  });
  await ok('the owner (password sign-in) changes it — audited: who, when, old → new', async () => {
    const r = await call('PATCH', LIMIT, T.owner, { credit_limit: 4000 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(limitOf(), 4000);
    const a = db.audit_log.at(-1);
    assert.deepEqual([a.action, a.user_id, a.user_name, a.before_data.credit_limit, a.after_data.credit_limit], ['customer.credit_limit.changed', OWNER, 'Olga', 1000, 4000]);
  });
  await ok('the owner\'s own PIN sign-in (the account the business names) may too; removing it is audited as .removed', async () => {
    const r = await call('PATCH', LIMIT, T.ownerPin, { credit_limit: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(limitOf(), 0);
    assert.equal(db.audit_log.at(-1).action, 'customer.credit_limit.removed');
    assert.equal((await call('GET', '/api/credit/candidates?search=acme', T.owner)).status, 200);
  });
  await ok('the owner gives it again (audited as .granted)', async () => {
    assert.equal((await call('PATCH', LIMIT, T.owner, { credit_limit: 1000 })).status, 200);
    assert.equal(db.audit_log.at(-1).action, 'customer.credit_limit.granted');
  });
  await ok('owner change: the built-in Manager sets a limit (and the picker) — recorded with who and the branch they acted at', async () => {
    assert.equal((await call('GET', '/api/credit/candidates?search=acme', T.mgr)).status, 200);
    const r = await call('PATCH', LIMIT, T.mgr, { credit_limit: 1500 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(limitOf(), 1500);
    const a = db.audit_log.at(-1);
    assert.deepEqual([a.action, a.user_id, a.user_name, a.branch_id, a.before_data.credit_limit, a.after_data.credit_limit],
      ['customer.credit_limit.changed', MGR, 'Max', BR, 1000, 1500]);
    assert.equal(CA.isBuiltInManagerRole({ name: ' manager ', is_default: true }), true);
    assert.equal(CA.isBuiltInManagerRole({ name: 'Manager', is_default: false }), false);
    assert.equal(CA.isBuiltInManagerRole({ name: 'General Manager', is_default: true }), false);
  });
  await ok('no other route writes a credit limit (the customer edit route ignores it; the only writer is PATCH /limit)', () => {
    const loy = read('apps/server/src/routes/loyalty.ts');
    assert.ok(!/credit_limit/.test(loy), 'loyalty.ts never touches credit_limit');
    const writers = fs.readdirSync(path.join(ROOT, 'apps/server/src/routes')).filter((f) => f.endsWith('.ts'))
      .filter((f) => /credit_limit\s*:/.test(read(`apps/server/src/routes/${f}`).replace(/select\([^)]*\)/g, '')));
    assert.deepEqual(writers.filter((f) => f !== 'credit.ts' && f !== 'pos.ts'), [], writers.join());
    const cr = read('apps/server/src/routes/credit.ts');
    assert.equal((cr.match(/\.update\(\{ credit_limit/g) ?? []).length, 1);
    assert.match(cr, /router\.patch\('\/customer\/:id\/limit', limitSetterGate\(\)/);
  });

  console.log('\nWho approves credit sales — the owner\'s setting\n');
  await ok('GET /approvers: OFF by default; the branches and who may be picked', async () => {
    const r = await call('GET', '/api/credit/approvers', T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rule, { on: false, branches: {} });
    assert.equal(r.body.branches.length, 2); assert.ok(r.body.staff.some((s) => s.id === SUP && s.branch_ids.includes(BR)));
    assert.ok(!r.body.staff.some((s) => s.id === GONE), 'inactive staff are not offered');
  });
  await ok('a manager, a partner, someone with the owner\'s role by PIN: refused both ways', async () => {
    for (const t of [T.mgr, T.partner, T.adminPin]) {
      assert.equal((await call('GET', '/api/credit/approvers', t)).status, 403);
      assert.equal((await call('PUT', '/api/credit/approvers', t, { on: true, branches: {} })).status, 403);
    }
    assert.equal(db.business_settings.length, 0);
  });
  await ok('PUT refuses another business\'s branch, an inactive person, someone who does not work there, junk', async () => {
    assert.equal((await call('PUT', '/api/credit/approvers', T.owner, { on: true, branches: { [id()]: [SUP] } })).status, 400);
    assert.equal((await call('PUT', '/api/credit/approvers', T.owner, { on: true, branches: { [BR]: [GONE] } })).status, 400);
    assert.equal((await call('PUT', '/api/credit/approvers', T.owner, { on: true, branches: { [BR]: [MGR2] } })).status, 400);
    assert.equal((await call('PUT', '/api/credit/approvers', T.owner, { on: 'yes' })).status, 400);
    assert.equal(db.business_settings.length, 0);
  });
  await ok('PUT: the owner turns it on with Ann at Westlands (Gina works everywhere — allowed); audited', async () => {
    const r = await call('PUT', '/api/credit/approvers', T.owner, { on: true, branches: { [BR]: [SUP, GM], [BR2]: [] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rule, { on: true, branches: { [BR]: [SUP, GM] } });
    assert.deepEqual(db.business_settings[0].value, { on: true, branches: { [BR]: [SUP, GM] } });
    assert.ok(db.audit_log.some((a) => a.action === 'credit.approvers.changed'));
  });
  await ok('the generic settings write never takes the key (READ_ONLY_KEY in routes/business.ts)', () => {
    assert.match(read('apps/server/src/routes/business.ts'), /\|\| String\(key\) === CREDIT_APPROVERS_KEY\) \{/);
  });
  await ok('the till\'s list carries its branch\'s approvers (and the owner) — kept offline', async () => {
    const r = await quiet(() => call('GET', '/api/pos/credit-customers', T.till));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.approval, { on: true, approvers: [SUP, GM], owner_id: OWNER });
  });

  console.log('\nApproval at the sale (orders.ts creditApproval — the web POS; tillCreditApprover — a till\'s push)\n');
  await ok('OFF: a manager with customers.credit approves their own sale; a cashier needs a PIN (A511 unchanged)', async () => {
    setRule({ on: false, branches: { [BR]: [SUP] } });
    const m = await approve(webReq(MGR, CREDIT_KEYS));
    assert.equal(m.approvedBy, MGR, JSON.stringify(m));
    const c = await approve(webReq(CASH, ['orders.create', 'customers.view']));
    assert.equal(c.status, 403); assert.equal(c.body.code, 'CREDIT_APPROVAL_REQUIRED');
    const withMax = await approve(webReq(CASH, ['orders.create', 'customers.view']), { credit_pin: '1111' });
    assert.equal(withMax.approvedBy, MGR, JSON.stringify(withMax));
  });
  setRule({ on: true, branches: { [BR]: [SUP] } });
  await ok('ON: the seller on the list approves their own sale automatically (Ann)', async () => {
    const a = await approve(webReq(SUP, CREDIT_KEYS));
    assert.equal(a.approvedBy, SUP, JSON.stringify(a)); assert.equal(a.approvedAtSale, true);
  });
  await ok('ON: a manager not on the list needs a PIN (customers.credit is not enough) — told whose', async () => {
    const r = await approve(webReq(MGR, CREDIT_KEYS));
    assert.equal(r.status, 403); assert.equal(r.body.code, 'CREDIT_APPROVAL_REQUIRED'); assert.match(r.body.error, /someone the owner chose/);
  });
  await ok('ON: a manager\'s PIN not on the list is refused; Ann\'s PIN approves; the owner\'s PIN approves', async () => {
    const no = await approve(webReq(CASH, ['orders.create', 'customers.view']), { credit_pin: '1111' });
    assert.equal(no.status, 403, JSON.stringify(no)); assert.equal(no.body.code, 'INVALID_APPROVER_PIN');
    const ann = await approve(webReq(CASH, ['orders.create', 'customers.view'], { ip: '1.2.3.5' }), { credit_pin: '5555' });
    assert.equal(ann.approvedBy, SUP, JSON.stringify(ann));
    const olga = await approve(webReq(MGR, CREDIT_KEYS, { ip: '1.2.3.6' }), { credit_pin: '9999' });
    assert.equal(olga.approvedBy, OWNER, JSON.stringify(olga));
  });
  await ok('ON: the owner selling approves it', async () => {
    const o = await approve(webReq(OWNER, ['*'], { isOwner: true }));
    assert.equal(o.approvedAtSale, true, JSON.stringify(o));
  });
  await ok('ON with nobody chosen at the branch: only the owner approves — a manager PIN is refused, the owner PIN taken', async () => {
    setRule({ on: true, branches: {} });
    const r = await approve(webReq(CASH, ['orders.create', 'customers.view'], { ip: '1.2.3.7' }), { credit_pin: '1111' });
    assert.equal(r.status, 403, JSON.stringify(r)); assert.equal(r.body.code, 'INVALID_APPROVER_PIN');
    const o = await approve(webReq(CASH, ['orders.create', 'customers.view'], { ip: '1.2.3.8' }), { credit_pin: '9999' });
    assert.equal(o.approvedBy, OWNER, JSON.stringify(o));
    setRule({ on: true, branches: { [BR]: [SUP] } });
  });
  await ok('ON: the till names a manager not on the list → awaiting a manager; names Ann → born confirmed by her', async () => {
    const rule = CA.readRule({ on: true, branches: { [BR]: [SUP] } });
    assert.equal(await O.tillCreditApprover(BZ, MGR, BR, rule), null);
    assert.deepEqual(await O.tillCreditApprover(BZ, SUP, BR, rule), { id: SUP, name: 'Ann' });
    assert.deepEqual(await O.tillCreditApprover(BZ, OWNER, BR, rule), { id: OWNER, name: 'Olga' });
    assert.equal(await O.tillCreditApprover(BZ, SUP, BR2, rule), null, 'not on Karen\'s list');
    assert.deepEqual(await O.tillCreditApprover(BZ, MGR, BR, CA.readRule(null)), { id: MGR, name: 'Max' }, 'OFF: A552');
  });
  await ok('the limit is still checked after the approval on both sale paths (no approver sells past it)', () => {
    const o = read('apps/server/src/routes/orders.ts');
    const n = o.match(/const ca = await creditApproval\(req, req\.body, [^)]+\);[\s\S]{0,900}?if \(creditAmount > available/g) ?? [];
    assert.equal(n.length, 2);
  });

  console.log('\nThe Credit history panel\n');
  await ok('GET /customer/:id/history: limit changes (who, when, old → new) and sales with who sold and who approved', async () => {
    const r = await call('GET', `/api/credit/customer/${CUST}/history`, T.cash);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.limits.map((l) => [l.action, l.from, l.to, l.by_name]).sort(), [['changed', 1000, 1500, 'Max'], ['changed', 1000, 4000, 'Olga'], ['granted', 0, 1000, 'Olga'], ['removed', 4000, 0, 'Olga']].sort());
    assert.equal(r.body.limits.find((l) => l.by_name === 'Max').branch_name, 'Westlands', 'the manager\'s branch shown');
    assert.equal(r.body.sales.length, 1);
    const s = r.body.sales[0];
    assert.deepEqual([s.order_number, s.amount, s.cashier_name, s.approved_by_name, s.branch_name], ['T1-0042', 250, 'Cate', 'Ann', 'Westlands']);
  });
  await ok('…read like the account (customers.view or customers.credit); without either refused; another customer 404', async () => {
    assert.equal((await call('GET', `/api/credit/customer/${CUST}/history`, T.nobody)).status, 403);
    assert.equal((await call('GET', `/api/credit/customer/${id()}/history`, T.owner)).status, 404);
  });

  console.log('\nThe rules as they are (lib/creditApprovers.ts, the dashboard\'s lib)\n');
  await ok('readRule: junk is OFF; only uuids kept', () => {
    assert.deepEqual(CA.readRule('nope'), { on: false, branches: {} });
    assert.deepEqual(CA.readRule({ on: true, branches: { [BR]: ['x', SUP, SUP] } }), { on: true, branches: { [BR]: [SUP] } });
  });
  await ok('onApproverList: the owner always; the list at that branch; someone who left the branch no longer', () => {
    const rule = { on: true, branches: { [BR]: [SUP] } };
    assert.equal(CA.onApproverList(rule, BR, { id: OWNER }, { ownerId: OWNER }), true);
    assert.equal(CA.onApproverList(rule, BR, { id: SUP, user_branches: [{ branch_id: BR }] }), true);
    assert.equal(CA.onApproverList(rule, BR, { id: SUP, user_branches: [{ branch_id: BR2 }] }), false);
    assert.equal(CA.onApproverList(rule, BR2, { id: SUP }), false);
    assert.equal(CA.onApproverList(rule, null, { id: SUP }), false);
  });
  await ok('the dashboard: toggle, staff for a branch, the summary and the history words', () => {
    let rule = { on: true, branches: {} };
    rule = LA.toggleApprover(rule, BR, SUP); assert.deepEqual(rule.branches, { [BR]: [SUP] });
    rule = LA.toggleApprover(rule, BR, SUP); assert.deepEqual(rule.branches, {});
    const staff = [{ id: 'a', name: 'Zed', role: null, branch_ids: [BR] }, { id: 'b', name: 'Amy', role: null, branch_ids: [] }, { id: 'c', name: 'Kip', role: null, branch_ids: [BR2] }];
    assert.deepEqual(LA.staffForBranch(staff, BR).map((s) => s.id), ['b', 'a']);
    assert.match(LA.approvalSummary({ on: false, branches: {} }), /^Off/);
    assert.match(LA.approvalSummary({ on: true, branches: {} }), /only you/);
    const fmt = (n) => `KES ${n}`;
    assert.equal(LA.limitChangeWords({ action: 'changed', from: 1000, to: 4000 }, fmt), 'Changed the limit KES 1000 → KES 4000');
    assert.equal(LA.approvalWords({ approved_by_name: 'Ann', decided_by_name: null, state: 'confirmed' }), 'Approved by Ann');
    assert.equal(LA.OWNER_SETS_LIMITS_LINE, 'Only the owner or a manager sets credit limits.');
    assert.equal(LA.limitBoxForRole('Manager'), true); assert.equal(LA.limitBoxForRole('Supervisor'), false);
  });
  await ok('the screens: the limit editors are the owner\'s; the history panel on the profile; the setting in Settings › Business', () => {
    assert.match(read('apps/dashboard/src/components/CreditLimitEditor.tsx'), /const mayCredit = usePermissions\(\)\.isOwner;[\s\S]*\{OWNER_SETS_LIMITS_LINE\}/);
    assert.match(read('apps/dashboard/src/pages/customers/CreditAccountsPage.tsx'), /const setsLimits = perms\.isOwner;/);
    const md = read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx');
    assert.match(md, /const setsLimits = limitBoxForRole\(session\?\.role\);/);
    assert.match(md, /\{setsLimits \? \([\s\S]{0,900}onClick=\{saveLimit\}[\s\S]{0,700}\{OWNER_SETS_LIMITS_LINE\}/, 'the web POS manager screen: the box for a manager, the line for others');
    assert.match(read('apps/dashboard/src/pages/crm/CustomersPage.tsx'), /<CreditHistoryPanel customerId=\{customer\.id\} currency=\{currency\} \/>/);
    assert.match(read('apps/dashboard/src/pages/settings/BusinessPage.tsx'), /isOwner \? \[\{ to: 'credit-approvals', label: 'Credit approvals' \}\]/);
    assert.match(read('apps/dashboard/src/App.tsx'), /<Route path="credit-approvals" element=\{<CreditApproversTab \/>\} \/>/);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
