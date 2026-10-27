/**
 * menu-pages.test.mjs — A472: the till's Menu screen in pages, and its POS grid a screenful at a time.
 *
 * Owner, 2026-10-14: "can we paginate the menu".
 *
 *   node test/menu-pages.test.mjs
 *
 * RUNS packages/core/src/paginate.ts (type-stripped; the one file the till and the web import as @zaptill/core/paginate):
 * page maths, the numbered window, clamping, the grid's step. Then pins (React is not run here): Menu pages its rows
 * with a pager, resets to page 1 when a filter changes and keeps (clamps) the page on a save / Refresh; the POS grid
 * draws incrementally from an IntersectionObserver on a sentinel in its scroll box, keeps its memoised tiles and testids.
 *
 * MUTATIONS TO CONFIRM BITE (both checked on the bench):
 *   - nextGridCount without `Math.min(total, …)` (the grid grows past the list)     → "60 tiles, then 60 more" fails
 *   - MenuWorkbench's page reset drops typeFilter from its deps                    → "a new filter → page 1" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.MENU_PAGES_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, MENU_PAGES_TS: '1' } });
  process.exit(r.status ?? 1);
}
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
const P = await import(pathToFileURL(path.join(DESKTOP, '..', '..', 'packages/core/src/paginate.ts')).href);
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const eq = (a, b, what = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const list = (n) => Array.from({ length: n }, (_, i) => i + 1);

// ── the helper ──
ok('page maths: 1,234 items at 50 → 25 pages, page 2 is 51–100', () => {
  const p = P.paginate(list(1234), 2, 50);
  eq([p.pages, p.from, p.to, p.items[0]], [25, 51, 100, 51]);
  eq(P.rangeLabel(p), 'Showing 51–100 of 1,234');
});
ok('page maths: 25 a page and 100 a page', () => {
  eq(P.paginate(list(1234), 1, 25).pages, 50); eq(P.paginate(list(1234), 13, 100).items.length, 34);
});
ok('clamping: the last page emptied → the page before; an edit that keeps the page keeps it', () => {
  eq(P.paginate(list(100), 3, 50).page, 2); eq(P.paginate(list(101), 3, 50).page, 3); eq(P.clampPage(0, 10, 50), 1);
});
ok('window: 1 2 3 4 5 … 20 · 1 … 9 10 11 … 20 · 1 … 16 17 18 19 20', () => {
  eq(P.pageWindow(2, 20), [1, 2, 3, 4, 5, 'gap', 20]);
  eq(P.pageWindow(10, 20), [1, 'gap', 9, 10, 11, 'gap', 20]);
  eq(P.pageWindow(19, 20), [1, 'gap', 16, 17, 18, 19, 20]);
  eq(P.pageWindow(2, 3), [1, 2, 3]);
});
ok('page size cleaned: 25 / 50 / 100, else 50', () => {
  eq([P.cleanPageSize('25'), P.cleanPageSize('100'), P.cleanPageSize(null), P.cleanPageSize('80')], [25, 100, 50, 50]);
});
ok('POS grid: 60 tiles, then 60 more, never past the list', () => {
  eq(P.GRID_STEP, 60);
  eq([P.nextGridCount(60, 1000), P.nextGridCount(990, 1000), P.nextGridCount(60, 61), P.nextGridCount(0, 0)], [120, 1000, 61, 0]);
});
ok('POS grid: an exact name / barcode / PLU first; otherwise the order is unchanged', () => {
  const items = [{ name: 'Milk 1L' }, { name: 'Milk', plu: '204' }, { name: 'Soy milk', barcode: '600123' }];
  const k = (p) => [p.name, p.barcode, p.plu];
  eq(P.exactFirst(items, 'MILK', k).map((p) => p.name), ['Milk', 'Milk 1L', 'Soy milk']);
  eq(P.exactFirst(items, '600123', k).map((p) => p.name), ['Soy milk', 'Milk 1L', 'Milk']);
  eq(P.exactFirst(items, 'mil', k).map((p) => p.name), ['Milk 1L', 'Milk', 'Soy milk']);
});

// ── Menu (manager) ──
const menu = read('src/renderer/pages/MenuWorkbench.tsx');
ok('Menu: rows are one page of the filtered list; the pager under the list', () => {
  assert(/const paged = paginate\(filtered, page, pageSize\);/.test(menu), 'paginate');
  assert(/\{paged\.items\.map\(p => \{\s*const draft = priceDrafts\[p\.id\];/.test(menu), 'rows map paged.items');
  assert(!/\{filtered\.map\(p => \{/.test(menu), 'no row map over every filtered item');
  assert(/<Pager paged=\{paged\} noun="items" onPage=\{setPage\} onSize=\{n => \{ setPageSize\(n\); setPage\(1\); \}\} \/>/.test(menu), 'pager');
  assert(/usePageSize\('swiftpos\.pageSize\.menu'\)/.test(menu), 'size remembered');
});
ok('Menu: a new filter → page 1 (search, category, type); a save / Refresh keeps the page, clamped', () => {
  assert(/useEffect\(\(\) => \{ setPage\(1\); \}, \[search, catFilter, typeFilter\]\);/.test(menu), 'reset on every filter');
  assert(/useEffect\(\(\) => \{ if \(paged\.page !== page\) setPage\(paged\.page\); \}, \[paged\.page, page\]\);/.test(menu), 'clamp');
});
ok('Menu: the count line and the type counts still count every filtered item', () => {
  assert(menu.includes('`${filtered.length} of ${products.length} items`'), 'count line');
  assert(/count: scoped\.length \}/.test(menu), 'type counts');
});

// ── the pager ──
const pager = read('src/renderer/components/Pager.tsx');
ok('Pager: First / Prev / numbered window / Next / Last, current page in the theme (action-*), size in try/catch', () => {
  for (const id of ['pager-first', 'pager-prev', 'pager-page', 'pager-next', 'pager-last', 'pager-size', 'pager-range']) assert(pager.includes(`data-testid="${id}"`), id);
  assert(/pageWindow\(page, pages\)\.map/.test(pager), 'window');
  assert(/slot === page \? 'bg-action-500\/10 text-action-400 font-semibold'/.test(pager), 'theme colour');
  assert(!/green-|emerald-/.test(pager), 'no raw green');
  assert(pager.includes("from '@zaptill/core/paginate'"), 'shared helper');
  assert(/try \{ return cleanPageSize\(localStorage\.getItem\(key\)\); \} catch/.test(pager) && /try \{ localStorage\.setItem\(key, String\(c\)\); \} catch/.test(pager), 'storage guarded');
});

// ── the POS grid ──
const pos = read('src/renderer/pages/POSPage.tsx');
const hook = read('src/renderer/hooks/useGridWindow.ts');
ok('POS grid: draws gridTiles (GRID_STEP, then more), resets on category / search, sentinel in the scroll box', () => {
  assert(/const gridList = useMemo\(\(\) => exactFirst\(filtered, search, \(p: any\) => \[p\.name, p\.barcode, p\.plu\]\), \[filtered, search\]\);/.test(pos), 'exact first');
  // A537: a menu chosen in the category panel starts the grid again too.
  assert(/const grid = useGridWindow\(gridList\.length, `\$\{activeMenu\}\|\$\{activeCategory\}\|\$\{search\}\|\$\{flags\.isPetrol\}`\);/.test(pos), 'reset key');
  assert(/const gridTiles = useMemo\(\(\) => gridList\.slice\(0, grid\.count\), \[gridList, grid\.count\]\);/.test(pos), 'slice memoised');
  assert(/<div ref=\{grid\.rootRef\} className="flex-1 overflow-y-auto p-4">/.test(pos), 'root = the scroll box');
  assert(/\{gridTiles\.map\(\(product: any\) => \(\s*<ProductTile key=\{product\.id\}/.test(pos) && !/\{filtered\.map\(\(product: any\)/.test(pos), 'tiles');
  assert(/\{grid\.more && <div ref=\{grid\.sentinelRef\} data-testid="grid-more" aria-hidden className="col-span-full h-px" \/>\}/.test(pos), 'sentinel');
});
ok('POS grid: tiles stay memoised with their testids; the grid filter count is still every match', () => {
  assert(/const ProductTile = memo\(function ProductTile\(/.test(pos), 'memo');
  assert(pos.includes('data-testid="tile-count"') && pos.includes('data-testid="grid-filter"'), 'testids');
  assert(/search, count: filtered\.length,/.test(pos), 'filter count');
});
ok('grid hook: IntersectionObserver on the sentinel, root = the grid\'s scroll box, steps by GRID_STEP, resets', () => {
  assert(/new IntersectionObserver\(\s*entries => \{ if \(entries\.some\(e => e\.isIntersecting\)\) setShown\(n => nextGridCount\(n, total, step\)\); \},\s*\{ root, rootMargin: '0px 0px 400px 0px' \},/.test(hook), 'observer');
  assert(/useEffect\(\(\) => \{\s*setShown\(step\);\s*if \(root\) root\.scrollTop = 0;\s*\}, \[resetKey, step\]\);/.test(hook), 'reset');
  assert(hook.includes("from '@zaptill/core/paginate'"), 'shared helper');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
