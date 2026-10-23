// A453 — 'cashier_no_money_out': only a manager signed in records an expense or cash in / out at the POS.
// Owner, 2026-10-12: "can we remove record expense and cash movement from cashier, is it a right they are given or we add
// it as a feature". Until now every cashier could (a manager approving a pay-out or an expense with a PIN, 0.6.37).
//
//   cd apps/server && npm run build && cd ../.. && node tests/cashier-money-switch.test.mjs
//
// Drives the REAL compiled routes (routes/shifts.js POST /:id/float and /:id/expense) behind the REAL requireAuth, with an
// in-memory database, then pins the till and the web POS to the same shared rule.
//
// MUTATIONS TO CONFIRM BITE:
//   - mayRecordMoneyMovement ignoring the switch          → "switch on: a cashier's pay-in is refused" fails
//   - the guard missing from /:id/expense                 → "…a cashier's expense, even with a manager's PIN" fails
//   - the guard letting a PIN through                     → "…even with a manager's PIN" fails
//   - the till's shift:float without the guard            → "the till refuses it in its own main process" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/shifts.js'))) {
  console.log('\nBuild the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const { mayRecordMoneyMovement, POS_FEATURE_KEYS, MONEY_MOVEMENT_MANAGER_ONLY } = require(path.join(DIST, 'lib/posFeatures.js'));
const jwt = require('jsonwebtoken');

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const SH = '33333333-3333-4333-8333-333333333333';
const CASHIER = '44444444-4444-4444-8444-444444444444', MANAGER = '55555555-5555-4555-8555-555555555555';
let db;
const reset = (switchOn) => {
  db = {
    businesses: [{ id: BZ, name: 'Your Business', owner_id: null, status: 'active' }],
    branches: [{ id: BR, business_id: BZ, name: 'Main Branch', status: 'active' }],
    shifts: [{ id: SH, business_id: BZ, branch_id: BR, status: 'open', cashier_id: CASHIER }],
    users: [{ id: CASHIER, business_id: BZ, name: 'Amina', status: 'active' }, { id: MANAGER, business_id: BZ, name: 'Joshua', status: 'active' }],
    feature_flags: switchOn ? [{ business_id: BZ, key: 'cashier_no_money_out', enabled: true }] : [],
    float_transactions: [], expenses: [], expense_categories: [],
  };
};

let nextId = 1;
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const run = () => { if (inserted) return inserted; if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; } return rows(); };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'is') return (k, v) => { f.push([k, (x) => (x ?? null) === v]); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'insert') return (r) => {
        const list = (db[table] ??= []);
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `row-${nextId++}`, ...x }));
        list.push(...inserted); return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/shifts', require(path.join(DIST, 'routes/shifts.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const tokenFor = (userId, keys) => jwt.sign({ userId, businessId: BZ, branchId: BR, isOwner: false, permissionKeys: keys,
  permissionsVersion: 1, sessionId: 's-' + userId, surface: 'web', tokenType: 'access' }, process.env.JWT_SECRET, { expiresIn: '15m' });
