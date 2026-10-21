// A492 — each branch's M-Pesa number (Buy Goods till number, or Paybill + account number), set on the till by its
// manager, kept per branch on the cloud, the owner told of every change.
// Owner, 2026-10-15: "each branch has a till number or paybill number … that should be set on the desktop app not web,
// the manager should be the one doing it not the owner, if its paybill they have to set an account number if its buy
// goods they dont have to".
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/mpesa-branch.test.mjs
//
// RUNS the COMPILED branches and business routers behind the REAL auth middleware over HTTP; the database in memory.
//
// MUTATIONS TO CONFIRM BITE: mpesaAllowed returning true → "a cashier / the till may not" fails; the account delete on a
// switch to Buy Goods removed → "switching back drops the account" fails; the notification removed → "the owner is told"
// fails; pos.ts merging key by key again → "the line is one thing" pin fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';
import { ipcHandlersSource } from '../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/branches.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const M = await import(pathToFileURL(path.join(ROOT, 'shared/mpesaReceive.ts')).href);

const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222', BR2 = '33333333-3333-4333-8333-333333333333';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MGR = 'aaaaaaaa-0000-4000-8000-000000000002',
  CASH = 'aaaaaaaa-0000-4000-8000-000000000003', MGR2 = 'aaaaaaaa-0000-4000-8000-000000000004';
