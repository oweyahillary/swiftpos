// 0.6.27 — a prospect's requests, switched per client in the admin portal (owner, 2026-09-30: "we can find a way of
// turning this features on and off per clients requests rather than killing some of them totally").
//
//   1 blind shift close · 2+3 delivery fee (pass-through) paid to the rider in cash · 4 "Delivery — Eugene" ·
//   5 expense payment method · 6 cashier's own History, ordered by method / type · 7 no reprint for cashiers ·
//   8 the manager sees the cashier's figures and gives reasons · 9 the Z-report shows the expense TYPE.
//
// Drives the REAL compiled dist/main (localDb, deviceConfig, referenceBundle, syncEngine.createLocalOrder,
// shiftService, managerReports, webSales) on a REAL SQLite file.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/prospect-features.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - parsePosFeatures turns on any truthy value (not only true)                  → "only a real true turns one on" fails
//   - createLocalOrder records no rider pay-out                                     → "expected cash is the fee lower" fails
//   - reverseRiderPayout puts it back twice (no float_in check)                     → "a second void changes nothing" fails
//   - the Z-report takes every expense out of the drawer (no cash filter)           → "an M-Pesa expense is not out of the drawer" fails
//   - expectedMethods ignores non-cash expenses                                      → "…it comes off M-Pesa's expected" fails
//   - historyScope ignores the switch                                               → "a cashier sees only their own" fails
//   - blindReport keeps the figures                                                  → "the blind report carries no figures" fails
//   - closeShift asks a blind cashier for a variance note                            → "a blind close needs no note" fails
//   - confirmShift does not require the reasons                                     → "a differing count needs a reason" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0627-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const R = require(path.join(dist, 'referenceBundle.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const S = require(path.join(dist, 'shiftService.js'));
const M = require(path.join(dist, 'managerReports.js'));
const W = require(path.join(dist, 'webSales.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const threw = (f) => { try { f(); return null; } catch (e) { return e; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B', '2026-09-30T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-amy', 'Amy'), ('u-ben', 'Ben'), ('u-mgr', 'Mary')`).run();
const signIn = (id, name, role) => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, '{}', 'br-1', 'tok', '2026-09-30T06:00:00Z')`).run(id, name, role);
db.prepare(`INSERT INTO products (id, name, base_price, status) VALUES ('p-chk', 'Chicken', 1000, 'active')`).run();
const features = (on) => C.setPosFeatures({ blind_shift_close: on, delivery_fee: on, cashier_own_history: on, cashier_no_reprint: on, confirm_shows_cashier_figures: on });

console.log('0.6.27 — the prospect\'s requests, per-client switches\n');

// ── The switches ─────────────────────────────────────────────────────────────
// 0.6.29: blind close and the cashier's figures at confirm are standard (always on); the rest are switches, off unless set.
ok('never told → every switch off; the two standard ones on', (() => { const f = C.getPosFeatures();
  return f.blind_shift_close === true && f.confirm_shows_cashier_figures === true
    && Object.entries(f).filter(([k]) => k !== 'blind_shift_close' && k !== 'confirm_shows_cashier_figures').every(([, v]) => v === false); })());
C.setPosFeatures({ delivery_fee: 'yes', blind_shift_close: 1, cashier_no_reprint: true, made_up: true });
ok('only a real true turns one on; unknown keys are dropped',
  JSON.stringify(C.getPosFeatures()) === JSON.stringify({ delivery_fee: false, cashier_own_history: false, cashier_no_reprint: true,
                                                kitchen_void_approval: false, pay_before_kitchen: false,
                                                blind_shift_close: true, confirm_shows_cashier_figures: true }),   // 0.6.29: standard ones last, always on
  JSON.stringify(C.getPosFeatures()));
C.setPosFeatures(undefined);
ok('an older cloud (nothing said) keeps what the till has', C.getPosFeatures().cashier_no_reprint === true);
C.saveDeviceConfig({ device_name: 'Front 2', pos_features: '{"delivery_fee":true}' });
ok('config:save can never switch one on (only the pull writes them)', C.getPosFeatures().delivery_fee === false);
ok('a peer takes the node\'s switches (bundle unpacked)',
  R.unpackNodeBundle({ posInit: { posFeatures: { delivery_fee: true } } }).config.posFeatures.delivery_fee === true
  && R.unpackNodeBundle({ posInit: {} }).config.posFeatures === undefined);
features(true);

