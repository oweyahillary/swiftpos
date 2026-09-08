/**
 * A264 — web POS cart converges on the desktop's shared core: an order-type
 * selector (Dine in / Takeaway / Delivery) at the top, and Send to Kitchen · Hold
 * above Charge in BOTH modes (previously Send to Kitchen only showed in
 * order_first). Web-only premium extras (Print Bill / Transfer / Split / Room) sit
 * below Charge so they never displace the shared buttons.
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/pos/CashierScreen.tsx'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('order-type selector (Dine in/Takeaway/Delivery) with a setter', () => {
  assert.match(c, /function setActiveOrderType\(val: 'dine_in' \| 'takeaway' \| 'delivery'\)/);
  assert.match(c, /\['dine_in', 'takeaway', 'delivery'\] as const\).map/);
  assert.match(c, /onClick=\{\(\) => setActiveOrderType\(val\)\}/);
});
ok('Send to Kitchen shows for any restaurant order — not gated on order_first', () => {
  assert.match(c, /\{isRestaurant && cart\.length > 0 && \(\s*\n\s*<div style=\{\{ display: 'flex', gap: 8 \}\}>/);
  assert.match(c, /onClick=\{sendToKitchen\}/);
  assert.doesNotMatch(c, /isRestaurant && orderMode === 'order_first' \? \(/);  // old mode gating gone
});
ok('Hold (parkOrder) sits beside Send to Kitchen', () => {
  assert.match(c, /onClick=\{parkOrder\}[\s\S]{0,80}Hold/);
});
ok('premium extras (Print Bill/Transfer/Split/Room) are below Charge', () => {
  const charge = c.indexOf('data-testid="charge-button"');
  const extras = c.indexOf('Web-only premium extras');
  assert.ok(charge > 0 && extras > charge, 'premium extras block must come after the Charge button');
  assert.match(c, /Print Bill/); assert.match(c, /Split Bill/); assert.match(c, /🏨 Room/);
});

ok('A265: receiptHeader/receiptFooter are destructured from usePOSData (Charge no longer crashes)', () => {
  // They are used in the PaymentModal props + printBill; must be declared or the
  // PaymentModal render throws ReferenceError (the dashboard build is esbuild-only,
  // so an undeclared identifier is only caught at runtime).
  assert.match(c, /\n    receiptHeader,\n    receiptFooter,\n    businessMode:/);
  assert.match(c, /receiptHeader=\{receiptHeader\}/);
});

ok('A266: PaymentModal resolves the business (no blank receipt) + auto-prints on success', () => {
  const pm = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/pos/PaymentModal.tsx'), 'utf8');
  assert.match(pm, /const \[resolvedBusiness, setResolvedBusiness\]/);
  assert.match(pm, /api\.get<Business>\('\/api\/business'\)\.then/);
  assert.match(pm, /business=\{resolvedBusiness as Business\}/);     // ReceiptView uses it (no blank box)
  assert.match(pm, /const printViaBridge = async/);
  assert.match(pm, /autoPrintedRef\.current = true;\s*\n\s*void printViaBridge\(\)/);  // auto-print once on success
});

ok('A267: getStoredRefreshToken falls back to any refresh token (fixes the 401 cascade)', () => {
  const api = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/api.ts'), 'utf8');
  assert.ok(api.includes('TOKEN_KEYS.posRefresh') && api.includes('TOKEN_KEYS.ownerRefresh'), 'refresh-token fallback (A267)');
  assert.ok(api.includes('TOKEN_KEYS.posAccess'), 'access-token fallback (A260) still present');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'} (${pass} passed)`);
process.exit(fail ? 1 : 0);
