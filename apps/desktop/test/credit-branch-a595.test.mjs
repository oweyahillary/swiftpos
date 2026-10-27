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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a595-'));
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
const cust = (over = {}) => ({ id: 'c-acme', name: 'Acme Ltd', phone: '07•• ••• 111', status: 'active', credit_limit: 1000, credit_balance: 300, ...over });
const sale = (n, legs, over = {}) => ({
  branch_id: 'br-1', order_number: `T1-${n}`, order_type: 'retail', subtotal: 200, vat_amount: 27.59, total: 200,
  items: [{ product: { id: 'p-chips', name: 'Chips' }, unitPrice: 200, quantity: 1, lineTotal: 200 }], payments: legs, ...over,
});
const onAcct = (amount = 200) => [{ method: 'credit', amount, amount_tendered: amount, change_given: 0, reference: null }];

console.log('\nA595 D4 — credit per branch at the POS, offline\n');
K.writeCreditCustomers(db, [cust(), cust({ id: 'c-bob', name: 'Bob', credit_limit: 0, credit_balance: 0 })], new Date());
{
  ok('no branch rule kept (an older cloud): credit on, the business-wide limit (A552 as before)',
    K.readCreditBranch(db).credit_enabled === true && K.creditCustomerById(db, 'c-acme').available === 700);
  K.writeCreditBranch(db, { credit_enabled: true, limits: { 'c-acme': { limit: 400, owed: 150 }, 'c-bob': { limit: 300, owed: 0 } } });
  const a = K.creditCustomerById(db, 'c-acme');
  ok('a limit at this branch: what is left is that limit less what is owed HERE (400 - 150)', a.available === 250 && a.branch_limit === 400 && a.owed_here === 150, JSON.stringify(a));
  ok('…and the total owed is still shown (owed here / owed in total)', a.owed === 300);
  ok('a customer with a limit only at this branch sells on account here', K.creditCustomerById(db, 'c-bob').available === 300
    && K.limitProblem(K.creditCustomerById(db, 'c-bob'), 200) === null);
  ok('over the branch limit: refused with the amount left', /250\.00 left/.test(K.limitProblem(a, 300) ?? ''), K.limitProblem(a, 300));
  const m = await throwsMsg(() => K.prepareCreditSale(sale(1, onAcct(300), { customer_id: 'c-acme' }), { asker: MANAGER, db, enabled: null }));
  ok('order:create refuses past the branch limit', /left/.test(m ?? ''), m);
}
{
  K.writeCreditBranch(db, { credit_enabled: false, limits: {} });
  const m = await throwsMsg(() => K.prepareCreditSale(sale(2, onAcct(100), { customer_id: 'c-acme' }), { asker: MANAGER, db, enabled: null }));
  ok('a branch the owner closed to credit: order:create refuses a sale on account (plain message), offline too', m === K.CREDIT_OFF_HERE, m);
  const src = fs.readFileSync(path.join(srcDir, 'main', 'ipc', 'credit.ts'), 'utf8');
  ok('…and the payment screen offers no On account there (credit:customers)', /const offered = onAccountOffered\(db\) && readCreditBranch\(db\)\.credit_enabled;/.test(src));
  K.writeCreditBranch(db, null);
  ok('a pull without a branch rule keeps the last one (credit stays off until the cloud says on)', K.readCreditBranch(db).credit_enabled === false);
  K.writeCreditBranch(db, { credit_enabled: true, limits: {} });
}
{
  const r = await K.answerCreditCustomers(db);
  ok('the branch server hands its tills the branch rule with the list', r.status === 200 && r.body.branch?.credit_enabled === true, JSON.stringify(r.body?.branch));
  const p = sale(3, onAcct(100), { customer_id: 'c-acme', customer_phone: undefined });
  await K.prepareCreditSale(p, { asker: MANAGER, db, enabled: null });
  ok('a masked number from the list is never put on the sale (A595: the cloud puts the real one on)', p.customer_phone === null, String(p.customer_phone));
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
