/**
 * payment-catalogue.test.mjs — A429 (owner, 2026-10-09: "find all common payment methods and delivery services in Kenya
 * and hardcode them"; 2026-10-10: "add them but as toggles — by default the current payment methods are on but the
 * manager can turn them on or off; add the others but the manager has to turn them on; per branch is also valid").
 *
 *   node tests/payment-catalogue.test.mjs
 *
 * RUNS the real packages/core/src/paymentCatalogue.ts (the list, the defaults, the setting, the buttons a screen shows) and the
 * till's report names; then pins the chain: the cloud stores and sends the branch's choice, the till keeps it (schema
 * 69) and relays it to its peers, both payment screens and both settings screens use it.
 *
 * MUTATIONS TO CONFIRM BITE: Airtel Money on by default → "the new ones are off" fails; the till showing On account →
 * "On account stays on the web" fails; an unknown code stored → "only catalogue codes" fails; the till's payment screen
 * back on its fixed list → its pin fails; the pull not keeping the setting → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ipcHandlersSource } from '../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.PAY_CAT_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, PAY_CAT_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const C = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/paymentCatalogue.ts')).href);
// The till's daily report names (its file needs Electron): modeLabel lifted into a temp file.
const dsr = read('apps/desktop/src/main/dailySalesReport.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a429-'));
fs.writeFileSync(path.join(tmp, 'modeLabel.ts'),
  dsr.slice(dsr.indexOf('const OTHER_MODE_NAMES'), dsr.indexOf('\n}\n', dsr.indexOf('export function modeLabel(')) + 3));
const { modeLabel } = await import(pathToFileURL(path.join(tmp, 'modeLabel.ts')).href);

console.log('\nThe list');
ok("Kenya's common ways to pay and the delivery apps", () => {
  const codes = C.PAYMENT_CATALOGUE.map((m) => m.code);
  for (const c of ['cash', 'mpesa', 'card', 'glovo', 'credit', 'airtel_money', 'tkash', 'bank_transfer', 'cheque', 'voucher', 'room_charge', 'uber_eats', 'bolt_food', 'yum']) assert.ok(codes.includes(c), c);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.match(c, /^[a-z0-9_]{1,40}$/);   // the cloud takes these (migration 89)
});
ok('on until switched off: what the tills and the web took before (Cash, M-Pesa, Card, Glovo, On account)', () => {
  assert.deepEqual(C.DEFAULT_ENABLED, ['cash', 'mpesa', 'card', 'glovo', 'credit']);
});
ok('the new ones are off until a manager switches them on', () => {
  for (const c of ['airtel_money', 'tkash', 'bank_transfer', 'cheque', 'voucher', 'room_charge', 'uber_eats', 'bolt_food', 'yum'])
    assert.equal(C.catalogueMethod(c).defaultOn, false, c);
});
ok('codes never change: cash is the drawer, mpesa the prompt and the matching', () => {
  assert.equal(C.catalogueMethod('cash').kind, 'cash');
  assert.equal(C.catalogueMethod('mpesa').kind, 'mobile');
});

console.log('\nThe setting');
ok('not chosen (or unreadable): the defaults', () => {
  assert.deepEqual(C.enabledFromSetting(null), C.DEFAULT_ENABLED);
  assert.deepEqual(C.enabledFromSetting('not json'), C.DEFAULT_ENABLED);
  assert.deepEqual(C.enabledFromSetting({}), C.DEFAULT_ENABLED);
});
ok('chosen: exactly those, in catalogue order; unknown codes dropped; every one off is allowed', () => {
  assert.deepEqual(C.enabledFromSetting('["uber_eats","cash","nope"]'), ['cash', 'uber_eats']);
  assert.deepEqual(C.enabledFromSetting([]), []);
});
ok('only catalogue codes are stored (the cloud refuses anything else)', () => {
  assert.equal(C.enabledSettingValue(['cash', 'airtel_money']), '["cash","airtel_money"]');
  assert.equal(C.enabledSettingValue('["tkash","cash"]'), '["cash","tkash"]');
  assert.equal(C.enabledSettingValue(['cash', 'bitcoin']), null);
  assert.equal(C.enabledSettingValue('cash'), null);
  assert.equal(C.enabledSettingValue([1]), null);
});

console.log('\nThe buttons');
ok('the till: the switched-on methods, then the business\'s own; On account too (A552)', () => {
  const b = C.paymentButtons(['cash', 'mpesa', 'credit', 'airtel_money'], [{ code: 'staff_meal', name: 'Staff meal' }, { code: 'mpesa', name: 'dup' }], 'till');
  // A552: On account on the till too — its payment screen offers it only when the till holds a credit customer.
  assert.deepEqual(b.map((x) => x.code), ['cash', 'mpesa', 'credit', 'airtel_money', 'staff_meal']);
  assert.ok(C.paymentButtons(['credit'], [], 'web').some((x) => x.code === 'credit'));
  assert.ok(!C.PAYMENT_CATALOGUE.some((m) => m.webOnly), 'no method is the web POS\'s alone');
  assert.ok(read('apps/desktop/src/renderer/components/PaymentModal.tsx').includes("b.code !== 'credit' || onAccount?.offered"), 'the till hides it unless offered');
});
ok('a method switched off is not offered — even as a business\'s own method with the same code', () => {
  assert.ok(!C.paymentButtons(['cash'], [{ code: 'glovo', name: 'Glovo' }], 'till').some((x) => x.code === 'glovo'));
});
ok('each method says what reference to take', () => {
  const b = C.paymentButtons(C.DEFAULT_ENABLED, [], 'till');
  assert.equal(b.find((x) => x.code === 'mpesa').reference, 'QHX4K2L9MP');
  assert.equal(b.find((x) => x.code === 'glovo').reference, 'Glovo order #');
  assert.equal(b.find((x) => x.code === 'cash').reference, null);
});
ok('names in the reports: the catalogue\'s, else the code tidied (the Z-report, the daily report)', () => {
  assert.equal(C.methodLabel('airtel_money'), 'Airtel Money');
  assert.equal(C.methodLabel('staff_meal'), 'Staff meal');
  assert.equal(modeLabel('bolt_food'), 'Bolt Food');
  assert.equal(modeLabel('staff_meal'), 'Staff meal');
  for (const m of C.PAYMENT_CATALOGUE) if (!['cash', 'mpesa', 'card', 'credit', 'glovo'].includes(m.code)) assert.equal(modeLabel(m.code), m.name, m.code);
});

console.log('\nThe cloud');
const biz = read('apps/server/src/routes/business.ts');
const br = read('apps/server/src/routes/branches.ts');
const pos = read('apps/server/src/routes/pos.ts');
ok('stored for the business and per branch — only catalogue codes', () => {
  assert.ok(biz.includes("  'payment_methods_enabled',\n") && biz.includes('if (key === PAYMENT_METHODS_ENABLED_KEY) {\n    const clean = enabledSettingValue(value);'));
  assert.ok(/'payment_methods_enabled'(\];|,\s+\/\/ A429)/.test(br) && br.includes('if (key === PAYMENT_METHODS_ENABLED_KEY) {\n    const clean = enabledSettingValue(value);'));
});
ok('sent to every till and the web POS — the branch\'s own wins', () => {
  assert.equal((pos.match(/'payment_methods_enabled'/g) || []).length, 2);
  assert.ok(pos.includes('paymentMethodsEnabled: enabledFromSetting(receiptText.payment_methods_enabled),'));
});
ok('a manager on a till may save it (the branch settings path, settings.manage)', () => {
  assert.ok(read('apps/server/src/lib/terminalWrites.ts').includes('/^\\/api\\/branches\\/[^/]+\\/settings$/,'));
});

console.log('\nThe till');
ok('kept on the till (schema 69, the cloud requires it), pulled, relayed to the branch\'s other tills', () => {
  assert.ok(read('apps/desktop/src/main/localDb.ts').includes("['payment_methods_enabled', 'TEXT'],"));
  // Added at 69; a later schema (A445: 70) keeps it — the till and the cloud still move together.
  const local = Number(read('apps/desktop/src/main/localDb.ts').match(/export const LOCAL_SCHEMA_VERSION = (\d+);/)[1]);
  const required = Number(read('apps/server/src/lib/desktopSchema.ts').match(/export const REQUIRED_DESKTOP_SCHEMA = (\d+);/)[1]);
  assert.ok(local >= 69 && required === local, `local ${local}, required ${required}`);
  const sync = read('apps/desktop/src/main/syncEngine.ts');
  assert.ok(sync.includes('setPaymentMethodsEnabled(c.paymentMethodsEnabled);'));
  assert.ok(sync.includes('paymentMethodsEnabled: Array.isArray(_j.paymentMethodsEnabled) ? _j.paymentMethodsEnabled : undefined,'));
  const rb = read('apps/desktop/src/main/referenceBundle.ts');
  assert.ok(rb.includes('paymentMethodsEnabled: rows.config.paymentMethodsEnabled,') && rb.includes("typeof cfg?.payment_methods_enabled !== 'string'")
    && rb.includes('paymentMethodsEnabled: Array.isArray(pi.paymentMethodsEnabled)'));
});
ok('the payment screen shows the branch\'s methods (not a fixed list), starting on cash where taken', () => {
  const pm = read('apps/desktop/src/renderer/components/PaymentModal.tsx');
  assert.ok(pm.includes("const buttons = useMemo(() => paymentButtons(enabledFromSetting(enabledMethods), customMethods, 'till'), [enabledMethods, customMethods]);"));
  assert.ok(pm.includes('{methods.map(b => ({ code: b.code, label: b.name, icon: b.icon })).map(m => ('));   // A552: less On account unless offered
  assert.ok(!pm.includes('METHOD_META'));
  assert.ok(pm.includes("{ method: firstMethod, amount: '', tendered: '', reference: '' },"));
  assert.ok(read('apps/desktop/src/renderer/pages/POSPage.tsx').includes('enabledMethods={enabledMethods}'));
});
ok('Manager › Settings › Payment methods — a switch per method, saved for the branch', () => {
  // A490: shown and edited for settings.payments (ManagerPage passes it; main checks it again).
  assert.ok(read('apps/desktop/src/renderer/components/SettingsPanel.tsx').includes('<BranchPaymentMethodsPanel canEdit={canPayments} />'));
  assert.ok(/\{canPayments && <section className="border-t border-gray-800 pt-6">\s*<BranchPaymentMethodsPanel/.test(read('apps/desktop/src/renderer/components/SettingsPanel.tsx')));
  assert.ok(read('apps/desktop/src/renderer/pages/ManagerPage.tsx').includes("canPayments={has('settings.payments')}"));
  assert.ok(ipcHandlersSource().includes("handle('manage:setPaymentMethodsEnabled', async (_e, codes) => {\n    requireKey(['settings.payments'], PAYMENTS_REFUSED);"));
  assert.ok(read('apps/desktop/src/renderer/components/BranchPaymentMethodsPanel.tsx').includes('await posApi.manage.setPaymentMethodsEnabled(enabledFromSetting(next));'));
  assert.ok(ipcHandlersSource().includes("const out = await manageFetch(`/api/branches/${encodeURIComponent(branchId)}/settings`, 'POST', { key: 'payment_methods_enabled', value: list });"));
});

console.log('\nThe web');
ok('the web POS: the branch\'s methods, the rest settling like a card; split payment only what the branch takes', () => {
  const wp = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
  assert.ok(wp.includes("const branchButtons = paymentButtons(enabledFromSetting(enabledMethods), customMethods, 'web');"));
  assert.ok(wp.includes('{builtInMethods.map(m => (') && wp.includes('{extraMethods.map(cm => ('));
  assert.ok(wp.includes('enabledMethods={builtInMethods}'));
  assert.ok(read('apps/dashboard/src/pages/pos/SplitPaymentPanel.tsx').includes('if (enabledMethods && !enabledMethods.includes(m)) return false;'));
  assert.ok(read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts').includes('setPaymentMethodsEnabled(Array.isArray(init.paymentMethodsEnabled) ? init.paymentMethodsEnabled : null);'));
});
ok('Settings › Branches › a branch: the same switches', () => {
  assert.ok(read('apps/dashboard/src/pages/settings/BranchReceiptOverrides.tsx').includes("onSave={(v) => save('payment_methods_enabled', v)} />"));
});
ok('one catalogue: the till, the web and the cloud import the one file in packages/core (no copies left)', () => {
  assert.ok(read('packages/core/src/paymentCatalogue.ts').length > 0);
  for (const p of ['shared/paymentCatalogue.ts', 'apps/server/src/lib/paymentCatalogue.ts', 'apps/desktop/src/shared/paymentCatalogue.ts', 'apps/dashboard/src/lib/paymentCatalogue.ts']) assert.ok(!fs.existsSync(path.join(ROOT, p)), p);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
