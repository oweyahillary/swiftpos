// kitchen-voids.test.mjs — 0.6.28: once sent to the kitchen, every item ends PAID or as a recorded KITCHEN VOID.
//
// Owner, 2026-10-01: "when a cashier clicks send to kitchen thats an order already … they can click send to kitchen
// then cancel … the customer pays they pocket the money and the kitchen staff proceed to prepare the meal". Decided:
// a void needs a reason (and, with 'kitchen_void_approval', a manager — no grace period), prints a VOID ticket and is on
// the Z-report; End Shift is refused while a sent order is unpaid; 'pay_before_kitchen' keeps takeaway/delivery/counter
// orders off the kitchen until paid. Also: a line of 2 that became 3 went out as 3 more (the kitchen cooked 5).
//
// Runs the BUILT main process (dist/main) against a real SQLite file, with a stand-in cloud for the push.
//
// MUTATIONS TO CONFIRM BITE:
//   - sentQtyOf ignores sentQty (kotSent only)                                   → "a line of 2 that became 3 sends 1" fails
//   - voidQtyFor counts unsent items                                              → "reducing below the sent count…" fails
//   - recordKitchenSend overwrites sent_qty instead of adding                     → "a second send adds to the first" fails
//   - markKitchenPaid not called from order:create (source pin)                   → "the sale marks its sent lines paid" fails
//   - recordKitchenVoid accepts any reason                                        → "an unknown reason is refused" fails
//   - kitchenCloseBlock ignores the switch                                        → "switch off: the shift may end" fails
//   - openKitchenOrders counts voided items                                       → "a partly voided order shows what is left" fails
//   - the push marks kitchen voids synced without the cloud's count               → "an older cloud: kept pending" fails
//   - kitchen:void skips the approver when the switch is on (source pin)          → "with the switch a manager approves" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0628-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const S = require(path.join(dist, 'shiftService.js'));
const K = require(path.join(dist, 'kitchenService.js'));
const KL = require(path.join(dist, 'kitchenLines.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const threw = (f) => { try { f(); return null; } catch (e) { return e; } };

console.log('0.6.28 — kitchen voids\n');

// ── The rules (shared/kitchenLines.ts) ───────────────────────────────────────
ok('a line saved before 0.6.28 (kotSent, no sentQty) counts as all sent', KL.sentQtyOf({ quantity: 3, kotSent: true }) === 3);
ok('a line of 2 that became 3 sends 1 — not 3 (the kitchen cooked 5)',
  KL.unsentQtyOf({ quantity: 3, sentQty: 2, kotSent: false }) === 1);
ok('reducing below the sent count is a void of the difference; unsent items go freely',
  KL.voidQtyFor({ quantity: 3, sentQty: 2 }, 2) === 0 && KL.voidQtyFor({ quantity: 3, sentQty: 2 }, 1) === 1
  && KL.voidQtyFor({ quantity: 3, sentQty: 2 }, 0) === 2);
ok('pay before kitchen: dine-in still sends first; takeaway, delivery and counter wait for payment',
  KL.maySendBeforePay(true, 'dine_in') && !KL.maySendBeforePay(true, 'takeaway') && !KL.maySendBeforePay(true, 'delivery')
  && !KL.maySendBeforePay(true, 'retail') && KL.maySendBeforePay(false, 'takeaway'));
ok('only our reasons are kept', KL.cleanVoidReason('changed_mind') === 'changed_mind' && KL.cleanVoidReason('because') === null);
ok('the Z-report line names the item, reason, made, approver and cashier',
  KL.kitchenVoidText({ quantity: 2, product_name: 'Chicken', reason: 'wrong_item', cooked: 1, approved_by_name: 'Mary', cashier_name: 'Amy' })
  === '2x Chicken — Wrong item punched; made; approved Mary, cashier Amy');

// ── The till: a sent order cannot disappear ──────────────────────────────────
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B', '2026-10-01T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, 'u-amy', 'Amy', 'cashier', '{}', 'br-1', 'tok', '2026-10-01T06:00:00Z')`).run();
S.openShift(1000);
const shiftId = S.currentShiftReport().shift.id;
const line = (id, qty, price = 1000, name = 'Chicken') => ({ line_id: id, product_id: null, product_name: name, unit_price: price, qty,
  item: { product: { id: 'p-' + id, name }, quantity: qty, unitPrice: price, lineTotal: price * qty, selectedVariants: [], selectedModifiers: [] } });

K.recordKitchenSend('T1-100', [line('a', 2), line('b', 1, 300, 'Soda')], { order_type: 'takeaway' });
K.recordKitchenSend('T1-100', [line('a', 1)], { order_type: 'takeaway' });
const open1 = K.openKitchenOrders(shiftId);
ok('a second send adds to the first (2 + 1 chicken on tickets)',
  open1.length === 1 && open1[0].lines.find((l) => l.line_id === 'a')?.qty === 3, JSON.stringify(open1));
ok('the unpaid order is listed with its value (3 × 1000 + 300)', open1[0].value === 3300 && open1[0].held === false);

C.setPosFeatures({ kitchen_void_approval: false });
ok('switch off: the shift may end (the order is still listed, not blocking)', K.kitchenCloseBlock(shiftId) === null);
C.setPosFeatures({ kitchen_void_approval: true });
const block = K.kitchenCloseBlock(shiftId);
ok('switch on: End Shift is refused while a sent order is unpaid, naming it', /1 order was sent to the kitchen and not paid \(#T1-100\)/.test(block ?? ''), block);

ok('an unknown reason is refused', /Choose why/.test(threw(() => K.recordKitchenVoid({ order_number: 'T1-100', lines: [line('a', 1)], reason: 'oops' }, null))?.message ?? ''));
const v1 = K.recordKitchenVoid({ order_number: 'T1-100', lines: [line('a', 1)], reason: 'changed_mind', cooked: false, note: '  customer   left ' },
  { id: 'u-mgr', name: 'Mary' });
const row = db.prepare(`SELECT * FROM kitchen_voids WHERE id=?`).get(v1.ids[0]);
ok('the void is recorded: item, quantity, amount, reason, note, cashier and approver',
  row.product_name === 'Chicken' && row.quantity === 1 && row.amount === 1000 && row.reason === 'changed_mind' && row.note === 'customer left'
  && row.cooked === 0 && row.cashier_id === 'u-amy' && row.cashier_name === 'Amy' && row.approved_by === 'u-mgr' && row.approved_by_name === 'Mary'
  && row.shift_id === shiftId && row.sync_status === 'pending', JSON.stringify(row));
const open2 = K.openKitchenOrders(shiftId)[0];
ok('a partly voided order shows what is left (2 chicken + soda = 2300)',
  open2.lines.find((l) => l.line_id === 'a')?.qty === 2 && open2.value === 2300, JSON.stringify(open2));

K.recordKitchenVoid({ order_number: 'T1-100', lines: [line('a', 2), line('b', 1, 300, 'Soda')], reason: 'kitchen_mistake', cooked: true }, { id: 'u-mgr', name: 'Mary' });
ok('everything sent and voided: nothing left unpaid, the shift may end', K.openKitchenOrders(shiftId).length === 0 && K.kitchenCloseBlock(shiftId) === null);

// A held tab saved before 0.6.28 has no ledger row — its lines can still be voided (and are recorded).
K.recordKitchenVoid({ order_number: 'T1-OLD', lines: [line('z', 1, 500, 'Fish')], reason: 'wrong_item', cooked: false }, null);
ok('a line sent before 0.6.28 (no ledger row) is voided and recorded, nothing left open',
  db.prepare(`SELECT COUNT(*) AS n FROM kitchen_voids WHERE order_number='T1-OLD'`).get().n === 1
  && K.openKitchenOrders().every((o) => o.order_number !== 'T1-OLD'));

// Paid: the sale marks its sent lines paid.
K.recordKitchenSend('T1-101', [line('c', 1)], { order_type: 'dine_in', table_number: '4' });
ok('a sent dine-in order is open until paid', K.openKitchenOrders(shiftId).some((o) => o.order_number === 'T1-101' && o.table_number === '4'));
ok('the sale marks its sent lines paid', K.markKitchenPaid('T1-101') === 1 && K.openKitchenOrders(shiftId).length === 0);
ok('order:create calls it (source)', /const orderId = createLocalOrder\(orderPayload\);\s*markKitchenPaid\(orderPayload\?\.order_number\);/.test(src('main/ipcHandlers.ts')));

// ── The Z-report ─────────────────────────────────────────────────────────────
const z = S.computeZReport(shiftId);
ok('the Z-report lists the kitchen voids and their sums (1000 + 2000 + 300 + 500 = 3800; 2300 already made)',
  z.kitchenVoids.lines.length === 4 && z.kitchenVoids.summary.value === 3800 && z.kitchenVoids.summary.cookedValue === 2300
  && z.kitchenVoids.summary.quantity === 5, JSON.stringify(z.kitchenVoids.summary));
ok('…by reason, biggest first', z.kitchenVoids.summary.byReason[0].reason === 'kitchen_mistake' && z.kitchenVoids.summary.byReason[0].value === 2300);

// ── The push: only a cloud that takes them marks them synced ─────────────────
let cloudCounts = false;
const seen = [];
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  if (u.endsWith('/api/sync/push')) {
    seen.push(...(body.kitchen_voids ?? []));
    const upserted = { shifts: 0, floats: 0, expenses: 0, businessDays: 0, ...(cloudCounts ? { kitchenVoids: (body.kitchen_voids ?? []).length } : {}) };
    return json(200, { ok: true, upserted, rejected: [] });
  }
  return json(404, { error: 'not here' });
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');
await E.syncPush();
const pending = () => db.prepare(`SELECT COUNT(*) AS n FROM kitchen_voids WHERE sync_status='pending'`).get().n;
ok('the push carries the kitchen voids with what the cloud needs',
  seen.length === 4 && seen.every((k) => k.reason && k.product_name && k.quantity > 0 && 'approved_by_name' in k && !('sync_status' in k)), JSON.stringify(seen[0]));
ok('an older cloud (no kitchenVoids count): kept pending, never lost', pending() === 4, String(pending()));
cloudCounts = true;
await E.syncPush();
ok('a cloud that takes them: marked synced', pending() === 0, String(pending()));

// ── The wiring (source) ──────────────────────────────────────────────────────
const ipc = src('main/ipcHandlers.ts');
ok('with the switch a manager approves: signed in as themselves, or a manager\'s PIN',
  /if \(getPosFeatures\(\)\.kitchen_void_approval\) \{\s*const signedIn = signedInConfirmer\(\);\s*if \(!signedIn && !String\(p\.pin \?\? ''\)\.trim\(\)\) throw new Error\(/.test(ipc)
  && /approver = signedIn && !String\(p\.pin \?\? ''\)\.trim\(\) \? signedIn : await identifyConfirmer\(String\(p\.pin\)\);/.test(ipc));
ok('the kitchen gets a VOID ticket (kitchen and dispatch)', /kitchen_void: \{ by: approver\?\.name \?\? '', reason: voidReasonLabel\(v\.reason\) \},\s*\}, \['kitchen', 'dispatch'\]\);/.test(ipc));
ok('End Shift checks the unpaid kitchen orders first', /const kitchenBlock = openShiftId \? kitchenCloseBlock\(openShiftId\) : null;\s*if \(kitchenBlock\) throw new Error\(kitchenBlock\);/.test(ipc));
ok('a held tab with sent items is not deleted', /if \(ledgerOpen \|\| anySent\(Array\.isArray\(cart\) \? cart : \[\]\)\) \{\s*throw new Error\(/.test(ipc));
const pos = src('renderer/pages/POSPage.tsx');
ok('Clear with sent items asks for a kitchen void (Hold keeps it instead)',
  /const sent = cart\.filter\(\(i\) => sentQtyOf\(i\) > 0\);\s*if \(!sent\.length \|\| !orderNumber\) \{ resetOrder\(\); return; \}\s*setKitchenVoid\(\{ title: 'Clear the order'/.test(pos));
ok('removing or reducing a sent line asks for a kitchen void',
  /const back = voidQtyFor\(item, newQty\);\s*if \(back > 0\) \{\s*setKitchenVoid\(/.test(pos) && /const sent = sentQtyOf\(item\);\s*if \(sent > 0\) \{\s*setKitchenVoid\(/.test(pos));
ok('Send prints only what the kitchen has not had (quantity − sentQty)',
  /const unsent = withIds\.filter\(i => unsentQtyOf\(i\) > 0\)\.map\(i => \(\{ item: i, qty: unsentQtyOf\(i\) \}\)\);/.test(pos) && /quantity: qty,\n/.test(pos));
ok('pay before kitchen hides Send (not dine-in); the charge sends what is left of a partly sent order',
  /const maySend = maySendBeforePay\(posFeatures\.pay_before_kitchen, flags\.isRestaurant \? orderType : 'retail'\);/.test(pos)
  && /\{maySend && <button/.test(pos) && /if \(someSent && cart\.some\(i => unsentQtyOf\(i\) > 0\)\) await handleSendToKitchen\(true\);/.test(pos)
  && /kot_sent: someSent,/.test(pos));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
