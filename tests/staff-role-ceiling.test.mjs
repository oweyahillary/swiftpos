/**
 * staff-role-ceiling.test.mjs — A340 (2026-09-27): a manager can never create, invite or promote an owner.
 *
 * Owner: "i have seen the manager can create an owner that should not happen".
 *
 *   node tests/staff-role-ceiling.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the real cloud: the COMPILED staff router (apps/server/dist/routes/staff.js) behind the REAL auth middleware, on a
 * real Express server, called over HTTP with real signed tokens — only the database is replaced, by an in-memory stand-in
 * behind supabase.from() (the same seam tests/till-name.test.mjs uses). The pickers are pinned by source (React not run).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - the invite guard removed                              → "a manager cannot INVITE an owner" fails (the owner's hole)
 *   - the overrides ceiling removed                         → "…nor grant a permission they do not hold" fails
 *   - GET /roles stops marking `assignable`                 → "the role list tells a manager Owner is not theirs to give" fails
 *   - canAssignRole lets a non-owner assign anything        → the rule checks fail
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'routes/staff.js'))) {
  console.log('\nCannot load apps/server/dist/routes/staff.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = 'test-secret-for-a340-0123456789';
process.env.ADMIN_JWT_SECRET ??= 'test-admin-secret-0123456789';
process.env.SUPABASE_JWT_SECRET ??= 'test-supabase-secret-0123456789';

const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const rule = require(path.join(DIST, 'lib/roleCeiling.js'));

// ── An in-memory database behind supabase.from() ──
const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const R = { owner: 'aaaaaaaa-0000-4000-8000-000000000001', manager: 'aaaaaaaa-0000-4000-8000-000000000002', cashier: 'aaaaaaaa-0000-4000-8000-000000000003' };
const PERM = { void: 'bbbbbbbb-0000-4000-8000-000000000001', settings: 'bbbbbbbb-0000-4000-8000-000000000002' };
const MGR = 'cccccccc-0000-4000-8000-000000000001';
let seq = 0;
const db = {
  roles: [{ id: R.owner, name: 'owner', business_id: B }, { id: R.manager, name: 'manager', business_id: B }, { id: R.cashier, name: 'cashier', business_id: B }],
  permissions: [{ id: PERM.void, key: 'orders.void' }, { id: PERM.settings, key: 'settings.manage' }],
  users: [{ id: MGR, business_id: B, name: 'Mary', role_id: R.manager, status: 'active', permissions_version: 1 }],
  user_branches: [{ user_id: MGR, branch_id: BR }],
  user_permissions: [],
};
supabase.from = (table) => {
  const st = { filters: [], op: 'select', payload: null };
  const rows = () => (db[table] ?? []).filter((r) => st.filters.every(([k, fn]) => fn(r[k])));
  const run = () => {
    if (st.op === 'insert') {
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({ id: r.id ?? `new-${++seq}`, ...r }));
      (db[table] ??= []).push(...list);
      return list;
    }
    if (st.op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, st.payload)); return hit; }
    if (st.op === 'delete') { const hit = new Set(rows()); db[table] = db[table].filter((r) => !hit.has(r)); return [...hit]; }
    return rows();
  };
  const q = {
    select() { return q; }, order() { return q; }, not() { return q; }, is() { return q; }, ilike() { return q; }, limit() { return q; },
    eq(k, v) { st.filters.push([k, (x) => x === v]); return q; },
    in(k, arr) { st.filters.push([k, (x) => arr.includes(x)]); return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; },
    update(p) { st.op = 'update'; st.payload = p; return q; },
    delete() { st.op = 'delete'; return q; },
    maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }); },
    single() { const r = run(); return Promise.resolve(r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'no rows', code: 'PGRST116' } }); },
    then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
  };
  return q;
};
supabase.auth = { admin: { inviteUserByEmail: async () => ({ error: null }) } };

// ── The real router on a real server ──
const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api/staff', require(path.join(DIST, 'routes/staff.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/staff`;
const token = (claims) => jwt.sign({ userId: MGR, businessId: B, branchId: BR, isOwner: false, permissionKeys: ['staff.manage', 'orders.void'], permissionsVersion: 0, sessionId: 's', surface: 'web', ...claims }, process.env.JWT_SECRET, { expiresIn: '5m' });
const as = (claims) => async (method, p, body) => {
  const res = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(claims)}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const manager = as({});
const owner = as({ isOwner: true, branchId: null, permissionKeys: ['*'] });
const usersNamed = (n) => db.users.filter((u) => u.name === n);

try {
  // ── The rule ──
  await ok('the rule: a non-owner may assign cashier, never owner/admin/manager/supervisor; unknown → refused', () => {
    assert.equal(rule.canAssignRole(false, 'cashier'), true);
    for (const r of ['owner', 'Owner', 'ADMIN', 'manager', 'supervisor', 'branch_manager']) assert.equal(rule.canAssignRole(false, r), false, r);
    assert.equal(rule.canAssignRole(false, null), false);
    assert.equal(rule.canAssignRole(true, 'owner'), true);
  });
  await ok('the rule: a non-owner grants only what they hold', () => {
    assert.deepEqual(rule.overridesBeyondCaller(false, ['orders.void'], ['orders.void', 'settings.manage']), ['settings.manage']);
    assert.deepEqual(rule.overridesBeyondCaller(true, [], ['settings.manage']), []);
  });

  // ── The routes, as a manager ──
  await ok('a manager cannot CREATE an owner (PIN staff)', async () => {
    const r = await manager('POST', '/', { name: 'Ollie', role_id: R.owner, pin: '1234' });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(usersNamed('Ollie').length, 0);
  });
  await ok('a manager cannot INVITE an owner (the hole: this route had no role check)', async () => {
    const r = await manager('POST', '/invite', { name: 'Iris', email: 'iris@example.com', role_id: R.owner });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(usersNamed('Iris').length, 0);
  });
  await ok('…nor invite into another branch', async () => {
    const r = await manager('POST', '/invite', { name: 'Ivy', email: 'ivy@example.com', role_id: R.cashier, branch_ids: ['99999999-9999-4999-8999-999999999999'] });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
  await ok('a manager CAN still create and invite a cashier (their own branch)', async () => {
    const c = await manager('POST', '/', { name: 'Carl', role_id: R.cashier, pin: '5678' });
    const i = await manager('POST', '/invite', { name: 'Cleo', email: 'cleo@example.com', role_id: R.cashier });
    assert.equal(c.status, 201, JSON.stringify(c.body)); assert.equal(i.status, 201, JSON.stringify(i.body));
    assert.ok(db.user_branches.some((b) => b.user_id === usersNamed('Cleo')[0].id && b.branch_id === BR), 'invited into the manager\'s branch');
  });
  await ok('a manager cannot promote a cashier to owner', async () => {
    const carl = usersNamed('Carl')[0];
    db.user_branches.push({ user_id: carl.id, branch_id: BR });
    const r = await manager('PATCH', `/${carl.id}`, { role_id: R.owner });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(carl.role_id, R.cashier);
  });
  await ok('…nor grant a permission they do not hold (settings.manage) — on create or on update', async () => {
    const c = await manager('POST', '/', { name: 'Sly', role_id: R.cashier, pin: '2468', overrides: [{ permission_id: PERM.settings, granted: true }] });
    assert.equal(c.status, 403, JSON.stringify(c.body)); assert.deepEqual(c.body.missing, ['settings.manage']);
    const carl = usersNamed('Carl')[0];
    const u = await manager('PATCH', `/${carl.id}`, { overrides: [{ permission_id: PERM.settings, granted: true }] });
    assert.equal(u.status, 403, JSON.stringify(u.body));
    assert.equal(db.user_permissions.length, 0);
  });
  await ok('…while granting one they DO hold still works', async () => {
    const carl = usersNamed('Carl')[0];
    const u = await manager('PATCH', `/${carl.id}`, { overrides: [{ permission_id: PERM.void, granted: true }] });
    assert.equal(u.status, 200, JSON.stringify(u.body));
  });
  await ok('a manager cannot mint a custom role named "Owner"', async () => {
    const r = await manager('POST', '/roles', { name: 'Owner' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
  await ok('the role list tells a manager Owner/Manager are not theirs to give (the pickers hide them)', async () => {
    const r = await manager('GET', '/roles');
    const a = Object.fromEntries(r.body.map((x) => [x.name, x.assignable]));
    assert.deepEqual(a, { owner: false, manager: false, cashier: true });
  });

  // ── The owner is unaffected ──
  await ok('the owner can still create an owner and see every role as assignable', async () => {
    const c = await owner('POST', '/', { name: 'Olga', role_id: R.owner, pin: '1357' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await owner('GET', '/roles');
    assert.ok(r.body.every((x) => x.assignable === true));
  });

  // ── The pickers (source — React not run here) ──
  await ok('both role pickers show only `assignable` roles', () => {
    assert.match(read('apps/desktop/src/renderer/pages/ManageTabs.tsx'), /roles\.filter\(r => r\.assignable !== false\)\.map\(r => <option/);
    assert.match(read('apps/dashboard/src/pages/settings/StaffTab.tsx'), /\.filter\(r => \(r as \{ assignable\?: boolean \}\)\.assignable !== false\)/);
  });
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
