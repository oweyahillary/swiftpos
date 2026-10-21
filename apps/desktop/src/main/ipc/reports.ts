// IPC: manager reports, sale history, order detail and branch prices. Registered from ipcHandlers.ts (D10); two
// register functions so the channels register in the order they always did.
import { cashierHistoryView } from '../cashierHistory';
import { readSessionTokens, readStaffTokens } from '../tokenStore';
import { cloudFetch } from '../cloudGateway';
import { signedInCan } from '../tillAccess';
import { getCloudUrl, getDeviceConfig } from '../deviceConfig';
import { historyScope } from '../shiftService';
import { resolveRange, getReportScope } from '../managerReports';
import { branchDay } from '../branchDay';   // A431 / A432
import { cloudBranchOrders } from '../webSales';
import { exportReportCsv } from '../reportExport';
import { exportDailySalesReport } from '../dailySalesReport';
import { type OrderDetail } from '../orderDetail';
import { getSalesSummary, getTopProducts, getRecentOrders, getStockLevels, getFuelSalesToday, getPumpStatus, getTableOccupancy, getPriceList, setBranchPrice, clearBranchPrice } from '../managerReports';
import { hasNode, fetchNodeReport } from '../nodeClient';
import { RangeArg, type IpcShared } from './shared';

/** The manager dashboard reports (local SQLite — D9 tiered depth), sale history and branch prices. */
export function registerReportHandlers(ctx: IpcShared) {
  const { handle, requireKey, NOT_ALLOWED, withinMs, readOrderDetail, MENU_READ, withoutCosts, REPORT_REFUSED } = ctx;

  // ── Manager dashboard reports (local SQLite — D9 tiered depth) ────────────

  // Range is optional so existing callers keep today's behaviour untouched.
  handle('manager:salesSummary',  async (_e, r?: RangeArg) => {
    requireKey(['reports.sales', 'reports.overview'], REPORT_REFUSED);
    return getSalesSummary(r ? resolveRange(r.preset, r.from, r.to) : undefined);
  });
  handle('manager:topProducts',   async (_e, r?: RangeArg) => {
    requireKey(['reports.items', 'reports.overview'], REPORT_REFUSED);
    return getTopProducts(r?.limit ?? 8, r ? resolveRange(r.preset, r.from, r.to) : undefined);
  });
  // 0.6.27: the POS History — the last 30 sales, narrowed to the signed-in cashier's own when the client has
  // 'cashier_own_history' on (a manager sees all); says whether Reprint is offered ('cashier_no_reprint').
  handle('pos:history', async () => {
    const scope = historyScope();
    if (scope.ownOnly && !scope.staffId) return { scope, orders: [] };
    // 0.6.29 (owner): "it should show everything of the days sales" — today's, all of them (it was the last 30).
    const orders = getRecentOrders(0, resolveRange('today'), scope.ownOnly ? scope.staffId : null);
    // 0.6.37 (A387): a cashier sees only the payment methods the manager chose (a split sale: only its allowed part).
    return { scope, orders: scope.methods.length ? cashierHistoryView(orders as any[], scope.methods) : orders };
  });
  // A444: one order's items, sizes, extras, notes and payments — this till's records first, else the cloud's (another
  // till's sale at the branch). A cashier only sees what their History already shows them.
  handle('order:detail', async (_e, orderId: string) => {
    const scope = historyScope();
    if (!scope.staffId) return { ok: false, error: 'Sign in to see an order.' };
    let found: { detail: OrderDetail; cashierId: string | null };
    try { found = await readOrderDetail(String(orderId)); }
    catch (e: any) { return { ok: false, error: e?.message ?? 'Could not read this order.' }; }
    if (!scope.manager) {
      if (scope.ownOnly && found.cashierId !== scope.staffId) return { ok: false, error: 'This sale is not yours.' };
      if (scope.methods.length) {
        const allowed = new Set(scope.methods);
        found.detail = { ...found.detail, payments: found.detail.payments.filter((p) => allowed.has(p.method)) };
      }
    }
    return { ok: true, detail: found.detail, canReprint: scope.canReprint };
  });
  handle('manager:recentOrders',  async (_e, r?: RangeArg) => {
    requireKey(['orders.view_all', 'reports.overview'], REPORT_REFUSED);
    return getRecentOrders(r?.limit ?? 30, r ? resolveRange(r.preset, r.from, r.to) : undefined);
  });

  // Cross-sync stage 1 (2026-09-27): every till's sales at this branch, read from the cloud (owner: "Branch
  // view, read from cloud"). Online only — the caller falls back to this till's own list and says so.
  handle('manager:branchOrders', async (_e, r?: RangeArg) => {
    requireKey(['orders.view_all'], REPORT_REFUSED);   // A490
    const cfg = getDeviceConfig();
    const token = readStaffTokens().token ?? readSessionTokens().token;
    if (!token) throw new Error('Not signed in');
    const range = resolveRange(r?.preset ?? 'today', r?.from, r?.to);
    const q = new URLSearchParams({ date_from: range.from, date_to: range.to, limit: '500', status: 'completed' });
    if (cfg?.branch_id) q.set('branch_id', cfg.branch_id);
    const res = await withinMs(cloudFetch(`${getCloudUrl()}/api/orders?${q}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-device-id': cfg?.device_id ?? '' },
    }), 8_000);
    if (!res.ok) throw new Error(`The cloud did not answer (HTTP ${res.status})`);
    const body = await res.json() as { orders?: any[] };
    return cloudBranchOrders(body.orders ?? [], cfg?.device_id ?? null);
  });

  // A431 / A432: the Overview — every till's sales and every shift at the branch, from the cloud (a manager's sign-in);
  // this till's own rows when the cloud cannot be reached, saying so. Read-only.
  handle('manager:branchDay', async (_e, r?: RangeArg) => {
    requireKey(['reports.overview', 'orders.view_all'], REPORT_REFUSED);   // A490: the Overview's own read
    const day = await branchDay(resolveRange(r?.preset ?? 'today', r?.from, r?.to));
    // A494: each drawer's expected cash and difference only to reports.shifts / shifts.confirm (as shift:stale) —
    // taken out, not merely hidden on the screen.
    if (signedInCan('reports.shifts', 'shifts.confirm')) return day;
    return { ...day, shifts: (day.shifts ?? []).map((s) => ({ ...s, expected_cash: null, variance: null })) };
  });

  // What the figures cover. Paired with every range query so a till's partial
  // view can never be read as the branch's takings.
  handle('manager:reportScope', async () => getReportScope());
  handle('manager:resolveRange', async (_e, r: RangeArg) =>
    resolveRange(r?.preset, r?.from, r?.to));
  // A490: a download is reports.export AND the report's own key (orders → orders.view_all, products → reports.items,
  // sales → reports.sales), as the cloud's exports.
  handle('manager:exportCsv', async (_e, req: any) => {
    const own = req?.kind === 'orders' ? 'orders.view_all' : req?.kind === 'products' ? 'reports.items' : 'reports.sales';
    if (!signedInCan('reports.export') || !signedInCan(own)) return { ok: false, error: 'Your role does not download this report.' };
    return exportReportCsv(req);
  });
  handle('manager:dailyReport', async (_e, req: any) => {
    if (!signedInCan('reports.export') || !signedInCan('reports.sales')) return { ok: false, error: 'Your role does not download this report.' };
    return exportDailySalesReport(req ?? {});
  });
  handle('manager:stockLevels',   async () => { requireKey(['inventory.view'], REPORT_REFUSED); return withoutCosts(getStockLevels()); });
  handle('manager:fuelSales',     async () => { requireKey(['reports.fuel', 'reports.overview'], REPORT_REFUSED); return getFuelSalesToday(); });
  handle('manager:pumpStatus',    async () => { requireKey(['reports.fuel', 'reports.overview', 'fuel.manage'], REPORT_REFUSED); return getPumpStatus(); });
  handle('manager:tableOccupancy',async () => { requireKey(['orders.view_all', 'reports.overview'], REPORT_REFUSED); return getTableOccupancy(); });

  // ── Branch price management (manager = branch authority, local-first) ──────
  handle('manager:priceList',      async () => { requireKey(MENU_READ, NOT_ALLOWED); return withoutCosts(getPriceList()); });
  // Audit 2026-10-14: checked here, not only on the screen. A490: menu.prices (the cloud's /branch-prices rule).
  const mayPrice = () => signedInCan('menu.prices');
  const PRICE_REFUSED = 'Only someone who may change prices can change a price.';
  handle('manager:setBranchPrice', async (_e, { product_id, price }) => {
    if (!mayPrice()) throw new Error(PRICE_REFUSED);
    return setBranchPrice(product_id, price);
  });
  handle('manager:clearBranchPrice', async (_e, { product_id }) => {
    if (!mayPrice()) throw new Error(PRICE_REFUSED);
    return clearBranchPrice(product_id);
  });
}

/** The branch report. */
export function registerBranchReportHandlers(ctx: IpcShared) {
  const { handle, requireKey, withoutCosts, REPORT_REFUSED } = ctx;

  // ── Manager branch-wide report ──────────────────────────────────────────────
  // Any till can see ALL the branch's tills' data by reading from the aggregation
  // node. If the node is unreachable (or this device has none) it falls back to
  // this machine's own local data, flagged so the UI can say so.
  handle('manager:branchReport', async () => {
    requireKey(['reports.sales', 'reports.overview'], REPORT_REFUSED);   // A490
    // A494: each part asks its own key — the orders list orders.view_all (or the Overview), stock inventory.view (costs
    // only to menu.costs / reports.costs) — as their own handlers do. A part not allowed is null.
    const seesOrders = signedInCan('orders.view_all', 'reports.overview');
    const seesStock = signedInCan('inventory.view');
    const parts = (rep: any) => ({ ...rep,
      recentOrders: seesOrders ? rep?.recentOrders ?? null : null,
      stockLevels: seesStock ? withoutCosts(rep?.stockLevels ?? null) : null });
    if (hasNode()) {
      const report = await fetchNodeReport().catch(() => null);
      if (report) return { ...parts(report), source: 'node' as const };
    }
    // Fallback: local-only view of this device.
    return {
      salesSummary: getSalesSummary(),
      topProducts:  getTopProducts(),
      recentOrders: seesOrders ? getRecentOrders() : null,
      stockLevels:  seesStock ? withoutCosts(getStockLevels()) : null,
      source: hasNode() ? ('local_fallback' as const) : ('local' as const),
    };
  });
}
