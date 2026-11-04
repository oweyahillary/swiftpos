/**
 * manager-cash-lines-a527.test.mjs — A527 (owner, 2026-10-17): "a manager when closing should see 4 items —
 * 1. opening float, 2. cash sold, 3. cash sold + float, 4. what the cashier keyed in".
 *
 *   node tests/manager-cash-lines-a527.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the shared lines (packages/core/src/shiftConfirm.ts `cashLines`, its types stripped by Node) and the cloud's compiled
 * `cashBreakdown`; pins the cloud's confirm-view (the cash only with the expected figures) and the three manager screens
 * (the till's confirm, the branch server's Close Branch confirm, the web's Shift confirmations).
 * The till's own confirm view is run for real in apps/desktop/test/shift-confirm.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: `other` not derived from expected → "the lines add up to expected" fails; the movement
 * lines always shown → "four lines when nothing moved" fails; confirm-view sending `cash` without the expected gate →
 * "the cloud sends the cash lines only with the expected figures" fails; the IPC not dropping `cash` → the desktop pin fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n}  ${d}`); } };

const DIST = path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/shiftConfirm.js'))) {
  console.log('\nCannot load apps/server/dist/lib/shiftConfirm.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const C = require(path.join(DIST, 'lib/shiftConfirm.js'));

// The A527 block of the shared file is self-contained (no imports): strip its types and run it.
const shared = read('packages/core/src/shiftConfirm.ts');
const at = shared.indexOf('export interface CashBreakdown');
const block = stripTypeScriptTypes(shared.slice(at));
const S = await import(`data:text/javascript,${encodeURIComponent(block)}`);

console.log('\nThe four lines\n');
const quiet = C.cashBreakdown(2000, 500, 2500, 2400);
const lines = S.cashLines(quiet);
ok('four lines when nothing moved: Opening float, Cash sold, Cash sold + float, Cashier keyed in',
  lines.map((l) => l.label).join(' | ') === 'Opening float | Cash sold | Cash sold + float | Cashier keyed in', lines.map((l) => l.label).join(' | '));
ok('…2000, 500, 2500 and what the cashier keyed in (2400)', lines.map((l) => l.amount).join() === '2000,500,2500,2400', lines.map((l) => l.amount).join());
ok('…"Cash sold + float" is the figure in bold (it is the expected cash)', lines.find((l) => l.key === 'float_sold').strong === true);

const moved = C.cashBreakdown(2000, 500, 2200, 2200);   // 300 paid out of the drawer
const ml = S.cashLines(moved);
ok('cash in / out or a cash expense: that line and the drawer\'s expected are shown too, between the sum and the cashier',
  ml.map((l) => l.key).join() === 'float,sold,float_sold,other,expected,cashier', ml.map((l) => l.key).join());
ok('…the lines add up to expected (float + sold + other = expected), the expected in bold, the sum not',
  moved.other === -300 && moved.float_plus_sales + moved.other === moved.expected && ml.find((l) => l.key === 'expected').strong === true
    && !ml.find((l) => l.key === 'float_sold').strong, JSON.stringify(moved));

console.log('\nThe cloud\'s breakdown\n');
ok('rounded to cents; the cashier\'s figure from a string; none when not keyed in',
  C.cashBreakdown(100.004, 0.105, 100.11, '50.5').cashier === 50.5 && C.cashBreakdown(1, 2, 3, null).cashier === null
    && C.cashBreakdown(1, 2, 3, '').cashier === null && C.cashBreakdown(1, 2, 3, 'x').cashier === null);
ok('…a missing cashier figure shows "not keyed in", never 0', S.cashLines(C.cashBreakdown(1, 2, 3, null)).find((l) => l.key === 'cashier').amount === null);
ok('no breakdown → no lines', S.cashLines(null).length === 0);

const route = read('apps/server/src/routes/shifts.ts');
ok('the cloud sends the cash lines only with the expected figures (to someone who may confirm)',
  /const cash = shift && expected \? cashBreakdown\(/.test(route) && /res\.json\(\{ showCashier, declared: [^}]+, expected, cash \}\);/.test(route));
ok('…cash sold is the same figure expected cash is built from (one helper)',
  /async function shiftCashSales\(shiftId: string\): Promise<number>/.test(route)
    && /const cashSales = await shiftCashSales\(shiftId\);/.test(route) && /await shiftCashSales\(String\(\(shift as any\)\.id\)\)/.test(route));
ok('…the cashier\'s figure: the declared cash, else the counted closing float',
  /methodMap\(\(shift as any\)\.declared_methods\)\?\.cash \?\? \(shift as any\)\.closing_float\)/.test(route));

console.log('\nThe manager screens\n');
const modal = read('apps/desktop/src/renderer/components/ConfirmShiftModal.tsx');
const branch = read('apps/desktop/src/renderer/pages/BranchCloseTab.tsx');
const web = read('apps/dashboard/src/components/ShiftConfirmations.tsx');
for (const [name, src] of [['the till\'s confirm', modal], ['the web\'s Shift confirmations', web]]) {
  ok(`${name} shows the lines from the shared cashLines, when the view carries them`,
    /\{view\.cash && \(/.test(src) && /cashLines\(view\.cash\)\.map\(/.test(src) && /data-testid="confirm-cash"/.test(src) && /'not keyed in'/.test(src));
}
ok('the branch server\'s Close Branch confirm shows them too — and leaves the cashier line out for a till that does not send it',
  /cashLines\(\{ opening_float: fl, cash_sales: sold,/.test(branch) && /\.filter\(\(l\) => l\.key !== 'cashier' \|\| keyed !== undefined\)/.test(branch));
const main = read('apps/desktop/src/main/branchClose.ts');
ok('…a 1.0.19 till sends the cashier\'s cash with its shifts', /cashier: declared && Number\.isFinite\(Number\(declared\.cash\)\) \? Number\(declared\.cash\) : null \}/.test(main));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
