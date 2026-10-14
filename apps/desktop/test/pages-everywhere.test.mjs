/**
 * pages-everywhere.test.mjs — A475: every till manager list that can run past 50 rows is in pages.
 *
 * Owner, 2026-10-14: "on pagination do it on every page that has more than 50 items to show". A472 paged the Menu
 * screen (test/menu-pages.test.mjs); this pins the same pager — components/Pager.tsx over shared/paginate.ts — on
 * Orders, Expenses, Stock Levels, Branch Prices (ManagerPage.tsx) and Staff (ManageTabs.tsx).
 *
 *   node test/pages-everywhere.test.mjs
 *
 * For each screen (React is not run here): it imports Pager + paginate; one page of the FULL filtered list is drawn
 * (`<paged>.items.map`), never the full list; the pager sits under the rows with a remembered size; a new search /
 * filter / period goes back to page 1; an edit / refresh keeps the page, clamped; counts, totals and subtotals still
 * add up every filtered row, not the page. Then the lists left unpaged, and why (SKIPPED).
 *
 * MUTATIONS TO CONFIRM BITE (both checked on the bench):
 *   - ExpensesTab's page reset drops `payer` from its deps           → "Expenses: a new period / filter → page 1" fails
 *   - OrdersTab's rows go back to `{orders.map(o => {`               → "Orders: rows are one page …" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The text of one function, from its header to the next top-level function / section comment. */
const fnBody = (src, header, next) => {
  const a = src.indexOf(header);
  assert(a >= 0, `${header} not found`);
  const b = src.indexOf(next, a + header.length);
  return src.slice(a, b < 0 ? undefined : b);
};

const mp = read('src/renderer/pages/ManagerPage.tsx');
const mt = read('src/renderer/pages/ManageTabs.tsx');

/**
 * The paged screens. `full` is the full filtered list, `p` the prefix of its page state (xPage / setXPage / xPageSize /
 * xPaged), `deps` the page-reset deps (null = no search / filter to reset on), `row` what the rows map begins with.
 */
