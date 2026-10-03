/**
 * free-delivery.test.mjs — 0.6.33 (A379): FREE DELIVERY — the shop pays the rider, the customer pays no fee.
 *
 * Owner, 2026-10-02: "can we add an option of free delivery … that can be turned on and of by the hotel owner" — then:
 * "though this free delivery the rider is still paid by the shop so delivery fee is a must but the customer does not pay
 * it". The shared rules run for real; source assertions on the cloud (Express + Supabase), the till (Electron + React),
 * the web POS and the owner's settings. The money paths are run for real in scripts/test-migration-115.mjs (Postgres),
 * apps/desktop/test/free-delivery.test.mjs (the till on SQLite) and shared/printing's delivery test (the receipt).
 *
 * MUTATIONS TO CONFIRM BITE: deliveryProblem letting a delivery go without a fee → "the fee is still a must" fails;
 * customerDeliveryFee charging a free delivery → "the customer pays none of it" fails; the rule written by a manager (not
 * in REVERSAL_SETTING_KEYS) → "owner only" fails; the cloud's /pay keeping the fee in the amount due → its pin fails; the
 * till or the web POS sending the customer's 0 as the fee (the rider unpaid) → their pins fail; autoFreeDelivery ignoring
 * the amount → "a bill reaching the owner's amount" fails; riderSummary counting a free one as customer-paid → "riders"
 * fails.
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
await ok('the fee is still a must on every delivery (the rider is paid it, free or not)', () => {
  assert.match(D.deliveryProblem(true, 'delivery', 'Eugene', ''), /Enter the delivery fee/);
  assert.match(D.deliveryProblem(true, 'delivery', 'Eugene', '0'), /Enter the delivery fee/);
  assert.strictEqual(D.deliveryProblem(true, 'delivery', 'Eugene', '300'), null);
  assert.match(D.deliveryProblem(true, 'delivery', '', '300'), /rider/);
});
await ok('the customer pays none of it on a free delivery; all of it otherwise', () => {
  assert.strictEqual(D.customerDeliveryFee(300, true), 0);
  assert.strictEqual(D.customerDeliveryFee('300', 1), 0);
  assert.strictEqual(D.customerDeliveryFee(300, false), 300);
  assert.strictEqual(D.customerDeliveryFee(300, undefined), 300);
  assert.strictEqual(D.amountDue(1000, 0, D.customerDeliveryFee(300, true)), 1000);
  assert.strictEqual(D.amountDue(1000, 0, D.customerDeliveryFee(300, false)), 1300);
});
await ok('only a delivery with a fee can be free', () => {
  assert.strictEqual(D.isFreeDelivery('delivery', 300, true), true);
  assert.strictEqual(D.isFreeDelivery('delivery', 0, true), false);
  assert.strictEqual(D.isFreeDelivery('takeaway', 300, true), false);
  assert.strictEqual(D.isFreeDelivery('delivery', 300, false), false);
});

// ── Free delivery above an amount (0.6.33, the owner's 'delivery_free_over') ───
await ok('a bill reaching the owner\'s amount delivers free; below it, or with none set, it does not', () => {
  assert.strictEqual(D.autoFreeDelivery(2000, 2000), true);
  assert.strictEqual(D.autoFreeDelivery(3500, 2000), true);
  assert.strictEqual(D.autoFreeDelivery(1999.99, 2000), false);
  assert.strictEqual(D.autoFreeDelivery(5000, null), false);
  assert.strictEqual(D.autoFreeDelivery(5000, 0), false);
});
await ok('the amount is stored, read back and carried to the till; empty = off; junk refused', () => {
  assert.strictEqual(R.reversalSettingValue('delivery_free_over', '2000'), '2000');
  assert.strictEqual(R.reversalSettingValue('delivery_free_over', ''), '0');
  assert.strictEqual(R.reversalSettingValue('delivery_free_over', 'abc'), null);
  assert.strictEqual(R.reversalSettingValue('delivery_free_over', -5), null);
  assert.strictEqual(R.parseReversalRules([{ key: 'delivery_free_over', value: '2000' }]).freeDeliveryOver, 2000);
  assert.strictEqual(R.parseReversalRules([{ key: 'delivery_free_over', value: '0' }]).freeDeliveryOver, null);
  assert.strictEqual(R.rulesFromWire({ freeDeliveryOver: 1500 }).freeDeliveryOver, 1500);
  assert.ok(R.isReversalSettingKey('delivery_free_over'));
});
await ok('till and web POS: free automatically from the amount (the tick shown, ticked and locked)', () => {
  const p = read('apps/desktop/src/renderer/pages/POSPage.tsx');
  assert.match(p, /const autoFree = riderFee > 0 && autoFreeDelivery\(cartSubtotal\(cart\), freeDeliveryOver\);/);
  assert.match(p, /const freeNow = riderFee > 0 && \(\(freeDeliveryAllowed && deliveryIsFree\) \|\| autoFree\);/);
  assert.match(p, /checked=\{deliveryIsFree \|\| autoFree\} disabled=\{autoFree\}/);
  const c = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(c, /const activeAutoFree = activeRiderFee > 0 && autoFreeDelivery\(orderTotal, freeDeliveryOver\);/);
  assert.match(c, /\|\| activeAutoFree\);/);
  assert.match(read('apps/desktop/src/main/ipcHandlers.ts'), /freeDeliveryOver: key === 'delivery_free_over' \? \(JSON\.parse\(clean\) \|\| null\) : now\.freeDeliveryOver,/);
  assert.match(read('apps/dashboard/src/pages/settings/VoidRefundRulesTab.tsx'), /void save\('delivery_free_over', n, \{ \.\.\.rules, freeDeliveryOver: n \|\| null \}\);/);
  assert.match(read('apps/desktop/src/renderer/components/ReversalRulesPanel.tsx'), /void save\('delivery_free_over', n, \{ \.\.\.rules, freeDeliveryOver: n \|\| null \}\);/);
});

// ── The riders summary (0.6.33) ──────────────────────────────────────────────
await ok('riders: one line each (name as typed, case-insensitive), deliveries, fees customers paid, free ones apart', () => {
  const r = D.riderSummary([
    { delivery_person: 'Eugene', delivery_fee: 300 }, { delivery_person: 'eugene ', delivery_fee: 300, delivery_free: true },
    { delivery_person: 'Joy', delivery_fee: 200 }, { delivery_person: null, delivery_fee: 0 },
  ]);
  assert.deepStrictEqual(r, [
    { rider: 'Eugene', deliveries: 2, feesPaid: 300, freeCount: 1, freeFees: 300 },
    { rider: 'Joy', deliveries: 1, feesPaid: 200, freeCount: 0, freeFees: 0 },
    { rider: 'No rider', deliveries: 1, feesPaid: 0, freeCount: 0, freeFees: 0 },
  ]);
});
await ok('the till\'s Z-report carries the riders (not voided; hidden on a blind close) and prints them', () => {
  const sv = read('apps/desktop/src/main/shiftService.ts');
  assert.match(sv, /WHERE shift_id=\? AND status != 'voided' AND order_type = 'delivery'/);
  assert.match(sv, /riders: z\.totals\.riders \? \[\] : z\.totals\.riders,/);
  assert.match(read('apps/desktop/src/renderer/components/ZReportView.tsx'), /data-testid="z-riders"/);
  assert.match(read('apps/desktop/src/renderer/lib/printShiftReport.ts'), /riders: \(totals\.riders \?\? \[\]\)\.map/);
});

// ── The owner's rule ──────────────────────────────────────────────────────────
await ok('off by default; stored, read back and carried to the till', () => {
  assert.strictEqual(R.defaultReversalRules().freeDeliveryAllowed, false);
  const v = R.reversalSettingValue('delivery_free_allowed', true);
  assert.strictEqual(v, 'true');
  const rules = R.parseReversalRules([{ key: 'delivery_free_allowed', value: v }]);
  assert.strictEqual(rules.freeDeliveryAllowed, true);
  assert.strictEqual(R.rulesFromWire(rules).freeDeliveryAllowed, true);
  assert.strictEqual(R.rulesFromWire({ voidWindowMinutes: 30 }).freeDeliveryAllowed, false, 'an older cloud says nothing → not offered');
  assert.strictEqual(R.reversalSettingValue('delivery_free_allowed', 'maybe'), null);
});
await ok('owner only: one of the owner\'s rule keys (the cloud refuses anyone else) and readable in settings', () => {
  assert.ok(R.isReversalSettingKey('delivery_free_allowed'));
  assert.match(read('apps/server/src/routes/business.ts'), /'offline_reverse_web_sales', 'delivery_free_allowed',/);
  assert.match(read('apps/server/src/routes/business.ts'), /if \(isReversalSettingKey\(key\)\) \{\s*if \(!req\.isOwner\) \{/);
  assert.match(read('apps/server/src/routes/pos.ts'), /\.\.\.REVERSAL_SETTING_KEYS\]\),/);
});

// ── The cloud ─────────────────────────────────────────────────────────────────
await ok('cloud: a sale records the rider\'s fee with delivery_free; /pay leaves a free fee out of the amount due', () => {
  const o = read('apps/server/src/routes/orders.ts');
  assert.match(o, /const deliveryFree = isFreeDelivery\(order_type, deliveryFee, deliveryFreeRaw\);/);
  assert.match(o, /delivery_free: deliveryFree, \/\/ 0\.6\.33/);
  assert.match(o, /const amountDue = round2\(payTotal \+ payTip \+ customerDeliveryFee\(payFee, payFree\)\);/);
  assert.match(o, /delivery_free:   payFree,  \/\/ 0\.6\.33/);
  // the rider is paid on a web sale whatever the customer paid (fee > 0, free or not)
  assert.match(o, /if \(deliveryFee > 0 && req\.surface !== 'desktop'\) \{\s*await payRider\(/);
});
await ok('migration 115 and the schema index carry orders.delivery_free; the till must be on schema 63', () => {
  assert.match(read('migrations/115_free_delivery.sql'), /v_due   := v_total \+ v_tip \+ CASE WHEN v_free THEN 0 ELSE v_fee END;/);
  assert.strictEqual(JSON.parse(read('scripts/schema-index.json')).orders.delivery_free, '"boolean" NOT NULL');
  assert.ok(Number(/export const REQUIRED_DESKTOP_SCHEMA = (\d+);/.exec(read('apps/server/src/lib/desktopSchema.ts'))[1]) >= 63);
});

// ── The till and the web POS (source) ─────────────────────────────────────────
await ok('till: the tick is offered with the owner\'s rule; the customer pays the bill alone; the rider\'s fee is sent', () => {
  const p = read('apps/desktop/src/renderer/pages/POSPage.tsx');
  assert.match(p, /const freeNow = riderFee > 0 && \(\(freeDeliveryAllowed && deliveryIsFree\) \|\| autoFree\);\s*const feeDue = freeNow \? 0 : riderFee;/);
  assert.match(p, /\.\.\.\(riderFee > 0 \? \{ delivery_fee: riderFee, \.\.\.\(freeNow \? \{ delivery_free: true \} : \{\}\) \} : \{\}\),/);
  assert.match(p, /orderType === 'delivery' && posFeatures\.delivery_fee && \(freeDeliveryAllowed \|\| autoFree\) && \(/);
  assert.match(p, /deliveryProblem\(posFeatures\.delivery_fee, orderType, deliveryPerson, deliveryFee\);/);
});
await ok('till: the owner switches it in Manager → Settings, and the till keeps the new value at once', () => {
  assert.match(read('apps/desktop/src/renderer/components/ReversalRulesPanel.tsx'),
    /save\('delivery_free_allowed', !free, \{ \.\.\.rules, freeDeliveryAllowed: !free \}\)/);
  assert.match(read('apps/desktop/src/main/ipcHandlers.ts'),
    /freeDeliveryAllowed: key === 'delivery_free_allowed' \? JSON\.parse\(clean\) : now\.freeDeliveryAllowed,/);
});
await ok('web POS: pos/init carries the rule; the customer pays the bill alone; the rider\'s fee is sent', () => {
  assert.match(read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts'),
    /setFreeDeliveryAllowed\(rulesFromWire\(init\.reversalRules \?\? null\)\.freeDeliveryAllowed\);/);
  const c = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  assert.match(c, /deliveryFee=\{activeFree \? 0 : activeRiderFee\}\s*deliveryFree=\{activeFree\}[^\n]*\s*riderFee=\{activeRiderFee\}/);
  const m = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
  assert.match(m, /const recordedFee = free \? riderFee : deliveryFee;/);
  assert.match(m, /const feeFields = recordedFee > 0 \? \{ delivery_fee: recordedFee, \.\.\.\(free \? \{ delivery_free: true \} : \{\}\) \} : \{\};/);
});
await ok('History shows what the customer paid (no fee on a free delivery)', () => {
  assert.match(read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx'), /customerDeliveryFee\(o\.delivery_fee, o\.delivery_free\)/);
  assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /customerDeliveryFee\(o\.delivery_fee, o\.delivery_free\)/);
});
await ok('web: Settings › Business › Voids, refunds & delivery has the owner\'s switch', () => {
  assert.match(read('apps/dashboard/src/pages/settings/VoidRefundRulesTab.tsx'),
    /save\('delivery_free_allowed', !free, \{ \.\.\.rules, freeDeliveryAllowed: !free \}\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
