/**
 * expense-filters.test.mjs — A474 (owner, 2026-10-14, screenshots of Expenses): "payment method and who paid are empty".
 *
 * The filter choices were built from the period's rows only, so a period with no expenses offered nothing. Every method
 * an expense can be paid with and every staff member are always offered now, plus anything else found in the rows.
 *
 *   node tests/expense-filters.test.mjs
 *
 * MUTATION TO CONFIRM BITE: build methodOptions from the rows only → "every payment method is offered" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/expenses/ExpensesPage.tsx'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };

ok('every payment method an expense can be paid with is offered, rows or none',
  /const methodOptions = \[\.\.\.new Set\(\[\.\.\.EXPENSE_METHODS\.map\(m => m\.code\), \.\.\.expenses\.map\(methodOf\)\]\)\];/.test(src));
ok('every staff member is offered as who paid, plus anyone found in the rows',
  /\.\.\.staff\.map\(s => \[s\.id, s\.name\]/.test(src) && /\.\.\.expenses\.filter\(e => e\.paid_by\)\.map\(e => \[e\.paid_by as string/.test(src));
ok('the staff list is loaded with the page', /api\.get<StaffMember\[\]>\('\/api\/staff'\)/.test(src));
ok('the selects still list them', /\{methodOptions\.map\(m => <option key=\{m\} value=\{m\}>\{methodName\(m\)\}<\/option>\)\}/.test(src)
  && /\{payerOptions\.map\(\(\[id, name\]\) => <option key=\{id\} value=\{id\}>\{name\}<\/option>\)\}/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
