/**
 * cashier-shift-sales.test.mjs — A416 (owner, 2026-10-09: "where is the feature for waiter seeing total sales on the shift
 * while closing? can we add it to the managers/owners side which can be toggled on and off at will but by default is off?").
 *
 *   node tests/cashier-shift-sales.test.mjs
 *
 * RUNS the real rule (apps/server/src/lib/cashierShiftSales.ts cleanSeesSales), then pins the path end to end: the owner's
 * switch and the branch override (dashboard + the cloud's allowlists), the cloud's till payload, the till's cache (schema
 * 68), the till's blind report and both close screens — and that the count stays blind (no expected cash, no method figure).
 *
 * MUTATIONS TO CONFIRM BITE: cleanSeesSales treating anything but "true" as on → "off unless true" fails; blindReport
 * adding the sales when the switch is off → "only when on" fails; blindReport putting expected cash back → "the count stays
 * blind" fails; the cloud sending the sales to a cashier without the switch → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

// The rule file imports the supabase client; its pure part is checked by source + a copy of the one-liner's behaviour.
const rule = read('apps/server/src/lib/cashierShiftSales.ts');
const cleanSrc = /export function cleanSeesSales\(raw: unknown\): boolean \{\s*return ([^;]+);\s*\}/.exec(rule)?.[1];
const cleanSeesSales = new Function('raw', `return ${cleanSrc};`);

console.log('\nThe switch\n');
ok('off unless "true" (the default is off)', () => {
  assert.ok(cleanSrc, 'cleanSeesSales not found');
  for (const v of [undefined, null, '', 'false', 'yes', '1', 0, 1, 'TRUEish']) assert.equal(cleanSeesSales(v), false, String(v));
  for (const v of ['true', ' TRUE ', true]) assert.equal(cleanSeesSales(v), true, String(v));
});
ok("the branch's own value wins, else the business default", () => {
  assert.match(rule, /if \(branchId\) \{[\s\S]*from\('branch_settings'\)[\s\S]*if \(own\) return cleanSeesSales\(/);
  assert.match(rule, /from\('business_settings'\)[\s\S]*return cleanSeesSales\(/);
});
ok('the owner sets it, and a branch may override it', () => {
  assert.match(read('apps/server/src/routes/business.ts'), /'cashier_sees_shift_sales',/);
  assert.match(read('apps/server/src/routes/branches.ts'), /'cashier_sees_shift_sales',/);
  assert.match(read('apps/dashboard/src/pages/settings/BusinessProfileTab.tsx'), /saveSetting\('cashier_sees_shift_sales', seesSales \? 'false' : 'true'\)/);
  assert.match(read('apps/dashboard/src/pages/settings/BranchReceiptOverrides.tsx'), /save\('cashier_sees_shift_sales', null\)/);
});

console.log('\nThe cloud\n');
const shifts = read('apps/server/src/routes/shifts.ts');
ok("a cashier's blind shift carries their sales only when the switch is on", () => {
  assert.match(shifts, /const seesSales = await cashierSeesShiftSales\(req\.businessId!, shift\.branch_id\);/);
  // A442 adds each person's part (sales only) inside the same switch.
  assert.match(shifts, /\.\.\.\(seesSales \? \{ cashier_sales: \{ total: Math\.round\(kept \* 100\) \/ 100, orders: \(orders \?\? \[\]\)\.length,\s*\/\/[^\n]*\n\s*by_cashier: byCashier\.map\(\(c\) => \(\{ name: c\.name, orders: c\.orders, sales: c\.sales \}\)\) \} \} : \{\}\)/);
});
ok('the till is told with its settings (the branch\'s own wins)', () => {
  const pos = read('apps/server/src/routes/pos.ts');
  assert.match(pos, /cashierSeesShiftSales: cleanSeesSales\(receiptText\.cashier_sees_shift_sales\),/);
  assert.equal((pos.match(/'cashier_sees_shift_sales'/g) || []).length, 2, 'read from business_settings and branch_settings');
});

console.log('\nThe till\n');
const svc = read('apps/desktop/src/main/shiftService.ts');
const blind = svc.slice(svc.indexOf('export function blindReport'), svc.indexOf('/** A manager for shift purposes'));
ok('only when on: the blind report adds the sales kept and the orders', () => {
  assert.match(blind, /seesSales: boolean = getCashierSeesShiftSales\(\)/);
  // A442 adds each person's part (sales only) inside the same switch, and strips the per-person figures when it is off.
  assert.match(blind, /\.\.\.\(seesSales \? \{ cashierSales: \{ total: money2\(z\.totals\.netSales \?\? z\.totals\.grossSales\), orders: z\.totals\.orderCount,\s*byCashier: \(z\.byCashier \?\? \[\]\)\.map\(\(c\) => \(\{ name: c\.name, orders: c\.orders, sales: c\.sales \}\)\) \} \} : \{\}\)/);
  assert.match(blind, /byCashier: seesSales \? \(z\.byCashier \?\? \[\]\)\.map\(\(c\) => \(\{ \.\.\.c, byMethod: \[\] \}\)\) : \[\],/);
});
ok('the count stays blind: expected cash 0, no variance, no method figures', () => {
  assert.match(blind, /shift: \{ \.\.\.z\.shift, expected_cash: 0, cash_variance: null \}/);
  assert.match(blind, /byMethod: z\.byMethod\.map\(\(m\) => \(\{ \.\.\.m, amount: 0, orders: 0 \}\)\)/);
  assert.match(blind, /cashSales: 0, expectedCash: 0/);
});
ok('cached on the till (schema 68 on), pulled, relayed by the branch server; off until told', () => {
  assert.match(read('apps/desktop/src/main/localDb.ts'), /\['cashier_sees_shift_sales', 'INTEGER'\]/);
  // Added at 68; a later schema (A429: 69) keeps it — the till and the cloud still move together.
  const local = Number(read('apps/desktop/src/main/localDb.ts').match(/export const LOCAL_SCHEMA_VERSION = (\d+);/)[1]);
  const required = Number(read('apps/server/src/lib/desktopSchema.ts').match(/export const REQUIRED_DESKTOP_SCHEMA = (\d+);/)[1]);
  assert.ok(local >= 68 && required === local, `local ${local}, required ${required}`);
  const cfg = read('apps/desktop/src/main/deviceConfig.ts');
  assert.match(cfg, /return getDeviceConfig\(\)\?\.cashier_sees_shift_sales === 1;/);
  assert.match(cfg, /if \(typeof raw !== 'boolean'\) return;/);
  assert.match(read('apps/desktop/src/main/syncEngine.ts'), /setCashierSeesShiftSales\(c\.cashierSeesShiftSales\);/);
  assert.match(read('apps/desktop/src/main/referenceBundle.ts'), /cashierSeesShiftSales: rows\.config\.cashierSeesShiftSales,/);
});
ok('both close screens show it — the till and the web POS', () => {
  assert.match(read('apps/desktop/src/renderer/pages/ShiftPanel.tsx'), /\{report\.cashierSales && \(\s*<p className="mt-2 text-white" data-testid="cashier-sales">/);
  assert.match(read('apps/dashboard/src/pages/pos/ShiftModal.tsx'), /\{blind && cashierSales && \(\s*<p style=\{s\.subtitle\} data-testid="cashier-sales">/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
