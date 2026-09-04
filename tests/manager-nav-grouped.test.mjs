/**
 * manager-nav-grouped.test.mjs — A133 Slice 2 (manager dashboard nav parity).
 *
 * Slice 1 grouped the OWNER sidebar into labelled sections. Slice 2 does the same
 * for the manager dashboard's flat NAV_ITEMS: each item carries a `group`, and the
 * sidebar renders GROUP_ORDER sections with an uppercase header, honouring the
 * existing permission filter. This pins the grouping + the grouped render.
 *
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mgr  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('nav items carry a group + GROUP_ORDER defines the section order', () => {
  assert.match(mgr, /interface NavItem \{[^}]*group: string \| null;[^}]*\}/,
    'NavItem must include a group field');
  assert.match(mgr, /const GROUP_ORDER: \(string \| null\)\[\] = \[null, 'Inventory', 'Finance', 'Customers', 'Settings'\]/,
    'GROUP_ORDER must define the section order');
});

ok('the settings-like items are grouped under Settings (parity with owner)', () => {
  assert.match(mgr, /key: 'staff',[\s\S]*?group: 'Settings'/, 'Staff must be in the Settings group');
  assert.match(mgr, /key: 'printers',[\s\S]*?group: 'Settings'/, 'Printers must be in the Settings group');
});

ok('the sidebar renders grouped sections with headers, honouring permissions', () => {
  assert.match(mgr, /GROUP_ORDER\.map\(group => \{[\s\S]*?visibleNav\.filter\(i => i\.group === group\)/,
    'the sidebar must iterate GROUP_ORDER and filter visibleNav by group');
  assert.match(mgr, /\{group && sidebarOpen &&[\s\S]*?uppercase tracking-wider/,
    'each non-top group must render an uppercase section header (when the sidebar is open)');
  assert.match(mgr, /if \(items\.length === 0\) return null;/,
    'a group with no visible (permitted) items must not render a header');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
