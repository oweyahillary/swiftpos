// A514 — the business-wide supervisor PIN is retired. Owner, 2026-10-16: "Retire it completely" — only people's own PINs
// approve (a void, a refund, a sale on account); an owner or a manager gives staff an approval PIN.
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/supervisor-pin-retired-a514.test.mjs
//
// RUNS the COMPILED routers (orders, business, staff) behind the REAL auth middleware over HTTP; the database in memory
// (tests/lib-memdb.mjs), holding a business whose old supervisor PIN is still stored (bcrypt hash AND a plaintext row from
// before hashing) — exactly what production keeps.
//
//   1 the old business PIN approves nothing: void, refund, credit → INVALID_APPROVER_PIN, counted by the PIN limiter
//   2 a branch where nobody may approve → NO_OVERRIDE_CONFIGURED, telling the owner / manager to give an approval PIN in
//     Staff — even with the old PIN stored
//   3 a person's own PIN (sign-in or approval PIN) still approves, recorded as them
//   4 the cloud never accepts a write of the supervisor PIN (any spelling, the owner included); the stored hash untouched
//   5 the owner, or a manager, gives an approval PIN in Staff — to someone who may approve (void, refund, credit or
//     drawers), never to a plain seller
//
// MUTATIONS TO CONFIRM BITE:
//   - put the verifySupervisorPin fallback back into approverByPin          → 1 fails (the old PIN approves)
//   - NO_APPROVER only when no business PIN is stored (the A355 condition)  → 2 fails (INVALID_APPROVER_PIN instead)
//   - drop the isRetiredSupervisorPinKey check in POST /business/settings   → 4 fails (OWNER_ONLY / 200)
//   - APPROVAL_PIN_KEYS back to sales.void / sales.refund only              → 5 fails (the credit approver is refused)
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/orders.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const pinAttempts = require(path.join(DIST, 'lib/pinAttempts.js'));
const bcrypt = require('bcrypt');

const B = '11111111-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-3333-4333-8333-333333333333';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MGR = 'aaaaaaaa-0000-4000-8000-000000000002',
  CASH = 'aaaaaaaa-0000-4000-8000-000000000003', BOSS = 'aaaaaaaa-0000-4000-8000-000000000005',
  SUP = 'aaaaaaaa-0000-4000-8000-000000000006';
const R = { owner: 'rrrrrrrr-0000-4000-8000-000000000001', mgr: 'rrrrrrrr-0000-4000-8000-000000000002', cash: 'rrrrrrrr-0000-4000-8000-000000000003',
  credit: 'rrrrrrrr-0000-4000-8000-000000000004', boss: 'rrrrrrrr-0000-4000-8000-000000000005' };
const OLD_PIN = '9999', OLD_PLAIN = '8888';
const PIN_MGR = '4321', PIN_BOSS = '8765', PIN_CASH = '1111', PIN_SUP = '2468';
const KEYS = {
  mgr: ['orders.create', 'sales.void', 'sales.refund', 'shifts.confirm', 'customers.credit', 'staff.view', 'staff.edit'],
  cash: ['orders.create'],
  credit: ['orders.create', 'customers.credit'],
  boss: ['orders.create', 'sales.void', 'sales.refund', 'shifts.confirm', 'customers.credit'],
};
const roleOf = (name, keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });
const H = { mgr: bcrypt.hashSync(PIN_MGR, 4), boss: bcrypt.hashSync(PIN_BOSS, 4), cash: bcrypt.hashSync(PIN_CASH, 4), sup: bcrypt.hashSync(PIN_SUP, 4) };
const person = (id, name, roleId, roleName, keys, extra = {}) => ({ id, name, status: 'active', business_id: B, permissions_version: 0,
  role_id: roleId, roles: roleOf(roleName, keys), user_permissions: [], user_branches: [{ branch_id: BR }], ...extra });
const OLD_SETTINGS = () => [
  { id: 'bs-1', business_id: B, key: 'supervisor_pin_hash', value: JSON.stringify(bcrypt.hashSync(OLD_PIN, 4)) },
  { id: 'bs-2', business_id: B, key: 'supervisor_pin', value: JSON.stringify(OLD_PLAIN) },
];
const O1 = 'cccccccc-0000-4000-8000-000000000001', O2 = 'cccccccc-0000-4000-8000-000000000002';