// ── 2+3+4: a delivery with a fee, paid by M-Pesa; the rider is paid from the drawer ──
signIn('u-amy', 'Amy', 'cashier');
S.openShift(1000);
const shiftId = S.currentShiftReport().shift.id;
const sale = (n, over) => E.createLocalOrder({
  branch_id: 'br-1', order_number: n, order_type: 'takeaway', subtotal: 1000, vat_amount: 0, total: 1000,
  items: [{ product: { id: 'p-chk', name: 'Chicken' }, unitPrice: 1000, quantity: 1, lineTotal: 1000 }],
  payments: [{ method: 'cash', amount: 1000 }], ...over,
});
const d1 = sale('T1-1', { order_type: 'delivery', delivery_person: 'Eugene', delivery_fee: 300, payments: [{ method: 'mpesa', amount: 1300 }] });
const z1 = S.currentShiftReport();
ok('the fee is stored on the sale; the bill (total, sales) is unchanged',
  db.prepare(`SELECT total, delivery_fee FROM orders WHERE id=?`).get(d1).delivery_fee === 300 && z1.totals.grossSales === 1000);
const payout = db.prepare(`SELECT type, amount, reason, order_id FROM float_transactions WHERE order_id=?`).get(d1);
ok('the rider is paid the fee in cash from the drawer — a pay-out tied to the sale',
  payout?.type === 'float_out' && payout.amount === 300 && payout.reason === 'Delivery fee — Eugene (#T1-1)', JSON.stringify(payout));
ok('…expected cash is the fee lower (1000 − 300 = 700)', z1.totals.expectedCash === 700, String(z1.totals.expectedCash));
ok('…M-Pesa carries it (1300 = 300 more than the sale)', S.expectedMethods(shiftId).mpesa === 1300, JSON.stringify(S.expectedMethods(shiftId)));
ok('…and the Z-report says why: delivery fees 300 in the payments, 300 paid to riders',
  z1.totals.deliveryFees === 300 && z1.totals.riderPayouts === 300 && z1.totals.riderReturned === 0);
const queued = JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id=?`).get(d1).payload);
ok('the cloud gets the fee with the sale (its legs = bill + fee)', queued.delivery_fee === 300);
const d2 = sale('T1-2', { order_type: 'takeaway', delivery_fee: 500 });
ok('a fee is only ever on a delivery (a takeaway\'s is dropped, no pay-out)',
  db.prepare(`SELECT delivery_fee FROM orders WHERE id=?`).get(d2).delivery_fee === 0
  && !db.prepare(`SELECT 1 FROM float_transactions WHERE order_id=?`).get(d2)
  && JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id=?`).get(d2).payload).delivery_fee === undefined);
// A cash delivery (1100 = bill + 100 fee), then voided: 700 + 1000 (takeaway) + 1100 − 100 = 2700 → back to 1700.
const d5 = sale('T1-5', { order_type: 'delivery', delivery_person: 'Joy', delivery_fee: 100, payments: [{ method: 'cash', amount: 1100 }] });
ok('a cash delivery: the fee comes in and goes straight out to the rider (2700)', S.currentShiftReport().totals.expectedCash === 2700,
  String(S.currentShiftReport().totals.expectedCash));
db.prepare(`UPDATE orders SET status='voided' WHERE id=?`).run(d5);
ok('a voided delivery puts the rider\'s pay-out back (a pay-in): 1700, as if never sold',
  W.reverseRiderPayout(d5, db) === 100 && S.currentShiftReport().totals.expectedCash === 1700, String(S.currentShiftReport().totals.expectedCash));
ok('…a second void changes nothing', W.reverseRiderPayout(d5, db) === 0
  && db.prepare(`SELECT COUNT(*) n FROM float_transactions WHERE order_id=?`).get(d5).n === 2);
ok('…the riders\' line nets it out (300 paid, 100 back)', S.currentShiftReport().totals.riderPayouts === 400 && S.currentShiftReport().totals.riderReturned === 100);

// ── 4 + 6 + 7: History ───────────────────────────────────────────────────────
signIn('u-ben', 'Ben', 'cashier');
sale('T1-3', { order_type: 'delivery', delivery_person: 'Eugene', delivery_fee: 100, payments: [{ method: 'cash', amount: 1100 }] });
signIn('u-amy', 'Amy', 'cashier');
const scope = S.historyScope();
ok('a cashier sees only their own sales, and no Reprint (switches on)', scope.ownOnly && !scope.canReprint && scope.staffId === 'u-amy');
const mine = M.getRecentOrders(30, undefined, scope.staffId);
ok('…the list is Amy\'s three sales, not Ben\'s', mine.length === 3 && mine.every((o) => o.cashier_id === 'u-amy'), JSON.stringify(mine.map((o) => o.cashier_id)));
ok('…with the rider on each delivery (History shows "Delivery — Eugene")', mine.some((o) => o.delivery_person === 'Eugene' && o.delivery_fee === 300));
signIn('u-mgr', 'Mary', 'manager');
ok('a manager sees every sale and may reprint', !S.historyScope().ownOnly && S.historyScope().canReprint && M.getRecentOrders(30).length === 4);
features(false);
signIn('u-amy', 'Amy', 'cashier');
ok('switches off: a cashier sees all and may reprint, as before', !S.historyScope().ownOnly && S.historyScope().canReprint);
features(true);

