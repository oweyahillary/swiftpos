// Renderer-side API — calls window.swiftpos.* (IPC via preload.ts)
// Shape mirrors the web dashboard's api.ts so shared logic stays consistent.

export interface StaffSession {
  staff: { id: string; name: string } | null;
  role: string | null;
  permissions: Record<string, boolean>;
  branchId: string;
  branchName: string | null;
}

export type DeployMode = 'cloud' | 'local';

export interface DiningTable {
  id: string;
  name: string;
  capacity: number;
  sort_order: number;
  slot_type: 'dining' | 'parking_bay';
  pos_x: number | null;
  pos_y: number | null;
  zone: string | null;
  shape: 'rect' | 'circle' | null;
}

export interface Pump {
  id: string;
  name: string;
  status: string;
  sort_order: number;
  fuel_product_id: string | null;
  fuel_product_name: string | null;
  price_per_litre: number | null;
}

export type DeviceRole = 'till' | 'node' | 'office';

export interface TechSession {
  techId: string; techName: string; branchId: string;
  startedAt: number; expiresAt: number; tokenHash: string;
}

export interface TechStatus {
  device: {
    device_id: string | null; device_name: string | null; device_role: DeviceRole;
    branch_id: string | null; deploy_mode: string | null; server_url: string | null; node_url: string | null;
  };
  sync: { online?: boolean; pending: number; failed: number; lastOrder: string | null; [k: string]: any };
}

export interface DeviceConfig {
  deploy_mode: DeployMode;
  server_url: string;
  branch_id: string | null;
  business_type: string | null;
  device_name: string | null;
  device_id: string | null;
  device_role: DeviceRole;
  node_url: string | null;
  // Shared secret for the branch LAN channel — mirrors DeviceConfig in
  // src/main/deviceConfig.ts. Sent as X-Node-Secret on every /node/* call.
  node_secret: string | null;
  terminal_code: string | null;
  vat_rate: number | null;
  ctl_rate: number | null;
  // Discount ceiling the server enforces; cached so an offline till clamps to it.
  max_discount_pct: number | null;
  receipt_header: string | null;
  receipt_footer: string | null;
  configured: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  reachable: boolean;
  status?: number;
  error?: string;
}

export interface ZReport {
  shift: {
    id: string;
    opened_at: string;
    closed_at: string | null;
    status: string;
    cashier_id: string | null;
    cashier_name: string;
    opening_float: number;
    closing_float: number | null;
    expected_cash: number;
    cash_variance: number | null;
    notes: string | null;
  };
  byMethod: { method: string; amount: number; orders: number }[];
  totals: {
    orderCount: number;
    grossSales: number;
    voidCount: number;
    cashSales: number;
    floatIn: number;
    floatOut: number;
    expectedCash: number;
  };
  businessName: string;
  currency: string;
}

/** Date-range selection for the manager reports. */
export interface ReportRangeArg {
  preset?: 'today' | 'yesterday' | 'last7' | 'last30' | 'month' | 'custom';
  from?: string;
  to?: string;
  limit?: number;
}

export type StationKind = 'kitchen' | 'dispatch' | 'receipt';

/**
 * What a variant group IS.
 *   choice  — free preference, exactly one, no price anywhere
 *   upgrade — priced ladder; the first option is the included baseline at 0
 *   review  — migration 45 could not classify it safely and left it untouched
 */
export type VariantKind = 'choice' | 'upgrade' | 'review';

/** A named print destination. The physical printer is bound per till, not here. */
export interface PrintStation {
  id: string;
  name: string;
  kind: StationKind;
  sort_order: number;
  active: boolean;
  category_ids: string[];
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
}

