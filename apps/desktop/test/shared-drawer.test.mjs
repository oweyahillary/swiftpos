// A334 (2026-09-26) — a drawer the web POS opened AS THIS TILL is joined by the till, not duplicated, and the
// till's close includes the web's cash (owner: "it should include").
//
// Drives the REAL compiled dist/main/shiftService.js (+ localDb, dayService, deviceConfig) on a REAL SQLite file,
// electron shimmed as in theme-pull.test.mjs. The cloud calls (GET /current, POST /foreign-cash) are not made
// here — their answers are passed in, which is exactly the seam the IPC handlers use.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/shared-drawer.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - adoptCloudShift drops the device check          → "another terminal's drawer is never adopted" fails
//   - adoptCloudShift drops the "already open here"   → "a till with its own open drawer adopts nothing" fails
//   - computeZReport ignores `foreign`                → "the web's cash is in expected cash" + "balances" fail
//   - closeShift ignores `foreign`                    → "a count that includes the web's cash balances" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a334-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

const L = require(path.join(dist, 'localDb.js'));
const S = require(path.join(dist, 'shiftService.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Your Business', '2026-09-26T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://x', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, token, logged_in_at) VALUES (1, 'u-tom', 'Tom', 'cashier', 'br-1', 'tok', '2026-09-26T09:30:00Z')`).run();

const webShift = { id: 'sh-web-1', status: 'open', device_id: 'dev-T1', branch_id: 'br-1', cashier_id: 'u-jane', opened_by: 'u-jane',
                   opened_at: '2026-09-26T09:02:00Z', opening_float: 1000, terminal_code: 'T1' };

console.log('A334 — the till joins a drawer the web POS opened as this till\n');
ok('another terminal\'s drawer is never adopted', S.adoptCloudShift({ ...webShift, device_id: 'dev-T2' }) === null);
ok('a closed cloud shift is never adopted', S.adoptCloudShift({ ...webShift, status: 'closed' }) === null);
ok('nothing to adopt → null (no cloud shift)', S.adoptCloudShift(null) === null);

const a = S.adoptCloudShift(webShift);
ok('the web\'s drawer is adopted under the SAME id — no second drawer', a && a.id === 'sh-web-1' && a.status === 'open');
ok('…with its opening float, opener and this till\'s identity', a && a.opening_float === 1000 && a.opened_by === 'u-jane' && a.device_id === 'dev-T1');
ok('…attached to this till\'s trading day, pending so the push records the day on the cloud row',
  a && !!a.business_day_id && a.sync_status === 'pending', JSON.stringify(a));
ok('a till with its own open drawer adopts nothing (never two)', S.adoptCloudShift({ ...webShift, id: 'sh-web-2' }) === null);
ok('opening a new drawer is still refused while the joined one is open', !!threw(() => S.openShift(500)));

// A sale rung on THIS till into the joined drawer: 400 cash.
db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status)
            VALUES ('o-till-1', 'biz-1', 'br-1', 'T1-1', 'completed', 400, 0, 400, 'sh-web-1', '2026-09-26T10:00:00Z', 'pending')`).run();
db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES ('p-till-1', 'o-till-1', 'cash', 400, 400, '2026-09-26T10:00:00Z')`).run();

// The web rang 2 sales, 700 cash, and paid out a 50 float on this drawer (the cloud's foreign-cash answer).
const foreign = { orders: 2, cash_sales: 700, float_in: 0, float_out: 50, expenses: 0 };
const zLocal = S.computeZReport('sh-web-1');
const zAll = S.computeZReport('sh-web-1', foreign);
ok('without the web\'s part: this till\'s own figures only (1000 + 400)', zLocal.totals.expectedCash === 1400, String(zLocal.totals.expectedCash));
ok('the web\'s cash is in expected cash (1000 + 400 + 700 − 50 = 2050)', zAll.totals.expectedCash === 2050, String(zAll.totals.expectedCash));
ok('…and in the sale count and cash sales; foreign is reported', zAll.totals.orderCount === 3 && zAll.totals.cashSales === 1100 && zAll.totals.foreign?.orders === 2);
ok('offline (foreign unknown) → null is reported, not zero', S.computeZReport('sh-web-1', null).totals.foreign === null);
ok('localShiftIds lists what this till holds', JSON.stringify(S.localShiftIds('sh-web-1').order_ids) === '["o-till-1"]');

// The drawer holds 2050. Counted with the web's part → balances, no note needed.
const noNote = threw(() => S.closeShift(2050, undefined, null));
ok('WITHOUT the web\'s part, counting the real drawer (2050) shows a false 650 over and demands a note',
  noNote && Math.round(noNote.variance) === 650, String(noNote?.variance));
let z = null;
const closeErr = threw(() => { z = S.closeShift(2050, undefined, foreign); });
ok('a count that includes the web\'s cash balances: closed, variance 0, no note',
  !closeErr && z?.shift.status === 'closed' && Math.round(z.shift.cash_variance * 100) === 0, closeErr ? closeErr.message : JSON.stringify(z?.shift));
ok('the stored expected cash includes the web (what the day close sums)',
  db.prepare(`SELECT expected_cash FROM shifts WHERE id='sh-web-1'`).get().expected_cash === 2050,
  String(db.prepare(`SELECT expected_cash FROM shifts WHERE id='sh-web-1'`).get().expected_cash));

// A342 (0.6.14): the web POS's OWN shift on this till (a second drawer on T1) is counted in this drawer too —
// owner: "Till's count covers both". Its expected cash arrives with the foreign-cash answer as `siblings`.
const zSib = S.computeZReport('sh-web-1', { ...foreign, siblings: { count: 1, expected: 730, shifts: [{ id: 'sh-web-2', opened_by_name: 'Jane', opened_at: null, expected: 730 }] } });
ok('A342: the web\'s own shift on this till is added to expected cash (2050 + 730 = 2780)', zSib.totals.expectedCash === 2780, String(zSib.totals.expectedCash));
ok('A342: …and reported, so the panel and the paper can say so', zSib.totals.foreign?.siblings?.count === 1);
ok('A342: an older cloud that sends no siblings changes nothing (2050)', S.computeZReport('sh-web-1', foreign).totals.expectedCash === 2050);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
