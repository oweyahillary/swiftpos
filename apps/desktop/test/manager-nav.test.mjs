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

// A490: each page by its own FINE key (NavAccess) — FULL is someone who holds them all (the owner).
const FULL = { isRestaurant: true, canOverview: true, canOrders: true, canItems: true, canShifts: true, canExpenses: true,
  canCloseDay: true, canMenu: true, canOffers: true, canSettings: true, canPrinting: true, canStaff: true,
  showStock: true, online: true, canTransfer: true };
// The old broad switches, as the keys they now are (canManageProducts → Menu + Offers; canManageSettings → General).
const NO_MENU = { canMenu: false, canOffers: false };
const labels = (nav) => nav.map((g) => `${g.label}${g.tabs.length > 1 ? ` [${g.tabs.map((t) => t.label).join(' · ')}]` : ''}`);

ok('an owner at a restaurant: seven sidebar items, the groups the owner asked for', () => {
  assert.deepEqual(labels(N.buildManagerNav(FULL)), [
    'Overview',
    'Sales [Orders · Item Mix · Current shift · Shift report]',
    'Expenses',
    'Close [Close Day · Close Branch]',
    'Menu [Menu · Offers]',   // A445: Offers beside the menu
    'Settings [General · Printing · Staff]',
    'Stock [Stock · Transfers]',   // A197: Transfers with the online licence and inventory.transfer
  ]);
});

ok('A460: without the online licence — no Offers, no Wastage, no Transfers (never shown)', () => {
  const nav = N.buildManagerNav({ ...FULL, online: false, canWaste: true });
  const keys = nav.flatMap((g) => g.tabs.map((t) => t.key));
  assert.ok(!keys.includes('offers') && !keys.includes('wastage') && !keys.includes('transfers') && keys.includes('menu'), JSON.stringify(keys));
});

ok('A466: the Monthly pack is the last Sales tab, only for reports.monthly_pack / expenses.manage (the rule the cloud applies)', () => {
  assert.deepEqual(N.groupOf(N.buildManagerNav({ ...FULL, canMonthly: true }), 'monthly').tabs.map((t) => t.label),
    ['Orders', 'Item Mix', 'Current shift', 'Shift report', 'Monthly pack']);
  assert.equal(N.groupOf(N.buildManagerNav({ ...FULL, canMonthly: false }), 'monthly'), null);
  assert.equal(N.groupOf(N.buildManagerNav({ ...FULL, online: false, canMonthly: true }), 'monthly').key, 'sales', 'not part of the online licence');
});
ok('A545: Credit sales (a manager confirms every sale on account) is a Sales tab, only for customers.credit, licence or not', () => {
  assert.deepEqual(N.groupOf(N.buildManagerNav({ ...FULL, canMonthly: true, canCredit: true, online: false }), 'credit').tabs.map((t) => t.label),
    ['Orders', 'Item Mix', 'Current shift', 'Shift report', 'Monthly pack', 'Credit sales']);
  assert.equal(N.groupOf(N.buildManagerNav({ ...FULL, canCredit: false }), 'credit'), null);
});

ok('a shop (not a restaurant): Sales has no Item Mix; no web POS → no Stock', () => {
  const nav = N.buildManagerNav({ ...FULL, isRestaurant: false, showStock: false, online: false });   // no web POS = no online licence (A460)
  assert.deepEqual(N.groupOf(nav, 'orders').tabs.map((t) => t.key), ['orders', 'shift', 'zreport']);
  assert.equal(nav.find((g) => g.key === 'stock'), undefined);
});

ok('every tab keeps its own permission: Settings shows only what the role may open', () => {
  const printOnly = N.buildManagerNav({ ...FULL, canSettings: false, ...NO_MENU, canStaff: false });
  assert.deepEqual(N.groupOf(printOnly, 'printers').tabs.map((t) => t.key), ['printers'], 'one tab → no tab bar');
  const staffOnly = N.buildManagerNav({ ...FULL, canSettings: false, ...NO_MENU, canPrinting: false });
  assert.deepEqual(staffOnly.find((g) => g.key === 'settings').tabs.map((t) => t.key), ['staff']);
  // A600: Backup is the last Settings tab, for the owner or a manager (canBackup); absent → no tab.
  assert.deepEqual(N.buildManagerNav({ ...FULL, canBackup: true }).find((g) => g.key === 'settings').tabs.map((t) => t.label), ['General', 'Printing', 'Staff', 'Backup']);
  assert.deepEqual(N.buildManagerNav({ ...FULL, canSettings: false, canPrinting: false, canStaff: false, canBackup: true }).find((g) => g.key === 'settings').tabs.map((t) => t.key), ['backup']);
  assert.equal(staffOnly.find((g) => g.key === 'menu'), undefined, 'no menu.edit / menu.prices / menu.offers → no Menu');
  // A490: Offers alone (menu.offers) keeps the Menu group with Offers only.
  assert.deepEqual(N.buildManagerNav({ ...FULL, canMenu: false }).find((g) => g.key === 'menu').tabs.map((t) => t.key), ['offers']);
});

ok('a role with only the reports: no Close, Menu or Settings in the sidebar at all', () => {
  const nav = N.buildManagerNav({ ...FULL, canCloseDay: false, ...NO_MENU, canSettings: false, canPrinting: false, canStaff: false, showStock: false, canTransfer: false });
  assert.deepEqual(nav.map((g) => g.key), ['overview', 'sales', 'expenses']);
  assert.ok(nav.every((g) => g.tabs.length > 0));
});

