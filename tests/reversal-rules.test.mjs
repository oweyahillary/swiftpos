/**
 * reversal-rules.test.mjs — 0.6.30 (A336 stage 3): the owner's void window and offline void/refund rules, on the cloud
 * and the web.
 *
 * Owner, 2026-10-01: "Void window yes let it remain 30 min but i thing we can add a feature for owner to either increase
 * or reduce the threshold but default is 30 … for offline we will let the owner decide the refund method in the managers
 * setting which methods are allow we need to add that to the web also. scope leave it to till own sales but let it be a
 * feature on the owners page also".
 * The shared rule run for real; source assertions on the routes (Express + Supabase) and the screens (React).
 *
 * MUTATIONS TO CONFIRM BITE: the void route back on a fixed 30 → "the owner's window" fails; a manager may write the
 * rules → "owner only" fails; the replay skips the till check → "the till that holds the sale" fails; pos/init without
 * the rules → "the till hears them" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const R = await import(pathToFileURL(path.join(ROOT, 'shared/reversalRules.ts')).href);

await ok('defaults: a 30-minute void window, cash refunds offline, the till\'s own sales', () => {
  assert.deepEqual(R.parseReversalRules([]), { voidWindowMinutes: 30, offlineRefundMethods: ['cash'], offlineReverseWebSales: false });
});
await ok('the owner may raise or lower the window (1 minute to a day); anything else is refused', () => {
  assert.equal(R.reversalSettingValue('void_window_minutes', 10), '10');
  assert.equal(R.reversalSettingValue('void_window_minutes', '120'), '120');
  assert.equal(R.reversalSettingValue('void_window_minutes', 0), null);
  assert.equal(R.reversalSettingValue('void_window_minutes', 1441), null);
  assert.equal(R.reversalSettingValue('void_window_minutes', 12.5), null);
  assert.equal(R.reversalSettingValue('offline_refund_methods', []), '[]');
  assert.equal(R.reversalSettingValue('offline_refund_methods', ['cash', 'bad code!']), null);
});
await ok('a stored value round-trips through the cloud\'s settings rows', () => {
  const rows = [{ key: 'void_window_minutes', value: R.reversalSettingValue('void_window_minutes', 45) },
                { key: 'offline_refund_methods', value: R.reversalSettingValue('offline_refund_methods', ['cash', 'mpesa']) },
                { key: 'offline_reverse_web_sales', value: R.reversalSettingValue('offline_reverse_web_sales', true) }];
  assert.deepEqual(R.parseReversalRules(rows), { voidWindowMinutes: 45, offlineRefundMethods: ['cash', 'mpesa'], offlineReverseWebSales: true });
  assert.deepEqual(R.rulesFromWire(R.parseReversalRules(rows)), R.parseReversalRules(rows));
});

const orders = read('apps/server/src/routes/orders.ts');
await ok('the cloud\'s void route uses the owner\'s window (the owner at any age); no fixed 30 left', () => {
  assert.match(orders, /const rules = await businessReversalRules\(req\.businessId\);\s*if \(!replay && !voidWindowOpen\(orderAge, rules, !!req\.isOwner\)\) \{/);
  assert.doesNotMatch(orders, /VOID_WINDOW_MINUTES/);
});
await ok('a till\'s replay: from a till, from THE till that holds the sale, with an approver who may approve', () => {
  assert.match(orders, /return req\.surface === 'desktop' && typeof req\.body\?\.offline_approved_by === 'string'/);
  assert.match(orders, /let holds = !!dev && order\.device_id === dev;/);
  assert.match(orders, /code: 'NOT_THIS_TILL'/);
  assert.match(orders, /if \(!approver \|\| !mayApprove\(approver, ownerId\)\) \{/);
  assert.match(orders, /isTillReplay\(req\) \? next\(\) : requirePermission\('orders\.void'\)\(req, res, next\)/);
  assert.match(orders, /router\.post\('\/:id\/void', reversalGate,/);
  assert.match(orders, /router\.post\('\/:id\/refund', reversalGate,/);
  assert.match(orders, /voided_at: replay\?\.at \?\? new Date\(\)\.toISOString\(\)/);
  assert.match(orders, /refunded_at:          replay\?\.at \?\? new Date\(\)\.toISOString\(\)/);
  assert.match(orders, /code: 'ALREADY_VOIDED'/);
  assert.match(orders, /code: 'ALREADY_REFUNDED'/);
});
await ok('the rules are the owner\'s: readable, and written only by the owner and only when valid', () => {
  const b = read('apps/server/src/routes/business.ts');
  assert.match(b, /'void_window_minutes', 'offline_refund_methods', 'offline_reverse_web_sales',/);
  assert.match(b, /if \(isReversalSettingKey\(key\)\) \{\s*if \(!req\.isOwner\) \{/);
  assert.match(b, /const clean = reversalSettingValue\(key, value\);/);
  // ahead of the generic write
  assert.ok(b.indexOf('if (isReversalSettingKey(key))') < b.indexOf('if (HASHED_SETTING_KEYS.has(key))'));
});
await ok('the till hears them with pos/init (every rule, defaults where unset)', () => {
  const p = read('apps/server/src/routes/pos.ts');
  assert.match(p, /\.\.\.REVERSAL_SETTING_KEYS\]\),/);
  assert.match(p, /reversalRules: parseReversalRules\(\(receiptTextRows \?\? \[\]\)/);
});
await ok('local schema 61 is required (by convention, with the till)', () => {
  assert.match(read('apps/server/src/lib/desktopSchema.ts'), /export const REQUIRED_DESKTOP_SCHEMA = 61;/);
  assert.match(read('apps/desktop/src/main/localDb.ts'), /export const LOCAL_SCHEMA_VERSION = 61;/);
});
await ok('the web: Settings › Business › Voids & refunds, and the Orders page follows the owner\'s window', () => {
  assert.match(read('apps/dashboard/src/pages/settings/BusinessPage.tsx'), /\{ to: 'voids-refunds', label: 'Voids & refunds' \}/);
  assert.match(read('apps/dashboard/src/App.tsx'), /<Route path="voids-refunds" element=\{<VoidRefundRulesTab \/>\} \/>/);
  const tab = read('apps/dashboard/src/pages/settings/VoidRefundRulesTab.tsx');
  for (const k of ['void_window_minutes', 'offline_refund_methods', 'offline_reverse_web_sales']) assert.ok(tab.includes(`'${k}'`), k);
  const op = read('apps/dashboard/src/pages/OrdersPage.tsx');
  assert.match(op, /setWindowMin\(parseReversalRules\(rows \?\? \[\]\)\.voidWindowMinutes\)/);
  assert.match(op, /if \(ageMin\(o\.created_at\) <= windowMin\) return \['void'\];/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
