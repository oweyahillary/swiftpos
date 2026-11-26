/**
 * notification-prefs-a627.test.mjs — A627 W3: per-person EMAIL alert preferences. The pure catalogue (an alert is offered
 * only to someone who holds its right), the staff route (GET returns the permitted alerts; PUT stores; self vs staff.edit;
 * the ceiling), and the enforcement helper (emailOptedOut resolves an opt-out to the e-mails a job must drop).
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/notification-prefs-a627.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: drop the permission check in alertAppliesTo → "a cashier is offered no alert" fails; drop the
 * opt-out filter in emailOptedOut → "an opted-out person's e-mail is dropped" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 3).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/staff.js'))) { console.log('\nBuild the server first: cd apps/server && npm run build\n'); process.exit(1); }

process.env.JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.ADMIN_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
console.warn = () => {}; console.error = () => {};

const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const NP = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/notificationPrefs.ts')).href);
const PREFS = require(path.join(DIST, 'lib/notificationPrefsStore.js'));

const id = () => crypto.randomUUID();
const BZ = id(), BR = id(), OWNER = id(), MGR = id(), CASH = id(), GM = id();
const R_OWNER = id(), R_MGR = id(), R_CASH = id(), R_GM = id();
const KEYS = ['orders.create', 'reports.overview', 'reports.inventory', 'reports.voids', 'staff.view', 'staff.edit'];
const PID = Object.fromEntries(KEYS.map((k) => [k, id()]));
const emailOf = { [OWNER]: 'owner@shop.test', [MGR]: 'max@shop.test', [GM]: 'gina@shop.test', [CASH]: 'cate@shop.test' };

let db;
const grant = (role_id, key) => ({ id: id(), role_id, permission_id: PID[key] });
const reset = () => {
  db = {
    businesses: [{ id: BZ, owner_id: OWNER, name: 'Pollo', type: 'retail' }],
    permissions: Object.entries(PID).map(([key, pid]) => ({ id: pid, key, label: key, module: 'x' })),
    roles: [{ id: R_OWNER, business_id: BZ, name: 'Owner' }, { id: R_MGR, business_id: BZ, name: 'Manager' },
            { id: R_CASH, business_id: BZ, name: 'Cashier' }, { id: R_GM, business_id: BZ, name: 'General Manager' }],
    role_permissions: [
      grant(R_MGR, 'reports.overview'), grant(R_MGR, 'staff.view'), grant(R_MGR, 'staff.edit'),
      grant(R_CASH, 'orders.create'),
      grant(R_GM, 'reports.overview'), grant(R_GM, 'reports.inventory'), grant(R_GM, 'reports.voids'), grant(R_GM, 'staff.view'), grant(R_GM, 'staff.edit')],
    users: [
      { id: OWNER, business_id: BZ, name: 'Olga', role_id: R_OWNER, status: 'active', email: emailOf[OWNER] },
      { id: MGR, business_id: BZ, name: 'Max', role_id: R_MGR, status: 'active', email: emailOf[MGR] },
      { id: CASH, business_id: BZ, name: 'Cate', role_id: R_CASH, status: 'active', email: emailOf[CASH] },
      { id: GM, business_id: BZ, name: 'Gina', role_id: R_GM, status: 'active', email: emailOf[GM] },
    ],
    user_permissions: [], user_branches: [], user_notification_prefs: [], business_settings: [],
  };
};
const embed = (table, r) => {
  if (table === 'role_permissions' || table === 'user_permissions') return { ...r, permissions: db.permissions.find((p) => p.id === r.permission_id) ?? null };
  if (table === 'roles') return { ...r, role_permissions: db.role_permissions.filter((g) => g.role_id === r.id).map((g) => embed('role_permissions', g)) };
  if (table === 'users') { const role = db.roles.find((x) => x.id === r.role_id);
    return { ...r, roles: role ? embed('roles', role) : null, user_permissions: db.user_permissions.filter((u) => u.user_id === r.id).map((u) => embed('user_permissions', u)) }; }
  return r;
};
let nextId = 1;
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null; let del = false; let selectCols = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (inserted) return inserted;
    if (del) { const hit = rows(); db[table] = db[table].filter((r) => !hit.includes(r)); return hit; }
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    return rows().map((r) => embed(table, r));
  };
  const q = new Proxy({}, { get(_t, prop) {
    if (prop === 'select') return (c) => { selectCols = c; return q; };
    if (prop === 'eq') return (k, v) => { f.push((r) => (String(k).includes('.') ? true : r[k] === v)); return q; };
    if (prop === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
    if (prop === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
    if (prop === 'not') return () => q;
    if (prop === 'update') return (p) => { patch = p; return q; };
    if (prop === 'delete') return () => { del = true; return q; };
    if (prop === 'insert' || prop === 'upsert') return (r, opts) => {
      const list = Array.isArray(r) ? r : [r]; inserted = [];
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
  } });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });
supabase.auth = { admin: { getUserById: async (uid) => ({ data: { user: { email: emailOf[uid] ?? null } }, error: null }) } };

const sign = (p) => jwt.sign({ sessionId: id(), permissionsVersion: 0, surface: 'web', businessId: BZ, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'] }),
  mgr: sign({ userId: MGR, permissionKeys: ['reports.overview', 'staff.view', 'staff.edit'] }),
  cash: sign({ userId: CASH, permissionKeys: ['orders.create'] }),
};
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/staff', require(path.join(DIST, 'routes/staff.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('\nA627 W3 — per-person email alert preferences\n');
try {
  state._setPermissionsMigrated?.(true);

  await ok('catalogue: an alert is offered only to someone who holds its right', () => {
    const keysOf = (held) => NP.alertsForKeys(held).map((a) => a.key).sort();
    assert.deepEqual(keysOf(['*']), ['daily_summary', 'low_stock', 'owner_alert'].sort());
    assert.deepEqual(keysOf(['reports.overview']), ['daily_summary', 'owner_alert'].sort());   // no reports.inventory → no low_stock
    assert.deepEqual(keysOf(['reports.inventory']), ['low_stock']);
    assert.deepEqual(keysOf(['orders.create']), []);   // a cashier is offered no alert
    assert.equal(NP.alertAppliesTo('low_stock', ['reports.inventory']), true);
    assert.equal(NP.alertAppliesTo('low_stock', ['reports.overview']), false);
  });

  await ok('GET /me: the owner sees all three alerts, on by default', async () => {
    reset();
    const r = await call('GET', '/api/staff/me/notification-prefs', T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.alerts.map((a) => a.key).sort(), ['daily_summary', 'low_stock', 'owner_alert'].sort());
    assert.ok(r.body.alerts.every((a) => a.enabled === true));
  });

  await ok('GET /me: a manager (reports.overview only) sees daily summary + operations, not low stock', async () => {
    reset();
    const r = await call('GET', '/api/staff/me/notification-prefs', T.mgr);
    assert.deepEqual(r.body.alerts.map((a) => a.key).sort(), ['daily_summary', 'owner_alert'].sort());
  });

  await ok('PUT /me: a person turns their own alert off; it persists and overrides the default', async () => {
    reset();
    const put = await call('PUT', '/api/staff/me/notification-prefs', T.mgr, { alert_type: 'daily_summary', enabled: false });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const row = db.user_notification_prefs.find((p) => p.user_id === MGR && p.alert_type === 'daily_summary');
    assert.equal(row?.email_enabled, false);
    const back = await call('GET', '/api/staff/me/notification-prefs', T.mgr);
    assert.equal(back.body.alerts.find((a) => a.key === 'daily_summary').enabled, false);
    assert.equal(back.body.alerts.find((a) => a.key === 'owner_alert').enabled, true);   // the other stays on
  });

  await ok('PUT /me: an alert the person does not hold the right for is refused', async () => {
    reset();
    const r = await call('PUT', '/api/staff/me/notification-prefs', T.mgr, { alert_type: 'low_stock', enabled: false });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'NOT_YOURS');
    assert.equal(db.user_notification_prefs.length, 0);
  });

  await ok('GET/PUT /:userId: staff.view reads a member\'s alerts, the owner sets one; a cashier is offered none', async () => {
    reset();
    const g = await call('GET', `/api/staff/${GM}/notification-prefs`, T.mgr);   // the manager has staff.view
    assert.deepEqual(g.body.alerts.map((a) => a.key).sort(), ['daily_summary', 'low_stock', 'owner_alert'].sort());   // GM holds all three rights
    const put = await call('PUT', `/api/staff/${GM}/notification-prefs`, T.owner, { alert_type: 'low_stock', enabled: false });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(db.user_notification_prefs.find((p) => p.user_id === GM && p.alert_type === 'low_stock')?.email_enabled, false);
    const cashAlerts = await call('GET', `/api/staff/${CASH}/notification-prefs`, T.mgr);
    assert.deepEqual(cashAlerts.body.alerts, []);   // a cashier receives no alert
  });

  await ok('PUT /:userId honours the ceiling: a manager may not set alerts for someone with more rights than them', async () => {
    reset();
    const r = await call('PUT', `/api/staff/${GM}/notification-prefs`, T.mgr, { alert_type: 'daily_summary', enabled: false });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'BEYOND_CALLER');
  });

  await ok('PUT /:userId needs staff.edit (a cashier is refused)', async () => {
    reset();
    const r = await call('PUT', `/api/staff/${GM}/notification-prefs`, T.cash, { alert_type: 'daily_summary', enabled: false });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(db.user_notification_prefs.length, 0);
  });

  await ok('enforcement: emailOptedOut drops an opted-out person\'s e-mail (owner + staff), keeps the rest', async () => {
    reset();
    // the owner opts out of the daily summary; a manager stays in
    db.user_notification_prefs.push({ business_id: BZ, user_id: OWNER, alert_type: 'daily_summary', email_enabled: false });
    db.user_notification_prefs.push({ business_id: BZ, user_id: MGR, alert_type: 'low_stock', email_enabled: false });
    const dailyDrop = await PREFS.emailOptedOut(BZ, OWNER, 'daily_summary');
    assert.ok(dailyDrop.has(emailOf[OWNER].toLowerCase()), 'the owner is dropped from the daily summary');
    assert.ok(!dailyDrop.has(emailOf[MGR].toLowerCase()), 'the manager is not');
    const stockDrop = await PREFS.emailOptedOut(BZ, OWNER, 'low_stock');
    assert.ok(stockDrop.has(emailOf[MGR].toLowerCase()), 'the manager is dropped from low stock');
    assert.ok(!stockDrop.has(emailOf[OWNER].toLowerCase()), 'the owner is not');
    const none = await PREFS.emailOptedOut(BZ, OWNER, 'owner_alert');
    assert.equal(none.size, 0, 'nobody opted out of operations alerts');
  });
} finally { server.close(); }

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
