// A573 (2026-10-22) — the till speaks the business's words: "Menu" and "Menus" at a restaurant or café, "Products" and
// "Departments" at a shop, "Groups" anywhere else.
//
// Owner, on a retail business's dashboard (Catalogue › Menus — "Food, Soft drinks, Alcohol, Tea"): "the items in the
// navigation bar, strangley enough in retail businness their is a menu item … please read all business menu and name items
// correctly ensure hotel references hav been removed everywere".
//
// RUNS the shared helper (src/shared/businessTerms.ts — the web runs the same file), lib/managerNav.ts (the Manager
// sidebar) and lib/posMode.ts, and the till's MenuBar / CategoryPanel (bundled with esbuild, rendered with
// react-dom/server); pins the wiring in ManagerPage and POSPage (big components — read from the source).
//
//   cd apps/desktop && node test/business-terms-a573.test.mjs
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-22):
//   - relabelCatalogue returning the nav untouched                 → "a shop's Manager sidebar says Products" fails
//   - the till's MenuBar ignoring its label                         → "the top tabs say Departments" fails
//   - POSPage passing no words to the panel                         → "the sale screen passes the business's words" fails
//   - businessTerms.retail back to Menus                            → "the till and the web read one word per type" fails
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const require = createRequire(import.meta.url);
const src = (p) => fs.readFileSync(path.join(desktop, 'src', p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const bundleDir = fs.mkdtempSync(path.join(desktop, 'node_modules', '.a573-'));
const bundle = (entry, out) => {
  require('esbuild').buildSync({ entryPoints: [path.join(desktop, entry)], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom'] });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};

const T = await import(pathToFileURL(path.join(desktop, 'src', 'shared', 'businessTerms.ts')).href);
const N = await import(pathToFileURL(path.join(desktop, 'src', 'renderer', 'lib', 'managerNav.ts')).href);
const PM = await import(pathToFileURL(path.join(desktop, 'src', 'renderer', 'lib', 'posMode.ts')).href);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const h = React.createElement;

const FULL = { isRestaurant: false, canOverview: true, canOrders: true, canItems: true, canShifts: true, canExpenses: true,
  canCloseDay: true, canMenu: true, canOffers: true, canSettings: true, canPrinting: true, canStaff: true,
  showStock: true, online: true, canTransfer: true };
const TYPES = ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'];

console.log('A573 — the till speaks the business\'s words\n');
try {
  ok('the till and the web read one word per type (the same file; the till\'s mode is the same type)', (() => {
    const shared = fs.readFileSync(path.join(desktop, '..', '..', 'shared', 'businessTerms.ts'), 'utf8');
    if (src('shared/businessTerms.ts') !== shared) return false;
    const words = TYPES.map((t) => T.businessTerms(PM.modeFlags(t).mode).menus);
    return JSON.stringify(words) === JSON.stringify(['Menus', 'Menus', 'Departments', 'Departments', 'Groups', 'Departments', 'Groups'])
      && TYPES.every((t) => T.isFoodService(PM.modeFlags(t).mode) === PM.modeFlags(t).isRestaurant);
  })());

  const shop = N.relabelCatalogue(N.buildManagerNav(FULL), T.businessTerms('retail').catalogue);
  const rest = N.relabelCatalogue(N.buildManagerNav({ ...FULL, isRestaurant: true }), T.businessTerms('restaurant').catalogue);
  const menuGroup = (nav) => nav.find((g) => g.key === 'menu');
  ok('a shop\'s Manager sidebar says Products [Products · Offers]; a restaurant\'s Menu [Menu · Offers]',
    menuGroup(shop).label === 'Products' && JSON.stringify(menuGroup(shop).tabs.map((t) => t.label)) === '["Products","Offers"]'
    && menuGroup(rest).label === 'Menu' && JSON.stringify(menuGroup(rest).tabs.map((t) => t.label)) === '["Menu","Offers"]',
    JSON.stringify(menuGroup(shop)));
  ok('only the words change: Import and Combos still open inside it, the other groups untouched',
    N.groupOf(shop, 'import')?.label === 'Products' && N.groupOf(shop, 'combos')?.key === 'menu'
    && JSON.stringify(shop.filter((g) => g.key !== 'menu')) === JSON.stringify(N.buildManagerNav(FULL).filter((g) => g.key !== 'menu')));
  ok('no food word in a shop\'s Manager sidebar', !/menu|kitchen|item mix/i.test(JSON.stringify(shop.map((g) => [g.label, g.tabs.map((t) => t.label)]))));

  const CP = await bundle('src/renderer/components/CategoryPanel.tsx', 'panel.mjs');
  const tabs = [{ id: 'all', name: 'All menus', color: null, icon: null }, { id: 'g', name: 'Groceries', color: null, icon: null }];
  const bar = renderToStaticMarkup(h(CP.MenuBar, { tabs, active: 'g', onPick() {}, label: 'Departments' }));
  ok('the top tabs say Departments when told; "Menus" when not (a restaurant, A566 as before)',
    /role="tablist" aria-label="Departments"/.test(bar)
    && /role="tablist" aria-label="Menus"/.test(renderToStaticMarkup(h(CP.MenuBar, { tabs, active: 'g', onPick() {} }))), bar);
  const panel = { open: true, prefs: { pinned: false, menu: 'all' }, setOpen() {}, setPinned() {}, setMenu() {}, picked() {} };
  const html = renderToStaticMarkup(h(CP.default, { panel, categories: [{ id: 'c', name: 'Soap', menu_id: 'g' }],
    menus: [{ id: 'g', name: 'Groceries', sort_order: 1, active: true }], products: [], activeMenu: 'all', activeCategory: 'all',
    onMenu() {}, onCategory() {}, overlay: false, menusLabel: 'Departments', allMenusLabel: 'All departments' }));
  ok('the panel\'s own tabs say "All departments", never "All menus"', />All departments</.test(html) && !/All menus/.test(html), html);

  const pos = src('renderer/pages/POSPage.tsx');
  ok('the sale screen passes the business\'s words (the bar, the panel, the chip)',
    pos.includes('const words = businessTerms(flags.mode);')
    && pos.includes('<MenuBar tabs={menuBar} active={activeMenu} onPick={pickMenu} label={words.menus} hints={hours.hints}')   // A578: + the hours' hints and Show all
    && pos.includes('menusLabel={words.menus} allMenusLabel={words.allMenus}')
    && pos.includes('`${chosenMenuName} ${words.menu.toLowerCase()}`'));
  const mp = src('renderer/pages/ManagerPage.tsx');
  ok('the Manager screen: the sidebar, the catalogue page and the import in the business\'s words',
    mp.includes('const words = businessTerms(flags.mode);') && mp.includes('const nav = relabelCatalogue(buildManagerNav({')
    && /\}\), words\.catalogue\);/.test(mp) && mp.includes('title={words.catalogue} />') && mp.includes('what={words.importWhat} />'));
  ok('MenuWorkbench and ImportTab show what they are told ("Menu" / "menu" when not)',
    src('renderer/pages/MenuWorkbench.tsx').includes('<h2 className="text-lg font-bold text-white">{title}</h2>')
    && src('renderer/pages/ManageTabs.tsx').includes('Import {what} from a spreadsheet'));
} finally {
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
