// 0.6.33 — FREE DELIVERY: the shop pays the rider, the customer pays no fee (owner, 2026-10-02: "free delivery … the
// rider is still paid by the shop so delivery fee is a must but the customer does not pay it").
//
// Drives the REAL compiled dist/main (localDb, deviceConfig, syncEngine.createLocalOrder, shiftService, managerReports)
// on a REAL SQLite file.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/free-delivery.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - createLocalOrder skips the rider's pay-out on a free delivery        → "the rider is still paid from the drawer" fails
//   - delivery_free not stored / not sent                                  → "stored on the sale" / "the cloud is told" fail
//   - the Z-report counts a free delivery's fee as paid by the customer    → "the Z-report keeps them apart" fails
//   - the riders summary counts voided deliveries                          → "a voided delivery is not counted" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0633-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const S = require(path.join(dist, 'shiftService.js'));
const M = require(path.join(dist, 'managerReports.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B', '2026-10-02T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-amy', 'Amy')`).run();
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, 'u-amy', 'Amy', 'cashier', '{}', 'br-1', 'tok', '2026-10-02T06:00:00Z')`).run();
db.prepare(`INSERT INTO products (id, name, base_price, status) VALUES ('p-piz', 'Pizza', 1000, 'active')`).run();
C.setPosFeatures({ delivery_fee: true });

console.log('0.6.33 — free delivery (the shop pays the rider)\n');

ok('local schema 63: orders.delivery_free and held_orders.delivery_free',
  L.LOCAL_SCHEMA_VERSION >= 63
  && db.prepare(`PRAGMA table_info(orders)`).all().some((c) => c.name === 'delivery_free')
  && db.prepare(`PRAGMA table_info(held_orders)`).all().some((c) => c.name === 'delivery_free'));

S.openShift(1000);
const shiftId = S.currentShiftReport().shift.id;
const sale = (n, over) => E.createLocalOrder({
  branch_id: 'br-1', order_number: n, order_type: 'delivery', delivery_person: 'Eugene', subtotal: 1000, vat_amount: 0, total: 1000,
  items: [{ product: { id: 'p-piz', name: 'Pizza' }, unitPrice: 1000, quantity: 1, lineTotal: 1000 }],
  payments: [{ method: 'mpesa', amount: 1000 }], ...over,
});

// A free delivery: the customer pays the bill alone (M-Pesa 1000); the rider is paid 300 from the drawer.
const f1 = sale('T1-1', { delivery_fee: 300, delivery_free: true });
const row = db.prepare(`SELECT delivery_fee, delivery_free FROM orders WHERE id=?`).get(f1);
ok('stored on the sale: the rider\'s fee (300) and free', row.delivery_fee === 300 && row.delivery_free === 1, JSON.stringify(row));
const payout = db.prepare(`SELECT type, amount FROM float_transactions WHERE order_id=?`).get(f1);
ok('the rider is still paid from the drawer (a 300 pay-out tied to the sale)', payout?.type === 'float_out' && payout.amount === 300, JSON.stringify(payout));
const z = S.currentShiftReport();
ok('expected cash is the fee lower (1000 − 300 = 700) — the shop paid it', z.totals.expectedCash === 700, String(z.totals.expectedCash));
ok('M-Pesa carries only the bill (1000)', S.expectedMethods(shiftId).mpesa === 1000, JSON.stringify(S.expectedMethods(shiftId)));
ok('the Z-report keeps them apart: no fee in the payments, 300 free deliveries, 300 paid to riders',
  z.totals.deliveryFees === 0 && z.totals.freeDeliveries === 300 && z.totals.riderPayouts === 300, JSON.stringify(z.totals));
const q1 = JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id=?`).get(f1).payload);
ok('the cloud is told: delivery_fee 300 with delivery_free (its legs = the bill)', q1.delivery_fee === 300 && q1.delivery_free === true, JSON.stringify(q1));

// A paid delivery beside it: unchanged.
const p1 = sale('T1-2', { delivery_fee: 200, payments: [{ method: 'mpesa', amount: 1200 }] });
const q2 = JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id=?`).get(p1).payload);
ok('a paid delivery is unchanged (not free; the fee in the payments)',
  db.prepare(`SELECT delivery_free FROM orders WHERE id=?`).get(p1).delivery_free === 0 && q2.delivery_free === undefined
  && S.currentShiftReport().totals.deliveryFees === 200 && S.currentShiftReport().totals.freeDeliveries === 300);

// "Free" with no fee is not a free delivery (nothing for the shop to pay).
const n1 = sale('T1-3', { delivery_free: true });
ok('free with no fee is ignored', db.prepare(`SELECT delivery_free FROM orders WHERE id=?`).get(n1).delivery_free === 0
  && JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id=?`).get(n1).payload).delivery_free === undefined);

// 0.6.33: the riders summary on the Z-report (Eugene: one free 300, one paid 200 by another order; T1-3 no fee).
const riders = S.currentShiftReport().totals.riders;
ok('the Z-report\'s riders: Eugene 3 deliveries — 200 paid by customers, 1 free (300, shop paid)',
  Array.isArray(riders) && riders.length === 1 && riders[0].rider === 'Eugene' && riders[0].deliveries === 3
  && riders[0].feesPaid === 200 && riders[0].freeCount === 1 && riders[0].freeFees === 300, JSON.stringify(riders));
ok('…a voided delivery is not counted', (() => {
  const v = sale('T1-4', { delivery_person: 'Joy', delivery_fee: 100, payments: [{ method: 'mpesa', amount: 1100 }] });
  db.prepare(`UPDATE orders SET status='voided' WHERE id=?`).run(v);
  return !S.currentShiftReport().totals.riders.some((r) => r.rider === 'Joy');
})());
ok('…and a blind close shows none (money per rider)', Array.isArray(S.blindReport(S.currentShiftReport()).totals.riders)
  && S.blindReport(S.currentShiftReport()).totals.riders.length === 0);

ok('History reads the flag (what the customer paid leaves the fee out)',
  M.getRecentOrders(30).some((o) => o.order_number === 'T1-1' && o.delivery_free === 1 && o.delivery_fee === 300));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
