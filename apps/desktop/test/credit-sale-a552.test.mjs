// A552 — sales on account (credit) at the desktop till.
// Owner, 2026-10-21: "for credit sales we need them on desktop app since its the one used by most clients".
//
// Drives the REAL compiled dist/main (localDb, deviceConfig, creditSale, syncEngine.createLocalOrder + syncPush,
// shiftService, escposBridge, peerRelay, pinCache) on a REAL SQLite file, with a stand-in cloud and branch server; and
// reads the payment screen's source for the gate.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/credit-sale-a552.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - onAccountOffered ignoring whether a credit customer is held          → "hidden: no credit customer" fails
//   - prepareCreditSale without the customer check                          → "the customer is required" fails
//   - creditApprover letting anyone through without a PIN (selfApproves → true) → "a cashier without customers.credit needs a PIN" fails
//   - creditApprover without the self-approval check                        → "never the asker" fails
//   - limitProblem never refusing                                           → "the limit" cases fail
//   - view() not adding this till's pending charges                         → "a second sale sees the first" fails
//   - markSynced not stamping synced_at                                     → "after the push the cloud's balance carries it" fails
//   - buildCloudOrderPayload keeping credit_pin                             → "never the PIN" fails
//   - the Z-report counting credit as cash                                  → "day close: on account is its own line" fails
//   - A559: credit:customers without the mayFindCreditCustomers check        → "refused without customers.view …" fails
//   - A559: prepareCreditSale without it                                     → "order:create refuses …" fails
//   - A559: mayFindCreditCustomers on customers.view only                    → "allowed with customers.credit" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const srcDir = path.join(here, '..', 'src');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a552-'));
const shim = path.join(userData, 'electron-shim.cjs');
// safeStorage "wraps" as plain base64 here, so the till's saved sign-ins (staff_pin_cache) are checked for real.
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }, net: { isOnline: () => globalThis.__online } };`);
globalThis.__online = false;
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const S = require(path.join(dist, 'shiftService.js'));
const K = require(path.join(dist, 'creditSale.js'));
const B = require(path.join(dist, 'escposBridge.js'));
const R = require(path.join(dist, 'peerRelay.js'));
const P = require(path.join(dist, 'pinCache.js'));
const A = require(path.join(dist, 'pinAttempts.js'));
const bcrypt = require(path.join(here, '..', 'node_modules', 'bcryptjs'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const throwsMsg = async (fn) => { try { await fn(); return null; } catch (e) { return e?.message ?? String(e); } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', '2026-10-21T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
E.configureSyncEngine('http://cloud', 'acc', 'ref');
db.prepare(`INSERT INTO products (id, name, base_price, status) VALUES ('p-chips', 'Chips', 200, 'active')`).run();

const V2 = (keys) => JSON.stringify({ 'catalogue.v2': true, ...Object.fromEntries(keys.map((k) => [k, true])) });
// A559: a cashier who sells on account holds customers.view (the built-in cashier role does); Nia below does not.
const CASHIER = { id: 'u-cate', name: 'Cate', roleName: 'cashier', permissions: V2(['orders.create', 'customers.view']) };
const MANAGER = { id: 'u-max', name: 'Max', roleName: 'Manager', permissions: V2(['orders.create', 'customers.credit']) };
// The till's saved sign-ins (A446: each till keeps its branch's PINs): Max (manager, this branch), Cate (cashier),
// Mo (a manager saved for ANOTHER branch), Sue (a supervisor without customers.credit).
const cache = (who, pin, branch) => P.cacheStaffCredential({ staffId: who.id, name: who.name, roleName: who.roleName, permissions: JSON.parse(who.permissions) },
  bcrypt.hashSync(pin, 4), branch);
cache(MANAGER, '1111', 'br-1');
cache(CASHIER, '2222', 'br-1');
cache({ id: 'u-mo', name: 'Mo', roleName: 'Manager', permissions: V2(['customers.credit']) }, '3333', 'br-2');
cache({ id: 'u-sue', name: 'Sue', roleName: 'Supervisor', permissions: V2(['sales.void', 'sales.refund']) }, '4444', 'br-1');
const signIn = (p) => {
  db.prepare(`DELETE FROM staff_session`).run();
  db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at) VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-21T06:00:00Z')`)
    .run(p.id, p.name, p.roleName, p.permissions);
};
signIn(CASHIER);