const person = (id, name, branch = BR) => ({ id, name, status: 'active', business_id: B, permissions_version: 0, branch_id: branch });
const reset = () => {
  mem.fail = () => null; mem.calls = [];
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Pollo' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands' }, { id: BR2, business_id: B, name: 'Kilimani' }],
    users: [person(OWNER, 'Owner'), person(MGR, 'Mary'), person(CASH, 'Joe'), person(MGR2, 'Kim', BR2)],
    branch_settings: [], business_settings: [], notifications: [],
    user_devices: [{ business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null }],   // the till itself, joined
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api/branches', require(path.join(DIST, 'routes/branches.js')).default);
app.use('/api/business', require(path.join(DIST, 'routes/business.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const tok = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, surface: 'desktop', pinSignIn: true, businessId: B, branchId: BR, isOwner: false, ...p },
  process.env.JWT_SECRET, { expiresIn: '5m' });
const T = {
  owner: tok({ userId: OWNER, isOwner: true, branchId: null, permissionKeys: ['*'] }),
  mgr: tok({ userId: MGR, permissionKeys: ['orders.create', 'settings.mpesa'] }),
  receipts: tok({ userId: MGR, permissionKeys: ['orders.create', 'receipt.manage'] }),
  cash: tok({ userId: CASH, permissionKeys: ['orders.create', 'products.view'] }),
  till: tok({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'] }),
  other: tok({ userId: MGR2, branchId: BR2, permissionKeys: ['settings.mpesa'] }),
};
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const own = () => Object.fromEntries(mem.db.branch_settings.filter((r) => r.branch_id === BR).map((r) => [r.key, r.value]));

try {
  state._setPermissionsMigrated(true);

  console.log('\nThe rules (shared/mpesaReceive.ts)\n');
  await ok('Buy Goods: a till number, no account; Paybill: a business number AND an account number', async () => {
    assert.deepEqual(M.cleanMpesaReceive({ kind: 'buy_goods', number: ' 123 456 ', account: 'x' }), { ok: true, value: { kind: 'buy_goods', number: '123456', account: null } });
    assert.equal(M.cleanMpesaReceive({ kind: 'paybill', number: '4098201' }).ok, false);
    assert.deepEqual(M.cleanMpesaReceive({ kind: 'paybill', number: '4098201', account: ' Shop 12 ' }).value, { kind: 'paybill', number: '4098201', account: 'Shop 12' });
    for (const bad of ['12', '123456789', 'abc123']) assert.equal(M.cleanMpesaReceive({ kind: 'buy_goods', number: bad }).ok, false, bad);
    assert.equal(M.cleanMpesaReceive({ kind: 'paybill', number: '4098201', account: 'a;drop' }).ok, false);
    assert.equal(M.cleanMpesaReceive({ kind: 'cash', number: '123456' }).ok, false);
  });
  await ok('the receipt prints the number, and a Paybill\'s account with it', async () => {
    assert.equal(M.mpesaReceiptNumber({ kind: 'buy_goods', number: '123456', account: null }), '123456');
    assert.equal(M.mpesaReceiptNumber({ kind: 'paybill', number: '4098201', account: '12' }), '4098201, Account 12');
    assert.deepEqual(M.mpesaFromSettings('Paybill', '4098201', '12'), { kind: 'paybill', number: '4098201', account: '12' });
    assert.deepEqual(M.mpesaFromSettings('Till No.', '555555', 'stale'), { kind: 'buy_goods', number: '555555', account: null }, 'an A450 label reads as Buy Goods');
    assert.equal(M.mpesaFromSettings('Buy Goods', '', ''), null);
  });

  console.log('\nSet on the till, by the branch\'s manager\n');
  reset();
  await ok('a manager with settings.mpesa sets Buy Goods: saved for the branch, no account', async () => {
    const r = await call('PUT', `/api/branches/${BR}/mpesa`, T.mgr, { kind: 'buy_goods', number: '123456' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(own(), { receipt_pay_label: 'Buy Goods', receipt_pay_number: '123456' });
  });
  await ok('the owner is told: which branch, from what, to what, who', async () => {
    assert.equal(mem.db.notifications.length, 1);
    const n = mem.db.notifications[0];
    assert.equal(n.user_id, OWNER); assert.equal(n.branch_id, BR); assert.equal(n.type, 'mpesa_changed');
    assert.match(n.title, /Westlands/); assert.match(n.message, /Mary changed it from not set to Buy Goods 123456/);
  });
  await ok('a Paybill without its account number is refused; with it, saved with the account', async () => {
    const bad = await call('PUT', `/api/branches/${BR}/mpesa`, T.mgr, { kind: 'paybill', number: '4098201' });
    assert.equal(bad.status, 400); assert.equal(bad.body.code, 'MPESA_INVALID'); assert.match(bad.body.error, /account number/);
    const r = await call('PUT', `/api/branches/${BR}/mpesa`, T.mgr, { kind: 'paybill', number: '4098201', account: 'WEST1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(own(), { receipt_pay_label: 'Paybill', receipt_pay_number: '4098201', receipt_pay_account: 'WEST1' });
    assert.equal(mem.db.branch_settings.filter((x) => x.branch_id === BR).length, 3, 'one row per key (no duplicates)');
  });
  await ok('switching back to Buy Goods drops the account', async () => {
    await call('PUT', `/api/branches/${BR}/mpesa`, T.mgr, { kind: 'buy_goods', number: '654321' });
    assert.deepEqual(own(), { receipt_pay_label: 'Buy Goods', receipt_pay_number: '654321' });
  });
  await ok('saving the same again tells nobody', async () => {
    const before = mem.db.notifications.length;
    const r = await call('PUT', `/api/branches/${BR}/mpesa`, T.mgr, { kind: 'buy_goods', number: '654321' });
    assert.equal(r.body.changed, false); assert.equal(mem.db.notifications.length, before);
  });
  await ok('GET: the branch\'s own, the business-wide one an older set-up left, and whether this person may change it', async () => {
    mem.db.business_settings.push({ business_id: B, key: 'receipt_pay_label', value: 'Paybill' }, { business_id: B, key: 'receipt_pay_number', value: '222222' },
      { business_id: B, key: 'receipt_pay_account', value: 'HQ' });
    const r = await call('GET', `/api/branches/${BR}/mpesa`, T.mgr);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.own, { kind: 'buy_goods', number: '654321', account: null });
    assert.deepEqual(r.body.inherited, { kind: 'paybill', number: '222222', account: 'HQ' });
    assert.equal(r.body.canEdit, true);
    assert.equal((await call('GET', `/api/branches/${BR}/mpesa`, T.cash)).body.canEdit, false);
  });

  console.log('\nWho may not\n');
  await ok('a cashier may not; nor the till by itself (a person decides where money goes)', async () => {
    const before = JSON.stringify(own());
    assert.equal((await call('PUT', `/api/branches/${BR}/mpesa`, T.cash, { kind: 'buy_goods', number: '999999' })).status, 403);
    assert.equal((await call('PUT', `/api/branches/${BR}/mpesa`, T.till, { kind: 'buy_goods', number: '999999' })).status, 403);
    assert.equal(JSON.stringify(own()), before);
  });
  await ok('a manager of another branch may not change this one', async () => {
    assert.equal((await call('PUT', `/api/branches/${BR}/mpesa`, T.other, { kind: 'buy_goods', number: '999999' })).status, 403);
    assert.equal((await call('PUT', `/api/branches/${BR2}/mpesa`, T.other, { kind: 'buy_goods', number: '777777' })).status, 200);
  });
  await ok('receipt.manage alone: only until migration 134 (who set the receipt line before); after it, settings.mpesa', async () => {
    state._setPermissionsMigrated(false);
    assert.equal((await call('PUT', `/api/branches/${BR}/mpesa`, T.receipts, { kind: 'buy_goods', number: '111111' })).status, 200);
    state._setPermissionsMigrated(true);
    assert.equal((await call('PUT', `/api/branches/${BR}/mpesa`, T.receipts, { kind: 'buy_goods', number: '121212' })).status, 403);
  });
  await ok('the owner may; and may clear it (the branch then prints the business-wide one, or none)', async () => {
    assert.equal((await call('PUT', `/api/branches/${BR}/mpesa`, T.owner, { clear: true })).status, 200);
    assert.deepEqual(own(), {});
  });

  console.log('\nNot on the web, not business-wide\n');
  await ok('the branch settings route and the business settings route refuse the M-Pesa keys', async () => {
    const a = await call('POST', `/api/branches/${BR}/settings`, T.owner, { key: 'receipt_pay_number', value: '123456' });
    assert.equal(a.status, 400); assert.equal(a.body.code, 'MPESA_ON_TILL');
    const b = await call('POST', '/api/business/settings', T.owner, { key: 'receipt_pay_label', value: 'Paybill' });
    assert.equal(b.status, 400); assert.equal(b.body.code, 'MPESA_ON_TILL');
  });
} finally {
  server.close();
}

console.log('\nWired in\n');
await ok('pos/init: the line is ONE thing — the branch\'s own, else the business\'s — and a Paybill prints its account', async () => {
  const pos = read('apps/server/src/routes/pos.ts');
  assert.match(pos, /const mpesa = branchMpesa \?\? businessMpesa;/);
  assert.match(pos, /receiptPayNumber: mpesaReceiptNumber\(mpesa\),/);
  assert.match(pos, /latest\('branch_settings',\s+'branch_id',\s+branchId\)/, 'a change reaches the other tills within 20 s');
});
await ok('the till: Manager › Settings › M-Pesa, its main process checks the person and prints the new line at once', async () => {
  const ipc = ipcHandlersSource();
  assert.match(ipc, /handle\('manage:setMpesa'[\s\S]{0,400}if \(!mayMpesa\(\)\) throw new Error\(MPESA_REFUSED\);/);
  assert.match(ipc, /setReceiptPay\(value \? \{ label: mpesaLabel\(value\.kind\), number: mpesaReceiptNumber\(value\) \} : null\);/);
  const sp = read('apps/desktop/src/renderer/components/SettingsPanel.tsx');
  assert.match(sp, /\{canMpesa && <section[^>]*>\s*<MpesaPanel \/>/);
  const mp = read('apps/desktop/src/renderer/components/MpesaPanel.tsx');
  assert.match(mp, /kind === 'paybill' && \(/, 'the account field shows for a Paybill only');
  assert.match(read('apps/desktop/src/renderer/pages/ManagerPage.tsx'), /canMpesa=\{mayMpesa\(staff\)\}/);
});
await ok('the web shows it, never edits it', async () => {
  const bp = read('apps/dashboard/src/pages/settings/BusinessProfileTab.tsx');
  assert.doesNotMatch(bp, /data-testid="receipt-pay-number"/);
  assert.match(bp, /Manager › Settings › M-Pesa/);
  const bo = read('apps/dashboard/src/pages/settings/BranchReceiptOverrides.tsx');
  assert.doesNotMatch(bo, /key: 'receipt_pay_number'/);
  assert.match(bo, /<BranchMpesaLine branchId=\{branchId\} \/>/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
