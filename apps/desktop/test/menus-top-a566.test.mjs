// A566 (2026-10-22) — the menus as big tabs across the top of the till's selling screen again, and "Check other branches"
// from the selling screen.
//
// Owner: "if a client has larger categories eg drinks, fast foods etc they should appear the way categories used to
// appear so that cashiers can easily pick the menu". And A564 left FindInBranches ready but not wired into the sale screen.
//
// RUNS the shared helper (src/shared/menuFilter.ts — the web POS runs the same file), the till's MenuBar and CategoryPanel
// (bundled with esbuild, rendered with react-dom/server), lib/branchCheck.ts and lib/access.ts; pins the sale screen's
// wiring (POSPage is one 2,400-line component — its filter and gates are read from the source).
//
//   cd apps/desktop && node test/menus-top-a566.test.mjs
//
//   1  menus → a row of top tabs ("All", "Food", "Drinks" …, 48 px, the action colour on the chosen one); no menus → no
//      row (the ☰ panel alone, as before).
//   2  a menu chosen narrows the grid AND the panel (the panel lists only that menu's categories and drops its own tabs);
//      All → every product; no menus → the panel is A537's plain list.
//   3  a search looks through every menu; A563's hidden / sold-out still apply inside a menu.
//   4  the sideways row: which ends hide more tabs (the arrows and fade).
//   5  "Check other branches": only with inventory.view AND the online licence; the search offer names items out HERE;
//      the long press / right-click is given to the tiles only when allowed; the view is A564's lookup, read only.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-22):
//   - menuBarTabs returning [] always                                → 1 "menus render as top tabs" fails
//   - CategoryPanel showing its own tabs with menuBar                 → 2 "the panel drops its own tabs" fails
//   - gridMenuScope returning the scope while searching               → 3 "a search looks through every menu" fails
//   - mayCheckOtherBranches ignoring the licence                       → 5 "only with the online licence" fails
//   - POSPage giving the tiles onCheckBranches unconditionally         → 5 "the long press only when allowed" fails
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

