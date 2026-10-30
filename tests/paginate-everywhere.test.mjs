/**
 * paginate-everywhere.test.mjs — A475: every web list that can show more than 50 rows, in pages.
 *
 * Owner, 2026-10-14: "on pagination do it on every page that has more than 50 items to show".
 *
 *   node tests/paginate-everywhere.test.mjs
 *
 * A472 paged the web Products page (tests/paginate.test.mjs runs the maths). This pins the same pager on every other
 * long list of the web dashboard (owner, web POS drawer; the manager portal is retired, A608) and the admin portal — source pins, React is not run:
 *   - the screen imports the Pager and lib/paginate, and remembers its page size under its own key;
 *   - its rows map ONE PAGE of the full filtered list (`<paged>.items.map`), never the full list;
 *   - the Pager sits under the rows;
 *   - a new search / filter / period / branch → page 1 (the reset effect and its deps); an edit keeps the page, clamped;
 *   - totals, counts, prints and Excel / CSV still use EVERY filtered row, not the page.
 * The lists left alone are in SKIPPED with the reason (bounded at 50 or fewer, server-capped at 50, server-paged, or a
 * worklist), and they draw no Pager — so adding one later means moving it here, on purpose.
 * The till's lists are pinned in apps/desktop/test/pages-everywhere.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE (both checked on the bench):
 *   - ExpensesPage's page reset drops filterPayer from its deps                       → "expenses: … page 1" fails
 *   - InventoryPage's rows map `filtered` again instead of `paged.items`             → "inventory: rows are one page" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};
const has = (src, s, what) => { if (!src.includes(s)) throw new Error(`${what ?? 'missing'}: ${s}`); };
const hasNot = (src, s, what) => { if (src.includes(s)) throw new Error(`${what ?? 'still there'}: ${s}`); };
/** The body of one component: from `marker` to the next top-level function. */
const body = (src, marker) => {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error(`no ${marker}`);
  const rest = src.slice(a + marker.length);
  const m = rest.search(/\n(?:export default )?function [A-Z]|\n\/\/ ─── [A-Z]/);
  return src.slice(a, m < 0 ? src.length : a + marker.length + m);
};
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const D = 'apps/dashboard/src/';
/**
 * One paged list. full = what paginate is given (every filtered row); paged / page = its names; deps = the reset
 * effect's deps (null: nothing narrows the list, so there is none); rows = how the page's rows are drawn when that is
 * not a plain `<paged>.items.map(` (e.g. a menu grouping the page under its categories); old = the row map it
 * replaced (must be gone);
 * keep = source that proves totals / prints / exports still use every row.
 */
