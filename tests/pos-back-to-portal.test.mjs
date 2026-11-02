/**
 * pos-back-to-portal.test.mjs — A222 source guard (rule 24), mutation-checkable.
 * The cashier screen shows a "Manager portal" back button, gated on the role-based
 * portal signal (resolveRoute), navigating to /manager. Hidden for plain cashiers.
 * A608 (2026-10-29): the web manager portal is retired — the button is now "← Dashboard", shown when the POS was opened
 * from the dashboard (session.fromDashboard), navigating to /dashboard.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cs = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/pos/CashierScreen.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// A608 (2026-10-29): the web manager portal is retired — its checks are gone; 
// the "← Manager portal" button (hasManagerPortal, navigate('/manager')) is gone from CashierScreen. Its new home is the
// "← Dashboard" way back, shown only when the POS was opened from the dashboard (session.fromDashboard).
ok('A608: the way back is derived from session.fromDashboard, not the portal route', () => {
  assert.match(cs, /const fromDashboard = session\?\.fromDashboard === true;/);
  assert.doesNotMatch(cs, /hasManagerPortal/, 'the manager-portal back button must be gone');
  assert.doesNotMatch(cs, /navigate\('\/manager'\)/, 'nothing on the cashier screen goes to the retired /manager');
});
ok('A608: the back button is gated on fromDashboard', () => {
  assert.match(cs, /\{fromDashboard && \(/);
});
ok('A608: the button navigates back to the dashboard', () => {
  assert.match(cs, /onClick=\{\(\) => navigate\('\/dashboard'\)\}/);
  assert.match(cs, /← Dashboard/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
