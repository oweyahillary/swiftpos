// A566 — the menus as big tabs across the top of the WEB POS's grid again (CashierScreen and MinimartPOS); the till's half
// is apps/desktop/test/menus-top-a566.test.mjs.
//
//   node --no-warnings tests/menus-top-a566.test.mjs
//
// Owner, 2026-10-22: "if a client has larger categories eg drinks, fast foods etc they should appear the way categories
// used to appear so that cashiers can easily pick the menu".
//
// RUNS the web POS's MenuBar and CategoryPanel (apps/dashboard/src/pages/pos/cashier/CategoryPanel.tsx, bundled with
// esbuild, rendered with react-dom/server) and the shared helper (lib/menuFilter.ts = shared/menuFilter.ts); pins the two
// screens' wiring.
//
//   T  menus → a row of top tabs ("All", "Food", "Drinks" …, 46 px, the theme's --act-strong on the chosen one, the POS's
//      light / dark tokens elsewhere); no menus → nothing (the ☰ panel alone, as before).
//   P  with the bar, the panel lists only the chosen menu's categories and has no tabs of its own; no menus → A537's list.
//   G  a menu narrows the grid; a search looks through every menu; the screens wire the bar, pickMenu and the chip.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-22):
//   - MenuBar's chosen tab in a raw colour instead of ACT                    → T "the theme's colour" fails
//   - CashierScreen without <MenuBar …>                                      → G "the screens wire the bar" fails
//   - CategoryPanel showing its own tabs with menuBar                         → P "no tabs of its own" fails
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'apps/dashboard');
const require = createRequire(path.join(DASH, 'package.json'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`PASS  ${n}`); pass++; } else { console.log(`FAIL  ${n}  ${d}`); fail++; } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.a566-'));
const bundle = (entry, out) => {
  require('esbuild').buildSync({ entryPoints: [path.join(DASH, entry)], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom'] });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};

try {
  const M = await import(pathToFileURL(path.join(DASH, 'src/lib/menuFilter.ts')).href);
  const CP = await bundle('src/pages/pos/cashier/CategoryPanel.tsx', 'panel.mjs');
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const C = [{ id: 'burgers', name: 'Burgers', menu_id: 'food' }, { id: 'fast', name: 'Fast foods', menu_id: 'food' },
    { id: 'sodas', name: 'Sodas', menu_id: 'drinks' }];
  const MS = [{ id: 'food', name: 'Food', sort_order: 1, active: true }, { id: 'drinks', name: 'Drinks', sort_order: 2, active: true }];
  const P = [{ id: 'p1', name: 'Beef burger', category_id: 'burgers', status: 'active' }, { id: 'p2', name: 'Chips', category_id: 'fast', status: 'active' },
    { id: 'p3', name: 'Coke', category_id: 'sodas', status: 'active' }];

  console.log('\nT. the top tabs\n');
  const tabs = M.menuBarTabs(MS, C);
  const bar = renderToStaticMarkup(React.createElement(CP.MenuBar, { tabs, active: 'food', onPick() {} }));
  const labels = [...bar.matchAll(/data-testid="menu-bar-tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
  ok('menus render as top tabs: a tablist "Menus", "All" then each menu', /data-testid="menu-bar"/.test(bar) && /role="tablist" aria-label="Menus"/.test(bar)
    && JSON.stringify(labels) === JSON.stringify(['All', 'Food', 'Drinks']), bar.slice(0, 300));
  ok('…big touch targets (46 px high, 84 px wide at least)', (bar.match(/min-height:46px;min-width:84px/g) || []).length === 3);
  ok('…the chosen one in the theme\'s colour (--act-strong), the others on the POS\'s own light / dark tokens',
    /aria-selected="true"[^>]*style="[^"]*background:rgb\(var\(--act-strong, 15 118 110\)\)[^"]*"[^>]*>Food</.test(bar)
    && /aria-selected="false"[^>]*style="[^"]*background:var\(--pos-surface, #1e293b\);color:var\(--pos-text, #f1f5f9\)/.test(bar)
    && !/#22c55e|#16a34a|#3b82f6|#2563eb/i.test(bar));
  ok('no menus: no row at all', M.menuBarTabs([], C).length === 0
    && renderToStaticMarkup(React.createElement(CP.MenuBar, { tabs: [], active: 'all', onPick() {} })) === '');

  console.log('\nP. the panel under the bar\n');
  const panel = (menus, menu, menuBar) => renderToStaticMarkup(React.createElement(CP.default, {
    panel: { open: true, prefs: { pinned: false, menu }, setOpen() {}, setPinned() {}, setMenu() {}, picked() {} },
    categories: C, menus, products: P, activeMenu: menu, activeCategory: 'all', onMenu() {}, onCategory() {}, overlay: false, menuBar }));
  const rows = (html) => [...html.matchAll(/data-testid="category-row"[\s\S]*?white-space:nowrap">([^<]+)</g)].map((m) => m[1]);
  const drinks = panel(MS, 'drinks', true);
  ok('with the bar, the panel lists only the chosen menu\'s categories and has no tabs of its own',
    JSON.stringify(rows(drinks)) === JSON.stringify(['Sodas']) && /All Drinks/.test(drinks) && !/data-testid="menu-tabs"/.test(drinks), JSON.stringify(rows(drinks)));
  ok('no menus: A537\'s plain list, no tabs', JSON.stringify(rows(panel([], 'all', false))) === JSON.stringify(['Burgers', 'Fast foods', 'Sodas'])
    && !/data-testid="menu-tabs"/.test(panel([], 'all', false)));

  console.log('\nG. the grid and the screens\n');
  const shown = (menu, search = '') => P.filter((p) => M.inMenuScope(p, M.gridMenuScope(M.menuScope(C, MS, menu), search))
    && p.name.toLowerCase().includes(search.toLowerCase())).map((p) => p.id).join();
  ok('a menu narrows the grid; a search looks through every menu', shown('food') === 'p1,p2' && shown('drinks') === 'p3'
    && shown('food', 'coke') === 'p3' && shown('all') === 'p1,p2,p3');
  for (const [n, f, searchVar, setter] of [['CashierScreen', 'apps/dashboard/src/pages/pos/CashierScreen.tsx', 'search', 'setSearch'],
    ['MinimartPOS', 'apps/dashboard/src/pages/pos/MinimartPOS.tsx', 'catalogueSearch', 'setCatalogueSearch']]) {
    const s = read(f);
    ok(`${n}: the screens wire the bar under the search, pickMenu (category and search start again), the panel told`,
      /<CategoryChip label=\{catChip\} onClear=\{clearCatChip\} \/>\s*<\/div>\s*\{\/\*[^]*?\*\/\}\s*<MenuBar tabs=\{menuBar\} active=\{activeMenu\} onPick=\{pickMenu\} \/>/.test(s)
      && s.includes(`const pickMenu = (id: string) => { catPanel.setMenu(id); setActiveCategory('all'); ${setter}(''); };`)
      && s.includes('const menuBar = useMemo(() => menuBarTabs(menus, categories), [menus, categories]);')
      && /menuBar=\{menuBar\.length > 0\} \/>/.test(s)
      && s.includes(`inMenuScope(p, gridMenuScope(menuFilterScope, ${searchVar}))`)
      && s.includes('const catChip = chosenCategoryName ?? (chosenMenuName && menuBar.length === 0 ? `${chosenMenuName} menu` : null);'));
  }
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  ok('CashierScreen keeps A563 (the hidden filter and the sold-out card)',
    /const matchStock = !hiddenOutOfStock\(stockView\.mode, stockView, p\.id\);/.test(cs) && /const soldOut = showsSoldOut\(stockView\.mode, stockView, product\.id\);/.test(cs));
} finally {
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
