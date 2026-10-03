/**
 * cashier-history.test.mjs — 0.6.37 (A387): a cashier's History shows only the payment methods the manager chose; a
 * cashier never reprints.
 *
 * Owner, 2026-10-03: "order history to only show manager allowed … so the manager selects what the cashier sees" —
 * "based on payment method" — "They can only see allowed method eg mpesa, cash, card but never reprints a receipt" —
 * set on the dashboard and the till. The shared rule run for real; source assertions on the cloud (the setting, the
 * branch override, pos/init, GET /api/orders), the web (POS History, Settings, Branches) and the till's wiring. The till
 * itself is run for real in apps/desktop/test/cashier-history.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: cashierHistoryView keeping a whole split sale → "a split sale shows only its allowed part"
 * fails; dropping the empty-list pass-through → "nothing chosen = every method" fails; GET /api/orders filtering a
 * manager → its pin fails; can_reprint for a cashier → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const H = await import(pathToFileURL(path.join(ROOT, 'shared/cashierHistory.ts')).href);

const sale = (id, payments, total) => ({ id, total, payments });
const ORDERS = [
  sale('cash-only', [{ method: 'cash', amount: 500 }], 500),
  sale('mpesa-only', [{ method: 'mpesa', amount: 800 }], 800),
  sale('split', [{ method: 'cash', amount: 300 }, { method: 'mpesa', amount: 700 }], 1000),
  sale('card-only', [{ method: 'card', amount: 1200 }], 1200),
  sale('no-rows', [], 250),
  sale('zero-leg', [{ method: 'cash', amount: 0 }, { method: 'mpesa', amount: 450 }], 450),
];

await ok('the setting: a list of method codes; empty / null / "[]" = every method; anything else refused', () => {
  assert.deepStrictEqual(H.cleanHistoryMethods(['MPESA', 'cash', 'cash']), ['mpesa', 'cash']);
  assert.deepStrictEqual(H.cleanHistoryMethods('["mpesa"]'), ['mpesa']);
  assert.deepStrictEqual(H.cleanHistoryMethods('cash, card'), ['cash', 'card']);
  for (const every of [null, undefined, '', '[]', []]) assert.deepStrictEqual(H.cleanHistoryMethods(every), [], String(every));
  for (const bad of [{ a: 1 }, ['m pesa'], ['<script>'], 42]) assert.strictEqual(H.cleanHistoryMethods(bad), undefined, JSON.stringify(bad));
  assert.strictEqual(H.historyMethodsSettingValue(['mpesa']), '["mpesa"]');
  assert.strictEqual(H.historyMethodsSettingValue([]), '[]');
  assert.strictEqual(H.historyMethodsSettingValue({}), null);
  assert.strictEqual(H.CASHIER_HISTORY_METHODS_KEY, 'cashier_history_methods');
});

await ok('nothing chosen = every method: the list is unchanged', () => {
  assert.strictEqual(H.cashierHistoryView(ORDERS, []), ORDERS);
  assert.strictEqual(H.cashierHistoryView(ORDERS, null), ORDERS);
});

await ok('M-Pesa only: the M-Pesa sales, whole; no cash or card sale', () => {
  const v = H.cashierHistoryView(ORDERS, ['mpesa']);
  assert.deepStrictEqual(v.map((o) => o.id), ['mpesa-only', 'split', 'zero-leg']);
  assert.strictEqual(v[0].history_partial, undefined);
  assert.strictEqual(v[2].history_partial, undefined, 'a zero cash leg beside the M-Pesa is not a split');
});

await ok('a split sale shows only its allowed part — that amount, never the bill', () => {
  const split = H.cashierHistoryView(ORDERS, ['mpesa']).find((o) => o.id === 'split');
  assert.strictEqual(split.history_partial, true);
  assert.strictEqual(split.history_shown_total, 700);
  assert.deepStrictEqual(split.payments, [{ method: 'mpesa', amount: 700 }]);
  assert.strictEqual(ORDERS[2].payments.length, 2, 'the original is not changed');
});

await ok('cash + card: a sale with no payment rows counts as cash; the split shows its cash part', () => {
  const v = H.cashierHistoryView(ORDERS, ['cash', 'card']);
  assert.deepStrictEqual(v.map((o) => o.id), ['cash-only', 'split', 'card-only', 'no-rows']);
  assert.strictEqual(v.find((o) => o.id === 'split').history_shown_total, 300);
});

await ok('the cloud: the setting (settings.manage, validated), the branch override, pos/init', () => {
  const biz = read('apps/server/src/routes/business.ts');
  assert.match(biz, /'cashier_history_methods',/);   // readable
  assert.match(biz, /if \(key === CASHIER_HISTORY_METHODS_KEY\) \{\s*const clean = historyMethodsSettingValue\(value\);\s*if \(clean === null\)/);
  assert.match(biz, /invalidateHistoryMethods\(req\.businessId\)/);
  const br = read('apps/server/src/routes/branches.ts');
  assert.match(br, /OVERRIDABLE_KEYS = \[[^\]]*'cashier_history_methods'\]/);
  assert.match(br, /if \(key === CASHIER_HISTORY_METHODS_KEY\) \{\s*const clean = historyMethodsSettingValue\(value\);/);
  const pos = read('apps/server/src/routes/pos.ts');
  assert.match(pos, /cashierHistoryMethods: cleanHistoryMethods\(receiptText\.cashier_history_methods\) \?\? \[\]/);
  assert.equal((pos.match(/'business_day_cutoff', 'cashier_history_methods'/g) ?? []).length, 2, 'business and branch keys');
  const hm = read('apps/server/src/lib/historyMethods.ts');
  assert.match(hm, /from\('branch_settings'\)/);
  assert.match(hm, /catch \{ methods = \[\]; \}/);
});

await ok('GET /api/orders: a cashier\'s list filtered in the query (pages right), split sales trimmed; managers see all; only managers reprint', () => {
  const o = read('apps/server/src/routes/orders.ts');
  assert.match(o, /const historyMethods = manager \? \[\] : await getHistoryMethods\(/);
  assert.match(o, /if \(historyMethods\.length\)\s+query = query\.in\('pm\.method', historyMethods\);/);
  assert.match(o, /if \(historyMethods\.length\) orders = cashierHistoryView\(orders, historyMethods\);/);
  assert.match(o, /total: count \?\? 0, own_only: ownOnly,\s*history_methods: historyMethods, can_reprint: manager \}\);/);
});

await ok('the web: POS History shows the allowed part; Settings and the branch override offer the methods', () => {
  const h = read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx');
  assert.match(h, /order\.history_partial\s*\? `\$\{fmt\(Number\(order\.history_shown_total \?\? 0\), currency\)\} \(part of a split payment\)`/);
  assert.match(h, /\{!order\.history_partial && <>/);
  assert.match(h, /setCanReprint\(res\.can_reprint === true\)/);
  const p = read('apps/dashboard/src/pages/settings/BusinessProfileTab.tsx');
  assert.match(p, /saveSetting\('cashier_history_methods', JSON\.stringify\(list\)\)/);
  const b = read('apps/dashboard/src/pages/settings/BranchReceiptOverrides.tsx');
  assert.match(b, /save\('cashier_history_methods', JSON\.stringify\(list\)\)/);
  assert.match(b, /save\('cashier_history_methods', null\)/);
  const pick = read('apps/dashboard/src/pages/settings/HistoryMethodsPicker.tsx');
  assert.match(pick, /if \(!next\.length\) \{ setError\('Leave at least one method ticked\.'\); return; \}/);
  assert.match(pick, /methods\.every\(\(m\) => next\.includes\(m\.code\)\) \? \[\] : next/);
});

await ok('the till: pulled and relayed, cached, filtered for a cashier, set from Manager → Settings', () => {
  const se = read('apps/desktop/src/main/syncEngine.ts');
  assert.match(se, /setCashierHistoryMethods\(c\.cashierHistoryMethods\)/);
  const rb = read('apps/desktop/src/main/referenceBundle.ts');
  assert.match(rb, /cashierHistoryMethods/);
  const ipc = read('apps/desktop/src/main/ipcHandlers.ts');
  assert.match(ipc, /scope\.methods\.length \? cashierHistoryView\(orders as any\[\], scope\.methods\) : orders/);
  assert.match(ipc, /handle\('manage:setCashierHistoryMethods'/);
  assert.match(read('apps/desktop/src/main/ipcSchemas.ts'), /'manage:setCashierHistoryMethods': \{ kind: 'stringArray' \}/);
  assert.match(read('apps/desktop/src/main/preload.ts'), /setCashierHistoryMethods: \(methods: string\[\]\)/);
  assert.match(read('apps/desktop/src/renderer/components/SettingsPanel.tsx'), /<CashierHistoryPanel canEdit=\{canEdit\} \/>/);
  assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /o\.history_partial \? fmtMoney\(Number\(o\.history_shown_total \?\? 0\)\)/);
  assert.match(read('apps/desktop/src/main/shiftService.ts'), /canReprint: manager,\s*methods: manager \? \[\] : getCashierHistoryMethods\(\),/);
});

await ok('schema 66 on both sides', () => {
  assert.ok(Number(/export const REQUIRED_DESKTOP_SCHEMA = (\d+);/.exec(read('apps/server/src/lib/desktopSchema.ts'))[1]) >= 66);
  assert.ok(Number(/export const LOCAL_SCHEMA_VERSION = (\d+);/.exec(read('apps/desktop/src/main/localDb.ts'))[1]) >= 66);
  assert.match(read('apps/desktop/src/main/localDb.ts'), /\['cashier_history_methods', ?'TEXT'\]/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