const LISTS = [
  { file: 'pages/expenses/ExpensesPage.tsx', name: 'expenses', key: 'expenses', full: 'shown', paged: 'paged', page: 'page',
    deps: '[filterFrom, filterTo, filterCategory, filterMethod, filterPayer, activeBranchId]', old: '{shown.map(e => (',
    keep: ['const shownTotal = shown.reduce(', '{shown.length} expense{shown.length !== 1', 'money(narrowed ? shownTotal : total, currency)', 'const byMethod = [...shown.reduce('] },
  { file: 'pages/customers/CreditAccountsPage.tsx', name: 'credit accounts', key: 'creditAccounts', full: 'rows', paged: 'paged', page: 'page',
    deps: '[search]', old: '{rows.map(c => (', keep: ['const totalOwed = rows.reduce('] },
  { file: 'pages/customers/CreditAccountsPage.tsx', name: 'a credit statement', key: 'creditStatement', full: 'ledger', paged: 'ledgerPaged', page: 'ledgerPage',
    deps: '[selected?.id]', old: '{ledger.map(l => (', keep: [] },
  { file: 'pages/stock/IngredientsPage.tsx', name: 'ingredients', key: 'ingredients', full: 'visible', paged: 'paged', page: 'page',
    deps: '[search, filterCat, filterStatus, activeBranchId]', old: '{visible.map(i => {', keep: ['const lowCount = ingredients.filter('] },
  { file: 'pages/inventory/InventoryPage.tsx', name: 'inventory', key: 'inventory', full: 'filtered', paged: 'paged', page: 'page',
    deps: '[search, filter, activeBranchId]', old: '{filtered.map(row => {', keep: ['rows.forEach(r => counts[getStatus(r)]++);'] },
  { file: 'pages/inventory/MovementsDrawer.tsx', name: 'a product\'s stock history', key: 'stockMovements', full: 'movements', paged: 'paged', page: 'page',
    deps: '[product.id]', old: '{movements.map(m => {', keep: [] },
  { file: 'pages/stock/SuppliersPage.tsx', name: 'suppliers', key: 'suppliers', full: 'filtered', paged: 'paged', page: 'page',
    deps: '[search]', old: '{filtered.map(s => (', keep: [] },
  { file: 'components/Wastage.tsx', name: 'the wastage log', key: 'wastage', full: 'report?.entries ?? []', paged: 'paged', page: 'page',
    deps: '[from, to, branchId]', old: '{report.entries.map((e) => (', keep: [] },
  { file: 'components/StockCounts.tsx', scope: 'export default function StockCounts(', name: 'stock counts', key: 'stockCounts', full: 'list', paged: 'paged', page: 'page',
    deps: '[branchId]', old: '{list.map((t) => (', keep: ["const open = list.find((t) => t.status === 'counting'"] },
  { file: 'components/StockCounts.tsx', scope: 'function CountScreen(', name: 'a count\'s lines', key: 'countLines', full: 'rows', paged: 'paged', page: 'page',
    deps: '[search, onlyLeft, onlyDiff, id]', old: '{rows.map((l) => {',
    // what is typed on any page is saved; the sheets print every line
    keep: ['return take.lines.filter((l) => typed[l.id] !== undefined', ": take.lines.map((l) => [l.name, l.category ?? '', l.unit ?? '', ''])"] },
  { file: 'components/Expiry.tsx', scope: 'export default function Expiry(', name: 'expiry batches', key: 'expiry', full: 'rows', paged: 'paged', page: 'page',
    deps: '[days, showOk, branchId]', old: '{rows.map((r) => (', keep: [] },
  { file: 'pages/DiscountsPage.tsx', name: 'discounts', key: 'discounts', full: 'discounts', paged: 'paged', page: 'page',
    deps: null, old: '{discounts.map(d => {', keep: [] },
  { file: 'pages/OpenShiftsPage.tsx', name: 'open drawers', key: 'openDrawers', full: 'shifts', paged: 'paged', page: 'page',
    deps: null, old: '{shifts.map(s => {', keep: [] },
  { file: 'pages/ShiftReportsPage.tsx', name: 'shift reports', key: 'shiftReports', full: 'shown', paged: 'paged', page: 'page',
    deps: '[from, to, filter]', old: '{shown.map((s) => {', keep: ['const lines = shown.map((s) => [', 'rows: shown.map((s) => ({'] },
  { file: 'pages/settings/EtimsSettingsPage.tsx', name: 'the eTIMS log', key: 'etimsLog', full: 'invoices', paged: 'paged', page: 'page',
    deps: '[branchId]', old: '{invoices.map(r => (', keep: [] },
  { file: 'pages/BranchDetailPage.tsx', name: 'a branch\'s staff', key: 'branchStaff', full: 'staff', paged: 'staffPaged', page: 'staffPage',
    reset: 'useEffect(() => { setStaffPage(1); setStockPage(1); }, [id]);', old: '{staff.map(member => (', keep: [] },
  { file: 'pages/BranchDetailPage.tsx', name: 'a branch\'s stock', key: 'branchStock', full: 'stock', paged: 'stockPaged', page: 'stockPage',
    reset: 'useEffect(() => { setStaffPage(1); setStockPage(1); }, [id]);', old: '{stock.map(item => {', keep: ['const lowStock = stock.filter('] },
  { file: 'pages/settings/StaffTab.tsx', scope: 'export default function StaffTab(', name: 'staff (settings)', key: 'staff', full: 'staff', paged: 'paged', page: 'page',
    deps: '[activeBranchId]', old: '{staff.map(s => {', keep: ["{staff.filter(s => s.status === 'active').length} active"] },
  { file: 'pages/FleetPage.tsx', name: 'devices (fleet)', key: 'fleet', full: 'fleet', paged: 'paged', page: 'page',
    deps: '[showRetired]', old: '{fleet.map(d => {', keep: ['const silent = fleet.filter(', 'const behind = fleet.filter('] },
  { file: 'pages/settings/DevicesTab.tsx', name: 'devices (settings)', key: 'devices', full: 'filtered', paged: 'paged', page: 'page',
    deps: '[filter]', old: '{filtered.map(d => (', keep: ["const pending  = devices.filter(d => d.status === 'pending');"] },
  { file: 'pages/products/CombosPage.tsx', name: 'combos', key: 'combos', full: 'filtered', paged: 'paged', page: 'page',
    deps: '[search]', old: '{filtered.map(c => {', keep: [] },
  { file: 'pages/products/CategoriesPage.tsx', name: 'categories', key: 'categories', full: 'categories', paged: 'paged', page: 'page',
    deps: null, old: '{categories.map(cat => (', keep: [] },
  { file: 'pages/settings/MinimartSettingsPage.tsx', name: 'minimart products & barcodes', key: 'minimartProducts', full: 'filtered', paged: 'paged', page: 'page',
    deps: '[search]', old: '{filtered.map(p => (', keep: [] },
  { file: 'pages/pos/POSInventoryTab.tsx', name: 'the web POS stock list', key: 'posInventory', full: 'filtered', paged: 'paged', page: 'page',
    deps: '[search, filter]', old: '{filtered.map(row => {', keep: ['`All (${tracked.length})`'] },
  // ── owner Reports ──
  { file: 'pages/ReportsPage.tsx', scope: 'function ItemMixTab(', name: 'Reports › Item Mix', key: 'reports.itemMix', full: 'filtered', paged: 'itemPaged', page: 'itemPage',
    deps: '[range.from, range.to, branchId, search, sortBy]', keep: ['rows: filtered.map((p, i) => ({ ...p, n: i + 1 })),'] },
  { file: 'pages/ReportsPage.tsx', scope: 'function VoidsTab(', name: 'Reports › Void log', key: 'reports.voids', full: 'data?.voids ?? []', paged: 'voidPaged', page: 'voidPage',
    deps: '[range.from, range.to, branchId]', keep: ['rows: data.voids.map(v => ({ ...v, time: localStamp(v.created_at) })) },'] },
  { file: 'pages/ReportsPage.tsx', scope: 'function RefundsTab(', name: 'Reports › Refund log', key: 'reports.refunds', full: 'data?.refunds ?? []', paged: 'refundPaged', page: 'refundPage',
    deps: '[range.from, range.to, branchId]', keep: ['rows: data.refunds.map(r => ({'] },
  { file: 'pages/ReportsPage.tsx', scope: 'function InventoryTab(', name: 'Reports › Stock movement', key: 'reports.inventory', full: 'data?.summary ?? []', paged: 'stockPaged', page: 'stockPage',
    deps: '[range.from, range.to, branchId]', keep: ['value={fmt.qty(rows.reduce((s, r) => s + r.sold, 0))}'] },
  { file: 'pages/ReportsPage.tsx', scope: 'function FoodCostTab(', name: 'Reports › Food cost, ingredients', key: 'reports.foodCost.ingredients', full: 'data?.ingredients ?? []', paged: 'ingredientPaged', page: 'ingredientPage',
    deps: '[range.from, range.to, branchId]', keep: ['rows: ingredients.map(i => i.actualCost === null'] },
  { file: 'pages/ReportsPage.tsx', scope: 'function FoodCostTab(', name: 'Reports › Food cost, dishes', key: 'reports.foodCost.dishes', full: 'data?.products ?? []', paged: 'dishPaged', page: 'dishPage',
    deps: '[range.from, range.to, branchId]', keep: ['rows: products },'] },
  { file: 'pages/ReportsPage.tsx', scope: 'function SplhTab(', name: 'Reports › SPLH shift log', key: 'reports.splh.shifts', full: 'data?.shifts ?? []', paged: 'shiftPaged', page: 'shiftPage',
    deps: '[range.from, range.to, branchId]', keep: ['rows: shifts.map(s => ({ ...s, opened: localStamp(s.opened_at) })) },'] },
  { file: 'pages/ReportsPage.tsx', scope: 'function WetStockTab(', name: 'Reports › Wet stock deliveries', key: 'reports.wetStock.deliveries', full: '((data?.deliveryLog ?? []) as any[])', paged: 'deliveryPaged', page: 'deliveryPage',
    deps: '[range.from, range.to, branchId]', keep: ['rows: ((deliveryLog ?? []) as any[]).map((d: any) => ({ ...d, date: localStamp(d.recorded_at) })) },'] },
  { file: 'pages/ReportsPage.tsx', scope: 'function MatrixQuad(', name: 'Reports › Menu Matrix quadrants', key: 'reports.matrix', full: 'items', paged: 'quadPaged', page: 'quadPage',
    deps: '[resetKey]', old: '{items.map(p => (', keep: ['<span className="text-xs text-gray-400 tabular-nums">{items.length}</span>'] },
  // A608 (2026-10-29): the web manager portal is retired — its checks are gone; its eleven lists (Manager › Expenses,
  // Credit, Reports, History, Menu) left LISTS; the dashboard's own pages above are the web's lists now.
];

