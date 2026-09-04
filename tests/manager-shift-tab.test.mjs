/**
 * manager-shift-tab.test.mjs — A207 (manager shift oversight on the web portal).
 *
 * Web managers had no shift oversight in the portal (only by opening POS). This
 * adds a Shifts tab: open shifts at the branch + force-close a stranded drawer
 * (reason required, recorded uncounted, gated on shifts.force_close). Normal
 * cash-counted close stays on the till. "Close Day" is NOT built: business_days
 * are a desktop/offline construct (till-managed, synced up) — the web has no
 * trading-day gate, so the shift is the web's end-of-day unit.
 *
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tab = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerShiftTab.tsx'), 'utf8');
const mgr = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n       ${e.message}`); } };

ok('tab: lists OPEN shifts at the branch', () => {
  assert.match(tab, /posApi\.get<OpenShift\[\]>\('\/api\/shifts\?status=open/, 'must fetch open shifts');
});

ok('tab: force-close requires a reason + is gated on shifts.force_close', () => {
  assert.match(tab, /hasPermission\('shifts\.force_close'\)/, 'force-close must be gated on shifts.force_close');
  assert.match(tab, /if \(!target \|\| !reason\.trim\(\)\) return;/, 'a reason must be required');
  assert.match(tab, /posApi\.post\(`\/api\/shifts\/\$\{target\.id\}\/force-close`, \{ reason: reason\.trim\(\) \}\)/,
    'force-close must POST the reason');
});

ok('tab: does NOT do a silent normal close from the manager (that stays on the till)', () => {
  const muts = [...tab.matchAll(/posApi\.(?:post|patch|put|delete)\(`?'?([^`',]+)/g)].map(m => m[1]);
  assert.ok(muts.length >= 1 && muts.every(p => /\/force-close/.test(p)),
    `the only mutation must be force-close; saw: ${muts.join(', ')}`);
});

ok('dashboard: Shifts tab wired (nav + render)', () => {
  assert.match(mgr, /key: 'shift',[\s\S]*?permission: 'orders\.view_all'[\s\S]*?group: 'Finance'/, 'Shifts nav item in Finance group');
  assert.match(mgr, /case 'shift': return <ManagerShiftTab/, 'the switch must render the Shifts tab');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
