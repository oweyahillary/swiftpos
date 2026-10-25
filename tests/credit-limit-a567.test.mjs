/**
 * credit-limit-a567.test.mjs — A567: give an EXISTING customer a credit limit from the dashboard.
 *
 * Owner, 2026-10-22: "yes they should be existing customers added in the system with an account and approved credit limit".
 *
 *   cd apps/server && npm run build && cd ../.. && TZ=UTC node tests/credit-limit-a567.test.mjs
 *
 * Before: New Customer had only Name/Phone/Email/Notes and Credit Accounts listed only customers whose limit or balance
 * was above 0 — no screen gave a customer their FIRST limit (only PATCH /api/credit/customer/:id/limit by hand).
 *
 * RUNS the COMPILED credit and pos routers behind the REAL requireAuth over HTTP (TILL_SCOPE_ENFORCE=true), against an
 * in-memory database; then the dashboard's own rules (apps/dashboard/src/lib/creditLimit.ts, imported as it is) and the
 * screens' wiring (source pins).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, put back):
 *   - PATCH /customer/:id/limit without requirePermission('customers.credit')   → "a cashier is refused" fails
 *   - GET /candidates without requirePermission('customers.credit')            → "a cashier is refused the picker" fails
 *
 * A585 (owner, 2026-10-23: "credit limit — the owner for now"): the limit and the picker are now THE OWNER's alone
 * (lib/creditApprovers.ts limitSetterGate) — then, the same day, the owner OR the built-in Manager role ("add the credit rights to
 * the manager"). This fixture's "Manager" is a custom role (is_default false), so it is refused; the built-in Manager is
 * tested in tests/credit-owner-a585.test.mjs. The grant below is the owner's. The full
 * owner-only suite is tests/credit-owner-a585.test.mjs.
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
if (!fs.existsSync(path.join(DIST, 'routes/credit.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
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
const L = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/creditLimit.ts')).href);

const id = () => randomUUID();
const BZ = id(), BZ2 = id(), BR = id(), OWNER = id(), MGR = id(), CASH = id(), CUST = id(), NEWBIE = id(), OTHER = id();
const R_MGR = id(), R_CASH = id();
const PID = Object.fromEntries(['orders.create', 'customers.view', 'customers.credit'].map((k) => [k, id()]));
let db;
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });
const reset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, name: 'Pollo' }],
    branches: [{ id: BR, business_id: BZ, name: 'Westlands', status: 'active' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [{ id: R_MGR, business_id: BZ, name: 'Manager', is_default: false }, { id: R_CASH, business_id: BZ, name: 'Cashier' }],
    role_permissions: [grant(R_MGR, 'customers.view'), grant(R_MGR, 'customers.credit'), grant(R_CASH, 'orders.create'), grant(R_CASH, 'customers.view')],
    users: [
      { id: OWNER, business_id: BZ, name: 'Olga', role_id: null, status: 'active', permissions_version: 1 },
      { id: MGR, business_id: BZ, name: 'Max', role_id: R_MGR, status: 'active', permissions_version: 1 },
      { id: CASH, business_id: BZ, name: 'Cate', role_id: R_CASH, status: 'active', permissions_version: 1 },
    ],
    user_branches: [{ user_id: MGR, branch_id: BR }, { user_id: CASH, branch_id: BR }],
    user_permissions: [],
    user_devices: [{ business_id: BZ, device_id: 'dev-T1', status: 'approved', retired_at: null, terminal_code: 'T1', branch_id: BR }],
    customers: [
      { id: CUST, business_id: BZ, name: 'Acme Ltd', phone: '0712 000 111', credit_limit: 1000, credit_balance: 300, status: 'active' },
      // an existing customer added in Customers › New Customer — no credit yet
      { id: NEWBIE, business_id: BZ, name: 'Wanjiru Hardware', phone: '0722 555 010', email: null, credit_limit: 0, credit_balance: 0, status: 'active' },
      { id: OTHER, business_id: BZ2, name: 'Wanjiru Elsewhere', phone: '0722 555 999', credit_limit: 0, credit_balance: 0, status: 'active' },
    ],
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
const likeRe = (pat) => new RegExp(`^${String(pat).split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
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
      if (prop === 'neq') return (k, v) => { f.push((r) => r[k] !== v); return q; };
      if (prop === 'in') return (k, a) => { f.push((r) => (k.includes('.') ? true : a.includes(r[k]))); return q; };
      if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (prop === 'ilike') return (k, v) => { f.push((r) => likeRe(v).test(String(r[k] ?? ''))); return q; };
      if (prop === 'or') return (expr) => {
        // 'credit_limit.gt.0,credit_balance.gt.0' or 'name.ilike.%x%,phone.ilike.%x%'
        const parts = String(expr).split(',').map((x) => { const [k, op, ...v] = x.split('.'); return [k, op, v.join('.')]; });
        f.push((r) => parts.some(([k, op, v]) => (op === 'gt' ? Number(r[k]) > Number(v) : op === 'ilike' ? likeRe(v).test(String(r[k] ?? '')) : false)));
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

const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', businessId: BZ, branchId: BR, isOwner: false, ...p },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const T = {
  owner: sign({ userId: OWNER, branchId: null, isOwner: true, ownerLogin: true, permissionKeys: ['*'] }),
  mgr: sign({ userId: MGR, permissionKeys: ['customers.view', 'customers.credit'] }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create', 'customers.view'] }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/credit', require(path.join(DIST, 'routes/credit.js')).default);
app.use('/api/pos', require(path.join(DIST, 'routes/pos.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': 'dev-T1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
const newbie = () => db.customers.find((c) => c.id === NEWBIE);
const inCredit = async (token) => ((await call('GET', '/api/credit/customers', token)).body ?? []).map((c) => c.id);
const atTill = async () => ((await quiet(() => call('GET', '/api/pos/credit-customers', T.till))).body?.customers ?? []).map((c) => c.id);

try {
  state._setPermissionsMigrated(true);
  console.log('\nA567 — giving an existing customer a credit limit\n');
  reset();

  await ok('before: a customer with no limit is in neither Credit Accounts nor the till\'s list', async () => {
    assert.ok(!(await inCredit(T.mgr)).includes(NEWBIE));
    assert.ok(!(await atTill()).includes(NEWBIE));
  });
  await ok('"+ Give credit" finds them by name or by phone (this business only, limit shown)', async () => {
    const byName = await call('GET', L.candidatesPath('wanjiru'), T.owner);   // A585: the owner's picker
    assert.equal(byName.status, 200, JSON.stringify(byName.body));
    assert.deepEqual(byName.body.map((c) => c.id), [NEWBIE], 'another business\'s Wanjiru is not offered');
    assert.equal(byName.body[0].credit_limit, 0);
    const byPhone = await call('GET', L.candidatesPath('0722 555 010'), T.owner);
    assert.deepEqual(byPhone.body.map((c) => c.id), [NEWBIE]);
    const sneaky = await call('GET', L.candidatesPath('x,credit_limit.gt.0'), T.owner);
    assert.equal(sneaky.status, 200); assert.ok(!sneaky.body.some((c) => c.id === CUST), 'a typed comma cannot widen the filter');
  });
  await ok('a cashier (customers.view, not customers.credit) is refused the picker', async () => {
    assert.equal((await call('GET', L.candidatesPath('wanjiru'), T.cash)).status, 403);
  });
  await ok('a cashier is refused setting a limit — nothing changes, nothing audited', async () => {
    const req = L.limitRequest(NEWBIE, 5000);
    const r = await call('PATCH', req.path, T.cash, req.body);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(newbie().credit_limit, 0); assert.equal(db.audit_log.length, 0);
  });
  await ok('a till\'s own session names nobody: refused (a person approves a limit)', async () => {
    const req = L.limitRequest(NEWBIE, 5000);
    const r = await quiet(() => call('PATCH', req.path, T.till, req.body));
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(newbie().credit_limit, 0);
  });
  await ok('A585: a custom role named Manager (not the built-in one) holding customers.credit is refused the picker and the limit', async () => {
    const pick = await call('GET', L.candidatesPath('wanjiru'), T.mgr);
    assert.equal(pick.status, 403); assert.equal(pick.body.code, 'OWNER_SETS_LIMITS');
    const req = L.limitRequest(NEWBIE, 5000);
    const r = await call('PATCH', req.path, T.mgr, req.body);
    assert.equal(r.status, 403); assert.equal(r.body.error, 'Only the owner or a manager sets credit limits.');
    assert.equal(newbie().credit_limit, 0); assert.equal(db.audit_log.length, 0);
  });
  await ok('the owner gives the first limit: saved, and who approved it and when is recorded', async () => {
    const typed = L.limitFromInput('5,000');
    assert.equal(typed.ok, true);
    const req = L.limitRequest(NEWBIE, typed.value);
    const r = await call('PATCH', req.path, T.owner, req.body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(newbie().credit_limit, 5000);
    const a = db.audit_log.find((x) => x.record_id === NEWBIE);
    assert.ok(a, 'an audit row');
    assert.deepEqual([a.action, a.user_id, a.user_name, a.table_name, a.before_data.credit_limit, a.after_data.credit_limit],
      ['customer.credit_limit.granted', OWNER, 'Olga', 'customers', 0, 5000]);
    assert.ok(!Number.isNaN(Date.parse(a.created_at)), 'when');
  });
  await ok('…they now appear in Credit Accounts and in the till\'s credit-customer list at its next pull', async () => {
    assert.ok((await inCredit(T.mgr)).includes(NEWBIE));
    assert.ok((await inCredit(T.cash)).includes(NEWBIE), 'a cashier still reads the accounts (customers.view)');
    const till = await quiet(() => call('GET', '/api/pos/credit-customers', T.till));
    const row = till.body.customers.find((c) => c.id === NEWBIE);
    assert.ok(row, 'on the till\'s list'); assert.deepEqual([row.credit_limit, row.credit_balance], [5000, 0]);
  });
  await ok('the owner changes it (audited as a change); the same value again writes no second row', async () => {
    const req = L.limitRequest(NEWBIE, 8000);
    assert.equal((await call('PATCH', req.path, T.owner, req.body)).status, 200);
    assert.equal((await call('PATCH', req.path, T.owner, req.body)).status, 200);
    const rows = db.audit_log.filter((x) => x.record_id === NEWBIE);
    assert.equal(rows.length, 2);   // the grant above, and this change
    assert.deepEqual([rows[1].action, rows[1].user_id, rows[1].before_data.credit_limit, rows[1].after_data.credit_limit],
      ['customer.credit_limit.changed', OWNER, 5000, 8000]);
  });
  await ok('a negative limit → 400; another business\'s customer or an unknown one → 404', async () => {
    assert.equal((await call('PATCH', L.limitRequest(NEWBIE, -1).path, T.owner, { credit_limit: -1 })).status, 400);
    assert.equal((await call('PATCH', L.limitRequest(OTHER, 100).path, T.owner, { credit_limit: 100 })).status, 404);
    assert.equal(db.customers.find((c) => c.id === OTHER).credit_limit, 0);
    assert.equal((await call('PATCH', L.limitRequest(id(), 100).path, T.owner, { credit_limit: 100 })).status, 404);
  });

  console.log('\nThe dashboard\'s rules (lib/creditLimit.ts) and screens\n');
  await ok('limitFromInput: a number (commas and spaces allowed), never below 0, never empty', () => {
    assert.deepEqual(L.limitFromInput(' 12 500.456 '), { ok: true, value: 12500.46 });
    assert.equal(L.limitFromInput('').ok, false); assert.equal(L.limitFromInput('-5').ok, false); assert.equal(L.limitFromInput('abc').ok, false);
    assert.deepEqual(L.limitFromInput('0'), { ok: true, value: 0 });
  });
  await ok('the requests are the cloud\'s routes; the key is the one the route requires', () => {
    assert.equal(L.CREDIT_LIMIT_KEY, 'customers.credit');
    // A585: the owner's or the built-in Manager role's (no permission key opens them).
    assert.match(read('apps/server/src/routes/credit.ts'), /router\.patch\('\/customer\/:id\/limit', limitSetterGate\(\)/);
    assert.match(read('apps/server/src/routes/credit.ts'), /router\.get\('\/candidates', limitSetterGate\(\)/);
    assert.deepEqual(L.limitRequest('c-1', 10), { path: '/api/credit/customer/c-1/limit', body: { credit_limit: 10 } });
    assert.equal(L.candidatesPath('  '), '/api/credit/candidates');
    assert.equal(L.candidatesPath('07 22'), '/api/credit/candidates?search=07%2022');
  });
  await ok('New Customer sends a limit only when one above 0 was typed AND the person may set limits', () => {
    assert.equal(L.limitOnCreate('5000', true), 5000);
    assert.equal(L.limitOnCreate('5000', false), null);
    assert.equal(L.limitOnCreate('', true), null); assert.equal(L.limitOnCreate('0', true), null); assert.equal(L.limitOnCreate('-3', true), null);
  });
  await ok('the picker notes who already has credit', () => {
    const fmt = (n) => `KES ${n}`;
    assert.equal(L.candidateNote({ credit_limit: 0, credit_balance: 0 }, fmt), 'No credit yet');
    assert.match(L.candidateNote({ credit_limit: 500, credit_balance: 0 }, fmt), /Limit KES 500 already/);
    assert.match(L.candidateNote({ credit_limit: 0, credit_balance: 50 }, fmt), /owes KES 50/);
  });
  await ok('the screens: "+ Give credit" on Credit Accounts, a Credit limit on the profile and on New Customer — A585: the owner only', () => {
    const page = read('apps/dashboard/src/pages/customers/CreditAccountsPage.tsx');
    assert.match(page, /const \{ setsLimits, line: limitLine \} = useSetsLimits\(\);/);
    assert.match(page, /\{setsLimits && \(\s*<button onClick=\{\(\) => \{ setGiving\(true\); setMsg\(null\); \}\} data-testid="give-credit"/);
    assert.match(page, /<GiveCreditPicker currency=\{currency\}/);
    assert.match(page, /void loadList\(\);/);
    const picker = read('apps/dashboard/src/components/GiveCreditPicker.tsx');
    assert.match(picker, /api\.get<Candidate\[\]>\(candidatesPath\(search\)\)/);
    assert.match(picker, /const req = limitRequest\(picked\.id, r\.value\);\s*await api\.patch\(req\.path, req\.body\);/);
    const editor = read('apps/dashboard/src/components/CreditLimitEditor.tsx');
    assert.match(editor, /const \{ setsLimits: mayCredit, line \} = useSetsLimits\(\);/);   // A587: the owner, or a partner at one of their branches
    assert.match(editor, /\{mayCredit \? \(/);
    const crm = read('apps/dashboard/src/pages/crm/CustomersPage.tsx');
    assert.match(crm, /<CreditLimitEditor customerId=\{customer\.id\} currency=\{currency\} \/>/);
    assert.match(crm, /\{mayCredit && \(\s*<div>\s*<label className="block text-xs text-gray-500 mb-1">Credit limit<\/label>/);
    assert.match(crm, /const limit = limitOnCreate\(createLimit, mayCredit\);/);
    assert.match(crm, /const mayCredit = useSetsLimits\(\)\.setsLimits;/);   // A587
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