for (const L of LISTS) {
  const whole = read(D + L.file);
  const src = L.scope ? body(whole, L.scope) : whole;
  const set = `set${cap(L.page)}`;
  ok(`${L.name}: imports the Pager and the shared page maths (${L.file})`, () => {
    if (!/import Pager, \{ usePageSize \} from ['"][./]+(?:components\/)?Pager['"];/.test(whole)) throw new Error('Pager import');
    if (!/import \{ paginate \} from ['"][./]+lib\/paginate['"];/.test(whole)) throw new Error('paginate import');
  });
  ok(`${L.name}: rows are one page of every filtered row; the pager under them; size kept as swiftpos.pageSize.${L.key}`, () => {
    has(src, `const ${L.paged} = paginate(${L.full}, ${L.page}, `);
    has(src, L.rows ?? `${L.paged}.items.map(`);
    has(src, `<Pager paged={${L.paged}}`);
    has(src, `onPage={${set}} onSize={n => { `);
    has(whole, `usePageSize('swiftpos.pageSize.${L.key}')`.replace(/'/g, whole.includes(`usePageSize("swiftpos.pageSize.${L.key}")`) ? '"' : "'"));
    if (L.old) hasNot(src, L.old, 'a row map over the full list');
  });
  ok(`${L.name}: ${L.deps || L.reset ? 'a new search / filter / period → page 1; ' : ''}an edit keeps the page (clamped)`, () => {
    if (L.reset) has(src, L.reset);
    else if (L.deps) has(src, `useEffect(() => { ${set}(1); }, ${L.deps});`);
    else hasNot(src, `${set}(1); }, [`, 'a reset effect with nothing to reset on');
    has(src, `useEffect(() => { if (${L.paged}.page !== ${L.page}) ${set}(${L.paged}.page); }, [${L.paged}.page, ${L.page}]);`);
  });
  if (L.keep.length) ok(`${L.name}: totals, counts, prints and exports still use every row`, () => {
    for (const k of L.keep) has(whole, k);
  });
}

// ── the supplier account: one pager for whichever tab is shown ──
ok('supplier account: bills, statement, payments and returns are each one page; the pager follows the tab', () => {
  const src = read(D + 'components/SupplierAccount.tsx');
  for (const [v, list] of [['billsPaged', 'acc?.bills'], ['statementPaged', 'acc?.statement'], ['paymentsPaged', 'acc?.payments'], ['returnsPaged', 'acc?.returns']]) {
    has(src, `const ${v} = paginate(${list} ?? [], page, pageSize);`); has(src, `{${v}.items.map((`);
  }
  for (const old of ['{acc.bills.map((b) => (', '{acc.statement.map((e) => (', '{acc.payments.map((x) => (', '{acc.returns.map((r) => (']) hasNot(src, old);
  has(src, "const paged = tab === 'bills' ? billsPaged : tab === 'statement' ? statementPaged : tab === 'payments' ? paymentsPaged : returnsPaged;");
  has(src, '<Pager paged={paged}');
  has(src, "usePageSize('swiftpos.pageSize.supplierAccount')");
  has(src, 'useEffect(() => { setPage(1); }, [tab, supplierId]);');
  has(src, 'useEffect(() => { if (paged.page !== page) setPage(paged.page); }, [paged.page, page]);');
  // the printed statement, the Pay form and "For" use every row
  has(src, 'rows: acc.statement.map((e) =>'); has(src, 'bills={acc.bills.filter((b) => b.due > 0)}'); has(src, 'acc.bills.find((b) => b.id === x.bill_id)');
});

ok('the page hooks run before any early return (rules of hooks) on the screens that return early', () => {
  const before = (file, scope, hook, early) => {
    const s = scope ? body(read(D + file), scope) : read(D + file);
    const h = s.indexOf(hook), e = s.indexOf(early);
    if (h < 0 || e < 0 || h > e) throw new Error(`${file}: ${hook} must come before ${early}`);
  };
  before('pages/inventory/InventoryPage.tsx', null, 'const paged = paginate(', 'if (!activeBranchId) {');
  before('pages/stock/SuppliersPage.tsx', null, 'const paged = paginate(', 'if (account) {');
  before('components/SupplierAccount.tsx', 'export default function SupplierAccount(', 'const paged = tab ===', 'if (!acc) {');
  before('components/StockCounts.tsx', 'export default function StockCounts(', 'const paged = paginate(', 'if (openId) {');
  before('components/StockCounts.tsx', 'function CountScreen(', 'const paged = paginate(', 'if (!take) {');
  before('pages/settings/EtimsSettingsPage.tsx', null, 'const paged = paginate(', 'if (!branchId) return <div');
  before('pages/BranchDetailPage.tsx', null, 'const stockPaged = paginate(', 'if (loading) return');
  for (const t of ['ItemMixTab', 'VoidsTab', 'RefundsTab', 'InventoryTab', 'FoodCostTab', 'SplhTab', 'WetStockTab'])
    before('pages/ReportsPage.tsx', `function ${t}(`, '= paginate(', 'if (loading) return');
});

ok('the Menu Matrix quadrant is its own component (it keeps its page between renders), fed the period as its reset key', () => {
  const src = read(D + 'pages/ReportsPage.tsx');
  hasNot(src, 'const Quad = (', 'a quadrant defined inside render remounts on every render and loses its page');
  if ((src.match(/<MatrixQuad currency=\{currency\} resetKey=\{`\$\{range\.from\}\|\$\{range\.to\}\|\$\{branchId \?\? ''\}`\}/g) || []).length !== 4) throw new Error('four quadrants with the reset key');
  has(src, ".flatMap(([cls, items]) => items.map(p => ({ cls, name: p.name, qty: p.qty, unitCM: p.unitCM })));");
});

// ── the admin portal: its own look, the same maths ──
const admin = read('apps/admin/src/AdminPortal.tsx');
const adminPager = read('apps/admin/src/AdminPager.tsx');
ok('admin: the pager is the admin\'s own (inline styles), on the same shared page maths', () => {
  has(adminPager, 'from "./lib/paginate"');
  has(adminPager, 'export function usePageSize(key: string)');
  has(adminPager, 'rangeLabel(paged)'); has(adminPager, 'pageWindow(page, pages)');
  hasNot(adminPager, 'className=', 'the admin portal has no Tailwind');
  has(read('scripts/check-shared-sync.mjs'), "'apps/admin/src/lib/paginate.ts',");
  if (read('apps/admin/src/lib/paginate.ts') !== read('shared/paginate.ts')) throw new Error('the admin copy differs from shared/paginate.ts');
  has(admin, 'import AdminPager, { usePageSize } from "./AdminPager";'); has(admin, 'import { paginate } from "./lib/paginate";');
});
for (const [scope, name, key, full, old, keep] of [
  ['function BillingPage(', 'admin › Billing', 'billing', 'invoices', '{invoices.map(inv => (', 'const total       = invoices.reduce('],
  ['function AuditPage(', 'admin › Audit log', 'audit', 'logs', '{logs.map(l => (', '{total} total events'],
]) {
  ok(`${name}: one page of the rows, the pager under them; the totals are every row`, () => {
    const src = body(admin, scope);
    has(src, `usePageSize("swiftpos.admin.pageSize.${key}")`);
    has(src, `const paged = paginate(${full}, page, pageSize);`);
    has(src, '{paged.items.map(');
    hasNot(src, old, 'a row map over the full list');
    has(src, '<AdminPager paged={paged} onPage={setPage} onSize={n => { setPageSize(n); setPage(1); }} />');
    has(src, 'useEffect(() => { if (paged.page !== page) setPage(paged.page); }, [paged.page, page]);');
    has(src, keep);
  });
}

// ── left alone, and why. Each draws no Pager; where the reason is a cap, the cap is pinned. ──
const SKIPPED = [
  ['apps/dashboard/src/pages/OrdersPage.tsx', 'server-paged: limit / offset with its own Prev / Next', (s) => has(s, 'offset: String((p - 1) * PAGE_SIZE)')],
  ['apps/dashboard/src/pages/crm/CustomersPage.tsx', 'server-paged (page / limit 20); a customer\'s transactions are capped at 20 by the cloud', (s) => has(s, "page: String(p), limit: String(LIMIT)")],
  ['apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx', 'server-paged (the manager\'s order history)', (s) => has(s, 'offset: String((p - 1) * PAGE_SIZE)')],
  ['apps/dashboard/src/pages/pos/POSCustomersTab.tsx', 'server-paged (page / limit)', (s) => has(s, "page: String(p), limit: String(LIMIT)")],
  ['apps/dashboard/src/pages/stock/PurchaseOrdersPage.tsx', 'the cloud returns at most 50 purchase orders (default limit)', () => has(read('apps/server/src/routes/stock.ts'), "const { status, supplier_id, limit = '50' }")],   // A494: the branch is branchScope's
  ['apps/dashboard/src/pages/stock/StockTransfersPage.tsx', 'the cloud returns at most 50 transfers (default limit)', () => has(read('apps/server/src/routes/stock.ts'), "const { status, limit = '50' }")],   // A494: the branch is branchScope's
  ['apps/dashboard/src/pages/settings/WebhooksTab.tsx', 'a webhook\'s deliveries are capped at 50 by the cloud; webhooks themselves are a handful', () => has(read('apps/server/src/routes/webhooks.ts'), '.limit(50);')],
  ['apps/dashboard/src/pages/settings/PetrolSettingsPage.tsx', 'tank movements are fetched with limit=50; pumps / tanks / grades are a station\'s few', (s) => has(s, "'/api/fuel-tanks/movements?limit=50'")],
  ['apps/dashboard/src/components/ShiftConfirmations.tsx', 'awaiting = a worklist emptied as shifts are confirmed; confirmed is the last 20', (s) => has(s, '.slice(0, 20)')],
  ['apps/dashboard/src/pages/ApprovalsPage.tsx', 'a worklist of changes awaiting approval — each leaves once decided', null],
  ['apps/dashboard/src/pages/PromotionsPage.tsx', 'a business\'s promotions — a handful of config cards', null],
  ['apps/dashboard/src/pages/OffersPage.tsx', 'a business\'s offers — a handful; its product picker is a search capped at 200 in a scroll box', null],
  ['apps/dashboard/src/pages/ReservationsPage.tsx', 'one day\'s bookings at one branch, bounded by its tables', null],
  ['apps/dashboard/src/pages/PaymentMethodsPage.tsx', 'a business\'s payment methods', null],
  ['apps/dashboard/src/pages/settings/RolesTab.tsx', 'a business\'s roles', null],
  ['apps/dashboard/src/pages/BranchesPage.tsx', 'a business\'s branches', null],
  ['apps/dashboard/src/pages/QRMenuPage.tsx', 'the customer\'s QR menu — browsed by category like the POS grid, not a management list', null],
  ['apps/dashboard/src/pages/pos/TableTurnoverPage.tsx', 'bounded by a branch\'s tables', null],
  ['apps/dashboard/src/pages/reports/MonthlyPackTab.tsx', 'bounded by the days of a month (≤ 31)', null],
  // A608 (2026-10-29): the web manager portal is retired — its checks are gone; ManagerShiftTab / RemoteDayClose /
  // ManagerReceivingTab left SKIPPED.
  ['apps/admin/src/MigrationsPage.tsx', 'the last 25 migration runs', null],
  ['apps/admin/src/AlertsPage.tsx', 'open alerts — a worklist, grouped critical / warning', null],
];
// Owner, 2026-10-14 ("proceed and build"): every client reachable — the SERVER pages (limit / offset), the pager drives it.
ok('admin › Clients pages through the server: limit and offset from the pager, page 1 on a filter change, the pager drawn',
  () => has(admin, 'const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) });')
    && has(admin, 'useEffect(() => { setPage(1); }, [search, status, type, pageSize]);')
    && has(admin, '{total > 0 && <AdminPager paged={pagedClients} onPage={setPage} onSize={n => { setPageSize(n); setPage(1); }} />}')
    && !admin.includes('new URLSearchParams({ limit: "50" })'));
for (const [file, why, cap] of SKIPPED) {
  ok(`left alone — ${file.replace(/^apps\/[a-z]+\/src\//, '')}: ${why}`, () => {
    const s = read(file);
    if (/<(?:Admin)?Pager /.test(s)) throw new Error('it draws a Pager now — move it from SKIPPED to LISTS');
    if (cap) cap(s);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