const CASHIER_T = tokenFor(CASHIER, ['orders.create']);
const MANAGER_T = tokenFor(MANAGER, ['shifts.manage', 'orders.void']);
const post = async (token, what, body) => {
  const r = await fetch(`${base}/api/shifts/${SH}/${what}`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  console.log('\nThe rule\n');
  await ok('the switch is one the admin portal lists, and off unless set', () => {
    assert.ok(POS_FEATURE_KEYS.includes('cashier_no_money_out'));
    assert.equal(mayRecordMoneyMovement({ cashier_no_money_out: false }, false), true, 'off: a cashier may, as before');
    assert.equal(mayRecordMoneyMovement({ cashier_no_money_out: true }, false), false, 'on: a cashier may not');
    assert.equal(mayRecordMoneyMovement({ cashier_no_money_out: true }, true), true, 'on: a manager signed in always may');
  });

  console.log('\nSwitch off — nothing changes\n');
  await ok('a cashier records a pay-in (no approval needed), as before', async () => {
    reset(false);
    const r = await post(CASHIER_T, 'float', { type: 'float_in', amount: 500, reason: 'change' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(db.float_transactions.length, 1);
  });
  await ok('a cashier\'s expense still asks for a manager\'s PIN (0.6.37), not the new refusal', async () => {
    reset(false);
    const r = await post(CASHIER_T, 'expense', { description: 'Cabbage', amount: 100, payment_method: 'cash' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'PAYOUT_APPROVAL_REQUIRED');
  });

  console.log('\nSwitch on — only a manager signed in\n');
  await ok('a cashier\'s pay-in is refused and nothing is written', async () => {
    reset(true);
    const r = await post(CASHIER_T, 'float', { type: 'float_in', amount: 500 });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'MANAGER_ONLY_MONEY'); assert.equal(r.body.error, MONEY_MOVEMENT_MANAGER_ONLY);
    assert.equal(db.float_transactions.length, 0);
  });
  await ok('a cashier\'s pay-out is refused even with a manager\'s PIN', async () => {
    reset(true);
    const r = await post(CASHIER_T, 'float', { type: 'float_out', amount: 300, pin: '1234' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'MANAGER_ONLY_MONEY');
    assert.equal(db.float_transactions.length, 0);
  });
  await ok('a cashier\'s expense is refused, even with a manager\'s PIN', async () => {
    reset(true);
    const r = await post(CASHIER_T, 'expense', { description: 'Token', amount: 4000, payment_method: 'cash', pin: '1234' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'MANAGER_ONLY_MONEY');
    assert.equal(db.expenses.length, 0);
  });
  await ok('a manager signed in records a pay-out and an expense', async () => {
    reset(true);
    const a = await post(MANAGER_T, 'float', { type: 'float_out', amount: 300, reason: 'bank' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(db.float_transactions[0].approved_by, MANAGER);
    const b = await post(MANAGER_T, 'expense', { description: 'Token', amount: 4000, payment_method: 'cash' });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(db.expenses.length, 1);
  });

  console.log('\nThe till and the web POS follow the same rule\n');
  await ok('the till refuses it in its own main process (float and expense), not only on screen', () => {
    // A490: the rule is shifts.cash_movements (tillAccess mayMoveMoney); on a map from before migration 134 the switch
    // still applies unless the person may confirm drawers — exactly this guard's meaning before.
    const h = ipcHandlersSource();
    const n = (h.match(/if \(!mayMoveMoney\(sessionPerson\(\), getPosFeatures\(\)\.cashier_no_money_out\)\) throw new Error\(MONEY_MOVEMENT_MANAGER_ONLY\);/g) ?? []).length;
    assert.equal(n, 2, 'shift:float and expense:create');
    const fl = h.slice(h.indexOf("handle('shift:float'"), h.indexOf("handle('shift:close'"));
    assert.ok(fl.indexOf('mayMoveMoney') >= 0 && fl.indexOf('mayMoveMoney') < fl.indexOf('payoutApprover'), 'before any PIN is checked');
    const ex = h.slice(h.indexOf("handle('expense:create'"), h.indexOf("handle('expense:range'"));
    assert.ok(ex.indexOf('mayMoveMoney') >= 0 && ex.indexOf('mayMoveMoney') < ex.indexOf('payoutApprover'), 'expense: before any PIN too');
    // …and the rule itself (read from source: the root suites run before the till is built): the switch binds an older
    // map's cashier, not someone who may confirm; a catalogue map decides by shifts.cash_movements alone; the owner always.
    assert.match(read('apps/desktop/src/main/personAccess.ts'), /export function mayMoveMoney\(p: PersonLike \| null \| undefined, cashierNoMoneyOut: boolean\): boolean \{\s*if \(!p\) return false;\s*const held = personKeys\(p\.roleName, p\.permissions\);\s*if \(held\.has\('\*'\)\) return true;\s*if \(hasMarker\(p\.permissions\)\) return hasPermission\(held, 'shifts\.cash_movements'\);\s*return !cashierNoMoneyOut \|\| hasPermission\(held, 'shifts\.confirm'\);/);
  });
  await ok('the till\'s shift screen hides the Expenses tab and the cash movement form from a cashier', () => {
    const p = read('apps/desktop/src/renderer/pages/ShiftPanel.tsx');
    // A490: the same rule on screen (lib/access.ts mayMoveMoney, on the signed-in session and the switch).
    assert.match(p, /const moneyAllowed = mayMoveMoney\(me, managerOnlyMoney\);/);
    assert.match(p, /posApi\.auth\.getStaffSession\(\)\.then\(\(s\) => setMe\(s \?\? null\)\)/);
    assert.match(read('apps/desktop/src/renderer/lib/access.ts'), /export function mayMoveMoney\(s: SessionLike \| null \| undefined, cashierNoMoneyOut: boolean\): boolean \{\s*if \(!s\) return false;\s*if \(isOwner\(s\)\) return true;\s*if \(hasMarker\(s\)\) return can\(s, 'shifts\.cash_movements'\);\s*return !cashierNoMoneyOut \|\| can\(s, 'shifts\.confirm'\);/);
    assert.match(p, /\(moneyAllowed \? \(\['shift', 'expenses'\] as const\) : \(\['shift'\] as const\)\)/);
    assert.match(p, /activeTab === 'expenses' && moneyAllowed &&/);
    assert.match(p, /data-testid="money-manager-only"/);
  });
  await ok('the web POS shows Float and Expense only when allowed', () => {
    const w = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    // A490: the key (shifts.cash_movements) AND, as before, the switch for anyone who cannot confirm drawers — a map
    // from before the catalogue holds the key for everyone, so the switch alone decides there (unchanged meaning).
    assert.match(w, /const mayMoveMoney = hasPermission\('shifts\.cash_movements'\)\s*&& mayRecordMoneyMovement\(posFeatures, maySignedInConfirm\(session as any\)\);/);
    assert.match(w, /\{mayMoveMoney && \(<>[\s\S]{0,400}setShiftModal\('float'\)[\s\S]{0,500}setShiftModal\('expense'\)[\s\S]{0,120}<\/>\)\}/);
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
