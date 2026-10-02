/**
 * pos-back-to-portal.test.mjs — A222 source guard (rule 24), mutation-checkable.
 * The cashier screen shows a "Manager portal" back button, gated on the role-based
 * portal signal (resolveRoute), navigating to /manager. Hidden for plain cashiers.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cs = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/pos/CashierScreen.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

ok('A222: derives hasManagerPortal from resolveRoute (role-based portal signal)', () => {
  assert.match(cs, /const hasManagerPortal = [\s\S]*?resolveRoute\(session\.permissions, session\.role\) === '\/manager'/);
});
ok('A222: the back button is gated on hasManagerPortal', () => {
  assert.match(cs, /\{hasManagerPortal && \(/);
});
ok('A222: the button navigates to the manager portal', () => {
  assert.match(cs, /onClick=\{\(\) => navigate\('\/manager'\)\}/);
  assert.match(cs, /Manager portal/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
