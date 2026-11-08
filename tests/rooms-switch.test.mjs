// Rooms — owner, 2026-11-04 ("3 yes"): "Charge to room" only for a business with rooms.
//
//   node --no-warnings tests/rooms-switch.test.mjs
//
// The web POS offered 🏨 Room (post a bill to a guest's room) to every restaurant, and the Room charge payment to any
// branch that switched it on. Now both follow one owner switch, 'rooms' (Settings › Business › POS options — a feature_flags
// row like every POS option, so no migration: the cloud reads it with the others and the desktop POS receives it with
// pos/init's posFeatures). On the desktop POS Room charge also needs the online licence; main refuses a sale charged to
// a room without both, whatever the screen sent.
//
//   C  the rules (packages/core): the switch is a POS option, off unless set; withRoomCharge; roomChargeRefusal.
//   O  the owner sets it: the cloud's OWNER_POS_KEYS, the web's POS options list, the admin portal shows it read-only.
//   W  the web POS: the Room button and its modal only with the switch; the payment buttons without Room charge when off.
//   D  the desktop POS: Room charge only with the switch and the online licence; main refuses a room leg otherwise.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - withRoomCharge returning the buttons as they are                  → C "without rooms", W, D "the payment screen"
//   - roomChargeRefusal returning null                                  → C "a room leg is refused"
//   - CashierScreen's Room button without posFeatures.rooms             → W "the Room button"
//   - POSPage passing rooms={posFeatures.rooms} (no licence)            → D "with the online licence"
//   - sale.ts without the roomChargeRefusal check                       → D "main refuses"
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const C = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/paymentCatalogue.ts')).href);
const F = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/posFeatures.ts')).href);
const O = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/ownerSettings.ts')).href);

console.log('\nC. the rules\n');
ok('the switch is a POS option named Rooms, off unless set', () => {
  const f = F.POS_FEATURES.find((x) => x.key === 'rooms');
  assert.ok(f, 'rooms is a POS option');
  assert.equal(f.label, 'Rooms');
  assert.equal(F.noPosFeatures().rooms, false);
  assert.equal(F.parsePosFeatures([{ key: 'rooms', enabled: true }]).rooms, true);
  assert.equal(F.parsePosFeatures({ rooms: 'yes' }).rooms, false, 'only a real true');
});
ok('without rooms the buttons leave Room charge out; with rooms they keep it; nothing else changes', () => {
  const b = C.paymentButtons(['cash', 'mpesa', 'room_charge', 'card'], [], 'till');
  assert.deepEqual(C.withRoomCharge(b, false).map((x) => x.code), ['cash', 'mpesa', 'card']);
  assert.deepEqual(C.withRoomCharge(b, true).map((x) => x.code), b.map((x) => x.code));
  assert.equal(C.ROOM_CHARGE_METHOD, 'room_charge');
});
ok('a room leg is refused without rooms (any case); other legs and a room leg with rooms are fine', () => {
  assert.match(C.roomChargeRefusal([{ method: 'cash', amount: 100 }, { method: 'ROOM_CHARGE', amount: 50 }], false) ?? '', /room/);
  assert.equal(C.roomChargeRefusal([{ method: 'room_charge', amount: 50 }], true), null);
  assert.equal(C.roomChargeRefusal([{ method: 'cash', amount: 100 }], false), null);
  assert.equal(C.roomChargeRefusal(null, false), null);
  assert.doesNotMatch(C.roomChargeRefusal([{ method: 'room_charge' }], false), /\btill\b/i, 'POS, never till');
});

console.log('\nO. the owner sets it\n');
ok('the cloud: an owner POS option (PUT /api/controls/pos/rooms, settings.pos); the admin portal cannot set it', () => {
  const ctl = read('apps/server/src/routes/controls.ts');
  assert.match(/export const OWNER_POS_KEYS = \[([^\]]*)\]/.exec(ctl)[1], /'rooms'/);
  assert.ok(O.OWNER_POS_OPTIONS.includes('rooms'));
  assert.equal(O.adminSwitches('rooms'), false);
});
ok('the web: listed on Settings › Business › POS options for every business type', () => {
  const oc = read('apps/dashboard/src/pages/settings/OwnerControls.tsx');
  assert.match(/export const POS_OPTION_KEYS = \[([^\]]*)\]/.exec(oc)[1], /'rooms'/);
  assert.doesNotMatch(/KITCHEN_POS_OPTION_KEYS: readonly PosOptionKey\[\] = \[([^\]]*)\]/.exec(oc)[1], /rooms/, 'not a kitchen-only option');
});

console.log('\nW. the web POS\n');
ok('the Room button and the Post to Room modal only with the switch', () => {
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(cs, /\{posFeatures\.rooms && \(\s+<button[^>]*\n\s+onClick=\{\(\) => \{ setRoomNumber\(''\);[^\n]*setShowRoomCharge\(true\); \}\}>\s+🏨 Room/);
  assert.match(cs, /\{showRoomCharge && isRestaurant && foodAreas\(businessMode\)\.roomCharge && posFeatures\.rooms && \(/);
});
ok('the payment screen: Room charge only with the switch', () => {
  assert.match(read('apps/dashboard/src/pages/pos/PaymentModal.tsx'),
    /const branchButtons = withRoomCharge\(paymentButtons\(enabledFromSetting\(enabledMethods\), customMethods, 'web'\), posFeatures\?\.rooms === true\);/);
});

console.log('\nD. the desktop POS\n');
ok('the payment screen: Room charge only when told rooms', () => {
  const pm = read('apps/desktop/src/renderer/components/PaymentModal.tsx');
  assert.match(pm, /startSplit = false, rooms = false \}: Props\)/);
  assert.match(pm, /withRoomCharge\(paymentButtons\(enabledFromSetting\(enabledMethods\), customMethods, 'till'\), rooms\)/);
});
ok('rooms = the switch AND the online licence', () => {
  assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /rooms=\{posFeatures\.rooms && onlineLicence\}/);
});
ok('main refuses a sale charged to a room without both, before anything is saved', () => {
  const s = read('apps/desktop/src/main/ipc/sale.ts');
  const h = s.slice(s.indexOf("handle('order:create'"));
  const check = h.indexOf("roomChargeRefusal(orderPayload?.payments, getPosFeatures().rooms && getDeviceConfig()?.web_pos_enabled === true)");
  assert.ok(check > 0, 'the check');
  assert.match(h, /if \(roomRefused\) \{[^}]*throw new Error\(roomRefused\); \}/);
  assert.ok(check < h.indexOf('createLocalOrder(orderPayload)'), 'before the order is saved');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