declare global {
  interface Window {
    swiftpos: {
      escpos: {
        assignments: () => Promise<unknown>;
        assign:      (a: unknown) => Promise<unknown>;
        unassign:    (stationId: string) => Promise<unknown>;
        status:      () => Promise<unknown>;
        enabled:     () => Promise<boolean>;
        setEnabled:  (on: boolean) => Promise<{ ok: boolean; enabled: boolean }>;
        canPrint:    (kind: 'kitchen' | 'dispatch' | 'receipt') => Promise<boolean>;
        // `skipped` names the stations that produced NOTHING — no printer
        // bound on this terminal. With the HTML fallback gone (0.5.27) this is
        // the only way the cashier learns a ticket did not go. Register D8.
        printProduction: (payload: unknown) => Promise<{ ok: boolean; skipped: string[] }>;
        // The branch's exclusion list as the printer applies it. The Printers
        // tab previews with THIS, not a per-till localStorage copy — a preview
        // that disagrees with the printer is worse than no preview.
        kitchenExclusions: () => Promise<{ terms: string[] }>;
        reprintReceipt: () => Promise<{ ok: boolean; error?: string }>;
        printShiftReport: (data: unknown) => Promise<{ ok: boolean; error?: string; internal?: boolean }>;
        retry:       (id: string) => Promise<unknown>;
        preview:     (ctx: unknown) => Promise<unknown>;
        test:        (ctx: unknown, target: string) => Promise<any>;
        onChanged:   (cb: () => void) => () => void;
      };
      version: string;
      platform: string;
      auth: {
        login: (email: string, password: string) => Promise<{ user: any; business: any }>;
        logout: () => Promise<boolean>;
        getSession: () => Promise<{ user: any; business: any } | null>;
        listBranches: () => Promise<{ id: string; name: string; desktop_licensed: boolean }[]>;
        verifyPin: (pin: string, branch_id: string) => Promise<StaffSession>;
        getStaffSession: () => Promise<StaffSession | null>;
        clearStaffSession: () => Promise<boolean>;
      };
      // A52 — the idle lock. See main/idleMonitor.ts for why the decision lives
      // in the main process (OS idle cannot fire mid-sale; renderer activity
      // tracking can).
      idle: {
        setSurface: (surface: 'manager' | 'pos' | null) => Promise<boolean>;
        clear:      () => Promise<boolean>;
        suppress:   () => Promise<number>;
        release:    (token: number) => Promise<boolean>;
        onLock:     (cb: () => void) => () => void;
      };
      pos: {
        init: () => Promise<{ products: any[]; categories: any[]; branchId: string | null; vatRate: number | null; ctlRate: number | null; maxDiscountPct: number | null;
          comboItems: Record<string, Array<{ product_id: string; name: string; quantity: number; is_kitchen: boolean }>>;
          kitchenCategories: string[];
        stationRouting?: {
          stations: Array<{ id: string; name: string; kind: 'kitchen' | 'dispatch' | 'receipt'; sort_order: number }>;
          byCategory: Record<string, string[]>;
        };
          receiptHeader: string; receiptFooter: string }>;
        getVariants: (productId: string) => Promise<any[]>;
        getModifiers: (productId: string) => Promise<any[]>;
        getTables: () => Promise<DiningTable[]>;
        getPumps: () => Promise<Pump[]>;
      };
      order: {
        create: (payload: any) => Promise<{ orderId: string }>;
        void:   (orderId: string, reason: string, supervisor_pin?: string, authorizer_id?: string) => Promise<{ ok: boolean }>;
        refund: (orderId: string, reason: string, override_pin?: string, authorizer_id?: string) => Promise<{ ok: boolean; refunded: number }>;
      };
      sync: {
        trigger: () => Promise<{ pulled: boolean; pushed: number; errors: string[] }>;
        status: () => Promise<{ online: boolean; pendingCount: number; failedCount: number;
                                failedReason?: string; failedSince?: string }>;
        retryFailed: () => Promise<{ requeued: number; pushed: number; errors: string[] }>;
        notifyNetworkChange: (online: boolean) => Promise<{ online: boolean; pendingCount: number; failedCount: number }>;
      };
      orders: {
        nextBillNumber: () => Promise<string>;
      };
      day: {
        gate: () => Promise<{ canTrade: boolean; reason?: string;
                              needsManager?: boolean; needsShift?: boolean;
                              staleDay?: { id: string; business_date: string }; }>;
        current: () => Promise<{ id: string; business_date: string; status: string } | null>;
        summary: () => Promise<{
          day: { id: string; business_date: string };
          shifts: number; unreconciledShifts: number;
          expectedCash: number; countedCash: number; variance: number;
        } | null>;
        isManager: () => Promise<boolean>;
        conflicts: () => Promise<{ id: string; cashier_name: string;
                                   business_date: string | null; notes: string | null }[]>;
        retryConflict: (shiftId: string) =>
          Promise<{ ok: boolean; rearmed?: number; error?: string }>;
        close: (countedCash: number, notes?: string) =>
          Promise<{ ok: boolean; error?: string; summary?: unknown }>;
      };
      branchClose: {
        overview: () => Promise<{
          business_date: string;
          tills: Array<{
            device_id: string;
            is_self: boolean;
            last_seen: string | null;
            state: {
              business_date: string | null; day_open: boolean;
              open_drawer: { cashier_name: string | null } | null;
              drawers_on_day: number; cashiers_counted_total: number;
            } | null;
            instruction: {
              id: number; status: string; created_at: string;
              delivered_at: string | null; acked_at: string | null;
              payload: { business_date: string; counted_cash: number; notes?: string };
              ack: { ok: boolean; error?: string; summary?: any; already_closed?: boolean } | null;
            } | null;
          }>;
        } | { error: string }>;
        closeTill: (deviceId: string, countedCash: number, notes?: string) => Promise<{
          ok: boolean; error?: string; instruction_id?: number;
          self?: boolean; summary?: unknown; already_closed?: boolean;
        }>;
      };
      print: {
        list: () => Promise<PrinterInfo[]>;
        shares: () => Promise<Record<string, { shared: boolean; shareName: string | null }>>;
        preview: (opts: { html: string; paperWidthMm: 58 | 80; title?: string }) => Promise<{ ok: boolean }>;
        probe: (deviceName: string) => Promise<{ ok: boolean; state: string }>;
        geometry: (deviceName: string) => Promise<
          { paperMm: number; printableMm: number; offsetMm: number } | null
        >;
        html: (opts: { html: string; deviceName: string; paperWidthMm: 58 | 80; copies: number }) => Promise<{ ok: boolean; error?: string }>;
      };
      config: {
        get: () => Promise<DeviceConfig | null>;
        isConfigured: () => Promise<boolean>;
        save: (patch: Partial<DeviceConfig>) => Promise<DeviceConfig>;
        clear: () => Promise<boolean>;
        identity: () => Promise<{ deviceId: string | null; terminalCode: string | null }>;
        resetPreview: () => Promise<{ terminalCode: string | null; deviceRole: string | null; unsyncedOrders: number; unsyncedValue: number; openShifts: number; safe: boolean }>;
        reset: (force?: boolean) => Promise<boolean>;
        testConnection: (url: string) => Promise<ConnectionTestResult>;
      };
      tech: {
        checkReveal:  (code: string)  => Promise<{ ok: boolean }>;
        openSession:  (token: string) => Promise<{ ok: true; session: TechSession } | { ok: false; error: string }>;
        getSession:   () => Promise<TechSession | null>;
        closeSession: () => Promise<{ ok: boolean }>;
        logAction:    (action: string, detail?: any) => Promise<{ ok: boolean }>;
        status:       () => Promise<TechStatus>;
        adoptFromNode:() => Promise<{ ok: true; session: TechSession } | { ok: false }>;
        promoteToNode: () => Promise<{ ok: boolean; role?: string; secret?: string; note?: string; error?: string }>;
        setNodeUrl: (url: string) => Promise<{ ok: boolean; role?: string; error?: string }>;
        backupNow: () => Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }>;
        maintenance: () => Promise<{ last_backup_at: string | null; last_backup_status: string | null;
                                     backup_dir: string; last_prune_at: string | null; retention_days: number }>;
        query: (sql: string) => Promise<
          | { ok: true; result: { columns: string[]; rows: unknown[][]; rowCount: number;
                                  truncated: boolean; maskedColumns: string[] } }
          | { ok: false; error: string }>;
      };
      shift: {
        // A shift left open past ~18 hours. Null when there is none, or when
        // the open one is still plausibly today's.
        stale: () => Promise<null | {
          id: string; opened_at: string; hoursOpen: number;
          cashier_name: string; expectedCash: number; orders: number;
        }>;
        // Ends it WITHOUT a cash count. Records closed_unreconciled with a null
        // variance — never zero, which would claim a check that never happened.
        forceClose: (reason: string) => Promise<ZReport>;
        current: () => Promise<ZReport | null>;
        open: (opening_float: number, drawer_label?: string) => Promise<ZReport | null>;
        float: (type: 'float_in' | 'float_out', amount: number, reason?: string) => Promise<ZReport | null>;
        close: (closing_float: number, notes?: string) => Promise<ZReport>;
        zreport: (shiftId: string) => Promise<ZReport>;
      };
      manage: {
        listProducts:   () => Promise<any[]>;
        createProduct:  (payload: any) => Promise<any>;
        updateProduct:  (id: string, patch: any) => Promise<any>;
        listCategories: () => Promise<any[]>;
        createCategory: (payload: any) => Promise<any>;
        listStations:  () => Promise<PrintStation[]>;
        unassignedCategories: () => Promise<{ id: string; name: string }[]>;
        createStation: (payload: { name: string; kind?: StationKind; sort_order?: number }) => Promise<PrintStation>;
        updateStation: (id: string, patch: Partial<{ name: string; kind: StationKind; sort_order: number; active: boolean }>) => Promise<PrintStation>;
        deleteStation: (id: string) => Promise<any>;
        setStationCategories: (id: string, categoryIds: string[]) =>
          Promise<{ station_id: string; category_ids: string[]; rejected: string[] }>;
        updateCategory: (id: string, patch: any) => Promise<any>;
        bulkProducts:       (rows: any[]) => Promise<{ created: number; updated: number; errors: Array<{ row: number; error: string }> }>;
        listCombos:         () => Promise<any[]>;
        createCombo:        (payload: any) => Promise<any>;
        updateCombo:        (id: string, patch: any) => Promise<any>;
        setComboItems:      (id: string, items: any[]) => Promise<any>;
        listModifierGroups:  (productId: string) => Promise<any[]>;
        createModifierGroup: (payload: any) => Promise<any>;
        deleteModifierGroup: (id: string) => Promise<any>;
        listVariantGroups:  (productId: string) => Promise<any[]>;
        createVariantGroup: (payload: any) => Promise<any>;
        updateVariantGroup: (id: string, patch: { name?: string; required?: boolean; kind?: VariantKind; combo_item_id?: string | null }) => Promise<any>;
        createVariantOption: (payload: { variant_group_id: string; name: string; price_adjustment?: number; sort_order?: number }) => Promise<any>;
        updateVariantOption: (id: string, patch: { name?: string; price_adjustment?: number; sort_order?: number }) => Promise<any>;
        deleteVariantOption: (id: string) => Promise<any>;
        deleteVariantGroup: (id: string) => Promise<any>;
        listStaff:      () => Promise<any[]>;
        listRoles:      () => Promise<any[]>;
        createStaff:    (payload: any) => Promise<any>;
        updateStaff:    (id: string, patch: any) => Promise<any>;
        getReceiptText: () => Promise<{ header: string; footer: string }>;
        setReceiptText: (header: string, footer: string) => Promise<any>;
      };
      manager: {
        reportScope: () => Promise<{
          terminalCode: string | null;
          deviceRole: 'till' | 'node';
          coversBranch: boolean;
          scopeLabel: string;
          earliestOrder: string | null;
        }>;
        resolveRange: (range: ReportRangeArg) => Promise<{ from: string; to: string; label: string }>;
        exportCsv: (req: { kind: 'sales' | 'orders' | 'products' } & ReportRangeArg) =>
          Promise<{ ok: boolean; path?: string; error?: string; rows?: number }>;
        dailyReport: (req?: ReportRangeArg) =>
          Promise<{ ok: boolean; path?: string; error?: string }>;
        salesSummary:    (range?: ReportRangeArg) => Promise<any>;
        topProducts:     (range?: ReportRangeArg) => Promise<any[]>;
        recentOrders:    (range?: ReportRangeArg) => Promise<any[]>;
        stockLevels:     () => Promise<any[]>;
        fuelSales:       () => Promise<any>;
        pumpStatus:      () => Promise<any[]>;
        tableOccupancy:  () => Promise<any[]>;
        branchReport:    () => Promise<{ salesSummary: any; topProducts: any[]; recentOrders: any[]; stockLevels: any[]; source: 'node' | 'local' | 'local_fallback' }>;
        priceList:        () => Promise<{ product_id: string; product_name: string; category_name: string | null; base_price: number; branch_price: number | null; effective_price: number; pending: boolean }[]>;
        setBranchPrice:   (product_id: string, price: number) => Promise<{ ok: true }>;
        clearBranchPrice: (product_id: string) => Promise<{ ok: true }>;
      };
      expense: {
        categories: () => Promise<{ id: string; name: string }[]>;
        create: (p: { description: string; amount: number; expense_category_id?: string; paid_by?: string }) => Promise<{ id: string }>;
        list: () => Promise<any[]>;
      };
    };
  }
}