const reset = ({ approvers = true } = {}) => {
  mem.fail = () => null; mem.calls = [];
  pinAttempts._resetAttempts();
  const now = new Date().toISOString();
  const allKeys = [...new Set(Object.values(KEYS).flat())];
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Pollo', currency: 'KES' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true }, { id: BR2, business_id: B, name: 'Kilimani' }],
    permissions: allKeys.map((key, i) => ({ id: `perm-${i}`, key })),
    roles: [{ id: R.owner, business_id: B, name: 'Admin' }, { id: R.mgr, business_id: B, name: 'Manager' }, { id: R.cash, business_id: B, name: 'Cashier' },
      { id: R.credit, business_id: B, name: 'Credit clerk' }, { id: R.boss, business_id: B, name: 'Supervisor' }],
    role_permissions: [],
    users: [
      person(OWNER, 'Owner', R.owner, 'Admin', [], { pin_hash: null, user_branches: [] }),
      person(MGR, 'Mary', R.mgr, 'Manager', KEYS.mgr, { pin_hash: H.mgr }),
      person(CASH, 'Joe', R.cash, 'Cashier', KEYS.cash, { pin_hash: H.cash }),
      person(SUP, 'Sue', R.credit, 'Credit clerk', KEYS.credit, { pin_hash: H.sup }),
      ...(approvers ? [person(BOSS, 'Boss', R.boss, 'Supervisor', KEYS.boss, { pin_hash: H.boss })] : []),
    ],
    user_branches: [{ user_id: MGR, branch_id: BR }, { user_id: CASH, branch_id: BR }, { user_id: SUP, branch_id: BR }, { user_id: BOSS, branch_id: BR }],
    business_settings: OLD_SETTINGS(), branch_settings: [], feature_flags: [], notifications: [], refresh_tokens: [], user_permissions: [],
    orders: [
      { id: O1, business_id: B, branch_id: BR, order_number: 'T1-1', status: 'completed', total: 500, created_at: now, device_id: 'dev-T1', cashier_id: CASH,
        order_items: [], payments: [{ id: 'pay1', status: 'completed', amount: 500, method: 'cash' }] },
      { id: O2, business_id: B, branch_id: BR, order_number: 'T1-2', status: 'completed', total: 300, created_at: now, device_id: 'dev-T1', cashier_id: CASH,
        order_items: [], payments: [{ id: 'pay2', status: 'completed', amount: 300, method: 'cash' }] },
    ],
    shifts: [], customers: [], payments: [], kitchen_tickets: [], expenses: [], float_transactions: [], user_devices: [],
  };
  for (const [rid, k] of [[R.mgr, KEYS.mgr], [R.cash, KEYS.cash], [R.credit, KEYS.credit], [R.boss, KEYS.boss]]) {
    for (const key of k) mem.db.role_permissions.push({ role_id: rid, permission_id: mem.db.permissions.find((p) => p.key === key).id, permissions: { key } });
  }
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
for (const [mount, file] of [['orders', 'orders'], ['business', 'business'], ['staff', 'staff']]) {
  app.use(`/api/${mount}`, require(path.join(DIST, `routes/${file}.js`)).default);
}
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: sign({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  mgr: sign({ userId: MGR, permissionKeys: KEYS.mgr, surface: 'dashboard' }),
  cash: sign({ userId: CASH, permissionKeys: KEYS.cash, surface: 'pos' }),
};
const call = async (method, p, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const storedUntouched = () => assert.deepEqual(mem.db.business_settings.filter((s) => /supervisor/.test(s.key)).map((s) => s.key).sort(),
  ['supervisor_pin', 'supervisor_pin_hash'], 'the stored supervisor PIN rows are left as they are');

try {
  console.log('\n1. The old business supervisor PIN approves nothing\n');
  reset();
  await ok('a void with the old supervisor PIN (hashed, or the plaintext one) → INVALID_APPROVER_PIN; the sale stays', async () => {
    for (const pin of [OLD_PIN, OLD_PLAIN]) {
      const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', supervisor_pin: pin });
      assert.equal(r.status, 403, `${pin}: ${JSON.stringify(r.body)}`); assert.equal(r.body.code, 'INVALID_APPROVER_PIN', pin);
    }
    assert.equal(mem.db.orders[0].status, 'completed');
    storedUntouched();
  });
  reset();
  await ok('a refund with it (as override_pin) → INVALID_APPROVER_PIN; nothing refunded', async () => {
    const r = await call('POST', `/api/orders/${O1}/refund`, T.mgr, { reason: 'x', override_pin: OLD_PIN });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'INVALID_APPROVER_PIN');
    assert.ok(!mem.db.orders[0].refunded_at);
  });
  reset();
  await ok('the old PIN is counted by the PIN limiter like any wrong PIN — then even the right PIN waits (429)', async () => {
    let last;
    for (let i = 0; i < pinAttempts.PIN_MAX_FAILS; i++) last = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', supervisor_pin: OLD_PIN });
    assert.equal(last.status, 403); assert.equal(last.body.code, 'INVALID_APPROVER_PIN');
    const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: PIN_BOSS });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'PIN_LOCKED');
    assert.equal(mem.db.orders[0].status, 'completed');
  });
  reset();
  await ok('a sale on account asks the same people-only approver (approverByPin credit) — no business PIN, no "approved by the supervisor PIN"', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/orders.ts'), 'utf8');
    assert.doesNotMatch(src, /verifySupervisorPin|'the supervisor PIN'/);
    assert.match(src, /const a = await approverByPin\(req, typeof body\?\.credit_authorizer_id === 'string' \? body\.credit_authorizer_id : undefined, pin, 'credit', branchId\);/);
  });

  console.log('\n2. Nobody at the branch may approve\n');
  reset({ approvers: false });
  // Mary asks; she may not approve her own; the owner has no PIN; Sue holds only customers.credit (not a void approver).
  await ok('a void where nobody else may approve → 400 NO_OVERRIDE_CONFIGURED (a PIN in Staff), even with the old PIN stored', async () => {
    for (const pin of [OLD_PIN, '0000']) {
      const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', supervisor_pin: pin });
      assert.equal(r.status, 400, `${pin}: ${JSON.stringify(r.body)}`); assert.equal(r.body.code, 'NO_OVERRIDE_CONFIGURED');
      // A518: "gives someone who may approve a PIN in Staff" — their sign-in PIN already approves (no second PIN needed).
      assert.match(r.body.error, /who may approve a PIN in Staff/);
      assert.match(r.body.error, /owner or a manager/);
    }
    assert.equal(mem.db.orders[0].status, 'completed');
    storedUntouched();
  });

  console.log('\n3. People\'s own PINs still approve\n');
  reset();
  await ok('another approver\'s sign-in PIN approves the void — recorded as them', async () => {
    const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', supervisor_pin: PIN_BOSS });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mem.db.orders[0].status, 'voided'); assert.equal(mem.db.orders[0].authorized_by, BOSS);
  });
  reset();
  await ok('an approval (override) PIN approves too — recorded as its holder', async () => {
    mem.db.users.find((u) => u.id === BOSS).override_pin_hash = bcrypt.hashSync('7070', 4);
    const r = await call('POST', `/api/orders/${O1}/void`, T.mgr, { reason: 'x', override_pin: '7070' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(mem.db.orders[0].authorized_by, BOSS);
  });

  console.log('\n4. The cloud never accepts a write of the supervisor PIN\n');
  reset();
  await ok('POST /api/business/settings supervisor_pin (any spelling) → 410 SUPERVISOR_PIN_RETIRED, the owner included; nothing written', async () => {
    const settingsMgr = sign({ userId: MGR, permissionKeys: [...KEYS.mgr, 'settings.business', 'receipt.manage'], surface: 'dashboard' });
    for (const [who, t] of [['owner', T.owner], ['manager with business settings', settingsMgr]]) {
      for (const key of ['supervisor_pin', 'supervisor_pin_hash', ' SUPERVISOR_PIN ']) {
        const r = await call('POST', '/api/business/settings', t, { key, value: '4567' });
        assert.equal(r.status, 410, `${who} ${key}: ${JSON.stringify(r.body)}`); assert.equal(r.body.code, 'SUPERVISOR_PIN_RETIRED');
        // A518: the sign-in PIN approves; a separate approval PIN in Staff is optional.
        assert.match(r.body.error, /sign-in PIN approves; the owner or a manager can set a separate approval PIN in Staff/);
      }
    }
    assert.equal(mem.db.business_settings.length, 2);
    storedUntouched();
    assert.equal(mem.db.business_settings.find((s) => s.key === 'supervisor_pin').value, JSON.stringify(OLD_PLAIN), 'not even rewritten');
  });
  await ok('GET /api/business/settings never hands it out', async () => {
    const r = await call('GET', '/api/business/settings', T.owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes('supervisor_pin'));
  });

  console.log('\n5. The owner or a manager gives an approval PIN in Staff\n');
  reset();
  await ok('the owner gives an approval PIN to someone who may approve sales on account (customers.credit) — A514 widened it', async () => {
    const r = await call('PATCH', `/api/staff/${SUP}`, T.owner, { override_pin: '1357' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sue = mem.db.users.find((u) => u.id === SUP);
    assert.ok(sue.override_pin_hash && await bcrypt.compare('1357', sue.override_pin_hash));
  });
  reset();
  await ok('a manager (sales.void + staff.edit) gives one to an approver at their branch', async () => {
    const r = await call('PATCH', `/api/staff/${SUP}`, T.mgr, { override_pin: '1357' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(mem.db.users.find((u) => u.id === SUP).override_pin_hash);
  });
  reset();
  await ok('…never to a plain seller (OVERRIDE_PIN_NO_AUTHORITY), and a cashier gives none', async () => {
    let r = await call('PATCH', `/api/staff/${CASH}`, T.owner, { override_pin: '1357' });
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.code, 'OVERRIDE_PIN_NO_AUTHORITY');
    r = await call('PATCH', `/api/staff/${SUP}`, T.cash, { override_pin: '1357' });
    assert.equal(r.status, 403);
    assert.ok(!mem.db.users.find((u) => u.id === CASH).override_pin_hash && !mem.db.users.find((u) => u.id === SUP).override_pin_hash);
  });
  await ok('the web Staff tab offers it to the same people (one list with the cloud)', () => {
    const tab = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/settings/StaffTab.tsx'), 'utf8');
    const staff = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/staff.ts'), 'utf8');
    const cloud = (staff.match(/APPROVAL_PIN_KEYS: readonly string\[\] = (\[[^\]]*\])/) ?? [])[1];
    assert.ok(cloud, 'APPROVAL_PIN_KEYS');
    assert.ok(tab.includes(`${cloud}.some(k => effectiveKeys.has(k))`), 'StaffTab mayApprove uses the cloud list');
    assert.match(tab, /Approval PIN/);
    assert.doesNotMatch(tab, /Entered by the supervisor/);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
