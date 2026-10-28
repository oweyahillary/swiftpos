// A573 (2026-10-22) — each business type reads its own words; food-service ("hotel") words and areas only at a restaurant.
//
// Owner, on Magas Limited's dashboard (a retail business: CATALOGUE › Menus, "Group your categories into menus — Food, Soft
// drinks, Alcohol, Tea …"): "the items in the navigation bar, strangley enough in retail businness their is a menu item i
// dont know if this is replicated across all businesses please read all business menu and name items correctly ensure hotel
// references hav been removed everywere and correct items replace them".
//
// RUNS the shared helper (shared/businessTerms.ts and its web copy), the web dashboard's sidebar (DashboardLayout, bundled
// with esbuild, its contexts stubbed, rendered with react-dom/server inside a MemoryRouter), the Menus page, Settings ›
// Business's setup tab, Devices and printers, and the web POS's MenuBar / CategoryPanel; pins the wiring that is one
// line in a big screen (the manager portal, the web POS, the roles screen, POS options). And scans every app's source for
// a user-visible "hotel".
//
//   node tests/business-terms-a573.test.mjs
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-22):
//   - GROUPING.retail back to Menus                                   → H "retail and minimart: Departments" fails
//   - DashboardLayout's relabel dropping the menus line                 → N "retail sidebar: Departments" fails
//   - FOOD_VERTICALS widened to every type (DashboardLayout)            → N "retail: no food-only entries" fails
//   - VerticalSetupRoute's default back to RestaurantSettingsPage       → S "retail setup is the shop's" fails
//   - the Kitchen display tab shown to every type                       → S "Devices and printers" fails
//   - permissionWords returning the catalogue's words for a shop        → R "a shop reads product words" fails
//   - "hotel room" put back on the web POS                              → X "no user-visible hotel" fails
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'apps/dashboard');
const require = createRequire(path.join(DASH, 'package.json'));
let pass = 0, fail = 0;
const ok = async (n, fn) => {
  try { await fn(); console.log(`PASS  ${n}`); pass++; } catch (e) { console.log(`FAIL  ${n}  ${e?.message ?? e}`); fail++; }
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Stubs for what the screens read from the app (contexts, the API, heavy child pages) — the business type comes from
// globalThis.__a573Type, so one bundle renders every type.
const STUBS = {
  AuthContext: 'export const useAuth = () => ({ signOut() {}, session: null, user: null });',
  BusinessContext: 'export const useBusiness = () => ({ business: globalThis.__a573Type === undefined ? null : { name: "Magas Limited", type: globalThis.__a573Type, currency: "KES" }, loading: false, refresh() {} });',
  ThemeContext: 'export const useTheme = () => ({ theme: "dark", toggleTheme() {} });',
  BranchContext: 'export const useBranch = () => ({ activeBranchId: null, branches: [], setActiveBranch() {} });',
  PermissionsContext: 'export const usePermissions = () => ({ can: () => true, isOwner: true });',
  api: 'export const api = { get: async () => ({}), post: async () => ({}), patch: async () => ({}), put: async () => ({}), delete: async () => ({}) };',
  BranchSelector: 'export default function BranchSelector() { return null; }',
  ReleaseBadge: 'export default function ReleaseBadge() { return null; }',
  CloudTrialNotice: 'export default function CloudTrialNotice() { return null; }',
  ReportSchedulerTab: 'export default function X() { return null; }',
  WebhooksTab: 'export default function X() { return null; }',
  DevicesTab: 'export default function X() { return null; }',
  RestaurantSettingsPage: 'import { jsx } from "react/jsx-runtime"; export default function X() { return jsx("p", { children: "PAGE:restaurant" }); }',
  MinimartSettingsPage: 'import { jsx } from "react/jsx-runtime"; export default function X() { return jsx("p", { children: "PAGE:shop" }); }',
  ParkingSettingsPage: 'import { jsx } from "react/jsx-runtime"; export default function X() { return jsx("p", { children: "PAGE:parking" }); }',
  PetrolSettingsPage: 'import { jsx } from "react/jsx-runtime"; export default function X() { return jsx("p", { children: "PAGE:petrol" }); }',
  SettingsSection: 'import { jsx } from "react/jsx-runtime"; export default function S({ title, tabs }) { return jsx("p", { children: title + ":" + tabs.map((t) => t.label).join("|") }); }',
};
const stubPlugin = {
  name: 'a573-stubs',
  setup(b) {
    const re = new RegExp(`(?:^|/)(${Object.keys(STUBS).join('|')})$`);
    b.onResolve({ filter: re }, (a) => ({ path: a.path.match(re)[1], namespace: 'a573' }));
    b.onLoad({ filter: /.*/, namespace: 'a573' }, (a) => ({ contents: STUBS[a.path], loader: 'js', resolveDir: DASH }));
  },
};
const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.a573-'));
const bundle = async (entry, out) => {
  await require('esbuild').build({ entryPoints: [path.join(DASH, entry)], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic',
    external: ['react', 'react-dom', 'react-router-dom', 'react/jsx-runtime'], plugins: [stubPlugin] });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};

const TYPES = ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'];

try {
  const T = await import(pathToFileURL(path.join(ROOT, 'shared/businessTerms.ts')).href);
  const P = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { MemoryRouter, Routes, Route } = require('react-router-dom');
  const h = React.createElement;
  const quiet = console.error;   // react-router's useLayoutEffect warning on the server — noise, not a finding
  console.error = (...a) => { if (!String(a[0]).includes('useLayoutEffect')) quiet(...a); };

  console.log('\nH. the helper — one word per type\n');
  await ok('the types are the cloud\'s (adminRules BUSINESS_TYPES); the copies are identical', () => {
    const rules = read('apps/server/src/lib/adminRules.ts');
    assert.match(rules, new RegExp(`BUSINESS_TYPES = \\[${TYPES.map((t) => `'${t}'`).join(', ')}\\]`));
    assert.deepEqual([...T.BUSINESS_TYPE_KEYS], TYPES);
    const s = read('shared/businessTerms.ts');
    for (const c of ['apps/dashboard/src/lib/businessTerms.ts', 'apps/desktop/src/shared/businessTerms.ts']) assert.equal(read(c), s, c);
    assert.match(read('scripts/check-shared-sync.mjs'), /name: 'businessTerms\.ts'/);
  });
  await ok('restaurant and café: Menus (Food, Soft drinks …), the Menu section, the Menu page', () => {
    for (const t of ['restaurant', 'cafe']) {
      const w = T.businessTerms(t);
      assert.equal(w.food, true, t);
      assert.deepEqual([w.menu, w.menus, w.allMenus, w.noMenu, w.catalogueGroup, w.catalogue, w.stockGroup], ['Menu', 'Menus', 'All menus', 'No menu', 'Menu', 'Menu', 'Inventory'], t);
      assert.ok(w.menuExamples.includes('Food'), t);
      assert.equal(w.products, 'Menu Items');
    }
  });
  await ok('retail and minimart: Departments (Groceries, Beverages …), Catalogue, Products, Stock — never a food word', () => {
    for (const t of ['retail', 'minimart']) {
      const w = T.businessTerms(t);
      assert.equal(w.food, false, t);
      assert.deepEqual([w.menu, w.menus, w.allMenus, w.noMenu, w.catalogueGroup, w.catalogue, w.stockGroup], ['Department', 'Departments', 'All departments', 'No department', 'Catalogue', 'Products', 'Stock'], t);
      assert.deepEqual([...w.menuExamples], ['Groceries', 'Beverages', 'Household', 'Personal care'], t);
      assert.equal(w.products, 'Products');
      assert.equal(w.backToGrid, 'Back to the items');
      assert.doesNotMatch(JSON.stringify(Object.values(w)), /menu|food|kitchen|dish|meal|alcohol|hotel/i, t);
    }
    assert.equal(T.businessTerms('retail').setupLabel, 'Retail setup');
    assert.equal(T.businessTerms('minimart').setupLabel, 'Minimart setup');
  });
  await ok('petrol station: Departments (Lubricants, Shop …); parking and other: Groups', () => {
    const p = T.businessTerms('petrol_station');
    assert.equal(p.menus, 'Departments'); assert.ok(p.menuExamples.includes('Lubricants'));
    for (const t of ['parking', 'other']) {
      const w = T.businessTerms(t);
      assert.deepEqual([w.menu, w.menus, w.allMenus, w.food], ['Group', 'Groups', 'All groups', false], t);
      assert.doesNotMatch(JSON.stringify(Object.values(w)), /menu|food|kitchen|hotel/i, t);
    }
  });
  await ok('the type is read as the POS reads it (case, spaces); unknown → other; blank → not known yet (the food words, as before)', () => {
    assert.equal(T.businessTypeOf('Petrol Station'), 'petrol_station');
    assert.equal(T.businessTypeOf('RETAIL'), 'retail');
    assert.equal(T.businessTypeOf('salon'), 'other');
    assert.equal(T.businessTypeOf(''), null);
    assert.equal(T.businessTypeOf(null), null);
    assert.equal(T.businessTerms(null).menus, 'Menus');
    assert.equal(T.businessTerms('salon').menus, 'Groups');
  });
  await ok('food-service areas (KDS, reservations, combos, ingredients, turnover, tables, room charge, kitchen switches): a restaurant\'s and café\'s only', () => {
    for (const t of TYPES) {
      const a = T.foodAreas(t);
      const want = t === 'restaurant' || t === 'cafe';
      for (const [k, v] of Object.entries(a)) assert.equal(v, want, `${t}.${k}`);
    }
    assert.equal(Object.keys(T.foodAreas('retail')).length, 8);
  });

  console.log('\nR. the roles screen — the catalogue\'s words are frozen (migration 134), a shop reads its own at display time\n');
  await ok('a shop reads product words for the menu / kitchen / table entries; a restaurant reads the catalogue as it is', () => {
    const word = (t, key) => { const p = P.PERMISSIONS.find((x) => x.key === key); return T.permissionWords(t, key, p.label, p.description); };
    assert.equal(word('retail', 'products.view').label, 'See the products');
    assert.equal(word('retail', 'menu.edit').label, 'Add and change the products');   // A595: menu.edit after its split (deleting and bulk changes are parts)
    assert.match(word('retail', 'menu.edit').description, /departments/);
    assert.match(word('other', 'menu.edit').description, /groups/);
    assert.equal(word('restaurant', 'products.view').label, 'See the menu');
    for (const t of ['retail', 'minimart', 'parking', 'petrol_station', 'other']) {
      for (const p of P.PERMISSIONS) {
        const w = T.permissionWords(t, p.key, p.label, p.description);
        if (p.key === 'menu.recipes' || p.key === 'ingredients.manage' || p.key === 'tables.manage' || p.key === 'reservations.manage') continue;   // the food areas' own keys
        assert.doesNotMatch(`${w.label} ${w.description}`, /\bmenu\b|kitchen|table turnover|food cost/i, `${t} ${p.key}`);
      }
      for (const g of P.PERMISSION_GROUPS) assert.doesNotMatch(T.permissionGroupWords(t, g.id, g.label, g.description).label, /^Menu$/, `${t} ${g.id}`);
    }
    // The catalogue itself is untouched (migration 134's test reads its exact words).
    assert.equal(P.PERMISSIONS.find((x) => x.key === 'products.view').label, 'See the menu');
  });
  await ok('the roles screen and a staff card ask for the business\'s words', () => {
    const picker = read('apps/dashboard/src/components/PermissionPicker.tsx');
    assert.match(picker, /keys: keys\.map\(\(k\) => \(\{ \.\.\.k, \.\.\.permissionWords\(businessType, k\.key, k\.label, k\.description\) \}\)\)/);
    assert.match(picker, /groups: groups\.map\(\(g\) => \(\{ \.\.\.g, \.\.\.permissionGroupWords\(businessType, g\.id, g\.label, g\.description\) \}\)\)/);
    for (const f of ['RolesTab', 'StaffTab']) assert.match(read(`apps/dashboard/src/pages/settings/${f}.tsx`), /usePermissionCatalogue\(api, useBusiness\(\)\.business\?\.type\)/, f);
  });

  console.log('\nN. the web dashboard\'s sidebar, rendered per type\n');
  const DL = await bundle('src/components/DashboardLayout.tsx', 'layout.mjs');
  const sidebar = (type, route) => {
    globalThis.__a573Type = type;
    const html = renderToStaticMarkup(h(MemoryRouter, { initialEntries: [route] },
      h(Routes, null, h(Route, { path: '*', element: h(DL.default) }))));
    return html.slice(html.indexOf('data-testid="dashboard-sidebar"'), html.indexOf('</aside>'));
  };
  const has = (html, label) => new RegExp(`>${label}<`).test(html);
  await ok('retail sidebar: Catalogue › Departments (Groceries, Beverages …), no "Menus" anywhere — Magas Limited\'s screen', () => {
    const s = sidebar('retail', '/dashboard/menus');
    assert.ok(has(s, 'Catalogue'), 'Catalogue');
    assert.ok(has(s, 'Departments'), 'Departments');
    assert.ok(!has(s, 'Menus') && !has(s, 'Menu'), 'no Menus');
    assert.match(s, /title="Groceries, Beverages, Household, Personal care — each holds some of your categories"/);
    assert.doesNotMatch(s, /Soft drinks|Alcohol/);
    for (const l of ['Categories', 'Products', 'Print labels', 'Discounts', 'Offers']) assert.ok(has(s, l), l);
  });
  await ok('minimart and petrol: Departments; parking and other: Groups', () => {
    for (const [t, w] of [['minimart', 'Departments'], ['petrol_station', 'Departments'], ['parking', 'Groups'], ['other', 'Groups']]) {
      const s = sidebar(t, '/dashboard/menus');
      assert.ok(has(s, w), `${t}: ${w}`);
      assert.ok(!has(s, 'Menus'), `${t}: no Menus`);
    }
  });
  await ok('restaurant and café sidebar: Menu › Menus (Food, Soft drinks …), Menu Items, Menu Sections, Set Meals — as before', () => {
    for (const t of ['restaurant', 'cafe']) {
      const s = sidebar(t, '/dashboard/menus');
      for (const l of ['Menu', 'Menus', 'Menu Items', 'Menu Sections', 'Set Meals']) assert.ok(has(s, l), `${t}: ${l}`);
      assert.match(s, /title="Food, Soft drinks, Alcohol, Tea — each holds some of your categories"/);
      assert.ok(has(s, 'KDS') && has(s, 'Reservations'), `${t}: KDS, Reservations`);
    }
  });
  await ok('retail: no food-only entries (KDS, Reservations, Set Meals / Combo Meals, Ingredients, Table Turnover); Stock (not "Purchasing")', () => {
    for (const t of ['retail', 'minimart', 'petrol_station', 'parking', 'other']) {
      const cat = sidebar(t, '/dashboard/products');
      for (const l of ['KDS', 'Reservations', 'Combo Meals', 'Set Meals']) assert.ok(!has(cat, l), `${t}: ${l}`);
      const stock = sidebar(t, '/dashboard/stock/suppliers');
      assert.ok(!has(stock, 'Ingredients'), `${t}: Ingredients`);
      assert.ok(has(stock, 'Stock') && !has(stock, 'Purchasing'), `${t}: the Stock section`);
      for (const l of ['Suppliers', 'Purchase Orders', 'Stock Counts']) assert.ok(has(stock, l), `${t}: ${l}`);
      const fin = sidebar(t, '/dashboard/orders');
      assert.ok(!has(fin, 'Table Turnover'), `${t}: Table Turnover`);
    }
    const rest = sidebar('restaurant', '/dashboard/orders');
    assert.ok(has(rest, 'Table Turnover'), 'a restaurant keeps Table Turnover');
    assert.ok(has(sidebar('restaurant', '/dashboard/stock/suppliers'), 'Ingredients'), 'a restaurant keeps Ingredients');
  });
  await ok('no "hotel" or kitchen word in any type\'s sidebar but a restaurant\'s', () => {
    for (const t of ['retail', 'minimart', 'petrol_station', 'parking', 'other']) {
      for (const r of ['/dashboard/menus', '/dashboard/stock/suppliers', '/dashboard/orders', '/dashboard/customers', '/dashboard/settings/business']) {
        assert.doesNotMatch(sidebar(t, r), /hotel|kitchen|dish|dine|waiter|>Menu/i, `${t} ${r}`);
      }
    }
  });

  console.log('\nM. the Menus page — a shop\'s Departments\n');
  const MP = await bundle('src/pages/products/MenusPage.tsx', 'menus.mjs');
  const menusPage = (type) => { globalThis.__a573Type = type; return renderToStaticMarkup(h(MP.default)); };
  await ok('retail: "Departments", Groceries, Beverages …, "New department", tabs across the top — no Food / Soft drinks / menu', () => {
    const s = menusPage('retail');
    assert.match(s, /<h1[^>]*>Departments<\/h1>/);
    assert.match(s, /Group your categories into departments — Groceries, Beverages, Household, Personal care\./);
    assert.match(s, /placeholder="New department, e\.g\. Beverages"/);
    assert.match(s, /\+ Add department/);
    assert.doesNotMatch(s.replace(/data-testid="[^"]*"/g, ''), /menu|Food|Soft drinks|Alcohol|🍔/i);
  });
  await ok('restaurant: "Menus", Food, Soft drinks, Alcohol, Tea — as before', () => {
    const s = menusPage('restaurant');
    assert.match(s, /<h1[^>]*>Menus<\/h1>/);
    assert.match(s, /into menus — Food, Soft drinks, Alcohol, Tea\./);
    assert.match(s, /placeholder="New menu, e\.g\. Soft drinks"/);
  });
  await ok('the category\'s select says the business\'s word (CategoriesPage)', () => {
    const c = read('apps/dashboard/src/pages/products/CategoriesPage.tsx');
    assert.match(c, /\{terms\.menu\}\n\s+<select data-testid="category-menu"/);
    assert.equal((c.match(/<option value="">\{terms\.noMenu\}<\/option>/g) ?? []).length, 2);
    assert.doesNotMatch(c, />Menu<|No menu</);
  });

  console.log('\nS. Settings — a shop\'s setup is the shop\'s, the kitchen display a restaurant\'s\n');
  const BP = await bundle('src/pages/settings/BusinessPage.tsx', 'business.mjs');
  const setup = (type) => { globalThis.__a573Type = type; return renderToStaticMarkup(h(BP.VerticalSetupRoute)); };
  const tabs = (type) => { globalThis.__a573Type = type; return renderToStaticMarkup(h(BP.default)); };
  await ok('retail setup is the shop\'s (scanner, products and barcodes) — not the restaurant\'s tables, floor plan and waiters', () => {
    assert.equal(setup('retail'), '<p>PAGE:shop</p>');
    assert.equal(setup('other'), '<p>PAGE:shop</p>');
    assert.equal(setup('minimart'), '<p>PAGE:shop</p>');
    assert.equal(setup('restaurant'), '<p>PAGE:restaurant</p>');
    assert.equal(setup('cafe'), '<p>PAGE:restaurant</p>');
    assert.equal(setup('parking'), '<p>PAGE:parking</p>');
    assert.equal(setup('petrol_station'), '<p>PAGE:petrol</p>');
    assert.match(tabs('retail'), /\|Retail setup\|/);
    assert.match(tabs('restaurant'), /\|Restaurant setup\|/);
    assert.match(read('apps/dashboard/src/pages/settings/MinimartSettingsPage.tsx'), /\{businessTerms\(business\?\.type\)\.setupLabel\}/);
  });
  await ok('Devices and printers: the Kitchen display tab at a restaurant or café only', () => {
    const DP = read('apps/dashboard/src/pages/settings/DevicesPrintersPage.tsx');
    assert.match(DP, /const kds = foodAreas\(useBusiness\(\)\.business\?\.type\)\.kds;/);
    assert.match(DP, /tabs=\{kds \? TABS : TABS\.filter\(\(t\) => t\.to !== 'kitchen-display'\)\}/);
  });
  await ok('POS options: Eat now, pay later and Pay before kitchen at a restaurant or café — or wherever already on', () => {
    const oc = read('apps/dashboard/src/pages/settings/OwnerControls.tsx');
    assert.match(oc, /KITCHEN_POS_OPTION_KEYS: readonly PosOptionKey\[\] = \['pay_later_tabs', 'pay_before_kitchen'\]/);
    assert.match(oc, /return on \|\| !KITCHEN_POS_OPTION_KEYS\.includes\(key\) \|\| foodAreas\(businessType\)\.kitchenOptions;/);
    assert.match(oc, /POS_OPTION_KEYS\.filter\(\(key\) => posOptionShown\(key, business\?\.type, !!data\.pos!\[key\]\)\)\.map/);
  });

  console.log('\nP. the web POS and the manager portal\n');
  const CP = await bundle('src/pages/pos/cashier/CategoryPanel.tsx', 'panel.mjs');
  await ok('the top tabs and the panel say Departments / All departments when told', () => {
    const tabsArr = [{ id: 'all', name: 'All menus', color: null, icon: null }, { id: 'g', name: 'Groceries', color: null, icon: null }];
    const bar = renderToStaticMarkup(h(CP.MenuBar, { tabs: tabsArr, active: 'g', onPick() {}, label: 'Departments' }));
    assert.match(bar, /role="tablist" aria-label="Departments"/);
    const panel = { open: true, prefs: { pinned: false, menu: 'all' }, setOpen() {}, setPinned() {}, setMenu() {}, picked() {} };
    const cats = [{ id: 'c', name: 'Soap', menu_id: 'g' }];
    const p = renderToStaticMarkup(h(CP.default, { panel, categories: cats, menus: [{ id: 'g', name: 'Groceries', sort_order: 1, active: true }], products: [],
      activeMenu: 'all', activeCategory: 'all', onMenu() {}, onCategory() {}, overlay: false, menusLabel: 'Departments', allMenusLabel: 'All departments' }));
    assert.match(p, /aria-label="Departments"/);
    assert.match(p, />All departments</);
    assert.doesNotMatch(p, /All menus/);
  });
  await ok('the web POS passes the business\'s words; Post to room says no "hotel"', () => {
    const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    assert.match(cs, /const words\s+= businessTerms\(businessMode\);/);
    assert.match(cs, /menusLabel=\{words\.menus\} allMenusLabel=\{words\.allMenus\}/);
    assert.match(cs, /← \{words\.backToGrid\}<\/button>/);
    assert.match(cs, /\{showRoomCharge && isRestaurant && foodAreas\(businessMode\)\.roomCharge && \(/);
    const mp = read('apps/dashboard/src/pages/pos/MinimartPOS.tsx');
    assert.match(mp, /const WORDS = businessTerms\('minimart'\);/);
    assert.match(mp, /menusLabel=\{WORDS\.menus\} allMenusLabel=\{WORDS\.allMenus\}/);
  });
  await ok('the manager portal: "Products" for a shop\'s catalogue, no Table Turnover at a shop', () => {
    const md = read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx');
    assert.match(md, /if \(key === 'turnover'\) return foodAreas\(businessType\)\.tableTurnover;/);
    assert.match(md, /navAllowed\(i, held, isPetrol\) && managerItemShown\(i\.key, session\.businessType\)/);
    assert.match(md, /<span className="truncate">\{words\.catalogue\}<\/span>/);
    assert.match(read('apps/dashboard/src/pages/manager/ManagerMenuTab.tsx'), /<h2 className="text-white text-lg font-semibold">\{words\.catalogue\}<\/h2>/);
  });

  console.log('\nX. no user-visible "hotel" anywhere in the apps\n');
  await ok('no user-visible "hotel" (comments may tell the owner\'s words; strings and screen text may not)', () => {
    const roots = ['apps/dashboard/src', 'apps/desktop/src', 'apps/admin/src', 'apps/server/src', 'shared'];
    const skip = /node_modules|[\\/]dist[\\/]|[\\/]out[\\/]|test-dist|migrations/;
    const found = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (skip.test(rel)) continue;
        if (e.isDirectory()) walk(rel);
        else if (/\.(tsx?|html|js|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
          const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
          lines.forEach((ln, i) => {
            if (!/hotel/i.test(ln)) return;
            const t = ln.trim();
            if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
            const code = ln.replace(/\/\/.*$/, '').replace(/\{\/\*.*?\*\/\}/g, '');
            if (/hotel/i.test(code)) found.push(`${rel}:${i + 1}`);
          });
        }
      }
    };
    for (const r of roots) walk(r);
    assert.deepEqual(found, []);
  });
} finally {
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
  delete globalThis.__a573Type;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
