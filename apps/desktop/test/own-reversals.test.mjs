// A336 follow-up (desktop 0.6.26) — a void or refund made on the WEB of a sale this TILL rang reaches the till.
//
// Known limit of A359: the till downloaded only the web's sales, so when a manager refunded or voided one of the till's
// OWN sales on the web, the cloud was right but the till's Z-report, shift figures, day close and History still counted
// it in full. The cloud now reports them with the web-sales pull (`own_reversals`); the till applies them like its own.
//
// Drives the REAL compiled dist/main (webSales.applyOwnReversals, shiftService.computeZReport) on a REAL SQLite file.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/own-reversals.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - the refund applied even when the till refunded the sale itself (`!row.refunded_at` dropped) → "counted once" fails
//   - the money-out rows not written                                                               → "expected cash" fails
//   - a web-rung sale (origin 'web') also touched                                                  → "only the till's own" fails
//   - the void not emitted for the branch node                                                     → "the node hears" fails
//   - the till's own refund mirrored without the "already refunded" check (mirrorTillRefund)     → "the race" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-ownrev-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const S = require(path.join(dist, 'shiftService.js'));
const W = require(path.join(dist, 'webSales.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B', '2026-09-30T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://x', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1' });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, token, logged_in_at) VALUES (1, 'u-tom', 'Tom', 'cashier', 'br-1', 'tok', '2026-09-30T09:00:00Z')`).run();
S.adoptCloudShift({ id: 'sh-1', status: 'open', device_id: 'dev-T1', branch_id: 'br-1', cashier_id: 'u-tom', opened_by: 'u-tom',
  opened_at: '2026-09-30T09:00:00Z', opening_float: 1000, terminal_code: 'T1' });

let k = 0;
const sale = (id, amount, method = 'cash', origin = null) => {
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id, origin)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', ?, 0, ?, 'sh-1', ?, 'synced', 'dev-T1', ?)`).run(id, `T1-${++k}`, amount, amount, `2026-09-30T10:0${k}:00Z`, origin);
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`p-${id}`, id, method, amount, amount, `2026-09-30T10:0${k}:00Z`);
};
const expected = () => S.computeZReport('sh-1').totals.expectedCash;
const order = (id) => db.prepare(`SELECT * FROM orders WHERE id=?`).get(id);

console.log('A336 follow-up — a web void / refund of the TILL\'s own sale reaches the till\n');
sale('o-a', 400); sale('o-b', 300); sale('o-c', 250);
ok('setup: float 1000 + 400 + 300 + 250 = 1950', expected() === 1950, String(expected()));

// 1. A refund on the web of o-a.
const refundA = { local_id: 'o-a', status: 'completed', voided_at: null, void_reason: null, refunded_at: '2026-09-30T11:00:00Z',
  refunded_amount: 400, refund_reason: 'Customer returned it',
  refund_payments: [{ id: 'cloud-neg-1', method: 'cash', amount: -400, created_at: '2026-09-30T11:00:00Z' }] };
ok('a web refund of the till\'s own sale is applied', W.applyOwnReversals([refundA], db) === 1);
ok('…the sale shows refunded (amount, when, why) — History stops offering Refund',
  order('o-a').refunded_amount === 400 && order('o-a').refunded_at === '2026-09-30T11:00:00Z' && order('o-a').refund_reason === 'Customer returned it');
ok('…and expected cash comes back out: 1950 − 400 = 1550', expected() === 1550, String(expected()));
ok('pulled again (every 20 s): nothing changes, the money-out row is there once',
  W.applyOwnReversals([refundA], db) === 0 && expected() === 1550
  && db.prepare(`SELECT COUNT(*) c FROM payments WHERE order_id='o-a' AND status='refunded'`).get().c === 1);

