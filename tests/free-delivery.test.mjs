/**
 * free-delivery.test.mjs — 0.6.33 (A379): the owner may allow free delivery — the cashier may leave the fee empty.
 *
 * Owner, 2026-10-02: "in adition to the delivery with delivery fee can we add an option of free delivery where its not a
 * must for the cashier to key in delivery fee? but that can be turned on and of by the hotel owner". The shared rules run
 * for real; source assertions on the till (Electron + React), the web POS and the owner's settings screens.
 *
 * MUTATIONS TO CONFIRM BITE: deliveryProblem ignoring freeAllowed → "with the owner's rule an empty fee is fine" fails;
 * freeAllowed accepting any text → "a typed fee must still be real" fails; the rule written by a manager (not in
 * REVERSAL_SETTING_KEYS) → "owner only" fails; the till's Charge or the web's openPayment without the rule → their pins
 * fail; the till's save handler dropping the field → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const D = await import(pathToFileURL(path.join(ROOT, 'shared/delivery.ts')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'shared/reversalRules.ts')).href);

// ── The delivery rule ─────────────────────────────────────────────────────────
await ok('without the owner\'s rule a delivery still needs its fee (unchanged)', () => {
  assert.match(D.deliveryProblem(true, 'delivery', 'Eugene', ''), /Enter the delivery fee/);
  assert.match(D.deliveryProblem(true, 'delivery', 'Eugene', '0'), /Enter the delivery fee/);
  assert.strictEqual(D.deliveryProblem(true, 'delivery', 'Eugene', '300'), null);
});
await ok('with the owner\'s rule an empty fee (or 0) is a free delivery', () => {
  for (const fee of ['', '  ', '0', '0.00', 0, null, undefined]) {
    assert.strictEqual(D.deliveryProblem(true, 'delivery', 'Eugene', fee, true), null, String(fee));
  }
  assert.strictEqual(D.deliveryProblem(true, 'delivery', 'Eugene', '300', true), null);
});
await ok('…but a typed fee must still be real, and the rider is still needed', () => {
  assert.match(D.deliveryProblem(true, 'delivery', 'Eugene', 'abc', true), /valid delivery fee, or leave it empty/);
  assert.match(D.deliveryProblem(true, 'delivery', 'Eugene', '-50', true), /valid delivery fee/);
  assert.match(D.deliveryProblem(true, 'delivery', '', '', true), /rider/);
});
await ok('only for a delivery, and only with the client\'s delivery-fee switch', () => {
  assert.strictEqual(D.deliveryProblem(false, 'delivery', '', '', false), null);
  assert.strictEqual(D.deliveryProblem(true, 'takeaway', '', '', false), null);
});
await ok('the fee box says when it may be left empty', () => {
  assert.strictEqual(D.deliveryFeePlaceholder(false), 'Delivery fee');
  assert.strictEqual(D.deliveryFeePlaceholder(true), 'Delivery fee (empty = free)');
});

// ── The owner's rule ──────────────────────────────────────────────────────────
await ok('off by default; stored, read back and carried to the till', () => {
  assert.strictEqual(R.defaultReversalRules().freeDeliveryAllowed, false);
  assert.strictEqual(R.parseReversalRules([]).freeDeliveryAllowed, false);
  const v = R.reversalSettingValue('delivery_free_allowed', true);
  assert.strictEqual(v, 'true');
  const rules = R.parseReversalRules([{ key: 'delivery_free_allowed', value: v }]);
  assert.strictEqual(rules.freeDeliveryAllowed, true);
  assert.strictEqual(R.rulesFromWire(rules).freeDeliveryAllowed, true);
  assert.strictEqual(R.rulesFromWire({ voidWindowMinutes: 30 }).freeDeliveryAllowed, false, 'an older cloud says nothing → fee required');
  assert.strictEqual(R.reversalSettingValue('delivery_free_allowed', 'maybe'), null);
});
await ok('owner only: one of the owner\'s rule keys (the cloud refuses anyone else) and readable in settings', () => {
  assert.ok(R.isReversalSettingKey('delivery_free_allowed'));
  assert.match(read('apps/server/src/routes/business.ts'), /'offline_reverse_web_sales', 'delivery_free_allowed',/);
  assert.match(read('apps/server/src/routes/business.ts'), /if \(isReversalSettingKey\(key\)\) \{\s*if \(!req\.isOwner\) \{/);
  assert.match(read('apps/server/src/routes/pos.ts'), /\.\.\.REVERSAL_SETTING_KEYS\]\),/);
});

// ── The wiring (source) ───────────────────────────────────────────────────────
await ok('till: Charge checks the rule; the fee box shows it; the rule is read when a delivery is chosen', () => {
  const p = read('apps/desktop/src/renderer/pages/POSPage.tsx');
  assert.match(p, /deliveryProblem\(posFeatures\.delivery_fee, orderType, deliveryPerson, deliveryFee, freeDelivery\);/);
  assert.match(p, /placeholder=\{deliveryFeePlaceholder\(freeDelivery\)\}/);
  assert.match(p, /if \(orderType !== 'delivery'\) return;\s*posApi\.pos\.reversalRules\(\)\.then\(\(r\) => setFreeDelivery\(r\.freeDeliveryAllowed === true\)\)/);
});
await ok('till: the owner switches it in Manager → Settings, and the till keeps the new value at once', () => {
  assert.match(read('apps/desktop/src/renderer/components/ReversalRulesPanel.tsx'),
    /save\('delivery_free_allowed', !free, \{ \.\.\.rules, freeDeliveryAllowed: !free \}\)/);
  assert.match(read('apps/desktop/src/main/ipcHandlers.ts'),
    /freeDeliveryAllowed: key === 'delivery_free_allowed' \? JSON\.parse\(clean\) : now\.freeDeliveryAllowed,/);
});
await ok('web POS: pos/init carries the rule; Pay checks it; the fee box shows it', () => {
  assert.match(read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts'),
    /setFreeDeliveryAllowed\(rulesFromWire\(init\.reversalRules \?\? null\)\.freeDeliveryAllowed\);/);
  const c = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(c, /deliveryProblem\(posFeatures\.delivery_fee, getOrderType\(\), activeRider, activeFeeText, freeDeliveryAllowed\);/);
  assert.match(c, /placeholder=\{deliveryFeePlaceholder\(freeDeliveryAllowed\)\}/);
});
await ok('web: Settings › Business › Voids, refunds & delivery has the owner\'s switch', () => {
  assert.match(read('apps/dashboard/src/pages/settings/VoidRefundRulesTab.tsx'),
    /save\('delivery_free_allowed', !free, \{ \.\.\.rules, freeDeliveryAllowed: !free \}\)/);
});
await ok('a free delivery pays the rider nothing (no pay-out at 0) — unchanged paths', () => {
  assert.match(read('apps/server/src/lib/riderPayout.ts'), /if \(fee <= 0 \|\| !o\.shiftId \|\| !o\.cashierId\) return false;/);
  assert.match(read('apps/desktop/src/main/syncEngine.ts'), /if \(deliveryFee > 0\) orderPayload\.delivery_fee = deliveryFee; else delete orderPayload\.delivery_fee;/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
