/**
 * A258/A259 — Overview layout (Top Items + Payment Methods side by side) and the
 * reports fixes (cashier name falls back to email instead of "Unknown"; open
 * shifts appear in the period even when opened earlier).
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('A258: Overview puts Top Items + Payment Methods in a 2-col grid (no blank)', () => {
  const d = r('apps/dashboard/src/pages/manager/ManagerDashboard.tsx');
  assert.match(d, /grid grid-cols-1 lg:grid-cols-2 gap-4">\s*\n\s*\{hourly\.length > 0/);
  assert.match(d, /Payment methods — beside Top Items/);
  assert.doesNotMatch(d, /grid grid-cols-1 sm:grid-cols-3 gap-4/); // payment methods restacked for the narrower column
});
ok('A259: staff report falls back to email when name is null (not "Unknown")', () => {
  const rep = r('apps/server/src/routes/reports.ts');
  assert.match(rep, /userMap\[u\.id\] = u\.name \|\| u\.email \|\| 'Unknown'/);
  assert.match(rep, /nameMap\[u\.id\] = u\.name \|\| u\.email \|\| 'Unknown'/);
});
ok('A259: shift queries include active OPEN shifts opened before the period', () => {
  const rep = r('apps/server/src/routes/reports.ts');
  // the two user-facing shift reports (Shifts tab + Summary Z-report) now include open shifts;
  // the labour report's status='closed' query is intentionally left exclusive.
  assert.strictEqual((rep.match(/status\.eq\.open,opened_at\.gte\.\$\{start\}/g) || []).length, 2);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'} (${pass} passed)`);
process.exit(fail ? 1 : 0);