// Bundles land under apps/desktop/node_modules so an external 'react' resolves to the app's own copy (removed at the end).
const bundleDir = fs.mkdtempSync(path.join(desktop, 'node_modules', '.a566-'));
const bundle = (entry, out) => {
  require('esbuild').buildSync({ entryPoints: [path.join(desktop, entry)], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom'] });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};

const M = await import(pathToFileURL(path.join(desktop, 'src', 'shared', 'menuFilter.ts')).href);
const BS = await import(pathToFileURL(path.join(desktop, 'src', 'renderer', 'lib', 'branchCheck.ts')).href);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// A business with menus: Food (Burgers, Fast foods), Drinks (Sodas), and Extras with no menu ("Other").
const C = [{ id: 'burgers', name: 'Burgers', menu_id: 'food' }, { id: 'fast', name: 'Fast foods', menu_id: 'food' },
  { id: 'sodas', name: 'Sodas', menu_id: 'drinks' }, { id: 'extras', name: 'Extras', menu_id: null }];
const MS = [{ id: 'drinks', name: 'Drinks', sort_order: 2, active: true, icon: '🥤' }, { id: 'food', name: 'Food', sort_order: 1, active: true }];
const P = [
  { id: 'p1', name: 'Beef burger', category_id: 'burgers', status: 'active' },
  { id: 'p2', name: 'Chips', category_id: 'fast', status: 'active' },
  { id: 'p3', name: 'Coke', category_id: 'sodas', status: 'active' },
  { id: 'p4', name: 'Coke Zero', category_id: 'sodas', status: 'active' },
  { id: 'p5', name: 'Ketchup', category_id: 'extras', status: 'active' },
];
// The grid's rule as the sale screen writes it (category, menu — ignored while searching — search, A563's hide).
const grid = (menu, search = '', hidden = new Set(), category = 'all') => {
  const scope = M.gridMenuScope(M.menuScope(C, MS, menu), search);
  return P.filter((p) => (category === 'all' || p.category_id === category) && M.inMenuScope(p, scope)
    && p.name.toLowerCase().includes(search.toLowerCase()) && !hidden.has(p.id)).map((p) => p.id).join(',');
};

const CP = await bundle('src/renderer/components/CategoryPanel.tsx', 'panel.mjs');
const panelState = (menu) => ({ open: true, prefs: { pinned: false, menu }, setOpen() {}, setPinned() {}, setMenu() {}, picked() {} });
const renderPanel = (menus, menu, menuBar) => renderToStaticMarkup(React.createElement(CP.default, {
  panel: panelState(menu), categories: C, menus, products: P, activeMenu: menu, activeCategory: 'all',
  onMenu() {}, onCategory() {}, overlay: false, menuBar }));
const rows = (html) => [...html.matchAll(/data-testid="category-row"[\s\S]*?<span class="flex-1 truncate">([^<]+)</g)].map((m) => m[1]);

console.log('A566 — menus as top tabs on the till; check other branches from the selling screen\n');
try {
  // ── 1 ──
  const tabs = M.menuBarTabs(MS, C);
  ok('menus: the top row holds "All", each menu in the owner\'s order, then "Other" (categories with no menu)',
    JSON.stringify(tabs.map(M.menuBarLabel)) === JSON.stringify(['All', 'Food', 'Drinks', 'Other']), JSON.stringify(tabs));
  const bar = renderToStaticMarkup(React.createElement(CP.MenuBar, { tabs, active: 'drinks', onPick() {} }));
  const tabLabels = [...bar.matchAll(/data-testid="menu-bar-tab"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?([^<]+)</g)].map((m) => m[1]);
  ok('menus render as top tabs: a tablist "Menus" with one big tab per menu (48 px, at least 88 px wide)',
    /data-testid="menu-bar"/.test(bar) && /role="tablist" aria-label="Menus"/.test(bar)
    && JSON.stringify(tabLabels) === JSON.stringify(['All', 'Food', 'Drinks', 'Other'])
    && (bar.match(/min-h-\[48px\] min-w-\[88px\]/g) || []).length === 4, bar.slice(0, 400));
  ok('…the chosen menu is selected in the theme\'s action colour (never a raw green); its icon shows',
    /aria-selected="true"[^>]*class="[^"]*bg-action-500[^"]*"[^>]*>(<span[^>]*>🥤<\/span>)Drinks/.test(bar)
    && (bar.match(/aria-selected="true"/g) || []).length === 1 && !/green-/.test(bar));
  ok('…a remembered menu that is gone selects "All"',
    /aria-selected="true"[^>]*>All</.test(renderToStaticMarkup(React.createElement(CP.MenuBar, { tabs, active: 'tea', onPick() {} }))));
  ok('no menus: no row at all (the ☰ panel alone, as before)', M.menuBarTabs([], C).length === 0
    && renderToStaticMarkup(React.createElement(CP.MenuBar, { tabs: M.menuBarTabs([], C), active: 'all', onPick() {} })) === ''
    && M.menuBarTabs(MS.map((m) => ({ ...m, active: false })), C).length === 0);

  // ── 2 ──
  ok('selecting a menu filters the grid: Food → its products only, Drinks → its own, Other → no-menu ones, All → every one',
    grid('food') === 'p1,p2' && grid('drinks') === 'p3,p4' && grid('other') === 'p5' && grid('all') === 'p1,p2,p3,p4,p5');
  const foodPanel = renderPanel(MS, 'food', true);
  ok('…and the panel: opened, it lists only that menu\'s categories ("All Food", Burgers, Fast foods) and drops its own tabs',
    JSON.stringify(rows(foodPanel)) === JSON.stringify(['Burgers', 'Fast foods']) && /All Food/.test(foodPanel) && !/data-testid="menu-tabs"/.test(foodPanel),
    JSON.stringify(rows(foodPanel)));
  ok('…All: every category under its menu\'s heading, still no tabs in the panel',
    JSON.stringify(rows(renderPanel(MS, 'all', true))) === JSON.stringify(['Burgers', 'Fast foods', 'Sodas', 'Extras'])
    && !/data-testid="menu-tabs"/.test(renderPanel(MS, 'all', true)));
  const plain = renderPanel([], 'all', false);
  ok('no menus: the panel is A537\'s plain list (every category, no tabs, no headings)',
    JSON.stringify(rows(plain)) === JSON.stringify(['Burgers', 'Fast foods', 'Sodas', 'Extras']) && !/data-testid="menu-tabs"/.test(plain));
  ok('…and without the bar (menuBar off) the panel keeps its own tabs (A537, untouched)', /data-testid="menu-tabs"/.test(renderPanel(MS, 'food', false)));

  // ── 3 ──
  ok('a search looks through every menu: Food chosen, "coke" finds the drinks', grid('food', 'coke') === 'p3,p4' && grid('food', '') === 'p1,p2'
    && M.gridMenuScope(M.menuScope(C, MS, 'food'), 'x') === null && M.gridMenuScope(M.menuScope(C, MS, 'food'), '') !== null);
  ok('A563 inside a menu: a hidden item stays off the menu\'s grid and out of a search', grid('drinks', '', new Set(['p3'])) === 'p4'
    && grid('food', 'coke', new Set(['p3'])) === 'p4');

  // ── 4 ──
  ok('the sideways row: the arrow and fade show on the side that hides more tabs',
    JSON.stringify(M.menuBarEdges(0, 1200, 600)) === '{"left":false,"right":true}' && JSON.stringify(M.menuBarEdges(300, 1200, 600)) === '{"left":true,"right":true}'
    && JSON.stringify(M.menuBarEdges(600, 1200, 600)) === '{"left":true,"right":false}' && JSON.stringify(M.menuBarEdges(0, 500, 600)) === '{"left":false,"right":false}');
  const panelSrc = src('renderer/components/CategoryPanel.tsx');
  ok('…it scrolls with a swipe or the wheel, has ‹ › arrows for a mouse (44+ px wide), keeps the chosen tab in view',
    /overflow-x-auto/.test(panelSrc) && /data-testid="menu-bar-left"/.test(panelSrc) && /data-testid="menu-bar-right"/.test(panelSrc)
    && /w-14/.test(panelSrc) && /scrollIntoView/.test(panelSrc) && /onScroll=\{measure\}/.test(panelSrc));

  // ── the sale screen's wiring ──
  const pos = src('renderer/pages/POSPage.tsx');
  ok('the sale screen: the bar under the search, before the grid, fed by menuBarTabs; the panel told the bar is there',
    /const menuBar = useMemo\(\(\) => menuBarTabs\(menus, categories\), \[menus, categories\]\);/.test(pos)
    && /<CategoryChip label=\{gridFilter\.categoryName\} onClear=\{clearCatChip\} \/>\s*<\/div>\s*\{\/\*[^]*?\*\/\}\s*<MenuBar tabs=\{menuBar\} active=\{activeMenu\} onPick=\{pickMenu\} \/>/.test(pos)
    && /overlay=\{narrowWindow\} menuBar=\{menuBar\.length > 0\} \/>/.test(pos));
  ok('…a tap on a menu shows its items: the menu remembered (A554), its category and any search start again',
    /const pickMenu = \(id: string\) => \{ catPanel\.setMenu\(id\); setActiveCategory\('all'\); setSearch\(''\); \};/.test(pos));
  ok('…the grid filter ignores the menu while searching (A563\'s matchStock and soldOut kept)',
    /const matchMenu\s+= inMenuScope\(p, gridMenuScope\(menuFilterScope, search\)\);/.test(pos)
    && /const matchStock\s+= !hiddenOutOfStock\(stockView\.mode, stockView, p\.id\);/.test(pos)
    && /soldOut=\{showsSoldOut\(stockView\.mode, stockView, product\.id\)\}/.test(pos)
    && pos.includes('}), [products, activeCategory, menuFilterScope, search, flags.isPetrol, gridDay, stockView]);'));
  ok('…with the bar, the chip names only the category (the bar shows the menu); with no menus, as before',
    /categoryName: chosenCategoryName \?\? \(chosenMenuName && menuBar\.length === 0 \? `\$\{chosenMenuName\} menu` : null\),/.test(pos));

  // ── 5 ──
  ok('"Check other branches" needs inventory.view AND the online licence (A564\'s two locks)',
    BS.mayCheckOtherBranches(true, true) === true && BS.mayCheckOtherBranches(false, true) === false
    && BS.mayCheckOtherBranches(true, false) === false && BS.mayCheckOtherBranches(false, false) === false);
  const RA = await bundle('src/renderer/lib/access.ts', 'access.mjs');
  const fine = (...keys) => Object.fromEntries([...keys.map((k) => [k, true]), ['catalogue.v2', true]]);
  ok('…a cashier without inventory.view does not hold it; with it, or the owner, does',
    RA.can({ role: 'cashier', permissions: fine('orders.create') }, 'inventory.view') === false
    && RA.can({ role: 'cashier', permissions: fine('orders.create', 'inventory.view') }, 'inventory.view') === true
    && RA.can({ role: 'owner', permissions: {} }, 'inventory.view') === true);
  const isOut = (hid, sold) => (p) => hid.has(p.id) || sold.has(p.id);
  ok('the search offer: items it finds that are sold out or hidden HERE (2+ letters, active only, at most 3)',
    BS.outHereMatches(P, 'coke', isOut(new Set(['p4']), new Set())).map((p) => p.id).join() === 'p4'
    && BS.outHereMatches(P, 'c', isOut(new Set(['p3']), new Set())).length === 0
    && BS.outHereMatches(P, 'coke', isOut(new Set(), new Set())).length === 0
    && BS.outHereMatches([{ ...P[2], status: 'inactive' }], 'coke', () => true).length === 0
    && BS.outHereMatches(P, 'ke', () => true).length === 3 && BS.outHereMatches(P, 'ke', () => true, 2).length === 2
    && BS.outHereNote([{ name: 'Coke' }]) === 'Coke is out here.' && BS.outHereNote([{ name: 'Coke' }, { name: 'Chips' }]) === 'Coke, Chips are out here.');
  ok('…on the sale screen: worked out only when allowed (sold out or hidden by A563; fuel never), shown as a strip with the button',
    /const outHere = useMemo\(\(\) => \(mayCheckBranches\s+\? outHereMatches\(products, search, \(p: any\) => !p\.is_fuel && \(hiddenOutOfStock\(stockView\.mode, stockView, p\.id\) \|\| showsSoldOut\(stockView\.mode, stockView, p\.id\)\)\)\s+: \[\]\)/.test(pos)
    && /\{outHere\.length > 0 && \(\s*<div data-testid="branch-check-offer"/.test(pos) && /Check other branches\s*<\/button>/.test(pos));
  ok('the gate on the sale screen: inventory.view from the session, the licence from the till (useOnlineLicence)',
    /setCanViewStock\(can\(ss, 'inventory\.view'\)\);/.test(pos) && /const onlineLicence = useOnlineLicence\(\);/.test(pos)
    && /const mayCheckBranches = mayCheckOtherBranches\(onlineLicence, canViewStock\);/.test(pos));
  ok('the long press / right-click is given to the tiles only when allowed; the click that ends a long press adds nothing',
    /onCheckBranches=\{mayCheckBranches \? checkBranchesFor : undefined\} \/>/.test(pos)
    && /const press = useLongPress\(onCheckBranches \? \(\) => onCheckBranches\(product\) : null\);/.test(pos)
    && /onClick=\{\(\) => \{ if \(press\.consume\(\)\) return; onTap\(product\); \}\}/.test(pos)
    && /if \(!on\) return \{ consume: \(\) => false, handlers: \{\} \};/.test(pos) && /onContextMenu: \(e: ReactMouseEvent\) => \{ e\.preventDefault\(\);/.test(pos));
  ok('the view is A564\'s lookup, read only (no Request — asking stays a manager\'s), and only while allowed',
    /\{branchCheck !== null && mayCheckBranches && \(/.test(pos) && /<FindInBranches key=\{branchCheck\} initial=\{branchCheck\} autoSearch \/>/.test(pos)
    && !/<FindInBranches[^>]*onRequest/.test(pos) && /a manager uses Manager › Stock › Other branches/.test(pos));
  const bst = src('renderer/components/BranchStockTab.tsx');
  ok('…FindInBranches looks at once when opened with the item named (autoSearch); offline it says "Needs a connection" (A564, main)',
    /useEffect\(\(\) => \{ if \(autoSearch && initial\.trim\(\)\.length >= 2\) void find\(\); \}, \[\]\);/.test(bst)
    && /posApi\.branchStock\.find\(q\.trim\(\)\)/.test(bst) && /Needs a connection/.test(src('main/ipc/branchStock.ts')));
} finally {
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