// ── Error messages ────────────────────────────────────────────────────────────
//
// Electron wraps anything thrown in a main-process handler, so a plain
// `throw new Error('Invalid PIN')` arrives in the renderer as:
//
//   Error invoking remote method 'auth:verifyPin': Error: Invalid PIN
//
// Every screen that shows `err.message` was therefore putting the IPC channel
// name in front of a cashier. Cleaning it here — at the one place the whole
// renderer talks to the main process — fixes all of them at once, rather than
// each call site remembering to do it.

const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_LABEL = /^(?:Uncaught\s+)?(?:Error|TypeError|RangeError):\s*/;

/** Technical strings the user should never see, and what to say instead. */
const FRIENDLY: Array<[RegExp, string]> = [
  [/invalid pin/i,                       'That PIN was not recognised. Please try again.'],
  // Order matters: activation runs BEFORE any session exists, so a 401 there is
  // a wrong address or wrong credentials, never an expiry. Matching the generic
  // "unauthorised" first told a technician the till had been signed out when it
  // had never been signed in — and sent an hour into the wrong problem.
  [/bad or missing x-node-secret|node.?secret/i,
                                         'That address is a branch server, not the main server. Branch servers relay sales between tills and cannot sign anyone in.'],
  [/desktop-login|activate/i,            'The server did not accept that sign-in. Check the email, the password, and the server address.'],
  [/invalid or expired token|jwt expired|unauthor/i,
                                         'This till was signed out. Ask a manager to sign in again.'],
  [/not signed in/i,                     'This till is not signed in. Ask a manager to sign in.'],
  [/failed to fetch|network ?error|fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ENETUNREACH/i,
                                         'Cannot reach the server. Check the internet connection — sales are still saved on this till.'],
  [/timeout|timed out/i,                 'The server took too long to answer. Please try again.'],
  [/UNIQUE constraint failed/i,          'That record already exists.'],
  [/FOREIGN KEY constraint failed/i,     'Something it depends on is missing. Please refresh and try again.'],
  [/SQLITE_BUSY|database is locked/i,    'The till is busy saving. Please try again in a moment.'],
  [/no such (table|column)/i,            'This till needs updating. Please contact support.'],
  [/insufficient stock|out of stock/i,   'There is not enough stock for that item.'],
  [/shift .*(not open|required)|no open shift/i,
                                         'No shift is open. Start a shift before selling.'],
  [/HTTP 5\d\d|internal server error/i,  'The server had a problem. Please try again shortly.'],
  [/HTTP 4\d\d/i,                        'The server rejected that request. Please check the details and try again.'],
];

