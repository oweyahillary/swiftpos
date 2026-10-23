// A585 — who approves a sale on account at the till, when the owner chose the approvers.
// Owner, 2026-10-23: "credit limit — the owner for now; they can assign to branch manager for approval but they set the
// limit".
//
// Drives the REAL compiled dist/main (localDb, deviceConfig, creditSale, pinCache, pinAttempts) on a REAL SQLite file,
// with a stand-in cloud and branch server; reads the payment screen's and the IPC's source for the wiring.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/credit-approval-a585.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - selfApproves ignoring the rule (always customers.credit)              → "a manager NOT on the list needs a PIN" fails
//   - creditApprover's PIN check ignoring the rule (selfApproves(who))     → "a manager's PIN not on the list is refused" fails
//   - prepareCreditSale not passing readCreditApproval(db)                   → "order:create: ON …" cases fail
//   - pullCreditCustomers not keeping the cloud's approval                   → "the cloud's rule is kept" fails
//   - answerCreditCustomers not handing the rule to its tills               → "the branch server hands its tills the rule" fails
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a585-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }, net: { isOnline: () => globalThis.__online } };`);
globalThis.__online = false;
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const K = require(path.join(dist, 'creditSale.js'));
const P = require(path.join(dist, 'pinCache.js'));
const A = require(path.join(dist, 'pinAttempts.js'));
const bcrypt = require(path.join(here, '..', 'node_modules', 'bcryptjs'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const throwsMsg = async (fn) => { try { await fn(); return null; } catch (e) { return e?.message ?? String(e); } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', '2026-10-23T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
E.configureSyncEngine('http://cloud', 'acc', 'ref');

const V2 = (keys) => JSON.stringify({ 'catalogue.v2': true, ...Object.fromEntries(keys.map((k) => [k, true])) });
const CASHIER = { id: 'u-cate', name: 'Cate', roleName: 'cashier', permissions: V2(['orders.create', 'customers.view']) };
const MANAGER = { id: 'u-max', name: 'Max', roleName: 'Manager', permissions: V2(['orders.create', 'customers.view', 'customers.credit']) };
// Ann: a supervisor the owner CHOSE (she holds no customers.credit); Olga: the owner.
const ANN = { id: 'u-ann', name: 'Ann', roleName: 'Supervisor', permissions: V2(['orders.create', 'customers.view']) };
const OWNER = { id: 'u-owner', name: 'Olga', roleName: 'Owner', permissions: V2([]) };
const cache = (who, pin) => P.cacheStaffCredential({ staffId: who.id, name: who.name, roleName: who.roleName, permissions: JSON.parse(who.permissions) }, bcrypt.hashSync(pin, 4), 'br-1');
cache(MANAGER, '1111'); cache(CASHIER, '2222'); cache(ANN, '5555'); cache(OWNER, '9999');

K.writeCreditCustomers(db, [{ id: 'c-acme', name: 'Acme Ltd', phone: '0712 000 111', status: 'active', credit_limit: 1000, credit_balance: 300 }], new Date());
const sale = (amount, over = {}) => ({ branch_id: 'br-1', order_number: 'T1-1', subtotal: amount, total: amount, items: [],
  payments: [{ method: 'credit', amount, amount_tendered: amount, change_given: 0 }], customer_id: 'c-acme', ...over });
const RULE_ON = { on: true, approvers: ['u-ann'], owner_id: 'u-owner' };
// prep: an approval expected — a refusal is a FAIL line, never a crash. prepRaw: a refusal expected (it throws).
const prepRaw = (asker, pin, amount = 200) => K.prepareCreditSale(sale(amount, pin ? { credit_pin: pin } : {}), { asker, db, enabled: null });
const prep = (asker, pin, amount) => prepRaw(asker, pin, amount).catch((e) => ({ refused: e?.message }));

console.log('\nA585 — the owner chose who approves sales on account\n');

console.log('Off (the default): A552 exactly as before');
{
  ok('no rule kept yet → OFF', K.readCreditApproval(db).on === false);
  ok('a manager with customers.credit approves it themselves', K.selfApproves(MANAGER, K.readCreditApproval(db)) === true);
  const r = await prep(CASHIER, '1111');
  ok('a cashier with the manager\'s PIN', r?.approver?.id === 'u-max', JSON.stringify(r?.approver));
  A.resetPinAttempts(db);
}

console.log('\nOn: kept on the till (offline), from the cloud');
{
  K.writeCreditApproval(db, RULE_ON);
  const kept = K.readCreditApproval(db);
  ok('the rule is kept in maintenance_state (no new local schema)', kept.on === true && kept.approvers.join() === 'u-ann' && kept.owner_id === 'u-owner'
    && !!db.prepare(`SELECT value FROM maintenance_state WHERE key = 'credit_approval'`).get(), JSON.stringify(kept));
  ok('…and survives a later answer that carries no rule (an older cloud or server)', (K.writeCreditApproval(db, undefined), K.readCreditApproval(db).on === true));
  ok('junk is OFF', K.cleanApproval('x').on === false && K.cleanApproval({ on: 'yes' }).on === false && K.cleanApproval({ on: true, approvers: [1, '', 'a', 'a'] }).approvers.join() === 'a');
}

console.log('\nOn: who approves');
{
  ok('the seller on the list approves it automatically (Ann, no customers.credit)', K.selfApproves(ANN, RULE_ON) === true);
  ok('the owner always approves (their role, or the account the business names)', K.selfApproves(OWNER, RULE_ON) === true
    && K.selfApproves({ id: 'u-owner', name: 'Olga', roleName: 'Manager', permissions: V2([]) }, RULE_ON) === true);
  ok('a manager NOT on the list needs a PIN (customers.credit no longer enough)', K.selfApproves(MANAGER, RULE_ON) === false);
  let r = await prep(ANN, null);
  ok('order:create: ON, Ann sells on account with no PIN — approved by her', r?.approver?.id === 'u-ann', JSON.stringify(r?.approver));
  let m = await throwsMsg(() => prepRaw(MANAGER, null));
  ok('order:create: ON, a manager not on the list without a PIN is refused — told whose PIN', m === K.CHOSEN_PIN_NEEDED, m);
  m = await throwsMsg(() => prepRaw(CASHIER, '1111'));
  ok('order:create: ON, a manager\'s PIN not on the list is refused (A552 would have taken it)', m === K.NOT_A_CHOSEN_APPROVER, m);
  A.resetPinAttempts(db);
  r = await prep(CASHIER, '5555');
  ok('order:create: ON, a cashier with Ann\'s PIN — approved by Ann (offline: this till\'s saved sign-ins)', r?.approver?.id === 'u-ann', JSON.stringify(r?.approver));
  r = await prep(MANAGER, '9999');
  ok('order:create: ON, the owner\'s PIN approves', r?.approver?.id === 'u-owner', JSON.stringify(r?.approver));
  m = await throwsMsg(() => prepRaw(CASHIER, '2222'));
  ok('order:create: ON, the cashier\'s own PIN is never an approval', m === K.SELF_APPROVAL, m);
  A.resetPinAttempts(db);
  m = await throwsMsg(() => prepRaw(CASHIER, '0000'));
  ok('order:create: ON, a PIN that is nobody\'s is refused', m === K.NOT_A_CHOSEN_APPROVER, m);
  A.resetPinAttempts(db);
  m = await throwsMsg(() => prepRaw(ANN, null, 800));
  ok('the limit still applies — no approver sells past what the owner allowed (700 left)', /Over Acme Ltd's credit limit/.test(m ?? ''), m);
  const p = sale(200, {});
  await K.prepareCreditSale(p, { asker: ANN, db, enabled: null });
  ok('the sale names its approver for the cloud (credit_approved_by)', p.credit_approved_by === 'u-ann');
}

console.log('\nThe rule travels with the customer list');
{
  K.writeCreditApproval(db, { on: false, approvers: [] });
  globalThis.__online = true;
  globalThis.fetch = async (url) => {
    if (/\/api\/pos\/credit-customers$/.test(String(url))) return new Response(JSON.stringify({ at: new Date().toISOString(),
      customers: [{ id: 'c-acme', name: 'Acme Ltd', status: 'active', credit_limit: 1000, credit_balance: 300 }], approval: RULE_ON }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  K._resetCreditPull();
  const pulled = await K.pullCreditCustomers(db);
  ok('the cloud\'s rule is kept with the list', pulled && K.readCreditApproval(db).on === true && K.readCreditApproval(db).approvers.includes('u-ann'));
  globalThis.__online = false;
  C.saveDeviceConfig({ device_role: 'node' });
  const a = await K.answerCreditCustomers(db);
  ok('the branch server hands its tills the rule', a.status === 200 && a.body.approval?.on === true && a.body.approval.approvers.includes('u-ann'), JSON.stringify(a.body.approval));
  C.saveDeviceConfig({ device_role: 'till', node_url: 'http://server.local:4848' });
  K.writeCreditApproval(db, { on: false, approvers: [] });
  K._resetCreditPull();
  globalThis.fetch = async (url) => String(url).endsWith('/node/credit-customers')
    ? new Response(JSON.stringify({ age_ms: 1000, customers: [{ id: 'c-acme', name: 'Acme Ltd', status: 'active', credit_limit: 1000, credit_balance: 300 }], approval: RULE_ON }), { status: 200 })
    : new Response('{}', { status: 404 });
  await K.pullCreditCustomers(db);
  ok('a till behind the server keeps the server\'s rule', K.readCreditApproval(db).on === true);
  C.saveDeviceConfig({ node_url: null });
}

console.log('\nThe screens');
{
  const ipc = fs.readFileSync(path.join(srcDir, 'main', 'ipc', 'credit.ts'), 'utf8');
  ok('credit:customers answers selfApproves under the kept rule, and says the owner chose', /selfApproves: selfApproves\(person, rule\),\s+chosenApprovers: rule\.on,/.test(ipc));
  const pm = fs.readFileSync(path.join(srcDir, 'renderer', 'components', 'PaymentModal.tsx'), 'utf8');
  ok('the payment screen asks for an approver\'s PIN (no new modal — the A517 main-chunk budget)', pm.includes(`"Approver's PIN — someone the owner chose"`) && pm.includes('const needsPin = !onAccount?.selfApproves;'));
  const pos = fs.readFileSync(path.join(srcDir, 'renderer', 'pages', 'POSPage.tsx'), 'utf8');
  ok('POSPage passes it on', pos.includes('chosen: !!r?.chosenApprovers'));
  const ls = fs.readFileSync(path.join(srcDir, 'main', 'localDb.ts'), 'utf8');
  ok('no local schema bump for A585 (still 77)', /LOCAL_SCHEMA_VERSION = 77;/.test(ls));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
