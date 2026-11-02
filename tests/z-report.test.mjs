/**
 * z-report.test.mjs — A231 source guards (rule 24), mutation-checkable.
 * The manager Shifts report can print a Z REPORT per shift, reading the REAL
 * server fields (order_revenue / cash_variance), with expected/counted/variance
 * in the totals. Also fixes the Shifts tab reading the mis-typed variance/total_revenue.
 * A608 (2026-10-29): the manager portal is retired — the web's shift report prints from Open drawers (printShiftReport).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const os = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/OpenShiftsPage.tsx'), 'utf8');
const lib = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/printShiftReport.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// A608 (2026-10-29): the web manager portal is retired — its checks are gone; 
// A231 pinned ManagerReportsPage.tsx's A4 "Print Z" (printZReport). The web's shift report now prints from the
// dashboard's Open drawers page (printShiftReport, the desktop's renderer) — pinned below on the real server fields.
ok('A608: each shift row on Open drawers prints its shift report', () => {
  assert.match(os, /import \{ printShiftReport \} from '\.\.\/lib\/printShiftReport';/);
  assert.match(os, /printShiftReport\(s\.id\)/);
});
ok('A608: the report reads the REAL server fields (cash_variance, total_revenue)', () => {
  assert.match(lib, /api\.get<any>\(`\/api\/shifts\/\$\{shiftId\}`\)/);
  assert.match(lib, /variance:\s+shift\.cash_variance == null \? null : cents\(shift\.cash_variance\)/);
  assert.match(lib, /grossSales:\s+cents\(shift\.total_revenue\)/);
});
ok('A608: expected / counted cash in the report', () => {
  assert.match(lib, /expectedCash: cents\(shift\.expected_cash \?\? shift\.expected_cash_computed \?\? 0\)/);
  assert.match(lib, /countedCash:\s+shift\.closing_float == null \? null : cents\(shift\.closing_float\)/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