// 2. A sale the till refunded ITSELF (online): the cloud reports it too — it must not come out twice.
db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, change_given, reference, status, created_at, sync_status)
            VALUES ('local-neg', 'o-b', 'cash', -300, 0, 0, 'REFUND-T1-2', 'refunded', '2026-09-30T11:05:00Z', 'synced')`).run();
db.prepare(`UPDATE orders SET refunded_at='2026-09-30T11:05:00Z', refunded_amount=300, refund_reason='Wrong item' WHERE id='o-b'`).run();
ok('the till\'s own refund: 1550 − 300 = 1250', expected() === 1250, String(expected()));
const refundB = { local_id: 'o-b', status: 'completed', voided_at: null, void_reason: null, refunded_at: '2026-09-30T11:05:01Z',
  refunded_amount: 300, refund_reason: 'Wrong item', refund_payments: [{ id: 'cloud-neg-2', method: 'cash', amount: -300, created_at: null }] };
ok('…the cloud\'s copy of it changes nothing — counted once (still 1250)',
  W.applyOwnReversals([refundB], db) === 0 && expected() === 1250, String(expected()));

// 3. A void on the web of o-c.
const heard = [];
const voidC = { local_id: 'o-c', status: 'voided', voided_at: '2026-09-30T11:10:00Z', void_reason: 'Rang twice',
  refunded_at: null, refunded_amount: 0, refund_reason: null, refund_payments: [] };
ok('a web void of the till\'s own sale is applied', W.applyOwnReversals([voidC], db, (id, at, why) => heard.push([id, at, why])) === 1);
ok('…status voided with when and why', order('o-c').status === 'voided' && order('o-c').voided_at === '2026-09-30T11:10:00Z' && order('o-c').void_reason === 'Rang twice');
ok('…expected cash drops the sale: 1250 − 250 = 1000', expected() === 1000, String(expected()));
ok('…the branch node hears (the same order_voided event as a till void)', JSON.stringify(heard) === '[["o-c","2026-09-30T11:10:00Z","Rang twice"]]', JSON.stringify(heard));
ok('…and only once', W.applyOwnReversals([voidC], db, (id) => heard.push([id])) === 0 && heard.length === 1);

// 4. Only the till's own sales: a web-rung sale (origin 'web') is updated by the orders list, never by this.
sale('c-web', 500, 'cash', 'web');
const before = expected();
ok('a web-rung sale is not touched by own_reversals (it has its own path)',
  W.applyOwnReversals([{ ...refundA, local_id: 'c-web', refund_payments: [{ id: 'x', method: 'cash', amount: -500, created_at: null }] }], db) === 0
  && expected() === before && order('c-web').refunded_at === null);
ok('an id the till does not have is ignored', W.applyOwnReversals([{ ...refundA, local_id: 'nope' }], db) === 0);

// 4b. The race: the till refunds a sale online; the ~20 s pull can store the cloud's copy of THAT refund between the cloud
//     accepting it and its answer reaching the till. Whichever lands first, the money comes out once.
sale('o-d', 600); sale('o-e', 700);
const base = expected();
const refundD = { ...refundA, local_id: 'o-d', refunded_amount: 600, refund_payments: [{ id: 'cloud-neg-d', method: 'cash', amount: -600, created_at: null }] };
ok('the race, pull first: the pull stores the refund, then the till\'s own answer changes nothing',
  W.applyOwnReversals([refundD], db) === 1 && W.mirrorTillRefund('o-d', [{ method: 'cash', amount: 600 }], 600, 'Cold', db) === false
  && expected() === base - 600, String(expected()));
ok('the race, answer first: the till stores it, then the pull changes nothing',
  W.mirrorTillRefund('o-e', [{ method: 'cash', amount: 700 }], 700, 'Cold', db) === true
  && W.applyOwnReversals([{ ...refundD, local_id: 'o-e', refunded_amount: 700 }], db) === 0
  && expected() === base - 1300 && order('o-e').refunded_amount === 700, String(expected()));
ok('the till\'s refund handler mirrors through mirrorTillRefund (never its own insert)', (() => {
  const ipc = fs.readFileSync(path.join(here, '..', 'src/main/ipcHandlers.ts'), 'utf8');
  const h = ipc.slice(ipc.indexOf("handle('order:refund'"), ipc.indexOf("// ── Tech access"));
  return /mirrorTillRefund\(String\(orderId\), legs, Number\(data\?\.refunded\) \|\| 0, String\(reason \?\? ''\)\);/.test(h)
    && !/INSERT INTO payments/.test(h);
})());

// 5. The wiring: the pull applies them, the cloud sends them.
const se = fs.readFileSync(path.join(here, '..', 'src/main/syncEngine.ts'), 'utf8');
ok('the web-sales pull applies own_reversals and tells the node about voids',
  /changed \+= applyOwnReversals\(body\.own_reversals \?\? \[\], undefined, \(id, at, reason\) =>\s*emitEvent\('order_voided', id, \{ status: 'voided', voided_at: at, void_reason: reason \}\)\);/.test(se));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
