/**
 * pos-manager-open.test.mjs — A206 (manager "Open POS" opens nothing).
 *
 * The manager dashboard's "Open POS" navigates to /pos/cashier, but CashierScreen's
 * mount guard redirected anyone whose resolveRoute home wasn't '/pos/cashier' — a
 * manager's home is '/manager', so it bounced them straight back and nothing opened.
 * Managers hold orders.create and are entitled to ring sales. Fix: the guard now
 * only redirects the OWNER (dest === '/'); managers and cashiers stay.
 *
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cashier = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/pos/CashierScreen.tsx'), 'utf8');
const routing = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/posRouting.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

ok('routing: a manager resolves to /manager (why the old guard bounced them)', () => {
  // A490: by permission, not role name — anyone holding a key beyond the shop floor's (isBackOffice) lands on /manager.
  assert.match(routing, /if \(isBackOffice\(backOfficeKeys\(permissions\)\)\) return '\/manager'/, 'managers resolve to /manager');
  assert.doesNotMatch(routing, /MANAGER_ROLE_NAMES|toLowerCase\(\)/, 'no role names decide the route');
});

ok('cashier guard: only the OWNER is redirected (managers may ring sales)', () => {
  // A608: … and not even the owner when they opened the POS from the dashboard (Open POS — they sell as themselves).
  assert.match(cashier, /if \(dest === '\/' && !session\.fromDashboard\) navigate\(dest, \{ replace: true \}\);/,
    "the guard must redirect only dest === '/' (owner), and not an owner who opened the POS from the dashboard");
  assert.doesNotMatch(cashier, /if \(dest !== '\/pos\/cashier'\) navigate/,
    'the old over-broad guard (bounces managers) must be gone');
});

// A608 (2026-10-29): the web manager portal is retired — its checks are gone; 
// the portal's Open POS button is gone; Open POS from the dashboard is pinned by staff-signin-by-role-a608.

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
