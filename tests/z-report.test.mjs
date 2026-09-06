/**
 * z-report.test.mjs — A231 source guards (rule 24), mutation-checkable.
 * The manager Shifts report can print a Z REPORT per shift, reading the REAL
 * server fields (order_revenue / cash_variance), with expected/counted/variance
 * in the totals. Also fixes the Shifts tab reading the mis-typed variance/total_revenue.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rp = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerReportsPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

ok('A231: printZReport builds a Z REPORT via the shared engine', () => {
  assert.match(rp, /import \{ printDocument \}/);
  assert.match(rp, /const printZReport = /);
  assert.match(rp, /docType: 'Z REPORT'/);
});
ok('A231: reads the REAL server fields (order_revenue / cash_variance)', () => {
  assert.match(rp, /r\.order_revenue \?\? r\.total_revenue/);
  assert.match(rp, /r\.cash_variance \?\? r\.variance/);
});
ok('A231: expected / counted / variance in the totals', () => {
  assert.match(rp, /label: 'Expected cash'/);
  assert.match(rp, /label: 'Counted cash'/);
  assert.match(rp, /label: 'Variance'/);
});
ok('A231: a Print Z button on each shift row', () => {
  assert.match(rp, /onClick=\{\(\) => printZReport\(r\)\}/);
  assert.match(rp, /Print Z/);
});
ok('A231: Shifts tab now shows real revenue (order_revenue), not the mis-typed field', () => {
  assert.match(rp, /const revenue  = r\.order_revenue \?\? r\.total_revenue \?\? null;/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
