// A450 + A381 — what a till holds of the business follows the cloud: its NAME and currency (owner, 2026-10-12: "I changed
// a business name on the web but the till" kept the old one — it was written only at sign-in), the receipt's M-Pesa line
// ("how do I add till number there or buy goods? I can't find that in settings" — the receipt had the line, nothing filled
// it), and a logo changed on a till with no internet reaching the branch's other tills through the branch server (A381).
//
// RUNS the real till (dist/main: syncEngine's pull, the receipt reprint, the branch server's bundle; real SQLite, electron
// shimmed) against a stand-in cloud answering /api/pos/catalogue-version and /api/pos/init as the real one does.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/business-identity.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - applyBusinessIdentity not called from applyReferenceConfig      → "the new business name is on the till" fails
//   - the receipt's tillNumber not set from getReceiptPay             → "Paybill: 4098201 under the payments" fails
//   - nodeIdentity left out of the branch server's bundle             → "a till behind the branch server gets them" fails
//   - businesses missing from the cloud's catalogue-version           → its pin fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a450-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.8', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, currency, logged_in_at) VALUES (1, 'till-tok', 'dev-T1', 'biz-1', 'Krunch', 'KES', '2026-10-12T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, 'u-mary', 'Mary', 'manager', '{"*":true}', 'br-1', 'tok', '2026-10-12T06:00:00Z')`).run();
// A sale this till made (the reprint rebuilds its receipt from the order).
db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, order_type, status, subtotal, vat_amount, discount_amount, total, created_at, device_id, cashier_id)
  VALUES ('o-1', 'biz-1', 'br-1', 'T1-0042', 'takeaway', 'completed', 200, 27.59, 0, 200, '2026-10-12T09:00:00Z', 'dev-T1', 'u-mary')`).run();
db.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name, category_name, unit_price, quantity, subtotal) VALUES ('i-1', 'o-1', 'p-soda', 'Soda', 'Drinks', 100, 2, 200)`).run();
db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, status, created_at) VALUES ('pay-1', 'o-1', 'mpesa', 200, 200, 'completed', '2026-10-12T09:00:01Z')`).run();

// ── The stand-in cloud ──────────────────────────────────────────────────────────────────────────────────────────────
const cloud = { version: '2026-10-12T08:00:00Z', name: 'Krunch', pay: { label: '', number: '' } };
const init = () => ({
  products: [{ id: 'p-soda', category_id: 'c-drinks', name: 'Soda', base_price: 100, status: 'active' }],
  categories: [{ id: 'c-drinks', name: 'Drinks', status: 'active' }], comboItems: {}, paymentMethods: [{ code: 'mpesa', name: 'M-Pesa' }],
  branchId: 'br-1', vatRate: 16, ctlRate: 0, businessType: 'restaurant', receiptHeader: '', receiptFooter: '',
  receiptPayLabel: cloud.pay.label, receiptPayNumber: cloud.pay.number, businessName: cloud.name, currency: 'KES',
});
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/api/pos/catalogue-version')) return new Response(JSON.stringify({ version: cloud.version }), { status: 200 });
  if (u.includes('/api/pos/init')) return new Response(JSON.stringify(init()), { status: 200 });
  if ((opts.method ?? 'GET') !== 'GET') return new Response('{}', { status: 200 });
  return new Response('[]', { status: 200 });
};

require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
require(path.join(dist, 'print', 'printWorker.js')).initPrinting(db, () => null);
db.prepare(`INSERT INTO station_printers (station_id, target, paper_width_mm, updated_at) VALUES ('receipt', '127.0.0.1:9', 80, 0)`).run();
const lastReceipt = () => {
  const row = db.prepare(`SELECT bytes FROM print_jobs WHERE kind = 'receipt' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get();
  return row ? Buffer.from(row.bytes).toString('latin1') : '';
};
const H = global.__handlers;
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine('http://cloud', 'till-tok', 'r');
const sessionRow = () => db.prepare(`SELECT business_name, currency FROM session WHERE id = 1`).get();

console.log('\nThe business renamed on the web\n');
{
  await E.pullIfCatalogueChanged();   // the first check: the till takes the cloud's catalogue
  cloud.name = 'Krunch Westlands';
  cloud.version = '2026-10-12T09:30:00Z';   // the rename moved businesses.updated_at — the 20-s check sees it
  const r = await E.pullIfCatalogueChanged();
  ok('the new business name is on the till after the 20-s check (before: only after setting the till up again)',
    r.changed === true && sessionRow().business_name === 'Krunch Westlands', JSON.stringify({ r, s: sessionRow() }));
  const s = await H['auth:getSession'](null);
  ok('…and the screens read it (the session they load names it)', s?.business?.name === 'Krunch Westlands', JSON.stringify(s?.business));
  await H['escpos:reprintReceiptForOrder'](null, 'o-1');
  ok('…and the receipt prints it', /KRUNCH WESTLANDS|Krunch Westlands/.test(lastReceipt()), lastReceipt().slice(0, 200));
  ok('no receipt M-Pesa line while none is set', !/Buy Goods|Paybill/.test(lastReceipt()));
}