const SCREENS = [
  { name: 'Orders', src: () => fnBody(mp, 'function OrdersTab(', '// ── Shift Tab'), full: 'orders', p: 'orders',
    key: 'orders', noun: 'orders', deps: 'range.preset, range.from, range.to, scope',
    row: "{ordersPaged.items.map(o => {\n                  const method = o.payments?.[0]?.method ?? '—';",
    oldRow: /\{orders\.map\(o => \{/ },
  { name: 'Expenses', src: () => fnBody(mp, 'function ExpensesTab(', '// ── Stock Tab'), full: 'rows', p: 'expenses',
    key: 'expenses', noun: 'expenses', deps: 'range.preset, range.from, range.to, method, payer',
    row: '{expensesPaged.items.map(e => (\n                <tr key={e.id}',
    oldRow: /\{rows\.map\(e => \(/ },
  { name: 'Stock Levels', src: () => fnBody(mp, 'function StockTab(', '// ── Top Items Tab'), full: 'visible', p: 'stock',
    key: 'stock', noun: 'products', deps: 'filter',
    row: '{stockPaged.items.map(s => {\n                  const critical',
    oldRow: /\{visible\.map\(s => \{/ },
  { name: 'Branch Prices', src: () => fnBody(mp, 'function PricesTab(', 'export default function ManagerPage'), full: 'visible', p: 'prices',
    key: 'prices', noun: 'products', deps: 'query',
    row: '{pricesPaged.items.map(r => {\n                  const hasOverride',
    oldRow: /\{visible\.map\(r => \{/ },
  { name: 'Staff', src: () => fnBody(mt, 'export function StaffTab(', '/* ── Receipt text'), full: 'staff', p: 'staff',
    key: 'staff', noun: 'staff', deps: null,
    row: '{staffPaged.items.map(m => (\n          <div key={m.id}',
    oldRow: /\{staff\.map\(m => \(/ },
];

ok('imports: Pager + usePageSize and the shared paginate, in both files', () => {
  for (const [f, src] of [['ManagerPage', mp], ['ManageTabs', mt]]) {
    assert(src.includes("import Pager, { usePageSize } from '../components/Pager';   // A475"), `${f}: Pager import`);
    assert(src.includes("import { paginate } from '../../shared/paginate';"), `${f}: paginate import`);
  }
});

for (const s of SCREENS) {
  const P = s.p, Cap = P[0].toUpperCase() + P.slice(1);
  const page = `${P}Page`, setPage = `set${Cap}Page`, size = `${P}PageSize`, setSize = `set${Cap}PageSize`, paged = `${P}Paged`;
  ok(`${s.name}: rows are one page of the full filtered list; the pager under the rows, size remembered`, () => {
    const t = s.src();
    assert(t.includes(`const [${page}, ${setPage}] = useState(1);`), 'page state');
    assert(t.includes(`const [${size}, ${setSize}] = usePageSize('swiftpos.pageSize.${s.key}');`), 'size remembered under its own key');
    assert(t.includes(`const ${paged} = paginate(${s.full}, ${page}, ${size});`), `paginate(${s.full}, …)`);
    assert(t.includes(s.row), `rows map ${paged}.items`);
    assert(!s.oldRow.test(t), `no row map over the full list (${s.oldRow})`);
    assert(t.includes(`<Pager paged={${paged}} noun="${s.noun}" onPage={${setPage}} onSize={n => { ${setSize}(n); ${setPage}(1); }} />`), 'pager');
    assert(t.indexOf(`<Pager paged={${paged}}`) > t.indexOf(`${paged}.items.map(`), 'pager under the rows');
  });
  ok(`${s.name}: ${s.deps ? 'a new period / filter → page 1; ' : ''}an edit / refresh keeps the page, clamped`, () => {
    const t = s.src();
    if (s.deps) assert(new RegExp(`useEffect\\(\\(\\) => \\{ ${setPage}\\(1\\); \\}, \\[${esc(s.deps)}\\]\\);`).test(t), `reset on [${s.deps}]`);
    else assert(!new RegExp(`${setPage}\\(1\\); \\}, \\[`).test(t), 'no reset effect (nothing to reset on)');
    assert(t.includes(`useEffect(() => { if (${paged}.page !== ${page}) ${setPage}(${paged}.page); }, [${paged}.page, ${page}]);`), 'clamp');
  });
  ok(`${s.name}: hooks before any early return`, () => {
    const t = s.src();
    const early = t.search(/\n  if \(loading\) return /);
    if (early >= 0) assert(t.indexOf(`usePageSize('swiftpos.pageSize.${s.key}')`) < early && t.indexOf(`const ${paged} = paginate(`) < early
      && t.indexOf(`if (${paged}.page !== ${page})`) < early, 'page hooks come before `if (loading) return`');
  });
}

ok('Orders: the count, the range total and the 500 note stay every order in the range', () => {
  const t = SCREENS[0].src();
  assert(t.includes('const rangeTotal = orders.reduce((s, o) => s + Number(o.total ?? 0), 0);'), 'total over orders');
  assert(t.includes("`${orders.length} order${orders.length === 1 ? '' : 's'} · ${fmt(rangeTotal, currency)}`"), 'count line');
  assert(t.includes('{orders.length === 500 &&'), '500 note');
  assert(t.includes('exportKind="orders"'), 'the download is the range export, not the page');
  assert(!/ordersPaged\.(items|total)[^;]*reduce/.test(t), 'no total over the page');
});
ok('Expenses: the summary, the per-method subtotals and the Total row stay every filtered expense', () => {
  const t = SCREENS[1].src();
  assert(t.includes('const shownTotal = rows.reduce((a, e) => a + Number(e.amount || 0), 0);'), 'shownTotal over rows');
  assert(t.includes('const byMethod = [...rows.reduce('), 'subtotals over rows');
  assert(t.includes("{fmt(shownTotal, currency)}</td>") && t.includes("{filtered ? 'Total (filtered)' : 'Total'}"), 'Total row');
  assert(t.includes("`${rows.length} expense${rows.length === 1 ? '' : 's'}"), 'summary counts rows');
  assert(t.indexOf('<Pager paged={expensesPaged}') > t.indexOf('</tfoot>'), 'pager under the Total row');
});
ok('Stock Levels: the counts and the tabs count every product', () => {
  const t = SCREENS[2].src();
  assert(t.includes('{stock.length} products · {low.length} low or critical'), 'count line');
  assert(t.includes("`All (${stock.length})` : `Low stock (${low.length})`"), 'tab counts');
});
ok('Branch Prices: the counts stay every product', () => {
  const t = SCREENS[3].src();
  assert(t.includes('{rows.length} products · {overrides} with a branch price'), 'count line');
  assert(t.includes('const overrides = rows.filter(r => r.branch_price !== null).length;'), 'overrides over rows');
});

// ── lists left unpaged, and why ──
const SKIPPED = [
  ['pages/ManagerPage.tsx', 'TopItemsTab (Item Mix)', 'capped at 50 on the till (getTopProducts(50)) and 10 from the cloud'],
  ['pages/ManagerPage.tsx', 'ZReportTab live Z-reports, ShiftTab by-method', 'one card per till / per payment method'],
  ['pages/ManagerPage.tsx', 'Overview cards (shifts and tills, staff performance, low stock, top sellers)', 'the Overview is not touched (A475 brief)'],
  ['pages/ManageTabs.tsx', 'MenuTab', 'not rendered — the Menu screen is MenuWorkbench, paged by A472'],
  ['pages/ManageTabs.tsx', 'CombosTab, CategoryBlock, add-on / variant groups', 'a handful of meal deals, categories, option groups'],
  ['pages/ManageTabs.tsx', 'ImportTab preview', 'already shows the first 50 rows (valid.slice(0, 50))'],
  ['components/TransfersTab.tsx', 'incoming / outgoing / Earlier', 'open transfers are a short work queue; Earlier is capped at 30'],
  ['screens/OffersScreen.tsx', 'offers; the product / category picker', 'a handful of offers; the picker is a capped (200) scroll box'],
  ['components/TillWastage.tsx', 'expiring / pending / refused', 'expiring is capped at 12; the others are this till\'s unsent queue'],
  ['components/MonthlyPackTab.tsx', 'summary, expenses by day, books, movements', 'one month: ≤31 day groups with day subtotals; the Excel has every line'],
  ['pages/DayCloseTab.tsx', 'conflicts, awaiting shifts', 'bounded by the shifts of a day'],
  ['pages/BranchCloseTab.tsx', 'tills, drawers, money lines', 'bounded by the tills of a branch'],
  ['pages/ShiftPanel.tsx', 'one shift\'s expenses, denominations, cashiers', 'one shift'],
  ['pages/TechPage.tsx', 'SQL console result', 'a technician\'s query box: capped at 500, in its own scroll box'],
  ['components/HeldOrdersModal.tsx', 'held orders', 'the cashier\'s open tabs, not a management list'],
  ['components/CashierHistoryPanel.tsx', 'payment methods', 'a settings list of methods'],
  ['components/ExclusionsPanel.tsx', 'kitchen-note exclusions', 'a short settings list'],
  ['pages/POSPage.tsx', 'the POS grid', 'draws incrementally (A472) — a cashier scrolls, no pages'],
];
ok('skipped lists: each named file exists, and none but the paged ones draws a Pager', () => {
  for (const [f] of SKIPPED) {
    const src = read(path.join('src/renderer', f));
    if (f === 'pages/ManagerPage.tsx' || f === 'pages/ManageTabs.tsx') continue;
    assert(!src.includes('<Pager '), `${f} has a Pager — move it out of SKIPPED and pin it`);
  }
  const topItems = fnBody(mp, 'function TopItemsTab(', '// ── Main ManagerPage');
  assert(!topItems.includes('<Pager '), 'Item Mix is capped at 50, unpaged');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