const cust = (over = {}) => ({ id: 'c-acme', name: 'Acme Ltd', phone: '0712 000 111', status: 'active', credit_limit: 1000, credit_balance: 300, ...over });
const sale = (n, legs, over = {}) => ({
  branch_id: 'br-1', order_number: `T1-${n}`, order_type: 'retail', subtotal: 200, vat_amount: 27.59, total: 200,
  items: [{ product: { id: 'p-chips', name: 'Chips' }, unitPrice: 200, quantity: 1, lineTotal: 200 }], payments: legs, ...over,
});
const onAcct = (amount = 200) => [{ method: 'credit', amount, amount_tendered: amount, change_given: 0, reference: null }];

console.log('\nA552 — sales on account at the till\n');

console.log('Offered only where it is used');
{
  ok('local schema 75: credit_customers + customer_credit_transactions.synced_at; REQUIRED moves with it',
    L.LOCAL_SCHEMA_VERSION >= 75 && db.prepare(`PRAGMA table_info(credit_customers)`).all().length >= 7
    && db.prepare(`PRAGMA table_info(customer_credit_transactions)`).all().some((c) => c.name === 'synced_at')
    && Number((fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'lib', 'desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]) === L.LOCAL_SCHEMA_VERSION);
  ok('hidden: no credit customer held (a business that keeps no credit accounts never sees the button)', K.onAccountOffered(db, null) === false);
  K.writeCreditCustomers(db, [cust(), cust({ id: 'c-old', name: 'Old Co', phone: null, status: 'inactive', credit_limit: 500, credit_balance: 0 })], new Date());
  ok('offered: the branch takes On account (defaults) and a credit customer is held', K.onAccountOffered(db, null) === true);
  ok('hidden: the manager switched On account off for the branch', K.onAccountOffered(db, ['cash', 'mpesa']) === false && K.onAccountOffered(db, ['cash', 'credit']) === true);
  const pm = fs.readFileSync(path.join(srcDir, 'renderer', 'components', 'PaymentModal.tsx'), 'utf8');
  ok('the payment screen shows the button only when offered (and one leg on account per sale)',
    pm.includes("buttons.filter((b) => b.code !== 'credit' || onAccount?.offered)") && pm.includes("disabled={m.code === 'credit' && creditIdx >= 0 && creditIdx !== i}")
    && fs.readFileSync(path.join(srcDir, 'renderer', 'pages', 'POSPage.tsx'), 'utf8').includes('onAccount={onAccount}'));
  ok('the order:create handler checks the sale before it is saved',
    /prepareCreditSale\(orderPayload, \{[\s\S]{0,200}\}\);\s+const askedNumber[\s\S]{0,200}createLocalOrder\(orderPayload\)/.test(fs.readFileSync(path.join(srcDir, 'main', 'ipc', 'sale.ts'), 'utf8')));
  const m = await throwsMsg(() => K.prepareCreditSale(sale(0, onAcct(), { customer_id: 'c-acme' }), { asker: MANAGER, db, enabled: ['cash'] }));
  ok('…and order:create refuses it when not offered', m === K.NO_ON_ACCOUNT, m);
  const list = K.readCreditCustomers(db, '0712000');
  ok('the customer is found by phone (spaces ignored) or name; owed, limit, left shown', list.length === 1 && list[0].owed === 300 && list[0].available === 700
    && K.readCreditCustomers(db, 'acm').length === 1 && K.readCreditCustomers(db, 'zzz').length === 0, JSON.stringify(list));
}

console.log('\nThe customer and the limit');
{
  let m = await throwsMsg(() => K.prepareCreditSale(sale(0, onAcct()), { asker: MANAGER, db, enabled: null }));
  ok('the customer is required', m === K.CUSTOMER_NEEDED, m);
  m = await throwsMsg(() => K.prepareCreditSale(sale(0, onAcct(), { customer_id: 'c-nobody' }), { asker: MANAGER, db, enabled: null }));
  ok('…one of this till\'s credit customers (an id the screen made up is not)', m === K.CUSTOMER_NEEDED, m);
  m = await throwsMsg(() => K.prepareCreditSale(sale(0, onAcct(), { customer_id: 'c-old' }), { asker: MANAGER, db, enabled: null }));
  ok('…whose account is active', /not active/.test(m ?? ''), m);
  m = await throwsMsg(() => K.prepareCreditSale(sale(0, onAcct(800), { customer_id: 'c-acme' }), { asker: MANAGER, db, enabled: null }));
  ok('the limit: 800 on account with 700 left is refused (the web POS\'s rule — no override)', /Over Acme Ltd's credit limit: KES 700\.00 left, this sale KES 800\.00/.test(m ?? ''), m);
  ok('…exactly what is left is allowed', K.limitProblem(K.creditCustomerById(db, 'c-acme'), 700) === null);
  ok('…no limit set: refused, and said so', /no credit limit/.test(K.limitProblem({ ...K.creditCustomerById(db, 'c-acme'), credit_limit: 0, available: -300 }, 10) ?? ''));
  m = await throwsMsg(() => K.prepareCreditSale(sale(0, [...onAcct(100), ...onAcct(100)], { customer_id: 'c-acme' }), { asker: MANAGER, db, enabled: null }));
  ok('one leg on account per sale', m === K.ONE_ACCOUNT_LEG, m);
  const p = sale(0, [{ method: 'cash', amount: 200 }], { credit_pin: '1111', credit_approved_by: 'u-max' });
  ok('a sale with no leg on account is untouched — and anything the screen sent about approval is dropped',
    (await K.prepareCreditSale(p, { asker: CASHIER, db, enabled: null })) === null && p.credit_pin === undefined && p.credit_approved_by === undefined);
}

console.log('\nWho approves (A511 at the till)');
{
  A.resetPinAttempts(db);
  let p = sale(1, onAcct(), { customer_id: 'c-acme', credit_pin: '9999' });
  let r = await K.prepareCreditSale(p, { asker: MANAGER, db, enabled: null });
  ok('the seller holds customers.credit: no PIN, they approve it themselves (any PIN sent is ignored)',
    r?.approver.id === 'u-max' && p.credit_approved_by === 'u-max' && p.credit_pin === undefined, JSON.stringify(r?.approver));
  ok('the owner (signed in) approves it themselves', K.selfApproves({ id: 'u-o', name: 'O', roleName: 'owner', permissions: '{}' }) === true);
  let m = await throwsMsg(() => K.prepareCreditSale(sale(2, onAcct(), { customer_id: 'c-acme' }), { asker: CASHIER, db, enabled: null }));
  ok('a cashier without customers.credit needs a manager\'s PIN', m === K.CREDIT_PIN_NEEDED, m);
  p = sale(3, onAcct(), { customer_id: 'c-acme', credit_pin: '1111' });
  r = await K.prepareCreditSale(p, { asker: CASHIER, db, enabled: null });
  ok('…the manager\'s PIN (this branch, customers.credit) approves it — checked on this till\'s saved sign-ins, offline',
    r?.approver.id === 'u-max' && p.credit_approved_by === 'u-max' && p.customer_name === 'Acme Ltd' && p.customer_phone === '0712 000 111'
    && p.on_account?.customer === 'Acme Ltd' && p.on_account?.balance_owed === 500, JSON.stringify(p));
  m = await throwsMsg(() => K.prepareCreditSale(sale(4, onAcct(), { customer_id: 'c-acme', credit_pin: '2222' }), { asker: CASHIER, db, enabled: null }));
  ok('never the asker: the cashier\'s own PIN', m === K.SELF_APPROVAL, m);
  m = await throwsMsg(() => K.prepareCreditSale(sale(5, onAcct(), { customer_id: 'c-acme', credit_pin: '4444' }), { asker: CASHIER, db, enabled: null }));
  ok('a supervisor who voids but does not hold customers.credit: refused', m === K.NOT_A_CREDIT_APPROVER, m);
  m = await throwsMsg(() => K.prepareCreditSale(sale(6, onAcct(), { customer_id: 'c-acme', credit_pin: '3333' }), { asker: CASHIER, db, enabled: null }));
  ok('another branch\'s manager: not recognised here', m === K.NOT_A_CREDIT_APPROVER, m);
  m = await throwsMsg(() => K.prepareCreditSale(sale(7, onAcct(), { customer_id: 'c-acme', credit_pin: '0000' }), { asker: CASHIER, db, enabled: null }));
  const strikes = () => { const r = db.prepare(`SELECT value FROM maintenance_state WHERE key = 'pin_attempts'`).get(); return r ? Number(JSON.parse(r.value).failures) || 0 : 0; };
  A.resetPinAttempts(db);
  await throwsMsg(() => K.prepareCreditSale(sale(4, onAcct(), { customer_id: 'c-acme', credit_pin: '2222' }), { asker: CASHIER, db, enabled: null }));
  const afterOwn = strikes();
  m = await throwsMsg(() => K.prepareCreditSale(sale(7, onAcct(), { customer_id: 'c-acme', credit_pin: '0000' }), { asker: CASHIER, db, enabled: null }));
  ok('a wrong PIN: refused, and counted towards the till\'s PIN lock (the asker\'s own is not)',
    m === K.NOT_A_CREDIT_APPROVER && afterOwn === 0 && strikes() === 1, JSON.stringify({ m, afterOwn, now: strikes() }));
  A.resetPinAttempts(db);
  for (let i = 0; i < A.PIN_MAX_FAILURES; i++) await throwsMsg(() => K.creditApprover(CASHIER, '0000', 'br-1'));
  m = await throwsMsg(() => K.creditApprover(CASHIER, '1111', 'br-1'));
  ok('…five wrong PINs lock the PIN entry, the right one too', m !== null && m !== K.NOT_A_CREDIT_APPROVER, m);
  A.resetPinAttempts(db);
}

console.log('\nOffline: saved on the till, the balance moves, pushed later');
let firstId;
{
  signIn(CASHIER);
  S.openShift(1000);
  const p = sale(10, onAcct(), { customer_id: 'c-acme', credit_pin: '1111' });
  await K.prepareCreditSale(p, { asker: CASHIER, db, enabled: null });
  firstId = E.createLocalOrder(p);
  const charge = db.prepare(`SELECT * FROM customer_credit_transactions WHERE order_id = ?`).get(firstId);
  ok('the sale is saved with its charge on the customer (offline, not synced yet)', charge?.customer_id === 'c-acme' && charge.amount === 200 && charge.synced_at === null, JSON.stringify(charge));
  const c = K.creditCustomerById(db, 'c-acme');
  ok('a second sale sees the first: owed 300 + 200 = 500, 500 left', c.pending === 200 && c.owed === 500 && c.available === 500, JSON.stringify(c));
  const m = await throwsMsg(() => K.prepareCreditSale(sale(11, onAcct(600), { customer_id: 'c-acme', credit_pin: '1111' }), { asker: CASHIER, db, enabled: null }));
  ok('…so 600 more is past the limit now', /Over Acme Ltd's credit limit/.test(m ?? ''), m);
  const q = JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id = ?`).get(firstId).payload);
  ok('the push names the customer and who approved it — never the PIN, never the receipt\'s lines',
    q.customer_id === 'c-acme' && q.credit_approved_by === 'u-max' && q.credit_pin === undefined && q.on_account === undefined
    && q.payments[0].method === 'credit' && q.payments[0].status === 'completed' && q.idempotency_key === firstId && !!q.created_at, JSON.stringify(q));
  const relayed = R.buildCloudOrderPayload({ ...p, credit_pin: '1111' }, { shiftId: null, deviceId: 'dev-T1', orderId: 'x', createdAt: 'y', cashierId: 'u-cate' });
  ok('…the branch server\'s relay builds the same (one builder)', relayed.credit_pin === undefined && relayed.on_account === undefined && relayed.credit_approved_by === 'u-max');
  const stored = JSON.parse(db.prepare(`SELECT payload FROM receipt_payloads WHERE order_id = ?`).get(firstId).payload);
  ok('the reprint keeps the receipt\'s lines (on_account), not the PIN', stored.on_account?.balance_owed === 500 && stored.credit_pin === undefined);

  // The cloud comes back: the sale goes up; the charge is stamped as now in the cloud's balance.
  globalThis.__online = true;
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (/\/api\/orders$/.test(u) && init.method === 'POST') { const b = JSON.parse(init.body); posted.push(b); return json(201, { orderId: b.idempotency_key, orderNumber: b.order_number }); }
    if (/\/api\/sync\/push$/.test(u)) { const b = JSON.parse(init.body); return json(200, { results: {}, accepted: b }); }
    if (/\/api\/pos\/credit-customers$/.test(u)) return json(200, { at: new Date().toISOString(), customers: [cust({ credit_balance: 500 })] });
    if (/\/api\/shifts\//.test(u)) return json(200, {});
    return json(404, { error: 'not found' });
  };
  await E.syncPush();
  const after = db.prepare(`SELECT synced_at FROM customer_credit_transactions WHERE order_id = ?`).get(firstId);
  const pushedSale = posted.find((b) => b.idempotency_key === firstId);
  ok('pushed like any sale (credit_approved_by on it) — and the charge stamped as reaching the cloud', !!pushedSale && pushedSale.credit_approved_by === 'u-max' && !!after?.synced_at,
    JSON.stringify({ posted: posted.length, after, status: db.prepare(`SELECT sync_status FROM orders WHERE id = ?`).get(firstId) }));
  ok('…until the list is read again it still counts (the cloud\'s figure was read before)', K.creditCustomerById(db, 'c-acme').owed === 500);
  K._resetCreditPull();
  const pulled = await K.pullCreditCustomers(db);
  const c2 = K.creditCustomerById(db, 'c-acme');
  ok('after the push the cloud\'s balance carries it: the next pull says 500 owed, nothing added twice', pulled && c2.cloud_balance === 500 && c2.pending === 0 && c2.owed === 500, JSON.stringify(c2));
  globalThis.__online = false;
}

console.log('\nThe branch server and its tills (A535 pattern)');
{
  // The server answers from its copy, saying how old it is.
  C.saveDeviceConfig({ device_role: 'node' });
  const a = await K.answerCreditCustomers(db);
  ok('the branch server hands its copy to its tills (and how old it is)', a.status === 200 && a.body.customers.length === 1 && a.body.customers[0].credit_balance === 500 && a.body.age_ms >= 0 && a.body.age_ms < 60_000, JSON.stringify(a));
  C.saveDeviceConfig({ device_role: 'till', node_url: 'http://server.local:4848' });
  K._resetCreditPull();
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith('/node/credit-customers')) return new Response(JSON.stringify({ age_ms: 30_000, customers: [cust({ credit_balance: 650 })] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const before = Date.now();
  const okPull = await K.pullCreditCustomers(db);
  const at = Date.parse(K.creditListAt(db));
  ok('a till behind a server asks the server (shop network), not the cloud; the list dated when the cloud read it (−30 s, −2 s margin)',
    okPull && asked.length === 1 && asked[0] === 'http://server.local:4848/node/credit-customers' && K.creditCustomerById(db, 'c-acme').cloud_balance === 650
    && at <= before - 32_000 + 50 && at >= before - 33_000, JSON.stringify({ asked, at: new Date(at).toISOString() }));
  const ns = fs.readFileSync(path.join(srcDir, 'main', 'nodeServer.ts'), 'utf8');
  ok('/node/credit-customers is for a proven till only', /url === '\/node\/credit-customers'\) \{\s+if \(!requireProven\(req, res, '\/node\/credit-customers'\)\) return;/.test(ns));
  K._resetCreditPull();
  globalThis.fetch = async (url) => String(url).endsWith('/node/credit-customers') ? new Response('{}', { status: 404 }) : new Response('{}', { status: 503 });
  await K.pullCreditCustomers(db);
  ok('an older server (404): not asked again for an hour — the cloud through it instead', K.creditCustomerById(db, 'c-acme').cloud_balance === 650);
  C.saveDeviceConfig({ node_url: null });
}

console.log('\nThe receipt');
{
  const rows = B.receiptPaymentRows([{ method: 'credit', amount: 120 }, { method: 'cash', amount: 80 }], { customer: 'Acme Ltd', balanceOwed: 620 });
  ok('On account names the customer, then "Balance owed"; other legs as before',
    JSON.stringify(rows) === JSON.stringify([{ label: 'On account: Acme Ltd', amount: 12000 }, { label: 'CASH', amount: 8000 }, { label: 'Balance owed', amount: 62000 }]), JSON.stringify(rows));
  ok('no leg on account: unchanged (no Balance owed line)', JSON.stringify(B.receiptPaymentRows([{ method: 'mpesa', amount: 200 }], undefined)) === JSON.stringify([{ label: 'MPESA', amount: 20000 }]));
}

console.log('\nDay close: on account is its own line, never cash');
{
  signIn(MANAGER);
  const cashSale = E.createLocalOrder(sale(20, [{ method: 'cash', amount: 200, amount_tendered: 200, change_given: 0 }]));
  const p = sale(21, [{ method: 'credit', amount: 120, amount_tendered: 120, change_given: 0 }, { method: 'cash', amount: 80, amount_tendered: 100, change_given: 20 }], { customer_id: 'c-acme' });
  await K.prepareCreditSale(p, { asker: MANAGER, db, enabled: null });
  E.createLocalOrder(p);
  const z = S.currentShiftReport();
  const credit = z.byMethod.find((m) => m.method === 'credit');
  const cash = z.byMethod.find((m) => m.method === 'cash');
  ok('the shift report: On account (200 + 120 = 320) its own line; cash 200 + 80 = 280', credit?.amount === 320 && cash?.amount === 280, JSON.stringify(z.byMethod));
  ok('expected cash in the drawer = float 1000 + cash 280 — nothing on account', z.totals.expectedCash === 1280, String(z.totals.expectedCash));
  const expected = S.expectedMethods(z.shift.id);
  ok('…and per method: credit expected as credit, never in cash (cash = float 1000 + 280)', expected.credit === 320 && expected.cash === 1280, JSON.stringify(expected));
  void cashSale;
}

console.log('\nA559: finding the customers needs customers.view or customers.credit (the web POS\'s rule)');
{
  // The real IPC handler (ipc/credit.ts), registered on a stand-in `handle`, with the person in staff_session.
  const handlers = {};
  const { registerCreditHandlers } = require(path.join(dist, 'ipc', 'credit.js'));
  registerCreditHandlers({ handle: (name, fn) => { handlers[name] = fn; }, requireKey: () => {}, creditOffline: () => true, manageFetch: async () => null });
  const ask = () => handlers['credit:customers'](null, { search: '' });
  globalThis.__online = false;
  const NIA = { id: 'u-nia', name: 'Nia', roleName: 'cashier', permissions: V2(['orders.create']) };
  const VIEWER = { id: 'u-vic', name: 'Vic', roleName: 'cashier', permissions: V2(['orders.create', 'customers.view']) };
  const CREDITOR = { id: 'u-cal', name: 'Cal', roleName: 'Supervisor', permissions: V2(['orders.create', 'customers.credit']) };
  ok('the rule: customers.view or customers.credit (the owner always); neither → no', K.mayFindCreditCustomers(VIEWER) && K.mayFindCreditCustomers(CREDITOR)
    && K.mayFindCreditCustomers({ id: 'u-o', name: 'O', roleName: 'owner', permissions: '{}' }) && !K.mayFindCreditCustomers(NIA) && !K.mayFindCreditCustomers(null));
  signIn(NIA);
  let r = await ask();
  ok('credit:customers refused without customers.view or customers.credit: not offered, no list (no On account button)',
    r.offered === false && r.customers.length === 0 && r.selfApproves === false, JSON.stringify(r));
  signIn(VIEWER);
  r = await ask();
  ok('…allowed with customers.view: offered, the list, a manager\'s PIN still approves it', r.offered === true && r.customers.length >= 1 && r.selfApproves === false, JSON.stringify(r));
  signIn(CREDITOR);
  r = await ask();
  ok('…allowed with customers.credit (it approves itself)', r.offered === true && r.customers.length >= 1 && r.selfApproves === true, JSON.stringify(r));
  const m = await throwsMsg(() => K.prepareCreditSale(sale(30, onAcct(10), { customer_id: 'c-acme', credit_pin: '1111' }), { asker: NIA, db, enabled: null, verify: async () => MANAGER }));
  ok('order:create refuses a sale on account by someone without the key — even with a manager\'s PIN', m === K.NO_CUSTOMER_ACCESS, m);
  const p = sale(31, onAcct(10), { customer_id: 'c-acme', credit_pin: '1111' });
  const okView = await K.prepareCreditSale(p, { asker: VIEWER, db, enabled: null, verify: async () => MANAGER });
  ok('…with customers.view the sale goes ahead on the manager\'s PIN', okView?.approver.id === 'u-max', JSON.stringify(okView?.approver));
  const pc = sale(32, onAcct(10), { customer_id: 'c-acme' });
  ok('…with customers.credit, on their own approval', (await K.prepareCreditSale(pc, { asker: CREDITOR, db, enabled: null }))?.approver.id === 'u-cal');
  const src = fs.readFileSync(path.join(srcDir, 'main', 'ipc', 'credit.ts'), 'utf8');
  ok('the check is in MAIN, before the list is read', /if \(!mayFindCreditCustomers\(person\)\) return \{ offered: false[^\n]*\n\s+await ensureCreditCustomers\(\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