console.log('\nThe receipt\'s M-Pesa line\n');
{
  cloud.pay = { label: 'Paybill', number: '4098201' };
  cloud.version = '2026-10-12T09:40:00Z';
  await E.pullIfCatalogueChanged();
  await H['escpos:reprintReceiptForOrder'](null, 'o-1');
  ok('set on the web → "Paybill: 4098201" under the payments on this till\'s receipt', /Paybill: 4098201/.test(lastReceipt()), lastReceipt().slice(-600));
  cloud.pay = { label: '', number: '777111' };
  cloud.version = '2026-10-12T09:50:00Z';
  await E.pullIfCatalogueChanged();
  await H['escpos:reprintReceiptForOrder'](null, 'o-1');
  ok('a number with no label prints as Buy Goods', /Buy Goods: 777111/.test(lastReceipt()));
  const offline = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await H['escpos:reprintReceiptForOrder'](null, 'o-1');
  ok('offline the till still prints it (kept on the till)', /Buy Goods: 777111/.test(lastReceipt()));
  globalThis.fetch = offline;
  cloud.pay = { label: 'Buy Goods', number: '' };
  cloud.version = '2026-10-12T10:00:00Z';
  await E.pullIfCatalogueChanged();
  await H['escpos:reprintReceiptForOrder'](null, 'o-1');
  ok('cleared on the web → no line', !/Buy Goods|Paybill/.test(lastReceipt()));
}

console.log('\nA till behind the branch server, and an older cloud\n');
{
  const R = require(path.join(dist, 'referenceBundle.js'));
  cloud.pay = { label: 'Till No.', number: '555000' };
  cloud.version = '2026-10-12T10:10:00Z';
  await E.pullIfCatalogueChanged();
  L.applyPulledBranding({ accentHex: '#aa3300', logoPng: 'iVBORw0KGgo=', logoReceipt: null, receiptLogoEnabled: false });
  // This machine as the branch server: what it hands its tills.
  const bundle = R.buildReferenceBundle(db, C.getDeviceConfig());
  const got = R.unpackNodeBundle(JSON.parse(JSON.stringify(bundle))).config;
  ok('a till behind the branch server gets the name, the currency and the M-Pesa line from it (no internet needed)',
    got.businessName === 'Krunch Westlands' && got.currency === 'KES' && got.receiptPay?.number === '555000' && got.receiptPay?.label === 'Till No.', JSON.stringify(got));
  ok('…and the logo (A381: a logo changed with no internet reaches every till of the branch)',
    got.branding?.logoPng === 'iVBORw0KGgo=' && got.branding?.accentHex === '#aa3300', JSON.stringify(got.branding));
  const old = R.unpackNodeBundle({ posInit: { products: [], categories: [] } }).config;
  ok('an older branch server (or cloud) that says nothing changes nothing on the till',
    old.businessName === undefined && old.currency === undefined && old.receiptPay === undefined && old.branding === undefined);
  E.applyBusinessIdentity('', undefined);
  ok('…and an empty name never blanks the receipt', sessionRow().business_name === 'Krunch Westlands');
}

console.log('\nThe wiring\n');
{
  const pos = read('apps/server/src/routes/pos.ts');
  ok('the cloud\'s 20-s check counts the business itself (a rename)', /latest\('businesses',\s*'id',\s*biz\)/.test(pos));
  // A492: the line is ONE thing — the branch's own set-up when it has one, else the business's — and a Paybill prints its
  // account with the number (tests/mpesa-branch.test.mjs runs it).
  ok('the cloud sends the M-Pesa line, the branch\'s own winning', /receiptPayNumber: mpesaReceiptNumber\(mpesa\)/.test(pos)
    && /const mpesa = branchMpesa \?\? businessMpesa;/.test(pos)
    && /'payment_methods_enabled', 'receipt_pay_label', 'receipt_pay_number', 'receipt_pay_account'\]/.test(pos));
  const br = read('apps/server/src/routes/branches.ts'), bz = read('apps/server/src/routes/business.ts');
  // A492 (owner, 2026-10-15): set on the TILL by the branch's manager — the web's routes refuse it, the branch keeps it.
  ok('…set on the till for its branch (PUT /branches/:id/mpesa); the web\'s settings routes refuse it', /router\.put\('\/:id\/mpesa'/.test(br)
    && /code: 'MPESA_ON_TILL'/.test(br) && /code: 'MPESA_ON_TILL'/.test(bz));
  const ipc = read('apps/desktop/src/main/ipcHandlers.ts'), ns = read('apps/desktop/src/main/nodeServer.ts');
  ok('a logo set on a till goes to its branch server at once', /if \(b\) void relayBrandingToNode\(/.test(ipc)
    && /url === '\/node\/branding'[\s\S]{0,1200}applyPulledBranding\(/.test(ns) && /applyPulledBranding\([\s\S]{0,300}bumpChangeVersion\(getLocalDb\(\)\)/.test(ns));
  const app = read('apps/desktop/src/renderer/App.tsx');
  ok('the screens take the new name after any pull', /onCatalogueChanged\(\(\) => \{\s*posApi\.auth\.getSession\(\)/.test(app));
  const web = read('apps/dashboard/src/lib/buildReceiptOrder.ts');
  ok('the web\'s receipts print the same line', /tillNumber:\s*extra\.pay\?\.number\?\.trim\(\) \|\| undefined/.test(web));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
