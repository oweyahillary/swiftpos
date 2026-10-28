import type { PosFeatures } from '../../shared/posFeatures';
import type { StockCountFreeze } from '../../shared/stockCountFreeze';
import type { StockView, OutOfStockMode } from '../../shared/stockGate';   // A563
import type { LabelSettings } from '../../shared/labels';   // A571
import type { BarcodeNumbering } from '../../shared/barcode';   // A574
// Renderer-side API — calls window.swiftpos.* (IPC via preload.ts)
// Shape mirrors the web dashboard's api.ts so shared logic stays consistent.

/** A345: why the back office's cloud-owned lists cannot be read right now (main/offlineSession.ts has the words). */
/** A492: a branch's M-Pesa set-up (shared/mpesaReceive.ts MpesaReceive). */
export interface MpesaReceiveLite { kind: 'buy_goods' | 'paybill'; number: string; account: string | null }

export interface OfflineManage { reason: 'offline_session' | 'no_connection'; message: string }

export interface StaffSession {
  staff: { id: string; name: string } | null;
  role: string | null;
  permissions: Record<string, boolean>;
  branchId: string;
  branchName: string | null;
  /** A334: set when this sign-in joined a drawer the web POS opened as this till. */
  joinedDrawer?: { openedByName: string | null; openedAt: string; sameCashier: boolean } | null;
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

/** A588: the pumps screen's gauges (main/forecourt.ts) — this POS's own fuel sales and, when known, the tanks. */
export interface Forecourt {
  pumps: { pump_id: string; litres_today: number; last_sale_at: string | null; last_sale_litres: number | null; last_sale_amount: number | null }[];
  grades: { product_id: string; litres_today: number; litres_yesterday: number }[];
  /** null = the levels are not known on this POS now (offline, no online licence, no tanks) — never zeros. */
  tanks: { id: string; name: string; product_id: string; capacity_litres: number; current_level: number; reorder_level: number | null }[] | null;
  tanksAt: string | null;
}

export type DeviceRole = 'till' | 'node' | 'office';

export interface TechSession {
  techId: string; techName: string; branchId: string;
  startedAt: number; expiresAt: number; tokenHash: string;
}

/** A501: one of a till's conversations with its branch server (main/nodeHealth.ts). */
export interface NodeChannelHealth {
  channel: 'health' | 'sync' | 'since' | 'poll' | 'roster' | 'reference' | 'gateway' | 'tls';
  lastOkAt: string | null; lastErrorAt: string | null; lastError: string | null; lastStatus: number | null; failures: number;
}
/** A501: what node:syncHealth answers — on a server or a till without one, only `role`. */
export type NodeSyncHealth =
  | { role: 'server' | 'none' }
  | { role: 'till'; url: string; channels: NodeChannelHealth[];
      backlog: { pending: number; failed: number; oldestPendingAt?: string | null; failedReason?: string | null };
      quarantine: { waiting: number; givenUp: number; reason: string | null };
      server: { device_id: string | null; branch_id: string | null; protocol: number; capabilities: string[]; min_till_protocol: number; seenAt: string } | null;
      tillProtocol: number; serverOlder: boolean; tillOlder: boolean;
      branch: { till: string | null; server: string | null; mismatch: boolean };
      refusal: { status: number; since: string; reason: 'access_code' | 'device_key' | 'branch' | 'tls' } | null;
      heard: { url: string; at: string; proven: boolean } | null };

/** A534 (A23): what node:distribution answers — on a machine that is not a branch server, only `role`. */
export type ServerDistribution =
  | { role: 'not_server' }
  | { role: 'server';
      waiting: { orders: number; ordersFromTills: number; shifts: number; days: number; floats: number; expenses: number; kitchenVoids: number; reversals: number };
      total: number; oldestAt: string | null; oldestAgeMs: number | null; lastPushOkAt: string | null; lastSyncedAt: string | null; runbook: string };

/** A542: what node:drawersStatus answers — the branch server's copy of its branch's drawers (A535, main/branchDrawers.ts). */
export type ServerDrawers =
  | { role: 'not_server' }
  | { role: 'server';
      status: { role: 'server' | 'peer' | 'direct'; mode: string; drawers: number; lastOkAt: string | null; polls: number; error: string | null;
        lastPollAt: string | null; lastPollOk: boolean | null; open: number; awaitingConfirmation: number; peersLastHour: number;
        channel: string; fallback: boolean; fallbackUntil: string | null; fresh: boolean } };

export interface TechStatus {
  device: {
    device_id: string | null; device_name: string | null; device_role: DeviceRole;
    branch_id: string | null; deploy_mode: string | null; server_url: string | null; node_url: string | null;
  };
  sync: { online?: boolean; pending: number; failed: number; lastOrder: string | null; [k: string]: any };
  build?: { sha: string; time: string };
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
  /** A346: does the business have the web POS (from the cloud)? null = not known yet = no. Read-only (the cloud sets it). */
  web_pos_enabled?: boolean | null;
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

/** 0.6.28: one kitchen void on the Z-report. */
export interface KitchenVoidLine {
  id: string; order_number: string; product_name: string; quantity: number; amount: number; reason: string;
  note: string | null; cooked: boolean; cashier_name: string | null; approved_by_name: string | null; created_at: string;
}

/** 0.6.28: a sent order not yet paid (kitchen:open). */
export interface OpenKitchenOrder {
  order_number: string; order_type: string | null; table_number: string | null; first_sent_at: string;
  cashier_id: string | null; held: boolean; value: number;
  lines: Array<{ line_id: string; product_id: string | null; product_name: string; unit_price: number; qty: number; item: unknown }>;
}

/** 0.6.28: a line handed to kitchen:sent / kitchen:void. */
export interface KitchenLinePayload {
  line_id: string; product_id: string | null; product_name: string; unit_price: number; qty: number; item?: unknown;
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
    /** A349: refunds, sales kept, taxes (refund-reduced), CTL levied?, tips — see main/shiftService.ts. */
    refunds?: number;
    netSales?: number;
    vat?: number;
    ctl?: number;
    ctlLevied?: boolean;
    tips?: number;
    voidCount: number;
    cashSales: number;
    floatIn: number;
    floatOut: number;
    expectedCash: number;
    /** A334: the web POS's cash on this (shared) drawer, already inside the totals. null = could not be checked. */
    foreign?: { orders: number; cash_sales: number; float_in: number; float_out: number; expenses: number;
      /** A342: the web's own shift(s) on this till, counted in this drawer. */
      siblings?: { count: number; expected: number; shifts?: Array<{ id: string; opened_by_name: string | null; opened_at: string | null; expected: number }> } | null } | null;
    /** Cross-sync stage 1: the web's sales downloaded onto the till — already inside the totals. */
    webSales?: { orders: number; cash_sales: number };
    /** 0.6.11: cash paid out as expenses — already taken off expectedCash. Absent on reports from older builds. */
    expenses?: number;
    /** 0.6.27: expenses paid by other methods (not from the drawer), per method. */
    expensesByMethod?: Record<string, number>;
    /** 0.6.27: delivery fees (pass-through, in the payments); riders paid from the drawer (inside floatOut), and any
     *  put back by a void (inside floatIn). */
    deliveryFees?: number;
    freeDeliveries?: number;   // 0.6.33
    /** 0.6.33: one line per rider this shift. */
    riders?: { rider: string; deliveries: number; feesPaid: number; freeCount: number; freeFees: number }[];
    riderPayouts?: number;
    riderReturned?: number;
  };
  /** 0.6.11: this till's expense lines on the shift. 0.6.27: `label` = type — description · method. */
  expenseLines?: { description: string; amount: number; created_at: string; paid_by_name: string | null;
                   label?: string; category_name?: string | null; payment_method?: string; approved_by_name?: string | null }[];
  /** 0.6.37 (A388): the cash-outs on this shift and the manager who approved each (`label` = reason · approved …). */
  payoutLines?: { reason: string | null; amount: number; created_at: string; approved_by_name: string | null; label: string }[];
  /** A363: what of this shift is not on the cloud yet. */
  notBackedUp?: { sales: number; drawerRefused: boolean };
  /** 0.6.28: items taken back after they were sent to the kitchen on this shift. */
  kitchenVoids?: {
    summary: { count: number; quantity: number; value: number; cookedValue: number;
               byReason: Array<{ reason: string; label: string; quantity: number; value: number }> };
    lines: KitchenVoidLine[];
  };
  /** A416 / A442: on a blind close, the SHIFT's sales and each person's part — only with the owner's switch on. */
  cashierSales?: { total: number; orders: number; byCashier?: Array<{ name: string; orders: number; sales: number }> };
  /** A442: who sold what on this shift — each person's orders, sales (kept) and money by method. */
  byCashier?: Array<{ cashier_id: string | null; name: string; orders: number; sales: number; byMethod: { method: string; amount: number }[] }>;
  /** A365: the manager's confirmation — awaiting, or confirmed (who, when, self) with per-method lines. */
  confirmation?: {
    status: 'awaiting' | 'confirmed';
    confirmed_by_name?: string | null; confirmed_at?: string; self?: boolean;
    /** 0.6.23: awaiting — what the manager recounts (names only). */
    methods?: string[];
    lines: ConfirmLine[];
  } | null;
  businessName: string;
  currency: string;
}

/** A365: one payment method on a shift's confirmation — cashier's figure, what the till recorded, the manager's recount. */
export interface ConfirmLine {
  method: string; declared: number | null; expected: number | null; confirmed: number | null;
  variance: number | null; mismatch: boolean; reason?: string | null;   // 0.6.27
}
/** A365: a closed shift waiting for a manager's recount. */
export interface AwaitingShift {
  id: string; cashier_id: string | null; cashier_name: string; opened_at: string; closed_at: string | null;
  business_day_id: string | null; methods: string[];
}
/** A365: the result of a manager's confirmation. */
export interface Confirmation {
  shift_id: string; confirmed_by: string; confirmed_by_name: string | null; confirmed_at: string; self: boolean;
  lines: ConfirmLine[];
}

/** 0.6.11: a row in the previous-shift-reports list. */
export interface ShiftSummary {
  id: string; status: string; opened_at: string; closed_at: string | null;
  cashier_name: string | null; expected_cash: number | null; cash_variance: number | null;
}

/** A197: a stock transfer as the cloud returns it (GET /api/stock/transfers). */
export interface StockTransfer {
  id: string; transfer_number: string | null; status: 'pending' | 'in_transit' | 'received' | 'cancelled';
  from_branch_id: string; to_branch_id: string; from_branch_name?: string | null; to_branch_name?: string | null;
  notes: string | null; receipt_note?: string | null; created_at: string;
  stock_transfer_items: Array<{ id: string; product_id: string; quantity: number; quantity_received: number | null; products?: { name: string } | null }>;
}

/** A564: the cloud's answer through the till — or why not (offline: no connection, said plainly). */
/** A571: barcode labels (main/ipc/labels.ts). */
export type LabelPath = 'windows' | 'tspl' | 'zpl' | 'escpos';
export interface LabelPrinter {
  path: LabelPath; windowsPrinter: string; rawTarget: string; escposTarget: string; escposWidthMm: 58 | 80; escposMode: 'gsk' | 'raster';
}
export interface LabelProduct { id: string; name: string; barcode: string | null; price: number; category_id: string | null; category: string | null }
export interface LabelSetup {
  settings: LabelSettings; from: 'cloud' | 'saved' | 'default'; printer: LabelPrinter; products: LabelProduct[];
  business: { name: string; currency: string; type?: string | null }; receiptPrinter: { target: string; paperWidthMm: 58 | 80 } | null; canSaveForBusiness: boolean;
  /** A574: the business's barcode numbering, every barcode this till knows (the preview), and whether this person may generate. */
  numbering: BarcodeNumbering; barcodes: string[]; canGenerate: boolean;
}
/** A574: a print run's answer — the items left out (never printed without a barcode) and the codes generated for it. */
export interface LabelPrintAnswer {
  ok: boolean; labels: number; bytes?: number; error?: string; warnings?: string[];
  skipped?: Array<{ id: string; name: string; reason: string }>; notice?: string; generated?: Array<{ id: string; barcode: string }>;
}
export interface BranchStockAnswer<T> { ok: boolean; data?: T; offline?: boolean; error?: string; code?: string | null }
/** A564: how much each OTHER branch holds of the items found (GET /api/stock/other-branches) — quantities only. */
export interface BranchStockFind {
  branch_id: string | null; truncated: boolean;
  products: Array<{ product_id: string; name: string; sold_by: string | null;
    branches: Array<{ branch_id: string; branch_name: string; quantity: number | null; qty_pieces: number | null; updated_at: string | null; counting: boolean }> }>;
}
/** A564: a branch asking another for an item (GET /api/stock/requests). */
export interface StockRequest {
  id: string; from_branch_id: string; to_branch_id: string; from_branch_name: string; to_branch_name: string;
  product_id: string; product_name: string; quantity: number; sent_quantity: number | null; note: string | null;
  status: 'requested' | 'accepted' | 'declined' | 'cancelled'; requested_by_name: string | null; requested_at: string;
  decided_by_name: string | null; decided_at: string | null; decline_reason: string | null; transfer_id: string | null;
}

/** A466: the monthly pack (A455) as the cloud builds it (apps/server/src/lib/monthlyPack.ts Pack). */
export type MovementKind = 'opening' | 'other_income' | 'drawing' | 'bank_deposit' | 'charges';
export interface MonthlySummaryRow { day: string; byMethod: Record<string, number>; total: number; expected: number | null; counted: number | null; variance: number | null; cashiers: string[]; remarks: string[] }
export interface MonthlyBookRow { day: string; sales: number; otherIn: number; expenses: number; paidOut: number; drawings: number; deposits: number; charges: number; balance: number }
export interface MonthlyPack {
  title: string; methods: string[];
  summary: { rows: MonthlySummaryRow[]; byMethod: Record<string, number>; total: number; expected: number; counted: number; variance: number };
  expenses: { days: { day: string; lines: { type: string | null; description: string; amount: number; method: string; by: string | null }[]; total: number }[];
    byType: { type: string; amount: number }[]; byMethod: { method: string; amount: number }[]; total: number };
  books: { method: string; label: string; opening: number; rows: MonthlyBookRow[]; totals: Omit<MonthlyBookRow, 'day' | 'balance'>; closing: number }[];
}
/** A466: what a manager recorded for the books (money_movements). */
export interface MoneyMovement { id: string; movement_date: string; method: string; kind: MovementKind; amount: number; note: string | null; recorded_by_name: string | null }
/** A466: a monthly-pack answer from main — never thrown; `code: 'offline'` when there is no connection. */
export interface MonthlyAnswer<T> { ok: boolean; data?: T; branch_id?: string; error?: string; code?: string | null; status?: number | null }

/** A452: one shift as its till reports it to the branch server (main/branchClose.ts PeerShift). */
/** A458: one payment method's line in the branch's day totals (main/branchClose.ts branchMethodTotals). */
export interface BranchMethodLine { method: string; sales: number; expected: number; confirmed: number; variance: number }
export interface BranchTotals {
  methods: BranchMethodLine[];
  total: Omit<BranchMethodLine, 'method'>;
  orders: number;
  shifts: { all: number; open: number; awaiting: number; confirmed: number; uncounted: number };
}

/** A520: the Close Branch rule's answer (main/branchClose.ts assessBranchClose). */
export interface BranchCloseAssessment {
  blockers: string[];
  /** A521: `note` + `close: false` — a till that never reported, or an older build (nothing is sent to it). */
  held: Array<{ device_id: string; label: string; business_date: string | null; note?: string; close?: boolean }>;
  /** A521: another till with money (a drawer open, a shift to confirm) — the manager may tick `warning` and close without it. */
  without?: Array<{ device_id: string; label: string; connected: boolean; lines: string[]; warning: string }>;
  self_drawer: { shift_id: string | null; cashier_name: string | null } | null;
}

/** A465: a cash in / out or expense the branch server sent to a till (main/branchClose.ts ShiftMoneyView). */
export interface ShiftMoneyView {
  id: number; status: string; error: string | null; created_at: string;
  shift_id: string; kind: 'float_in' | 'float_out' | 'expense'; amount: number; note: string | null;
  /** set once the till has picked it up — from then on it may be on its books, so it can no longer be withdrawn */
  delivered_at: string | null; acked_at: string | null;
}
export interface ShiftMoneyRequest {
  device_id: string; shift_id: string; kind: 'float_in' | 'float_out' | 'expense'; amount: number; reason?: string;
  description?: string; expense_category_id?: string; category_name?: string; payment_method?: string;
  /** A594: the manager confirmed a cash in that looks like a drawer count is a real cash in. */
  count_ack?: boolean;
}

export interface BranchPeerShift {
  id: string; cashier_name: string; opened_at: string; closed_at: string | null;
  state: 'open' | 'awaiting' | 'confirmed' | 'closed';
  orders: number; sales: number; by_method: Record<string, number>; expected: Record<string, number>;
  methods: string[]; declared: Record<string, number> | null;
  cash: { opening_float: number; cash_sales: number; float_in: number; float_out: number; expenses: number; cashier?: number | null };   // A527: cashier
  confirmed?: { by_name: string | null; at: string; counted: Record<string, number> | null } | null;
}

/** 0.6.11: an expense on the manager's Expenses screen. */
export interface ExpenseRow {
  id: string; description: string; amount: number; created_at: string; shift_id: string | null;
  paid_by_name: string | null; expense_category_id: string | null; sync_status: string;
  /** A452: how it was paid, its type, who paid it. */
  payment_method: string; expense_type_name: string | null; paid_by: string | null;
}

/** Date-range selection for the manager reports. */

/** A431 / A432 — main/branchDay.ts. */
export type BranchShiftState = 'open' | 'awaiting' | 'confirmed' | 'closed';
export interface BranchShiftRow {
  id: string; device_id: string | null; till: string; this_till: boolean; cashier: string;
  opened_at: string; closed_at: string | null; state: BranchShiftState; force_closed: boolean; confirmed_by: string | null;
  opening_float: number; orders: number; sales: number; by_method: Array<{ method: string; amount: number }>;
  expected_cash: number | null; counted_cash: number | null; variance: number | null;
  declare_codes: string[];
}
/** A433: a shift anywhere at the branch, for Sales › Shift report (the cloud's list). */
export interface BranchShiftListRow {
  id: string; status: string; opened_at: string; closed_at: string | null; cashier_name: string | null;
  expected_cash: number | null; cash_variance: number | null; till: string; this_till: boolean; awaiting: boolean;
}
export interface BranchDay {
  source: 'cloud' | 'local';
  scopeLabel: string;
  fallbackReason: string | null;
  localCoversBranch: boolean;
  summary: any;
  paymentMethods: Record<string, number>;
  hourly: Array<{ hour: number; revenue: number; orders: number }>;
  byTill: Array<{ device_id: string | null; label: string; this_till: boolean; orders: number; revenue: number }>;
  shifts: BranchShiftRow[];
  topProducts: Array<{ name: string; qty: number; revenue: number }>;
  /** A440: staff performance — each person's sales by who rang them up, with their money by method. */
  byStaff?: Array<{ id: string; name: string; orders: number; revenue: number; avg: number; by_method: Array<{ method: string; amount: number }> }>;
}
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
  /** A411: routing saved on this till, not yet on the cloud. */
  pending_sync?: boolean;
}