ok('A490: a person with no key for a page does not see it — even the Overview; one key is one page', () => {
  const none = { isRestaurant: true, canOverview: false, canOrders: false, canItems: false, canShifts: false, canExpenses: false,
    canCloseDay: false, canMenu: false, canOffers: false, canSettings: false, canPrinting: false, canStaff: false, showStock: false };
  assert.deepEqual(N.buildManagerNav(none), []);
  assert.equal(N.firstTab(N.buildManagerNav(none)), null);
  const ordersOnly = N.buildManagerNav({ ...none, canOrders: true });
  assert.deepEqual(labels(ordersOnly), ['Sales']);
  assert.equal(N.firstTab(ordersOnly), 'orders', 'opens on the one page they have, not the Overview');
  assert.equal(N.firstTab(ordersOnly, 'dayclose'), 'orders', 'a page asked for that they do not have → their first');
  assert.equal(N.firstTab(N.buildManagerNav(FULL), 'dayclose'), 'dayclose');
  assert.deepEqual(N.buildManagerNav({ ...none, canShifts: true }).flatMap((g) => g.tabs.map((t) => t.key)), ['shift', 'zreport']);
  assert.deepEqual(N.buildManagerNav({ ...none, canItems: true }).flatMap((g) => g.tabs.map((t) => t.key)), ['items']);
  assert.deepEqual(N.buildManagerNav({ ...none, canItems: true, isRestaurant: false }), [], 'Item Mix is a restaurant page');
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
  assert.equal(N.groupOf(N.buildManagerNav({ ...FULL, ...NO_MENU }), 'import'), null);
});

ok('every page ManagerPage can show belongs to exactly one group', () => {
  const nav = N.buildManagerNav(FULL);
  for (const t of ['overview', 'orders', 'items', 'shift', 'zreport', 'expenses', 'dayclose', 'branchclose', 'menu', 'offers',
    'settings', 'printers', 'staff', 'stock', 'transfers']) {
    assert.equal(nav.filter((g) => g.tabs.some((x) => x.key === t)).length, 1, t);
  }
});

const mp = fs.readFileSync(path.join(DESKTOP, 'src/renderer/pages/ManagerPage.tsx'), 'utf8');
ok('ManagerPage renders the sidebar from buildManagerNav with each page\'s own gate', () => {
  // A490: each page by its own fine key — never a role's name. A545: Credit sales is customers.credit.
  assert.match(mp, /const nav = relabelCatalogue\(buildManagerNav\(\{\n\s+isRestaurant: flags\.isRestaurant,\n\s+canOverview: has\('reports\.overview'\),\n\s+canOrders: has\('orders\.view_all'\),\n\s+canItems: has\('reports\.items'\),\n\s+canShifts: hasAny\('reports\.shifts', 'shifts\.confirm'\),\n\s+canMonthly: has\('reports\.monthly_pack'\) \|\| has\('expenses\.manage'\),\n\s+canCredit: has\('customers\.credit'\),   \/\/ A545\n\s+canExpenses: hasAny\('expenses\.view', 'expenses\.manage'\),\n\s+canCloseDay: has\('shifts\.close_day'\),\n\s+canCloseBranch: has\('shifts\.close_branch'\),[^\n]*\n\s+isBranchServer,[^\n]*\n\s+canMenu: hasAny\('menu\.edit', 'menu\.prices'\),\n\s+canOffers: has\('menu\.offers'\),\n\s+canSettings: hasAny\('settings\.business', 'settings\.payments'\) \|\| mayMpesa\(staff\),[^\n]*\n\s+canPrinting: has\('stations\.manage'\) \|\| canManageReceipt,\n\s+canStaff: hasAny\('staff\.view', 'staff\.edit'\),\n\s+canBackup: hasAny\('settings\.business', 'shifts\.close_branch'\),[^\n]*\n\s+showStock,\n\s+canWaste: has\('inventory\.waste'\),   \/\/ A414\n\s+online,   \/\/ A460\n\s+canTransfer: has\('inventory\.transfer'\),[^\n]*\n\s+canBranchStock: has\('inventory\.view'\),[^\n]*\n\s+branchRequests,[^\n]*\n\s+canLabels: hasAny\('menu\.edit', 'inventory\.view'\),[^\n]*\n\s+\}\), words\.catalogue\);/);   // A564: Other branches; A571: Labels
  assert.ok(!/\['owner', 'admin'\]|MANAGER_ROLES|isManagerRole/.test(mp), 'no role-name gate left');
  assert.match(mp, /\{nav\.map\(group => \(\n\s+<button key=\{group\.key\} onClick=\{\(\) => openTab\(openGroup\(group, lastTab\)\)\}/);
  assert.ok(!/navItems/.test(mp), 'the old flat list is gone');
});
ok('the tab bar shows only when the group has more than one tab for this role', () => {
  assert.match(mp, /\{activeGroup && activeGroup\.tabs\.length > 1 && \(/);
  assert.match(mp, /<SegmentedSelector options=\{activeGroup\.tabs\} value=\{active\} onChange=\{openTab\} \/>/);
});
ok('each tab renders its own page (no nested Orders/Shift selectors left)', () => {
  // A444: the Orders page also gets who may void / refund from its row panel.
  assert.match(mp, /case 'orders':\s+return <OrdersTab currency=\{currency\}(?: rights=\{\{ void: has\('sales\.void'\), refund: has\('sales\.refund'\) \}\})? \/>;/);
  assert.match(mp, /case 'shift':\s+return <ShiftTab currency=\{currency\} \/>;/);
  assert.match(mp, /case 'zreport': return <ZReportTab/);
  assert.match(mp, /case 'items':\s+return <TopItemsTab/);
  assert.ok(!/function (OrdersAndMixTab|ShiftAndReportTab)/.test(mp));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
