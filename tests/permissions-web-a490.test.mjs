/**
 * permissions-web-a490.test.mjs — A490 / A491 on the web (apps/dashboard): one permission rule, fine keys everywhere,
 * no role names, the owner sets it all in one place.
 *
 *   node tests/permissions-web-a490.test.mjs
 *
 * RUNS the real lib/posRouting.ts, pages/orderRefund.ts and the pure helpers of components/PermissionPicker.tsx
 * (bundled with esbuild, as tests/paginate.test.mjs does), then pins the screens to the catalogue's keys.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - posRouting back to a role-name list                         → "no role-name checks" and "routing" fail
 *   - posRouting without dropping OPEN_BEFORE_A490                → "a pre-A490 cashier stays on the till" fails
 *   - a manager nav item back to 'reports.view' / null            → "every manager page has its fine key" fails
 *   - a report tab without its key                                → "every report tab has its key" fails
 *   - PaymentModal sending a promo discount without sales.discount → "discount" fails
 *   - POSOrderHistoryTab gating refund on sales.void              → "void and refund" fails
 *   - ZReportModal showing expected cash to everyone              → "Z-report" fails
 *   - RolesTab saving permission_ids                              → "RolesTab" fails
 *   - the Business tabs not calling /api/controls                 → "Business" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/dashboard/src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

function requireFrom(pkgDirs, name) {
  for (const d of pkgDirs) {
    try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ }
  }
  throw new Error(`${name} not installed (npm ci in apps/dashboard)`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a490-web-'));
const bundle = async (entry, name) => {
  const outfile = path.join(tmp, `${name}.mjs`);
  esbuild.buildSync({ entryPoints: [path.join(SRC, entry)], bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    outfile, logLevel: 'silent', nodePaths: [path.join(ROOT, 'apps/dashboard/node_modules')] });
  return import(pathToFileURL(outfile).href);
};
const Routing = await bundle('lib/posRouting.ts', 'routing');
const Perms = await bundle('lib/permissions.ts', 'permissions');
const Refund = await bundle('pages/orderRefund.ts', 'refund');
const Picker = await bundle('components/PermissionPicker.tsx', 'picker');
const KEYS = new Set(Perms.PERMISSION_KEYS);
const mapOf = (keys, marker = true) => Object.fromEntries([...keys.map((k) => [k, true]), ...(marker ? [[Perms.MAP_MARKER, true]] : [])]);

// ── Routing: by permission, never by role name ──────────────────────────────────────────────────────────────────────
await ok('routing: the owner → /, a manager\'s keys → /manager, a cashier\'s → the till; the role name decides nothing', () => {
  assert.equal(Routing.resolveRoute({ '*': true }, 'cashier'), '/');
  assert.equal(Routing.resolveRoute(mapOf(Perms.defaultKeysFor('manager')), 'cashier'), '/manager');
  assert.equal(Routing.resolveRoute(mapOf(Perms.defaultKeysFor('cashier')), 'manager'), '/pos/cashier');
  assert.equal(Routing.resolveRoute(mapOf(['orders.create', 'reports.sales']), 'Waiter'), '/manager');
});
await ok('routing: an older map\'s broad keys still count (settings.manage → back office)', () => {
  assert.equal(Routing.resolveRoute({ 'orders.create': true, 'settings.manage': true }, 'whatever'), '/manager');
});
await ok('routing: a pre-A490 cashier (no marker — the open keys are added) stays on the till', () => {
  // OPEN_BEFORE_A490 holds sales.history_all and staff.view, which are not shop-floor keys.
  assert.equal(Routing.resolveRoute({ 'orders.create': true, 'products.view': true }, 'cashier'), '/pos/cashier');
  assert.equal(Routing.resolveRoute(mapOf([...Perms.defaultKeysFor('cashier'), ...Perms.OPEN_BEFORE_A490]), 'cashier'), '/pos/cashier');
});

// ── No role-name checks anywhere on the web ─────────────────────────────────────────────────────────────────────────
const ALLOW = [
  // the one place a role NAME decides (the owner's role is the owner) — a shared file (shared/shiftConfirm.ts)
  { file: 'lib/shiftConfirm.ts', has: "['owner', 'admin'].includes(" },
];
await ok('no role-name checks remain in apps/dashboard/src (display of the role\'s name is fine)', () => {
  const hits = [];
  const RX = [
    /\b(?:OTP_ROLES|MANAGER_ROLE_NAMES|ELEVATED_ROLE_NAMES|excludeRoles)\b/,
    /\[[^\]]*'(?:manager|supervisor|branch_manager)'[^\]]*\]\s*\.includes\(/,
    /\[[^\]]*'(?:owner|admin)'[^\]]*\]\s*\.includes\(\s*(?:String\()?\s*[\w.?]*role/i,
    /\brole(?:Name|_name)?\b[\w.?()]*\s*(?:===|!==|==)\s*'[a-z_ ]+'/i,
    /\broles\?*\.name\b[\w.?()]*\s*(?:===|!==)/,
  ];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|jsx?)$/.test(e.name)) continue;
      const rel = path.relative(SRC, p).split(path.sep).join('/');
      if (rel === 'lib/permissions.ts') continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (!RX.some((r) => r.test(code))) return;
        if (ALLOW.some((a) => a.file === rel && line.includes(a.has))) return;
        hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
      });
    }
  })(SRC);
  assert.deepEqual(hits, [], `role-name checks:\n${hits.join('\n')}`);
});
await ok('no broad (legacy) key in any permission check on the web', () => {
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?)$/.test(e.name)) continue;
      const rel = path.relative(SRC, p).split(path.sep).join('/');
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/(?:hasPermission|can|hasAnyPermission)\(\s*(?:held,\s*)?\[?'([a-z_.*]+)'/g)) {
        if (!KEYS.has(m[1])) hits.push(`${rel}: ${m[1]}`);
      }
    }
  })(SRC);
  assert.deepEqual(hits, []);
});

// ── One rule on the PIN-session apps ────────────────────────────────────────────────────────────────────────────────
await ok('POSAuthContext: hasPermission is the expanded map (memoised); a refresh takes the new permission map', () => {
  const c = read('context/POSAuthContext.tsx');
  assert.match(c, /const held = useMemo<ReadonlySet<string>>\(\s*\(\) => \(session \? expandMap\(session\.permissions \?\? \{\}\) : new Set<string>\(\)\),/);
  assert.match(c, /\(key: string\) => !!session && holds\(held, key\)/);
  // A506: the renewal is api.ts refreshSession (one chain); its answer reaches the session through 'swiftpos:pos-token'.
  assert.match(c, /d\.permissions && typeof d\.permissions === 'object' \? \{ permissions: d\.permissions \}/);
  assert.doesNotMatch(c, /session\.permissions\[key\] === true/);
});

// ── Manager portal: every page, tab and action by its fine key ───────────────────────────────────────────────────────
const EXPECTED_NAV = {
  overview: "'reports.overview'", menu: "'products.view'", offers: "'menu.offers'", inventory: "'inventory.view'",
  receiving: "['inventory.receive', 'inventory.transfer']", counts: "'inventory.count'", wastage: "'inventory.waste'",
  // A523: Shifts also opens for whoever may close a day or force-close a drawer (Tills & days lives in it).
  expiry: "'inventory.waste'", history: "'inventory.receive'", orders: "'orders.view_all'", shift: "['orders.view_all', 'shifts.close_day', 'shifts.force_close']",
  reports: 'MANAGER_REPORT_KEYS', analytics: "'reports.analytics'" /* A549; A595: its own part of reports.sales */, turnover: "'orders.view_all'", expenses: "'expenses.view'", customers: "'customers.view'",
  credit: "'customers.view'", staff: "'staff.view'", printers: "'stations.manage'", security: 'null',
  // A502: the owner's by default, for someone the owner gives the right.
  promotions: "'menu.promotions'", reversals: "'settings.reversals'",
  // A518: supplier bills — read with payables.view (the Accountant), recorded and paid with payables.manage.
  bills: "['payables.view', 'payables.manage']",
  // A544: their branch's own theme, colour and receipt footer — the Branding tab's keys (the cloud: own branch only).
  branding: "['receipt.manage', 'settings.business']",
  // A576: the watch list (loss-prevention alerts) — the voids & exceptions report's key, as the cloud's GET /api/loss-alerts.
  watch: "'reports.voids'",
};
await ok('every manager page has its fine key (and only "My sign-in" is open)', () => {
  const md = read('pages/manager/ManagerDashboard.tsx');
  const block = md.slice(md.indexOf('const NAV_ITEMS: NavItem[] = ['), md.indexOf('const GROUP_ORDER'));
  const items = [...block.matchAll(/\{ key: '([a-z]+)',[^\n]*?permission: ((?:'[a-z_.]+'|\[[^\]]+\]|MANAGER_REPORT_KEYS|null)),/g)];
  const got = Object.fromEntries(items.map((m) => [m[1], m[2]]));
  assert.deepEqual(got, EXPECTED_NAV);
  for (const v of Object.values(got)) for (const k of v.matchAll(/'([a-z_.]+)'/g)) assert.ok(KEYS.has(k[1]), k[1]);
  assert.match(md, /const visibleNav\s+= NAV_ITEMS\.filter\(i => navAllowed\(i, held, isPetrol\)(?: && managerItemShown\(i\.key, session\.businessType\))?\);/);   // A573: a restaurant's pages only at a restaurant
  assert.match(md, /if \(item\.key === 'reports'\) return hasAnyPermission\(held, tabsForBusiness\(isPetrol\)\.map\(t => t\.permission\)\);/);
});
await ok('every manager report tab has its key; the page shows only the ones held', () => {
  const rp = read('pages/manager/ManagerReportsPage.tsx');
  const tabs = Object.fromEntries([...rp.matchAll(/\{ id: '([a-z_]+)',\s+label: '[^']+',\s+permission: '([a-z_.]+)' \}/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(tabs, { summary: 'reports.sales', hourly: 'reports.sales', items: 'reports.items', voids: 'reports.voids',
    staff: 'reports.staff', shifts: 'reports.shifts', fuel_sales: 'reports.fuel', wet_stock: 'reports.fuel' });
  assert.match(rp, /const TABS = tabsForBusiness\(isPetrol\)\.filter\(t => hasPermission\(t\.permission\)\);/);
  assert.match(rp, /\{report && mayDownload && \(/);
  assert.match(rp, /const mayDownload = hasPermission\('reports\.export'\);/);
});
await ok('manager actions: credit edits, drawer confirm / count, day close, staff edits, costs', () => {
  const md = read('pages/manager/ManagerDashboard.tsx');
  assert.match(md, /const canManage = hasPermission\('customers\.credit'\);/);
  // A595: and the parts of staff.edit (PINs, own rights, pay) by the person's own keys.
  assert.match(md, /<StaffTab branches=\{managerBranch\} canEdit=\{hasAnyPermission\(held, \['staff\.edit'\]\)\} can=\{\(k\) => hasPermission\(k\)\} \/>/);
  assert.match(md, /const seesCosts\s+= hasAnyPermission\(held, \['menu\.costs', 'reports\.costs'\]\);/);
  assert.match(md, /<Wastage [^>]*showCosts=\{seesCosts\} \/>/);
  assert.match(md, /<Expiry [^>]*showCosts=\{seesCosts\}\s+canEditBatches=/);   // A506: + batch edits by receive / adjust
  const sh = read('pages/manager/ManagerShiftTab.tsx');
  assert.match(sh, /const canCountClose = hasPermission\('shifts\.confirm'\);/);
  assert.match(sh, /const seesExpected = hasPermission\('reports\.shifts'\) \|\| canCountClose;/);
  assert.match(sh, /\{seesExpected && <> · expected /);
  assert.match(read('pages/manager/RemoteDayClose.tsx'), /const allowed = hasPermission\('shifts\.close_day'\);/);
  const rc = read('pages/manager/ManagerReceivingTab.tsx');
  assert.match(rc, /const seesCosts\s+= hasPermission\('menu\.costs'\) \|\| hasPermission\('reports\.costs'\);/);
  assert.match(rc, /unit_cost: seesCosts \? Number\(poLines\[g\.id\]\?\.cost \|\| 0\) : undefined/);
  assert.match(read('pages/manager/ManagerHistoryTab.tsx'), /hideCosts: !seesCosts/);
});
await ok('the Overview fetches a report only with its key', () => {
  const md = read('pages/manager/ManagerDashboard.tsx');
  const ov = md.slice(md.indexOf('function OverviewTab()'), md.indexOf('// ── Expenses Tab'));
  // A518: the day's figures (/sales) and the top items (/products) also with reports.overview — the cloud admits it there
  // (tests/web-tidy-a518.test.mjs); the hourly chart and products-v2 keep their own keys.
  assert.match(ov, /const seesDay = hasPermission\('reports\.sales'\) \|\| hasPermission\('reports\.overview'\);/);
  assert.match(ov, /seesDay \? posApi\.get<SalesSummary>\(`\/api\/reports\/sales/);
  assert.match(ov, /hasPermission\('reports\.sales'\) \? posApi\.get<\{ series: HourlyRow\[\] \}>\(`\/api\/reports\/hourly/);
  assert.match(ov, /hasPermission\('reports\.items'\) \? posApi\.get<\{ products: TopProduct\[\] \}>\(`\/api\/reports\/products-v2/);
  assert.doesNotMatch(ov, /\/api\/reports\/(?:voids|staff)/);
  assert.match(md, /seesFuel \? posApi\.get<any>\(`\/api\/reports\/fuel-sales/);
  assert.match(md, /seesSales \? posApi\.get<any>\(`\/api\/reports\/sales/);
});

// ── Web POS ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A595 (owner decision D6): the web POS applies set-up discounts and promo codes — sales.discount_preset (or the typed
// discounts' sales.discount); the cloud checks the discount named and its amount (routes/orders.ts discountRefused).
await ok('discount: sales.discount or its set-up part — no discount reaches the sale without one; the input is not offered', () => {
  const pm = read('pages/pos/PaymentModal.tsx');
  assert.match(pm, /const mayDiscount = hasPermission\('sales\.discount'\) \|\| hasPermission\('sales\.discount_preset'\);/);
  assert.match(pm, /const rawPromoDiscount\s+= mayDiscount \? \(discountState\?\.discount_amount \?\? 0\) : 0;/);
  assert.equal((pm.match(/discount_id:\s+mayDiscount \? \(discountState\?\.discount\.id \?\? null\) : null,/g) ?? []).length, 2);
  const dp = read('pages/pos/DiscountPanel.tsx');
  assert.match(dp, /const mayDiscount = hasPermission\('sales\.discount'\) \|\| hasPermission\('sales\.discount_preset'\);/);
  assert.match(dp, /if \(!mayDiscount\) return null;/);
});
await ok('void and refund: sales.void and sales.refund, each on its own', () => {
  assert.equal(Refund.canVoidOrder({ status: 'completed', payments: [] }, true), true);
  assert.equal(Refund.canVoidOrder({ status: 'completed', payments: [] }, false), false);
  assert.equal(Refund.canRefundOrder({ status: 'completed', payments: [] }, false), false);
  const h = read('pages/pos/POSOrderHistoryTab.tsx');
  assert.match(h, /const mayVoid\s+= hasPermission\('sales\.void'\);/);
  assert.match(h, /const mayRefund = hasPermission\('sales\.refund'\);/);
  assert.match(h, /\{canRefundOrder\(order, mayRefund\) && \(/);
  assert.match(h, /\{canVoidOrder\(order, mayVoid\) && inVoidWindow\(order\) && \(/);
  const op = read('pages/OrdersPage.tsx');
  assert.match(op, /const canVoid = can\('sales\.void'\);\s+const canRefund = can\('sales\.refund'\);/);
});
await ok('Z-report: kept for the cashier, but expected cash and the difference need reports.shifts or shifts.confirm', () => {
  const z = read('pages/pos/ZReportModal.tsx');
  assert.match(z, /const seesExpected = hasPermission\('reports\.shifts'\) \|\| hasPermission\('shifts\.confirm'\);/);
  assert.match(z, /\{seesExpected && data\.shifts && data\.shifts\.length > 0 && \(\(\) => \{/);
  assert.match(z, /\{seesProfit && \(\s*<div className="total-row"/);
  assert.match(read('pages/pos/CashierScreen.tsx'), /onClick=\{\(\) => setShowZReport\(true\)\}/);
});
await ok('Float / Expense: shifts.cash_movements (the old switch still applies on a map from before); printers: stations.manage', () => {
  const cs = read('pages/pos/CashierScreen.tsx');
  // A594: shifts.cash_movements is "Record cash in" now; Float / Expense are offered to all (a manager approves without it).
  assert.match(cs, /const mayCashIn = hasPermission\('shifts\.cash_movements'\)\s*&& mayRecordMoneyMovement\(posFeatures, maySignedInConfirm\(session as any\)\);/);
  assert.match(cs, /const canSetPrinters = hasPermission\('stations\.manage'\);/);
  assert.match(cs, /\{canSetPrinters && \(/);
  assert.doesNotMatch(cs, /isManager\b/);
});
await ok('POS Menu: built from the catalogue — four real screens, no private key lists, no "not built yet" pages', () => {
  const d = read('pages/pos/POSDrawer.tsx');
  assert.doesNotMatch(d, /KEY_LABELS|ALL_KNOWN_KEYS|GenericPermissionView|hasn't been built yet/);
  assert.match(d, /import \{ PERMISSIONS, PERMISSION_GROUPS, hasAnyPermission \} from '\.\.\/\.\.\/lib\/permissions';/);
  for (const k of ["'reports'", "'orders.view_all'", "'inventory.view'", "'customers.view'"]) assert.ok(d.includes(`${k}:`), k);
  assert.match(d, /\{ id: 'reports',\s+icon: '[^']+', rail: 'Reports',\s+keys: POS_REPORT_KEYS \}/);
  assert.match(read('pages/pos/POSReportsTab.tsx'), /export const POS_REPORT_KEYS: readonly string\[\] = \['reports\.sales'\];/);
});

// ── The owner's one place: Roles and permissions ────────────────────────────────────────────────────────────────────
await ok('the picker: catalogue words from the cloud (local copy as fallback), "4 of 14 reports", what differs from the role', () => {
  assert.equal(Picker.groupSummary(4, 14, 'Reports'), '4 of 14 reports');
  const d = Picker.keyDifferences(new Set(['a', 'c']), new Set(['a', 'b']), ['a', 'b', 'c']);
  assert.deepEqual(d, { added: ['c'], removed: ['b'] });
  const p = read('components/PermissionPicker.tsx');
  assert.match(p, /client\.get<CatalogueKey\[\]>\('\/api\/staff\/permissions'\)/);
  assert.match(p, /client\.get<CatalogueGroup\[\]>\('\/api\/staff\/permission-groups'\)/);
  assert.match(p, /ref\.current\.indeterminate = indeterminate && !checked/);
  assert.match(p, /placeholder="Search permissions…"/);
  assert.match(p, /surface === 'both' \? \['Web', 'POS'\]/);
});
await ok('RolesTab: the new API — keys, copy_from, rename, delete with ROLE_IN_USE, the owner\'s role locked, unsaved guard', () => {
  const r = read('pages/settings/RolesTab.tsx');
  assert.match(r, /api\.put\(`\/api\/staff\/roles\/\$\{editingRole\.id\}\/permissions`, \{ keys: /);
  assert.doesNotMatch(r, /permission_ids/);
  assert.match(r, /api\.post<RoleRow>\('\/api\/staff\/roles', \{[\s\S]{0,200}copy_from: copyFrom/);
  assert.match(r, /api\.patch\(`\/api\/staff\/roles\/\$\{renaming\.id\}`, \{ name: /);
  assert.match(r, /api\.delete\(`\/api\/staff\/roles\/\$\{r\.id\}`\)/);
  assert.match(r, /e\?\.code === 'ROLE_IN_USE' \|\| e\?\.status === 409 \? roleInUseMessage\(r\.name, e\?\.members\)/);
  assert.match(r, /Everything — the owner\\'s role/);
  assert.match(r, /window\.addEventListener\('beforeunload', warn\)/);
  assert.match(r, /title: 'Leave without saving\?'/);
  assert.match(r, /<PermissionPicker keys=\{catalogue\.keys\} groups=\{catalogue\.groups\} checked=\{draft\}/);
});
await ok('StaffTab: a person\'s rights by key (override_keys) on the same picker, against the role; no role names', () => {
  const s = read('pages/settings/StaffTab.tsx');
  // A506: an edit sends them when they changed; A595: with `parts: true` (the keys exactly as ticked), and only with staff.access.
  assert.match(s, /const keysField: \{ override_keys\?: Record<string, boolean>; parts\?: true \} = keysChanged \? \{ override_keys, parts: true \} : \{\};/);
  assert.match(s, /\.\.\.keysField,\s*\}\);/);
  assert.match(s, /api\.post\('\/api\/staff', \{[^}]*\.\.\.keysField/);   // A595: the person's rights (override_keys, parts: true) when the adder holds staff.access
  assert.match(s, /<PermissionPicker keys=\{catalogue\.keys\} groups=\{catalogue\.groups\} checked=\{effectiveKeys\}\s+onChange=\{setEffectiveKeys\} baseline=\{roleBaseline\}/);
  assert.match(s, /canResetSignIn && s\.status === 'active' && needsSignInCode\(role, s\.override_keys\)/);
  assert.doesNotMatch(s, /OTP_ROLES|excludeRoles|permission_id: p\.id/);
});

// ── Moved from the admin portal: Settings › Business ───────────────────────────────────────────────────────────────
await ok('Business: POS options and the business-wide payment methods, on /api/controls — no Till updates (A493: the admin approves)', () => {
  const c = read('pages/settings/OwnerControls.tsx');
  assert.match(c, /api\.get<Controls>\('\/api\/controls'\)/);
  assert.match(c, /api\.put\(`\/api\/controls\/pos\/\$\{key\}`, \{ enabled: next \}\)/);
  assert.match(c, /api\.put\('\/api\/controls\/loyalty', patch\)/);
  assert.doesNotMatch(c, /\/api\/controls\/updates/);
  assert.match(c, /api\.post\('\/api\/business\/settings', \{ key: PAYMENT_METHODS_ENABLED_KEY, value: v \}\)/);
  assert.match(c, /export const POS_OPTION_KEYS = \['delivery_fee', 'pay_later_tabs', 'pay_before_kitchen', 'login_codes', 'approval_pin'\] as const;/);   // A594
  const bp = read('pages/settings/BusinessPage.tsx');
  assert.match(bp, /\{ to: 'pos-options',\s+label: 'POS options' \}/);
  assert.doesNotMatch(bp, /till-updates/);
  const app = read('App.tsx');
  assert.match(app, /<Route path="pos-options"\s+element=\{<PosOptionsTab \/>\} \/>/);
  assert.doesNotMatch(app, /TillUpdatesTab|till-updates/);
  assert.match(read('pages/PaymentMethodsPage.tsx'), /<BusinessPaymentMethods \/>/);
  assert.match(read('components/SignInSecurity.tsx'), /The owner turns them on in Settings › Business › POS options/);
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
