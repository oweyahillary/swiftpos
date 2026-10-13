/**
 * web-mobile.test.mjs — A463: the web apps fit a phone.
 *
 * Owner, 2026-10-13: "read all the web apps especially dashboard make it mobile responsive".
 *
 * Pins the shipped layouts (React is not run): the owner's sidebar and the manager's sidebar are drawers on a phone, the
 * web POS cart is a full-screen sheet opened from a bar, dialogs fit the screen, wide tables scroll sideways inside
 * their card, and the admin portal's three-column grids collapse.
 *
 *   node tests/web-mobile.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE: the owner's aside without -translate-x-full → "the owner's sidebar is a drawer" fails;
 * the POS cart without the phone sheet → "the web POS cart is a sheet" fails; an inline repeat(3,1fr) back on the
 * admin KPI grid → "the admin KPI grids collapse" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n}  ${d}`); } };

const D = 'apps/dashboard/src/';
const layout = read(D + 'components/DashboardLayout.tsx');
const mgr = read(D + 'pages/manager/ManagerDashboard.tsx');
const pos = read(D + 'pages/pos/CashierScreen.tsx');

// ── the owner's dashboard ──
ok('the owner\'s sidebar is a drawer on a phone, fixed from md up',
  /-translate-x-full/.test(layout) && /md:static/.test(layout) && /md:translate-x-0/.test(layout));
ok('☰ opens it; a page change closes it',
  /data-testid="nav-open"/.test(layout) && /setNavOpen\(true\)/.test(layout) && /setNavOpen\(false\); \}, \[navLocation\.pathname\]/.test(layout));
ok('the phone\'s top bar shows only below md', /md:hidden sticky top-0/.test(layout));
ok('the shell uses the dynamic viewport height', /h-\[100dvh\]/.test(layout) && !/h-screen/.test(layout));
ok('the notifications panel fits a phone', /fixed left-3 right-3 top-16 md:absolute/.test(layout));

// ── the manager's dashboard ──
ok('the manager\'s sidebar is a drawer on a phone',
  /isPhone \? `fixed inset-y-0 left-0 z-40 w-64/.test(mgr) && /-translate-x-full/.test(mgr));
ok('picking a page on a phone closes the drawer', /setActive\(item\.key\); if \(isPhone\) setSidebarOpen\(false\)/.test(mgr));
ok('the manager\'s drawer starts closed on a phone', /useState\(\(\) => !\(typeof window/.test(mgr));

// ── the web POS ──
ok('the web POS cart is a sheet on a phone, opened from the cart bar',
  /data-testid="pos-cart"/.test(pos) && /display: cartSheet \? 'flex' : 'none'/.test(pos)
  && /data-testid="pos-cart-bar"[^>]*onClick=\{\(\) => setCartSheet\(true\)\}/.test(pos)
  && /data-testid="pos-cart-back"[^>]*onClick=\{\(\) => setCartSheet\(false\)\}/.test(pos));
ok('the cart bar shows the item count and the total', /🛒 Cart · /.test(pos) && /\{fmt\(orderTotal, currency\)\} ›/.test(pos));
ok('the POS dialogs fit a phone', /maxWidth: 340, maxHeight: '90dvh', overflowY: 'auto'/.test(pos) && !/width: 340,/.test(pos));
ok('the POS fills the dynamic viewport', (pos.match(/height: '100dvh'/g) || []).length >= 2 && !/height: '100vh'/.test(pos));

// ── wide tables scroll inside their card; side panels stack; toasts fit ──
const mgrRep = read(D + 'pages/manager/ManagerReportsPage.tsx');
ok('the manager\'s report tables scroll sideways', (mgrRep.match(/overflow-x-auto/g) || []).length >= 6);
for (const f of ['pages/OrdersPage.tsx', 'pages/expenses/ExpensesPage.tsx', 'pages/stock/IngredientsPage.tsx',
                 'pages/OpenShiftsPage.tsx', 'components/ShiftConfirmations.tsx', 'pages/DiscountsPage.tsx']) {
  ok(`${f}: its table scrolls sideways`, /overflow-x-auto/.test(read(D + f)));
}
ok('expenses: the categories panel stacks above the list on a phone',
  /flex flex-col lg:flex-row/.test(read(D + 'pages/expenses/ExpensesPage.tsx')));
ok('purchase orders: on a phone a PO opens full width with a way back',
  /setSelected\(null\)\} className="lg:hidden[^"]*">← Back to the list/.test(read(D + 'pages/stock/PurchaseOrdersPage.tsx')));
ok('the toast fits a phone', /w-\[calc\(100%-2rem\)\] max-w-sm/.test(read(D + 'components/Toast.tsx')));
ok('the counted close dialog scrolls on a short screen', /max-h-\[90vh\] overflow-y-auto/.test(read(D + 'components/CountedCloseModal.tsx')));

// ── minimart POS and the shift dialog ──
const mini = read(D + 'pages/pos/MinimartPOS.tsx');
ok('minimart POS: on a phone the cart sits under the products',
  /isPhone \? \{ \.\.\.s\.body, flexDirection: 'column' \}/.test(mini) && /isPhone \? \{ \.\.\.s\.cartPanel, width: '100%'/.test(mini));
ok('the shift dialog scrolls on a short screen', /maxHeight: '90dvh', overflowY: 'auto'/.test(read(D + 'pages/pos/ShiftModal.tsx')));

// ── admin portal ──
const admin = read('apps/admin/src/AdminPortal.tsx');
ok('the admin KPI grids collapse on a phone',
  !/gridTemplateColumns: "repeat\(3,1fr\)"/.test(admin) && /@media[^{]*max-width:\s*767px[\s\S]*?\.sp-kpi-grid\.sp-kpi-3 \{ grid-template-columns: 1fr; \}/.test(admin));
ok('the admin new-client form rows collapse on a phone',
  /className="sp-form-2"/.test(admin) && /\.sp-form-2 \{ grid-template-columns: 1fr; \}/.test(admin));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