export function humaniseError(raw: unknown): string {
  let msg = String((raw as any)?.message ?? raw ?? '').trim();

  // The wrapper can nest, so strip until it stops changing.
  let prev = '';
  while (msg !== prev) {
    prev = msg;
    msg = msg.replace(IPC_WRAPPER, '').replace(ERROR_LABEL, '').trim();
  }

  if (!msg) return 'Something went wrong. Please try again.';

  for (const [pattern, friendly] of FRIENDLY) {
    if (pattern.test(msg)) return friendly;
  }

  // Not a known case. Keep the server's own wording — it is usually written for
  // a person — but never show a stack trace, and start with a capital.
  msg = msg.split('\n')[0].trim();
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

/**
 * Builds a plain mirror of the IPC surface whose functions clean their own
 * rejections. Same shape, same return values — only `err.message` changes.
 *
 * Deliberately NOT a Proxy. `window.swiftpos` comes through Electron's
 * contextBridge, which defines its properties as read-only and
 * non-configurable. A Proxy `get` trap is required to return the identical
 * value for such properties, so returning a wrapped one violates the invariant
 * and throws before the app can even read the session:
 *
 *   'get' on proxy: property 'auth' is a read-only and non-configurable data
 *   property on the proxy target but the proxy did not return its actual value
 *
 * Walking the object once at startup sidesteps that entirely.
 */
function wrapApi<T>(target: T, seen = new WeakMap<object, any>()): T {
  if (typeof target === 'function') {
    const fn = target as unknown as (...a: unknown[]) => unknown;
    return ((...args: unknown[]) => {
      try {
        const result = fn(...args);
        return result instanceof Promise
          ? result.catch((err: unknown) => { throw new Error(humaniseError(err)); })
          : result;
      } catch (err) {
        throw new Error(humaniseError(err));
      }
    }) as unknown as T;
  }

  if (target === null || typeof target !== 'object') return target;

  // Guard against a cycle in the bridged object.
  const obj = target as unknown as Record<string, unknown>;
  if (seen.has(obj)) return seen.get(obj);
  const out: Record<string, unknown> = {};
  seen.set(obj, out);

  // Own keys AND inherited ones: contextBridge can place members on a prototype.
  const keys = new Set<string>([
    ...Object.keys(obj),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(obj) ?? {}).filter(k => k !== 'constructor'),
  ]);
  for (const key of keys) {
    try {
      const value = obj[key];
      // Bind before wrapping so a method that relies on `this` still works
      // once it is detached from its original object.
      out[key] = typeof value === 'function'
        ? wrapApi((value as (...a: unknown[]) => unknown).bind(obj), seen)
        : wrapApi(value, seen);
    } catch {
      /* skip anything the bridge refuses to read */
    }
  }
  return out as unknown as T;
}

export const posApi = wrapApi(window.swiftpos);
