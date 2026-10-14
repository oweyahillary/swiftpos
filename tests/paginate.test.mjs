/**
 * paginate.test.mjs — A472: the menu in pages (web Products), the web POS grids a screenful at a time.
 *
 * Owner, 2026-10-14: "can we paginate the menu".
 *
 *   node tests/paginate.test.mjs
 *
 * RUNS the web's lib/paginate.ts (bundled with esbuild, like report-downloads): page maths, the numbered window with
 * its gaps, clamping after a delete, the remembered size cleaned, "Showing 51–100 of 1,234", the POS grid's next step
 * and the exact hit first. Then pins (React is not run here): the Products page pages its rows, "Select all" still
 * means every FILTERED product across pages, "Select this page" is the page; the pager fits a phone; the web POS and
 * minimart grids draw incrementally from an IntersectionObserver on a sentinel, rooted in the grid's own scroll box.
 *
 * MUTATIONS TO CONFIRM BITE (both checked on the bench):
 *   - clampPage without `Math.min(…, pageCount(…))` (a page past the end stays)  → "clamping" fails
 *   - ProductsPage's header checkbox selects `paged.items` instead of `filtered` → "Select all is every filtered" fails
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'apps/dashboard');
const read = (p) => fs.readFileSync(path.join(DASH, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};
const eq = (a, b, what = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const assert = (c, msg) => { if (!c) throw new Error(msg); };

function requireFrom(pkgDirs, name) {
  for (const d of pkgDirs) {
    try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ }
  }
  throw new Error(`${name} not installed (npm ci in apps/dashboard)`);
}
const esbuild = requireFrom(['apps/server', 'apps/dashboard'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a472-'));
const outFile = path.join(tmp, 'paginate.mjs');
esbuild.buildSync({ entryPoints: [path.join(DASH, 'src/lib/paginate.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: outFile, logLevel: 'silent' });
const P = await import(pathToFileURL(outFile).href);

const list = (n) => Array.from({ length: n }, (_, i) => i + 1);

// ── page maths ──
await ok('page maths: 1,234 rows at 50 a page → 25 pages; page 2 is rows 51–100', () => {
  const p = P.paginate(list(1234), 2, 50);
  eq([p.pages, p.page, p.from, p.to, p.items.length, p.items[0], p.items[49]], [25, 2, 51, 100, 50, 51, 100]);
  eq(P.rangeLabel(p), 'Showing 51–100 of 1,234');
  eq(P.rangeShort(p), '51–100 of 1,234');
});
await ok('page maths: the last page holds the remainder (1,201–1,234)', () => {
  const p = P.paginate(list(1234), 25, 50);
  eq([p.from, p.to, p.items.length], [1201, 1234, 34]);
  eq(P.rangeLabel(p), 'Showing 1,201–1,234 of 1,234');
});
await ok('page maths: an empty list is page 1 of 1, nothing shown', () => {
  const p = P.paginate([], 3, 25);
  eq([p.page, p.pages, p.from, p.to, p.items.length], [1, 1, 0, 0, 0]);
  eq(P.rangeLabel(p), 'Nothing to show');
});
await ok('page maths: exactly a full page is one page (50 of 50); 51 is two', () => {
  eq(P.pageCount(50, 50), 1); eq(P.pageCount(51, 50), 2); eq(P.pageCount(0, 50), 1);
});

// ── clamping ──
await ok('clamping: deleting the last item of the last page shows the page before it', () => {
  eq(P.clampPage(3, 101, 50), 3);   // 101 rows: page 3 holds row 101
  eq(P.clampPage(3, 100, 50), 2);   // it is deleted → page 2
  eq(P.paginate(list(100), 3, 50).page, 2);
  eq(P.paginate(list(100), 3, 50).items[0], 51);
});
await ok('clamping: a page below 1, or not a number, is page 1', () => {
  eq(P.clampPage(0, 100, 50), 1); eq(P.clampPage(-4, 100, 50), 1); eq(P.clampPage(NaN, 100, 50), 1);
});
await ok('clamping: an edit that keeps the page keeps it (page 4 of 25 stays 4)', () => {
  eq(P.paginate(list(1234), 4, 50).page, 4);
});

// ── the remembered size ──
await ok('page size: 25 / 50 / 100 kept; anything else (null, "abc", 7, 1000) is 50', () => {
  eq(P.PAGE_SIZES, [25, 50, 100]); eq(P.DEFAULT_PAGE_SIZE, 50);
  eq([P.cleanPageSize('25'), P.cleanPageSize('100'), P.cleanPageSize(50)], [25, 100, 50]);
  eq([P.cleanPageSize(null), P.cleanPageSize('abc'), P.cleanPageSize(7), P.cleanPageSize('1000')], [50, 50, 50, 50]);
});

// ── the numbered window ──
await ok('window: seven pages or fewer — every page, no gaps', () => {
  eq(P.pageWindow(1, 1), [1]); eq(P.pageWindow(3, 7), [1, 2, 3, 4, 5, 6, 7]);
});
await ok('window: near the start — 1 2 3 4 5 … 20', () => {
  eq(P.pageWindow(1, 20), [1, 2, 3, 4, 5, 'gap', 20]);
  eq(P.pageWindow(4, 20), [1, 2, 3, 4, 5, 'gap', 20]);
});
await ok('window: the middle — 1 … 9 10 11 … 20', () => {
  eq(P.pageWindow(10, 20), [1, 'gap', 9, 10, 11, 'gap', 20]);
  eq(P.pageWindow(5, 20), [1, 'gap', 4, 5, 6, 'gap', 20]);
});
await ok('window: near the end — 1 … 16 17 18 19 20', () => {
  eq(P.pageWindow(17, 20), [1, 'gap', 16, 17, 18, 19, 20]);
  eq(P.pageWindow(20, 20), [1, 'gap', 16, 17, 18, 19, 20]);
});
await ok('window: always seven slots past seven pages, the current page always in it, never a gap of one page', () => {
  for (let t = 8; t <= 40; t++) for (let c = 1; c <= t; c++) {
    const w = P.pageWindow(c, t);
    assert(w.length === 7, `t=${t} c=${c} → ${w.length} slots`);
    assert(w.includes(c) && w[0] === 1 && w[6] === t, `t=${t} c=${c}: ${w}`);
    const nums = w.filter((x) => x !== 'gap');
    for (let i = 1; i < w.length; i++) if (w[i] === 'gap') assert(w[i + 1] - w[i - 1] > 2, `t=${t} c=${c}: a gap hides one page: ${w}`);
    assert(nums.every((x, i) => i === 0 || x > nums[i - 1]), `t=${t} c=${c}: not ascending`);
  }
});
await ok('digits group the same everywhere: 1234567 → 1,234,567', () => {
  eq([P.groupDigits(0), P.groupDigits(999), P.groupDigits(1000), P.groupDigits(1234567)], ['0', '999', '1,000', '1,234,567']);
});

// ── the POS grid ──
await ok('POS grid: 60 tiles first, then 60 more, never past the list', () => {
  eq(P.GRID_STEP, 60);
  eq([P.nextGridCount(60, 1000), P.nextGridCount(960, 1000), P.nextGridCount(1000, 1000), P.nextGridCount(60, 30)], [120, 1000, 1000, 30]);
});
await ok('POS grid: an exact name / barcode is the first tile; the rest keep their order; no search → the same list', () => {
  const items = [{ n: 'Coke 300ml' }, { n: 'Diet Coke', b: '111' }, { n: 'Coke' }, { n: 'Coke Zero' }];
  const keys = (x) => [x.n, x.b];
  eq(P.exactFirst(items, '  coke ', keys).map((x) => x.n), ['Coke', 'Coke 300ml', 'Diet Coke', 'Coke Zero']);
  eq(P.exactFirst(items, '111', keys).map((x) => x.n), ['Diet Coke', 'Coke 300ml', 'Coke', 'Coke Zero']);
  assert(P.exactFirst(items, '', keys) === items, 'no search should return the same list');
  eq(P.exactFirst(items, 'cok', keys).map((x) => x.n), items.map((x) => x.n));
});
await ok('POS grid: an exact hit at position 900 of a 1,000-tile search is inside the first 60 drawn', () => {
  const items = list(1000).map((i) => ({ n: i === 900 ? 'Tea' : `Tea blend ${i}` }));
  eq(P.exactFirst(items, 'tea', (x) => [x.n]).slice(0, P.GRID_STEP)[0].n, 'Tea');
});

// ── pins: the web Products page ──
const products = read('src/pages/products/ProductsPage.tsx');
await ok('Products: rows are one page of the filtered list, with the pager under the table', () => {
  assert(/const paged = paginate\(filtered, page, pageSize\);/.test(products), 'paginate(filtered, page, pageSize)');
  assert(/\{paged\.items\.map\(p => \(\s*<Fragment key=\{p\.id\}>/.test(products), 'rows map paged.items');
  assert(!/\{filtered\.map\(p => \(/.test(products), 'no row map over every filtered product');
  assert(/<Pager paged=\{paged\} noun="products" onPage=\{setPage\} onSize=\{n => \{ setPageSize\(n\); setPage\(1\); \}\} \/>/.test(products), 'the pager');
  assert(/usePageSize\('swiftpos\.pageSize\.products'\)/.test(products), 'the size remembered per screen');
});
await ok('Products: a new search or category → page 1; an edit / delete keeps the page, clamped', () => {
  assert(/useEffect\(\(\) => \{ setPage\(1\); \}, \[search, filterCategory\]\);/.test(products), 'reset on search / category');
  assert(/useEffect\(\(\) => \{ if \(paged\.page !== page\) setPage\(paged\.page\); \}, \[paged\.page, page\]\);/.test(products), 'clamp follows');
  assert(!/setPage\(1\)[^;]*\}, \[[^\]]*products/.test(products), 'a reload of the products must not reset the page');
});
await ok('Products: "Select all" is every filtered product across pages, labelled with the count; "Select this page" is the page', () => {
  const head = products.slice(products.indexOf('<th className="px-4 py-3 w-10">'), products.indexOf('Product</th>'));
  assert(/onChange=\{e => setSelectedIds\(e\.target\.checked \? new Set\(filtered\.map\(p => p\.id\)\) : new Set\(\)\)\}/.test(head), 'header checkbox: filtered');
  assert(/aria-label=\{`Select all \$\{groupDigits\(filtered\.length\)\}`\}/.test(head), 'header labelled "Select all 1,234"');
  assert(/const allSelected = filtered\.length > 0 && filtered\.every\(p => selectedIds\.has\(p\.id\)\);/.test(products), 'all = every filtered');
  assert(/data-testid="select-all-filtered" onClick=\{\(\) => setSelectedIds\(new Set\(filtered\.map\(p => p\.id\)\)\)\}/.test(products), 'Select all button');
  assert(/Select all \{groupDigits\(filtered\.length\)\}/.test(products), 'Select all N text');
  assert(/const selectPage = \(\) => setSelectedIds\(prev => \{ const next = new Set\(prev\); for \(const p of paged\.items\) next\.add\(p\.id\); return next; \}\);/.test(products), 'select page adds the page');
  assert(/data-testid="select-page" onClick=\{selectPage\}/.test(products) && /Select this page \(\{paged\.items\.length\}\)/.test(products), 'Select this page button');
});
await ok('Products: bulk actions still act on every selected id (not the page)', () => {
  assert(/setBulkPriceIds\(Array\.from\(selectedIds\)\)/.test(products) && /const ids = Array\.from\(selectedIds\);/.test(products), 'bulk from selectedIds');
});

// ── pins: the pager ──
const pager = read('src/components/Pager.tsx');
await ok('Pager: First / Prev / numbered window / Next / Last; the current page teal (swift), marked aria-current', () => {
  for (const id of ['pager-first', 'pager-prev', 'pager-page', 'pager-next', 'pager-last', 'pager-size', 'pager-range']) assert(pager.includes(`data-testid="${id}"`), id);
  assert(/pageWindow\(page, pages\)\.map/.test(pager), 'window');
  assert(/aria-current=\{slot === page \? 'page' : undefined\}/.test(pager), 'aria-current');
  assert(/slot === page \? 'bg-swift text-gray-950 font-semibold'/.test(pager), 'teal current page');
  assert(!/green-|emerald-|blue-\d/.test(pager), 'no green / blue');
});
await ok('Pager: a phone keeps Prev / Next and "51–100 of 1,234"; the numbers and First / Last only from sm', () => {
  assert(/<span className="hidden sm:flex items-center gap-1">\s*\{pageWindow/.test(pager), 'numbers hidden below sm');
  assert(/data-testid="pager-first" className=\{`hidden sm:inline-block/.test(pager) && /data-testid="pager-last" className=\{`hidden sm:inline-block/.test(pager), 'first / last from sm');
  assert(/data-testid="pager-range-short" className="sm:hidden/.test(pager), 'short range on a phone');
  assert(/className="flex flex-wrap items-center justify-between/.test(pager), 'wraps');
});
await ok('Pager: the size is remembered in try/catch (a private window does not break the page)', () => {
  assert(/try \{ return cleanPageSize\(localStorage\.getItem\(key\)\); \} catch \{ return DEFAULT_PAGE_SIZE; \}/.test(pager), 'read');
  assert(/try \{ localStorage\.setItem\(key, String\(c\)\); \} catch/.test(pager), 'write');
});

// ── pins: the web POS grids ──
const hook = read('src/hooks/useGridWindow.ts');
await ok('grid hook: an IntersectionObserver on the sentinel, rooted in the grid\'s scroll box, steps by GRID_STEP', () => {
  assert(/new IntersectionObserver\(\s*entries => \{ if \(entries\.some\(e => e\.isIntersecting\)\) setShown\(n => nextGridCount\(n, total, step\)\); \},\s*\{ root, rootMargin: '0px 0px 400px 0px' \},/.test(hook), 'observer');
  assert(/io\.observe\(sentinel\);/.test(hook) && /return \(\) => io\.disconnect\(\);/.test(hook), 'observe / disconnect');
  assert(/useEffect\(\(\) => \{\s*setShown\(step\);\s*if \(root\) root\.scrollTop = 0;\s*\}, \[resetKey, step\]\);/.test(hook), 'reset on a new category / search');
  assert(/const count = canObserve \? Math\.min\(shown, total\) : total;/.test(hook), 'no observer → every tile');
});
const cashier = read('src/pages/pos/CashierScreen.tsx');
await ok('web POS: draws gridList.slice(0, grid.count), resets on category / search, sentinel at the end', () => {
  assert(/const gridList = exactFirst\(filtered, search, \(p\) => \[p\.name, \(p as any\)\.barcode\]\);/.test(cashier), 'exact first');
  assert(/const grid = useGridWindow\(gridList\.length, `\$\{activeCategory\}\|\$\{search\}\|\$\{isPetrol\}`\);/.test(cashier), 'reset key');
  assert(/<div ref=\{grid\.rootRef\} style=\{s\.productGrid\}>/.test(cashier), 'root = the grid scroll box');
  assert(/gridList\.slice\(0, grid\.count\)\.map\(\(product\) => \{/.test(cashier) && !/filtered\.map\(\(product\)/.test(cashier), 'incremental map');
  assert(/\{grid\.more && <div ref=\{grid\.sentinelRef\} data-testid="grid-more"/.test(cashier), 'sentinel');
  assert(/data-testid="product-card"/.test(cashier) && /data-testid="cart-badge"/.test(cashier) && /data-testid="product-info"/.test(cashier), 'testids kept');
});
const mini = read('src/pages/pos/MinimartPOS.tsx');
await ok('minimart POS: the same incremental grid', () => {
  assert(/const grid = useGridWindow\(gridList\.length, `\$\{activeCategory\}\|\$\{catalogueSearch\}`\);/.test(mini), 'hook');
  assert(/<div ref=\{grid\.rootRef\} style=\{s\.productGrid\}>/.test(mini), 'root');
  assert(/gridList\.slice\(0, grid\.count\)\.map\(product => \{/.test(mini) && !/filteredProducts\.map\(product/.test(mini), 'map');
  assert(/\{grid\.more && <div ref=\{grid\.sentinelRef\} data-testid="grid-more"/.test(mini), 'sentinel');
});

// ── the shared copy ──
await ok('lib/paginate.ts is the shared file, registered in check-shared-sync', () => {
  eq(read('src/lib/paginate.ts'), fs.readFileSync(path.join(ROOT, 'shared/paginate.ts'), 'utf8'));
  assert(/'apps\/dashboard\/src\/lib\/paginate\.ts'/.test(fs.readFileSync(path.join(ROOT, 'scripts/check-shared-sync.mjs'), 'utf8')), 'registered');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