// ── 5 + 9: expenses ──────────────────────────────────────────────────────────
const exp = (id, amount, method, type, desc) => db.prepare(`INSERT INTO expenses (id, business_id, branch_id, description, amount, expense_date, shift_id, created_at, device_id, payment_method, expense_type_name, expense_category_id)
  VALUES (?, 'biz-1', 'br-1', ?, ?, '2026-09-30', ?, ?, 'dev-T1', ?, ?, ?)`).run(id, desc, amount, shiftId, `2026-09-30T10:0${id.length}:00Z`, method, type, type ? 'cat-1' : null);
const before = S.currentShiftReport().totals.expectedCash;
exp('e-1', 200, 'cash', 'Transport', 'boda to market');
exp('e-22', 1200, 'mpesa', 'Supplier', 'chicken');
const z2 = S.currentShiftReport();
ok('a cash expense comes out of the drawer (−200)', z2.totals.expectedCash === before - 200 && z2.totals.expenses === 200, `${before} → ${z2.totals.expectedCash}`);
ok('an M-Pesa expense is not out of the drawer; it is listed by method', JSON.stringify(z2.totals.expensesByMethod) === '{"mpesa":1200}');
ok('…it comes off M-Pesa\'s expected (1300 → 100)', S.expectedMethods(shiftId).mpesa === 100, JSON.stringify(S.expectedMethods(shiftId)));
ok('the Z-report shows the expense TYPE first, then what it was for, then the method when not cash',
  JSON.stringify(z2.expenseLines.map((e) => e.label)) === JSON.stringify(['Transport — boda to market', 'Supplier — chicken · M-Pesa']),
  JSON.stringify(z2.expenseLines.map((e) => e.label)));

// ── 1: a blind close ─────────────────────────────────────────────────────────
ok('a cashier closes blind (switch on); a manager does not', (signIn('u-amy', 'Amy', 'cashier'), S.blindClose())
  && (signIn('u-mgr', 'Mary', 'manager'), !S.blindClose()));
signIn('u-amy', 'Amy', 'cashier');
const br = S.blindReport(S.currentShiftReport());
ok('the blind report carries no figures — sales, per method, expected — only which methods to count',
  br.blind && br.totals.grossSales === 0 && br.totals.expectedCash === 0 && br.byMethod.every((m) => m.amount === 0)
  && JSON.stringify(br.declareMethods) === '["mpesa"]', JSON.stringify(br.declareMethods));
const closed = threw(() => S.closeShift(1234, undefined, null, { mpesa: 100 }));
ok('a blind close needs no variance note (the cashier cannot see one)', closed === null, closed?.message);

// ── 8: the manager sees the cashier's figures and gives reasons ──────────────
signIn('u-mgr', 'Mary', 'manager');
const view = S.confirmView(shiftId);
ok('the confirm screen may show the cashier\'s figures (switch on)', view.showCashier && view.declared.cash === 1234 && view.declared.mpesa === 100);
const noReason = threw(() => S.confirmShift(shiftId, { id: 'u-mgr', name: 'Mary' }, { cash: 1200, mpesa: 100 }));
ok('a differing count needs a reason', /Give a reason where your count differs from the cashier's: cash/.test(noReason?.message ?? ''), noReason?.message);
const c = S.confirmShift(shiftId, { id: 'u-mgr', name: 'Mary' }, { cash: 1200, mpesa: 100 }, { cash: '  34 was a float for change ', mpesa: 'ignored — no difference' });
ok('…with it, confirmed; only the differing method keeps a reason (cleaned)',
  c.lines.find((l) => l.method === 'cash')?.reason === '34 was a float for change' && !c.lines.find((l) => l.method === 'mpesa')?.reason,
  JSON.stringify(c.lines));
ok('…stored for the cloud and the report', JSON.parse(db.prepare(`SELECT confirm_reasons FROM shifts WHERE id=?`).get(shiftId).confirm_reasons).cash === '34 was a float for change'
  && S.shiftConfirmation(db.prepare(`SELECT * FROM shifts WHERE id=?`).get(shiftId)).lines.find((l) => l.method === 'cash').reason === '34 was a float for change');
features(false);
// 0.6.29: standard — no switch turns it off; a stored row for the old key is ignored.
ok('the confirm screen always shows the cashier\'s figures (standard since 0.6.29)', S.confirmView(shiftId).showCashier === true && S.confirmView(shiftId).declared !== null);
C.setPosFeatures({ blind_shift_close: false, confirm_shows_cashier_figures: false });
signIn('u-amy', 'Amy', 'cashier');
ok('…and a cashier always closes blind, whatever a stored row says', S.blindClose() && S.confirmView(shiftId).showCashier === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
