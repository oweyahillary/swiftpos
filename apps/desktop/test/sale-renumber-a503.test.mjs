// A503 (E1) — a sale the till renumbers (A500: claimOrderNumberForOwnSale found the number already used on this till) keeps
// its kitchen ledger and its sale screen right: the kitchen lines sent under the number the screen asked with are marked
// paid, and the screen shows the number the receipt printed.
//
//   cd apps/desktop && npm run build:main && node test/sale-renumber-a503.test.mjs
//
// Real dist/main billNumber + kitchenService on a real SQLite file; the wiring (order:create, POSPage) by source.
// MUTATIONS: drop the second markKitchenPaid → "the old number's kitchen lines are paid" fails;
//            POSPage back to `orderNumber: num` → "the sale screen shows the final number" fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const src = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a503e1-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.16', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true }, session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
const BN = require(path.join(dist, 'billNumber.js'));
const K = require(path.join(dist, 'kitchenService.js'));

console.log('\nThe renumber itself (A500)\n');
const now = new Date().toISOString();
db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, subtotal, vat_amount, total, created_at, device_id) VALUES ('o-old', 'b', 'br-1', 'T1--5', 10, 0, 10, ?, 'dev-me')`).run(now);
const claim = BN.claimOrderNumberForOwnSale(db, 'T1--5', 'dev-me', 'T1');
ok('a number this till already used gives the sale the next one', claim.renumbered === true && claim.number !== 'T1--5', JSON.stringify(claim));

console.log('\nThe kitchen ledger\n');
db.prepare(`INSERT INTO kitchen_lines (order_number, line_id, product_name, unit_price, sent_qty, status, first_sent_at, updated_at)
            VALUES ('T1--5', 'l-1', 'Chips', 100, 1, 'open', ?, ?)`).run(now, now);
K.markKitchenPaid(claim.number);
ok('marking only the final number leaves the sent lines open (the defect)', db.prepare(`SELECT status FROM kitchen_lines WHERE line_id = 'l-1'`).get().status === 'open');
K.markKitchenPaid('T1--5');
ok('…the number the screen asked with closes them', db.prepare(`SELECT status FROM kitchen_lines WHERE line_id = 'l-1'`).get().status === 'paid');

console.log('\nWired in (order:create, the sale screen)\n');
const ipc = src('src/main/ipcHandlers.ts');
const create = ipc.slice(ipc.indexOf("handle('order:create'"), ipc.indexOf("handle('print:list'"));
ok('order:create: the old number\'s kitchen lines are paid', /const askedNumber = orderPayload\?\.order_number \?\? null;/.test(create)
  && /if \(askedNumber && askedNumber !== orderPayload\?\.order_number\) markKitchenPaid\(askedNumber\);/.test(create));
ok('order:create: answers with the final number', /return \{ orderId, orderNumber: orderPayload\?\.order_number \?\? null, printFailed: printed\.failed \};/.test(create));
ok('the sale screen shows the final number', /setCompletedOrder\(\{ orderNumber: created\?\.orderNumber \|\| num,/.test(src('src/renderer/pages/POSPage.tsx')));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