/** A411: saved on the cloud, saved on this till and waiting for the cloud, or refused by the cloud. */
export interface StationRoutingResult {
  station_id: string;
  state: 'saved' | 'pending' | 'refused';
  category_ids: string[] | null;
  rejected: string[];
  message?: string;
}

/** A414: an item that can be written off at this branch. */
export interface WasteItem { kind: 'product' | 'ingredient'; id: string; name: string; unit: string | null; by_piece: boolean; stocked: boolean; held: number | null; cost: number | null }
export interface WasteRecordingView {
  client_id: string; reason: string; note: string; recorded_by_name: string; recorded_at: string;
  items: Array<{ kind: string; id: string; name: string; quantity: number }>;
}
/** A552: a customer this till may sell to on account (main/creditSale.ts) — owed = the cloud's balance + this till's sales
 *  on account the cloud had not taken; available = the limit less that. */
export interface CreditCustomerView {
  id: string; name: string; phone: string | null; status: string;
  credit_limit: number; cloud_balance: number; pending: number; owed: number; available: number;
  /** A595 D4: the customer's limit at this branch (null = the business-wide one) and what they owe here. */
  branch_limit?: number | null; owed_here?: number;
}
/** A545: a sale on account and its manager's confirmation (main/creditConfirm.ts). */
export interface CreditSaleView {
  order_id: string; order_number: string | null; branch_id: string | null; branch_name: string | null;
  customer_name: string | null; amount: number; state: 'awaiting' | 'confirmed' | 'disputed'; source: string; over_limit: boolean;
  cashier_name: string | null; approved_by_name: string | null; decided_by_name: string | null; decided_at: string | null;
  dispute_reason: string | null; sold_at: string; pending?: boolean;
}
/** A413: a batch on the expiry list. */
export interface ExpiringBatch {
  id: string; name: string; unit: string | null; batch_no: string | null; expiry_date: string | null; remaining: number;
  status: 'expired' | 'soon' | 'ok' | 'none'; days_left: number | null; kind: 'product' | 'ingredient'; item_id: string;
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
        // The EFFECTIVE list, where it came from, and the cloud baseline. The
        // setup screen previews with `terms`, so a preview never disagrees with
        // the printer; `source`/`cloudTerms` drive the "local override vs
        // business default" affordance.
        kitchenExclusions: () => Promise<{ terms: string[]; source: 'local' | 'cloud'; cloudTerms: string[] }>;
        // Set this terminal's local override. Allowed on any till; the override
        // wins over the cloud default and is never overwritten by a sync.
        setKitchenExclusions: (terms: string[]) => Promise<{ ok: boolean; error?: string; terms: string[] }>;
        // Drop the override and follow the cloud baseline again. Returns the
        // baseline now in force.
        clearKitchenExclusions: () => Promise<{ ok: boolean; error?: string; terms: string[] }>;
        reprintReceipt: () => Promise<{ ok: boolean; error?: string }>;
        reprintReceiptForOrder: (orderId: string) => Promise<{ ok: boolean; error?: string }>;
        printShiftReport: (data: unknown) => Promise<{ ok: boolean; error?: string; internal?: boolean }>;
        retry:       (id: string) => Promise<unknown>;
        preview:     (ctx: unknown) => Promise<unknown>;
        test:        (ctx: unknown, target: string) => Promise<any>;
        onChanged:   (cb: () => void) => () => void;
      };
      version: string;
      platform: string;
      auth: {
        redeemEnrolment: (business_id: string, code: string) => Promise<{ business: any; branchId: string | null }>;
        /** A415: the technician rejoins this till to its business (tech console only); everything on the till is kept. */
        rejoin: (business_id: string, code: string) => Promise<{ business: any; branchId: string | null }>;
        getSession: () => Promise<{ till: { device_id: string | null }; business: any } | null>;
        listBranches: () => Promise<{ id: string; name: string; desktop_licensed: boolean }[]>;
        verifyPin: (pin: string, branch_id: string) => Promise<StaffSession>;
        /** A446: the lock screen — is this the signed-in person's PIN? The session is kept (not re-signed in). */
        unlock: (pin: string) => Promise<{ ok: boolean; reason?: 'wrong' }>;   // A494: one answer — never 'other'
        getStaffSession: () => Promise<StaffSession | null>;
        clearStaffSession: () => Promise<boolean>;
        /** A490: main stored a fresher permission map for the person signed in; returns its unsubscribe. */
        onPermissionsChanged: (cb: () => void) => () => void;
      };
      /** A427: a new till finds the branch server on the shop network and asks to join it. */
      install: {
        findServers: () => Promise<FoundServer[]>;
        /** A436: `rejoin` — a till already set up, signed out: joins again keeping everything on it. */
        /** A489: `securityCode` — from the server's certificate (null: a server on an older build, joined unencrypted). */
        requestJoin: (url: string, rejoin?: boolean) => Promise<{ ok: true; name: string; securityCode?: string | null }>;
        joinStatus: () => Promise<JoinStatus>;
        /** A519: is this terminal code free at the branch, and the next free one (T1 → T2 …). */
        checkTerminalCode: (code: string, branch_id?: string) => Promise<{ ok: boolean; taken: boolean; inUse: string[]; suggestion: string; source: 'cloud' | 'server' | 'none'; message: string | null }>;
      };
      /** A427: on the branch server — tills waiting to join, and the answer. */
      serverJoin: {
        requests: () => Promise<Array<{ id: string; name: string; ip: string; at: string; securityCode?: string | null }>>;
        answer: (id: string, allow: boolean) => Promise<{ ok: true }>;
        /** A443: on the branch server — the version it holds for its tills, and what each till runs. */
        tillVersions: () => Promise<{ serverVersion: string; ready: string | null;
          /** A496: the server's own fetch of the approved version for its tills. */
          share?: { version: string; state: 'fetching' | 'failed' | string; failures: number; error: string | null; bytes: number | null; size: number | null } | null;
          tills: Array<{ deviceId: string; name: string | null; version: string; seenAt: string; current: boolean }> }>;
        /** A489: this till's connection to its branch server — or, on the server, its own security code. */
        tlsStatus: () => Promise<{ state: 'none' | 'plain' | 'encrypted' | 'old_server' | 'mismatch' | 'tls_failed' | 'server'; code: string | null; error: string | null }>;
        /** A489: forget the server's certificate (it was reinstalled); the next one it hands out is trusted. */
        tlsRetrust: () => Promise<{ ok: true }>;
        /** A501: this till's conversation with its branch server, channel by channel (Tech page › Branch sync). */
        syncHealth: () => Promise<NodeSyncHealth>;
        /** A501: the records the server refused go to it again; the rows held back from other tills are tried again. */
        retryFailed: () => Promise<{ requeued: number; released: number; applied: number }>;
        /** A534 (A23): on a branch server, how far its distribution to the cloud is behind (Tech page). */
        distribution: () => Promise<ServerDistribution>;
        /** A542: on a branch server, its copy of the branch's drawers (Tech page). */
        drawersStatus: () => Promise<ServerDrawers>;
      };
      // A52 — the idle lock. See main/idleMonitor.ts for why the decision lives
      // in the main process (OS idle cannot fire mid-sale; renderer activity
      // tracking can).
      idle: {
        setSurface: (surface: 'manager' | 'pos' | null) => Promise<boolean>;
        clear:      () => Promise<boolean>;
        /** A517: may the manager screens be fetched in the background now (start-up over, memory to spare)? */
        mayPreload?: () => Promise<{ ok: boolean; settled: boolean; why: string }>;
        suppress:   () => Promise<number>;
        release:    (token: number) => Promise<boolean>;
        onLock:     (cb: () => void) => () => void;
      };
      pos: {
        init: () => Promise<{ products: any[]; categories: any[]; menus?: any[]; branchId: string | null; vatRate: number | null; ctlRate: number | null; maxDiscountPct: number | null;
          comboItems: Record<string, Array<{ product_id: string; name: string; quantity: number; is_kitchen: boolean }>>;
          kitchenCategories: string[];
        stationRouting?: {
          stations: Array<{ id: string; name: string; kind: 'kitchen' | 'dispatch' | 'receipt'; sort_order: number }>;
          byCategory: Record<string, string[]>;
        };
          receiptHeader: string; receiptFooter: string }>;
        getVariants: (productId: string) => Promise<any[]>;
        getModifiers: (productId: string) => Promise<any[]>;
        /** A367: the owner's quick picks for order notes (cached from the cloud; the defaults until told). */
        notePicks: () => Promise<string[]>;
        /** 0.6.27: the per-client POS switches (set in the admin portal; all off until the till is told). */
        features: () => Promise<PosFeatures>;
        stockCountFreeze: () => Promise<StockCountFreeze>;   // A394
        stockView: () => Promise<StockView & { mode: OutOfStockMode; branchId: string | null }>;   // A563
        /** A521: a manager's PIN releases a frozen item for sale on this till. */
        approveFrozenSale: (pin: string, productId: string) => Promise<{ ok: boolean; error?: string; approvedBy?: string | null }>;
        /** 0.6.27: History — the orders this person may see, and whether they may reprint from it. */
        history: () => Promise<{ scope: { staffId: string | null; manager: boolean; ownOnly: boolean; canReprint: boolean; canVoid?: boolean; canRefund?: boolean; methods: string[]; showTotal?: boolean }; orders: any[] }>;
        /** 0.6.30: the owner's void window and offline void/refund rules (shared/reversalRules.ts). */
        reversalRules: () => Promise<{ voidWindowMinutes: number; offlineRefundMethods: string[]; offlineReverseWebSales: boolean; freeDeliveryAllowed: boolean; freeDeliveryOver: number | null }>;
        /** 0.6.35 (A384): the Help screen — who to call (the shop's tech or SwiftPOS support), this till's name and version. */
        help: () => Promise<{ contact: { name: string; phones: string[]; assigned: boolean }; till: string | null; version: string }>;
        getTables: () => Promise<DiningTable[]>;
        getPumps: () => Promise<Pump[]>;
        /** A588: the pumps screen's gauges — this POS's litres today / yesterday, each pump's last sale, the tanks (null = not known). */
        forecourt: () => Promise<Forecourt>;
        paymentMethods: () => Promise<{ code: string; name: string }[]>;
        /** A429: the payment methods this branch takes (null = not told yet = the catalogue's defaults). */
        paymentMethodsEnabled: () => Promise<{ enabled: string[] | null }>;
        /** A445: the branch's offers as the till holds them, and its branch (an offer may be for chosen branches). */
        offers: () => Promise<{ offers: import('../../shared/offers').Offer[]; branchId: string | null }>;
        onCatalogueChanged: (cb: () => void) => () => void;   // A278
      };
      order: {
        /** A349: printFailed names tickets that could not be produced (shown to the cashier); [] when all went out. */
        create: (payload: any) => Promise<{ orderId: string; orderNumber?: string | null; printFailed?: string[] }>;
        void:   (orderId: string, reason: string, supervisor_pin?: string, authorizer_id?: string) => Promise<{ ok: boolean; offline?: boolean; approvedBy?: string | null }>;
        /** A444: an order's items, sizes, extras, notes and payments; `canReprint` = this person may reprint it. */
        detail: (orderId: string) => Promise<{ ok: boolean; error?: string; detail?: import('../../shared/orderDetail').OrderDetail; canReprint?: boolean }>;
        refund: (orderId: string, reason: string, override_pin?: string, authorizer_id?: string) => Promise<{ ok: boolean; refunded: number; offline?: boolean; approvedBy?: string | null }>;
        /** A552: On account — offered on this till?, may the person signed in approve it themselves (no PIN)?, the customers. */
        creditCustomers: (search?: string) => Promise<{ offered: boolean; selfApproves: boolean; chosenApprovers?: boolean; saved_at: string | null; customers: CreditCustomerView[] }>;
        /** A595 D1: add a customer on the cloud (name, phone, e-mail, KRA PIN). */
        createCustomer: (c: { name: string; phone: string; email?: string; kra_pin?: string }) => Promise<{ ok: boolean; customer: unknown }>;
      };
      sync: {
        trigger: () => Promise<{ pulled: boolean; pushed: number; errors: string[] }>;
        status: () => Promise<{ online: boolean; pendingCount: number; failedCount: number;
                                failedReason?: string; failedSince?: string;
                                /** A363: records the cloud refused (parked), why, and when the till last had nothing waiting. */
                                parkedCount?: number; parkedReason?: string; lastSyncedAt?: string | null;
                                /** A529: the cloud could not be reached on the last try (no answer, its 5xx, another server's page). */
                                cloudUnreachable?: { since: string; why: string } | null;
                                /** A581: the cloud refuses this business's sync (its cloud plan lapsed); records stay queued. */
                                cloudLapsed?: { since: string; message: string } | null }>;
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
              /** A452: the till's shifts (absent from an older till), and its clock when it reported. */
              shifts?: BranchPeerShift[];
              clock?: string;
              /** A465: the till's code and name (absent from an older till). */
              terminal?: { code?: string | null; name?: string | null };
            } | null;
            /** A452: the latest confirm sent per shift. */
            confirms?: Record<string, { status: string; error: string | null; created_at: string }>;
            /** A465: cash in / out and expenses sent to this till from the server (last 24 h). */
            money?: ShiftMoneyView[];
            instruction: {
              id: number; status: string; created_at: string;
              delivered_at: string | null; acked_at: string | null;
              payload: { business_date: string; counted_cash: number | null; notes?: string; wait_for_till?: boolean };
              ack: { ok: boolean; error?: string; summary?: any; already_closed?: boolean; wait?: boolean } | null;   // A521: wait = "not yet"
            } | null;
          }>;
          /** A458: the day's totals per payment method over every shift the tills reported. */
          totals: BranchTotals;
          /** A520: what stands between the branch and its close — the same rule closeBranch applies (main/branchClose.ts
           *  assessBranchClose). `held`: tills not heard from whose last report needs nobody — their day closes when they
           *  next connect. `self_drawer`: this terminal's own open drawer (the server used as a till) — close it first. */
          close?: BranchCloseAssessment;
        } | { error: string }>;
        closeTill: (deviceId: string, countedCash: number, notes?: string) => Promise<{
          ok: boolean; error?: string; instruction_id?: number;
          self?: boolean; summary?: unknown; already_closed?: boolean;
          /** A521: the till is not connected — it applies when it reconnects (`message` says so). */
          queued_offline?: boolean; message?: string;
        }>;
        confirmShift: (deviceId: string, shiftId: string, counts: Record<string, number>, reasons?: Record<string, string>) => Promise<{
          ok: boolean; error?: string; instruction_id?: number; self?: boolean; summary?: Confirmation | null;
          queued_offline?: boolean; message?: string;   // A521
        }>;
        /** A458: totalsConfirmed — the manager ticked the day's totals by payment method (required to close).
         *  A521: withoutTills — the tills with money (BranchCloseAssessment.without) the manager ticked to close without. */
        closeBranch: (notes?: string, totalsConfirmed?: boolean, withoutTills?: string[]) => Promise<{
          ok: boolean; error?: string; blockers?: string[]; code?: string;
          without?: BranchCloseAssessment['without'];
          results?: Array<{ device_id: string; ok: boolean; sent?: boolean; held?: boolean; without?: boolean; skipped?: boolean; error?: string }>;
        }>;
        /** A465: a cash in / out or expense on any running shift of the branch — the till records it (server only). */
        shiftMoney: (req: ShiftMoneyRequest) => Promise<{
          ok: boolean; error?: string; code?: string; instruction_id?: number; row_id?: string; direct?: boolean;   // A594: code
          summary?: { kind: string; amount: number; shift_id: string; expected_cash: number } | null;
          queued_offline?: boolean; message?: string;   // A521
        }>;
        /** A465: withdraw one the till has not answered yet. */
        cancelShiftMoney: (instructionId: number) => Promise<{ ok: boolean; error?: string }>;
        /** F4: "Forget this till" — off the Close Branch list (manager, branch server only). A521: "Revoke this till" —
         *  its device key goes: refused everywhere until it joins again. */
        forgetTill: (deviceId: string) => Promise<{ ok: boolean; error?: string }>;
        /** A521: "Hide from Close Branch" — off the list until it next reports; its key is kept. */
        hideTill: (deviceId: string) => Promise<{ ok: boolean; error?: string }>;
      };
      /** A197: stock transfers between branches (online licence; inventory.transfer). */
      transfers: {
        list: () => Promise<{ ok: boolean; data?: StockTransfer[]; branch_id?: string; error?: string; code?: string | null }>;
        branches: () => Promise<{ ok: boolean; data?: Array<{ id: string; name: string }>; error?: string }>;
        create: (toBranchId: string, items: Array<{ product_id: string; quantity: number }>, notes?: string) =>
          Promise<{ ok: boolean; data?: StockTransfer; error?: string; code?: string | null }>;
        status: (body: { id: string; status: 'in_transit' | 'received' | 'cancelled'; reason?: string;
          received_items?: Array<{ product_id: string; quantity_received: number }>; receipt_note?: string; allow_same_user?: boolean }) =>
          Promise<{ ok: boolean; data?: StockTransfer; error?: string; code?: string | null }>;
      };
      /** A564: another branch's stock, and asking that branch for an item (online licence; from the cloud). */
      branchStock: {
        find: (q: string, productId?: string) => Promise<BranchStockAnswer<BranchStockFind>>;
        requests: () => Promise<BranchStockAnswer<{ branch_id: string | null; incoming_open: number; requests: StockRequest[] }>>;
        request: (fromBranchId: string, productId: string, quantity: number, note?: string) => Promise<BranchStockAnswer<StockRequest>>;
        decide: (id: string, step: 'accept' | 'decline' | 'cancel', extra?: { reason?: string; quantity?: number }) =>
          Promise<BranchStockAnswer<StockRequest & { transfer?: { id: string; transfer_number: string; status: string }; warning?: string }>>;
      };
      /** A571: barcode labels — this till's catalogue, the business's label, this till's label printer (main/ipc/labels.ts). */
      labels: {
        setup: () => Promise<LabelSetup>;
        save: (body: { settings?: LabelSettings; printer?: LabelPrinter }) =>
          Promise<{ ok: boolean; settings: LabelSettings; printer: LabelPrinter; cloud: 'saved' | 'offline' | 'not-allowed' | null }>;
        print: (body: { items: Array<{ product_id: string; copies: number }>; path?: LabelPath; settings?: LabelSettings; generate?: boolean }) =>
          Promise<LabelPrintAnswer>;
        /** A574: save the business's barcode numbering (menu.edit, online). */
        numbering: (numbering: BarcodeNumbering) => Promise<{ ok: boolean; numbering: BarcodeNumbering; error?: string }>;
      };
      /** A466: the monthly pack (A455) — from the cloud, with the manager's own sign-in; online only. */
      monthly: {
        get: (month: string, branchId?: string) => Promise<MonthlyAnswer<MonthlyPack>>;
        export: (month: string, branchId?: string) => Promise<{ ok: boolean; path?: string; error?: string; code?: string | null; canceled?: boolean }>;
        movements: {
          list: (month: string, branchId?: string) => Promise<MonthlyAnswer<MoneyMovement[]>>;
          add: (m: { movement_date: string; method: string; kind: MovementKind; amount: number; note?: string; branch_id?: string }) => Promise<MonthlyAnswer<MoneyMovement>>;
          remove: (id: string) => Promise<MonthlyAnswer<{ ok: true }>>;
        };
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
      branding: {
        get: () => Promise<{ accentHex: string | null; logoPng: string | null; logoReceipt: string | null; receiptLogoEnabled: boolean; themeId?: string | null;
                             /** A544: this till's branch's override (null = none) and the look resolved branch → business → default. */
                             branch?: { branchId: string; themeId: string | null; accentHex: string | null; receiptFooter: string | null } | null;
                             effective?: { themeId: string | null; accentHex: string | null } } | null>;
        // A301: desktop-local write path. undefined field = leave as-is, null = clear, value = set.
        // Rejects (throws) on a bad hex, an SVG, a non-raster data-URI, or a logo over 250 KB.
        // A312: logoRgba = the logo's pixels (≤384×240 RGBA); main thresholds them into the receipt
        // raster. receiptLogoEnabled = the opt-in toggle.
        set: (b: { businessId: string; accentHex?: string | null; logoPng?: string | null;
                   logoRgba?: { width: number; height: number; data: Uint8ClampedArray } | null;
                   receiptLogoEnabled?: boolean })
          => Promise<{ accentHex: string | null; logoPng: string | null; logoReceipt: string | null; receiptLogoEnabled: boolean; themeId?: string | null;
                       /** 0.6.25: how the cloud copy went (saved / pending until the next sync / refused with why). */
                       cloud?: { state: 'saved' | 'pending' | 'refused'; message?: string } }>;
      };
      // A306: auto-update status + manager-gated install-now.
      update: {
        getStatus: () => Promise<{ state: string; version: string | null; percent: number | null; downloadedAt?: number | null }>;   // A541: downloadedAt
        /** A496: the status with its reason (note), when it last checked, the approved version, and the last log lines. */
        getDiagnostics: () => Promise<{ status: { state: string; version: string | null; percent: number | null; note?: string | null; checkedAt?: string | null; approved?: string | null };
                                        running: string | null; log: Array<{ at: string; line: string }>;
                                        /** A508: the last idle install (shown on the Tech page only — never a cashier banner). */
                                        idleInstall?: { from: string; to: string; at: string; reason: 'idle' | 'startup'; why?: string; ok: boolean } | null;   // A541: 'startup'
                                        /** A508: why the downloaded update has not installed on its own yet. */
                                        idleNote?: string | null;
                                        /** A509: the updater task (installs with no Windows prompt) and its own log's last lines. */
                                        updaterTask?: { installed: boolean | null; log: string[] };
                                        /** A513: the last start's timing line (ready / window / sync sequence / memory), and the graphics mode. */
                                        startup?: string | null; graphics?: string | null }>;
        /** A519: one tap — main allows the signed-in back-office person or a technician (no PIN — the PIN restart channel is gone). */
        installNow: () => Promise<{ ok: boolean; reason?: string }>;
        onStatus: (cb: (s: { state: string; version: string | null; percent: number | null; downloadedAt?: number | null }) => void) => () => void;
      };
      config: {
        get: () => Promise<DeviceConfig | null>;
        isConfigured: () => Promise<boolean>;
        save: (patch: Partial<DeviceConfig>) => Promise<DeviceConfig>;
        clear: () => Promise<boolean>;
        identity: () => Promise<{ deviceId: string | null; terminalCode: string | null; deviceName?: string | null }>;
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
        backupNow: () => Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }>;
        /** A516: the graphics mode a technician sets (A513 low-memory mode); it takes effect at the next start. */
        getGpuMode: () => Promise<{ mode: 'auto' | 'on' | 'off' }>;
        setGpuMode: (mode: 'auto' | 'on' | 'off') => Promise<{ ok: boolean; mode: string }>;
        maintenance: () => Promise<{ last_backup_at: string | null; last_backup_status: string | null;
                                     backup_dir: string; last_prune_at: string | null; retention_days: number;
                                     same_disk?: boolean; custom_dir?: boolean; keep?: number }>;
        /** A380: pick a folder (null = cancelled); set it (null = the default) — a backup is written there at once. */
        chooseBackupDir: () => Promise<string | null>;
        setBackupDir: (dir: string | null) => Promise<{ ok: boolean; path?: string; error?: string; dir: string; same_disk: boolean }>;
        query: (sql: string) => Promise<
          | { ok: true; result: { columns: string[]; rows: unknown[][]; rowCount: number;
                                  truncated: boolean; maskedColumns: string[] } }
          | { ok: false; error: string }>;
        testConnection: () => Promise<{ ok: boolean; status: number | null; ms: number; error?: string }>;
        logTail: (lines?: number) => Promise<{ path: string | null; text: string }>;
        /** A519: send the last 24 h of the log to support — a reference to read out, or why not (offline → save it). */
        sendLogs: () => Promise<{ ok: true; reference: string } | { ok: false; offline: boolean; message: string }>;
        /** A519: the same text saved where the technician chooses. */
        saveLog: () => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
      };
      /** 0.6.28: what went to the kitchen, and kitchen voids. */
      kitchen: {
        sent: (p: { order_number: string; lines: KitchenLinePayload[]; order_type?: string; table_number?: string }) =>
          Promise<{ recorded: number }>;
        void: (p: { order_number: string; lines: KitchenLinePayload[]; reason: string; note?: string; cooked?: boolean;
                    pin?: string; order_type?: string; table_number?: string }) =>
          Promise<{ ok: true; total: number; approvedBy: string | null; skipped: string[] }>;
        open: () => Promise<{ all: OpenKitchenOrder[]; shift: OpenKitchenOrder[] }>;
      };
      shift: {
        // A shift left open past ~18 hours. Null when there is none, or when
        // the open one is still plausibly today's.
        stale: () => Promise<null | {
          id: string; opened_at: string; hoursOpen: number;
          cashier_name: string; expectedCash: number | null; orders: number;   // A490: null without shifts.confirm
        }>;
        // Ends it WITHOUT a cash count. Records closed_unreconciled with a null
        // variance — never zero, which would claim a check that never happened.
        forceClose: (reason: string) => Promise<ZReport>;
        /** A401: the shift was closed on the web and the till closed it too. Returns an unsubscribe. */
        onClosedElsewhere: (cb: (e: { id: string; message: string }) => void) => () => void;
        /** A465: the branch server recorded a cash in / out or expense on this till's shift. Returns an unsubscribe. */
        onChangedElsewhere: (cb: (e: { id: string | null; kind: string | null }) => void) => () => void;
        current: (opts?: { includeForeign?: boolean }) => Promise<ZReport | null>;
        open: (opening_float: number, drawer_label?: string) => Promise<ZReport | null>;
        /** 0.6.37 (A388): a pay out needs a manager — signed in, or `pin` (a manager's). */
        float: (type: 'float_in' | 'float_out', amount: number, reason?: string, pin?: string, countAck?: boolean) => Promise<ZReport | null>;   // A594: countAck
        close: (closing_float: number, notes?: string, declared?: Record<string, number>) => Promise<ZReport>;
        /** A365: this till's shifts awaiting a manager's confirmation. */
        awaiting: () => Promise<AwaitingShift[]>;
        /** A365: a manager's blind recount of every payment method, approved with their own PIN. */
        confirm: (shiftId: string, pin: string | undefined, counts: Record<string, number>, reasons?: Record<string, string>) => Promise<Confirmation>;
        /** 0.6.27: may the confirm screen show the cashier's figures ('confirm_shows_cashier_figures')? */
        confirmView: (shiftId: string) => Promise<{ showCashier: boolean; declared: Record<string, number> | null; expected?: Record<string, number> | null; cash?: import('../../shared/shiftConfirm').CashBreakdown | null }>;   // A527: cash = the manager's four cash lines
        /** A433: another till's shift — confirmed on the cloud by the signed-in manager (or a manager's PIN). */
        remoteConfirmView: (shiftId: string) => Promise<{ showCashier: boolean; declared: Record<string, number> | null; expected?: Record<string, number> | null; cash?: import('../../shared/shiftConfirm').CashBreakdown | null }>;
        remoteConfirm: (shiftId: string, pin: string | undefined, counts: Record<string, number>, reasons?: Record<string, string>) => Promise<Confirmation>;
        /** 0.6.23: is the signed-in person a manager (confirms without a PIN)? */
        canConfirm: () => Promise<boolean>;
        /** A366: may the signed-in person close the open shift — its owner or a manager? */
        closeRights: () => Promise<{ allowed: boolean; ownerName: string | null }>;
        zreport: (shiftId: string) => Promise<ZReport>;
        /** 0.6.11: this till's shifts, newest first (previous shift reports). */
        history: () => Promise<ShiftSummary[]>;
      };
      manage: {
        listProducts:   () => Promise<any[]>;
        createProduct:  (payload: any) => Promise<any>;
        updateProduct:  (id: string, patch: any) => Promise<any>;
        listCategories: () => Promise<any[]>;
        createCategory: (payload: any) => Promise<any>;
        listStations:  () => Promise<PrintStation[]>;
        listPaymentMethods: () => Promise<{ id: string; name: string; code: string; is_active: boolean; sort_order: number }[]>;
        createPaymentMethod: (payload: { name: string; sort_order?: number }) => Promise<{ id: string; name: string; code: string; is_active: boolean; sort_order: number }>;
        updatePaymentMethod: (id: string, patch: { name?: string; is_active?: boolean; sort_order?: number }) => Promise<any>;
        deletePaymentMethod: (id: string) => Promise<{ success: boolean }>;
        seedDefaultStations: () => Promise<{ created: boolean; stations: number; routed: { packing: number; kitchen: number } }>;
        unassignedCategories: () => Promise<{ id: string; name: string }[]>;
        createStation: (payload: { name: string; kind?: StationKind; sort_order?: number }) => Promise<PrintStation>;
        updateStation: (id: string, patch: Partial<{ name: string; kind: StationKind; sort_order: number; active: boolean }>) => Promise<PrintStation>;
        deleteStation: (id: string) => Promise<any>;
        setStationCategories: (id: string, categoryIds: string[]) => Promise<StationRoutingResult>;
        // A414: wastage on the till (saved here first, sent later); A413: the expiry list.
        wastageItems: () => Promise<{ source: 'cloud' | 'saved' | 'till'; saved_at?: string; items: WasteItem[] }>;
        recordWastage: (payload: { reason: string; note?: string; items: Array<{ kind: 'product' | 'ingredient'; id: string; name: string; quantity: number }> }) =>
          Promise<{ client_id: string; state: 'saved' | 'pending' | 'refused'; ref?: string; value?: number; message?: string }>;
        wastageState: () => Promise<{ pending: WasteRecordingView[]; refused: Array<WasteRecordingView & { refused_at: string; message: string }> }>;
        dismissWastage: (clientId: string) => Promise<{ ok: true }>;
        // A545: credit sales a manager confirms or disputes (the cloud's list; the last one kept for offline).
        creditSales: () => Promise<{ online: boolean; saved_at: string | null; message?: string; rows: CreditSaleView[];
          refused: Array<{ order_id: string; decision: 'confirm' | 'dispute'; by_name: string | null; refused_at: string; message: string }> }>;
        decideCredit: (orderId: string, decision: 'confirm' | 'dispute', reason?: string) => Promise<{ state: 'saved' } | { state: 'pending'; message: string }>;
        creditAwaiting: () => Promise<{ count: number; notice: string; saved: boolean }>;
        dismissCredit: (orderId: string) => Promise<{ ok: true }>;
        expiringBatches: () => Promise<{ online: false; message: string } | { online: true; batches: ExpiringBatch[]; summary: { expired: number; soon: number } }>;
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
        /** A345: what this till has saved, shown read-only while the cloud is out of reach. `offline` null = the cloud is
         *  reachable (or refused for another reason) — nothing is returned then. */
        cachedMenu:     () => Promise<{ offline: OfflineManage | null; products: any[]; categories: any[]; combos: any[] }>;
        cachedStaff:    () => Promise<{ offline: OfflineManage | null; source: 'branch' | 'till' | null; staff: any[] }>;
        createStaff:    (payload: any) => Promise<any>;
        /** A448: set a staff member's PIN on this till — works here at once, wins on the cloud (unless another has it). */
        setStaffPin:    (id: string, pin: string) => Promise<{ ok: true }>;
        /** A448: changes made on this till that wait (for the cloud, or the owner's approval) or were refused. */
        changeStates:   () => Promise<Array<{ entity_id: string; entity: string; state: 'pending' | 'awaiting' | 'refused' | 'done' | 'rejected'; message: string | null; summary: string }>>;
        /** A520: clear the refused ones from the list (the cloud's value already stands on this till). */
        dismissRefusedChanges: () => Promise<{ ok: boolean; cleared?: number; error?: string }>;
        updateStaff:    (id: string, patch: any) => Promise<any>;
        getReceiptText: () => Promise<{ header: string; footer: string }>;
        setReceiptText: (header: string, footer: string) => Promise<any>;
        getContinuousOperation: () => Promise<{ enabled: boolean }>;
        setContinuousOperation: (enabled: boolean) => Promise<any>;
        /** 0.6.30: the owner's void/refund rules (void_window_minutes, offline_refund_methods, offline_reverse_web_sales). */
        setReversalRule: (key: string, value: unknown) => Promise<any>;
        /** 0.6.37 (A387): the payment methods a cashier's History shows ([] = every method). Manager (settings.manage). */
        /** A429: switch the branch's payment methods (catalogue codes). */
        setPaymentMethodsEnabled: (codes: string[]) => Promise<any>;
        /** A492: the branch's M-Pesa number — its own, the business-wide one an older set-up left, and whether this person may change it. */
        getMpesa: () => Promise<{ own: MpesaReceiveLite | null; inherited: MpesaReceiveLite | null; canEdit: boolean }>;
        setMpesa: (v: { kind?: 'buy_goods' | 'paybill'; number?: string; account?: string; clear?: boolean }) => Promise<any>;
        /** A445: Manager › Offers — the cloud's offers (each with `editable`), save (new or changed), delete. */
        offers: () => Promise<Array<import('../../shared/offers').Offer & { editable?: boolean; created_by_name?: string | null }>>;
        saveOffer: (offer: unknown) => Promise<any>;
        deleteOffer: (id: string) => Promise<any>;
        getCashierHistoryMethods: () => Promise<{ methods: string[] }>;
        setCashierHistoryMethods: (methods: string[]) => Promise<any>;
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
        /** Every till's sales at this branch, from the cloud (online only — throws offline). */
        branchOrders:    (range?: ReportRangeArg) => Promise<any[]>;
        /** A431 / A432: every till's sales and every shift at the branch (the cloud), else this till's — `source` says. */
        branchDay:       (range?: ReportRangeArg) => Promise<BranchDay>;
        /** A433: every shift at the branch (the cloud, a manager's sign-in) — throws offline. */
        branchShifts:    () => Promise<BranchShiftListRow[]>;
        /** A433: another till's shift as a Z-report, from the cloud. */
        remoteZReport:   (shiftId: string) => Promise<ZReport>;
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
        /** A341: add an expense type on the cloud (expenses.manage). */
        addCategory: (name: string) => Promise<{ id: string; name: string }>;
        create: (p: { description: string; amount: number; expense_category_id?: string; paid_by?: string;
                  /** 0.6.27: how it was paid ('cash' leaves the drawer) and the type's name. */
                  payment_method?: string; category_name?: string;
                  /** A466: the branch server's manager — recorded outside any drawer even with a shift open here. */
                  no_drawer?: boolean;
                  /** 0.6.37 (A388): a manager's PIN — every expense needs a manager (none when one is signed in). */
                  pin?: string }) => Promise<{ id: string; approvedBy?: string | null }>;
        list: () => Promise<any[]>;
        /** 0.6.11: expenses paid out on this till in a date range. */
        range: (range?: ReportRangeArg) => Promise<{ rows: ExpenseRow[]; total: number; label: string }>;
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
                                         'That address is a branch server, not the main server. Branch servers relay sales between points of sale and cannot sign anyone in.'],
  [/enrol|activate/i,                    'The server did not accept that enrolment. Check the business ID, the enrolment code, and the server address.'],
  [/invalid or expired token|jwt expired|unauthor/i,
                                         'This POS was signed out. Ask a manager to sign in again.'],
  [/not signed in/i,                     'This POS is not signed in. Ask a manager to sign in.'],
  [/failed to fetch|network ?error|fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ENETUNREACH/i,
                                         'Cannot reach the server. Check the internet connection — sales are still saved on this POS.'],
  [/timeout|timed out/i,                 'The server took too long to answer. Please try again.'],
  [/UNIQUE constraint failed/i,          'That record already exists.'],
  [/FOREIGN KEY constraint failed/i,     'Something it depends on is missing. Please refresh and try again.'],
  [/SQLITE_BUSY|database is locked/i,    'The POS is busy saving. Please try again in a moment.'],
  [/no such (table|column)/i,            'This POS needs updating. Please contact support.'],
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

/** A427: a branch server heard on the shop network. */
export interface FoundServer { url: string; ip: string; port: number; business: string | null; server: string | null }
/** A427: where a join request stands. 'joined' carries what the setup screen fills in. */
export type JoinStatus =
  | { status: 'none' | 'pending' | 'denied' | 'expired' }
  | { status: 'joined'; business: any; branchId: string; branchName: string | null; cloudUrl: string;
      nodeIp: string; nodePort: number; nodeSecret: string };
