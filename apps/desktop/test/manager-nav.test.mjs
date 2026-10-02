/**
 * manager-nav.test.mjs — A351 (2026-09-28): the manager sidebar, grouped.
 *
 * Owner: "this menu is too long can we collapse some items like settings can have printer and staff, close branch and
 * close day, orders and shift" → "go with it, build 0.6.17".
 *
 *   node test/manager-nav.test.mjs
 *
 * RUNS the real src/renderer/lib/managerNav.ts (type-stripped): which groups and tabs each role sees, where a sidebar
 * tap lands, and that pages opened from inside another (Menu → Import) stay in their group. Then pins that
 * ManagerPage renders from it (React is not run here).
 *
 * MUTATIONS TO CONFIRM BITE: drop `.filter((g) => g.tabs.length > 0)` → "a cashier-level role" fails; openGroup always
 * returns tabs[0] → "remembers the last tab" fails; Close Branch first → "Close opens on Close Day" fails; the tab bar
 * condition `> 1` → `> 0` → the source pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.MANAGER_NAV_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, MANAGER_NAV_TS: '1' } });
  process.exit(r.status ?? 1);
}
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = await import(pathToFileURL(path.join(DESKTOP, 'src/renderer/lib/managerNav.ts')).href);
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const FULL = { isRestaurant: true, isManagerRole: true, canManageProducts: true, canManageStaff: true,
  canManageSettings: true, canPrinting: true, showStock: true };
const labels = (nav) => nav.map((g) => `${g.label}${g.tabs.length > 1 ? ` [${g.tabs.map((t) => t.label).join(' · ')}]` : ''}`);

ok('an owner at a restaurant: seven sidebar items, the groups the owner asked for', () => {
  assert.deepEqual(labels(N.buildManagerNav(FULL)), [
    'Overview',
    'Sales [Orders · Item Mix · Current shift · Shift report]',
    'Expenses',
    'Close [Close Day · Close Branch]',
    'Menu',
    'Settings [General · Printing · Staff]',
    'Stock',
  ]);
});

ok('a shop (not a restaurant): Sales has no Item Mix; no web POS → no Stock', () => {
  const nav = N.buildManagerNav({ ...FULL, isRestaurant: false, showStock: false });
  assert.deepEqual(N.groupOf(nav, 'orders').tabs.map((t) => t.key), ['orders', 'shift', 'zreport']);
  assert.equal(nav.find((g) => g.key === 'stock'), undefined);
});

ok('every tab keeps its own permission: Settings shows only what the role may open', () => {
  const printOnly = N.buildManagerNav({ ...FULL, canManageSettings: false, canManageProducts: false, canManageStaff: false });
  assert.deepEqual(N.groupOf(printOnly, 'printers').tabs.map((t) => t.key), ['printers'], 'one tab → no tab bar');
  const staffOnly = N.buildManagerNav({ ...FULL, canManageSettings: false, canManageProducts: false, canPrinting: false });
  assert.deepEqual(staffOnly.find((g) => g.key === 'settings').tabs.map((t) => t.key), ['staff']);
  assert.equal(staffOnly.find((g) => g.key === 'menu'), undefined, 'no products.manage → no Menu');
});

ok('a cashier-level role: no Close, Menu or Settings in the sidebar at all', () => {
  const nav = N.buildManagerNav({ isRestaurant: true, isManagerRole: false, canManageProducts: false, canManageStaff: false,
    canManageSettings: false, canPrinting: false, showStock: false });
  assert.deepEqual(nav.map((g) => g.key), ['overview', 'sales', 'expenses']);
  assert.ok(nav.every((g) => g.tabs.length > 0));
});

ok('Close opens on Close Day (the everyday one); Close Branch is a deliberate second tap', () => {
  const close = N.buildManagerNav(FULL).find((g) => g.key === 'close');
  assert.equal(N.openGroup(close, {}), 'dayclose');
  assert.deepEqual(close.tabs.map((t) => t.key), ['dayclose', 'branchclose']);
});

ok('a group remembers the last tab used in it — and forgets one the role can no longer open', () => {
  const nav = N.buildManagerNav(FULL);
  const settings = nav.find((g) => g.key === 'settings');
  assert.equal(N.openGroup(settings, {}), 'settings');
  assert.equal(N.openGroup(settings, { settings: 'printers' }), 'printers');
  const noPrinting = N.buildManagerNav({ ...FULL, canPrinting: false }).find((g) => g.key === 'settings');
  assert.equal(N.openGroup(noPrinting, { settings: 'printers' }), 'settings');
});

ok('Menu → Import stays in the Menu group (sidebar highlight and page title)', () => {
  const nav = N.buildManagerNav(FULL);
  assert.equal(N.groupOf(nav, 'import').key, 'menu');
  assert.equal(N.groupOf(N.buildManagerNav({ ...FULL, canManageProducts: false }), 'import'), null);
});

ok('every page ManagerPage can show belongs to exactly one group', () => {
  const nav = N.buildManagerNav(FULL);
  for (const t of ['overview', 'orders', 'items', 'shift', 'zreport', 'expenses', 'dayclose', 'branchclose', 'menu',
    'settings', 'printers', 'staff', 'stock']) {
    assert.equal(nav.filter((g) => g.tabs.some((x) => x.key === t)).length, 1, t);
  }
});

const mp = fs.readFileSync(path.join(DESKTOP, 'src/renderer/pages/ManagerPage.tsx'), 'utf8');
ok('ManagerPage renders the sidebar from buildManagerNav with each page\'s own gate', () => {
  assert.match(mp, /const nav = buildManagerNav\(\{\n\s+isRestaurant: flags\.isRestaurant,\n\s+isManagerRole,\n\s+canManageProducts,\n\s+canManageStaff,\n\s+canManageSettings,\n\s+canPrinting: has\('stations\.manage'\) \|\| canManageReceipt,\n\s+showStock,\n\s+\}\);/);
  assert.match(mp, /\{nav\.map\(group => \(\n\s+<button key=\{group\.key\} onClick=\{\(\) => openTab\(openGroup\(group, lastTab\)\)\}/);
  assert.ok(!/navItems/.test(mp), 'the old flat list is gone');
});
ok('the tab bar shows only when the group has more than one tab for this role', () => {
  assert.match(mp, /\{activeGroup && activeGroup\.tabs\.length > 1 && \(/);
  assert.match(mp, /<SegmentedSelector options=\{activeGroup\.tabs\} value=\{active\} onChange=\{openTab\} \/>/);
});
ok('each tab renders its own page (no nested Orders/Shift selectors left)', () => {
  assert.match(mp, /case 'orders':\s+return <OrdersTab currency=\{currency\} \/>;/);
  assert.match(mp, /case 'shift':\s+return <ShiftTab currency=\{currency\} \/>;/);
  assert.match(mp, /case 'zreport': return <ZReportTab/);
  assert.match(mp, /case 'items':\s+return <TopItemsTab/);
  assert.ok(!/function (OrdersAndMixTab|ShiftAndReportTab)/.test(mp));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
