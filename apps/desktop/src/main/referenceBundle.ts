// referenceBundle.ts — the branch node's DOWNSTREAM reference snapshot (A24).
// ─────────────────────────────────────────────────────────────────────────────
// The node already holds the whole branch's reference data in its own local
// tables — its ordinary cloud sync (syncEngine.pullCatalogue) writes categories,
// products, variants, modifiers, stock, tables, pumps, stations and payment
// methods, and caches the config fields on device_config. It just never served
// any of it. A peer therefore reads reference data straight from the CLOUD and
// goes stale the moment it loses internet (register A24): a price edit reaches
// the node and never the peers, and two tills at one branch can sell the same
// item at two prices.
//
// This module lets the node serve that snapshot to its peers over the LAN, in
// the EXACT shapes pullCatalogue already consumes from the cloud, so the peer
// (batch -b) can feed the bundle straight into the same write transaction with
// no change to the write path.
//
// SCOPE (deliberate): non-credential reference ONLY. The staff roster (A20)
// rides this same channel in a later change, behind the owner's trust-domain
// decision (PHASE5 §10.1) — proving the channel on harmless data first, per the
// register's own reasoning (a bad reference snapshot prints a wrong ticket; a
// bad roster snapshot signs in someone who should not be). business_settings /
// kitchen-exclusion distribution is also held: business_settings has no
// branch_id yet (A24 step 4), so distributing it would hand down an ambiguous
// truth. Both are named as the next slices, not silently dropped.
//
// The reshape logic is split into a PURE function (mapReferenceBundle) so it can
// be mutation-tested off a plain row set without SQLite or Electron — the tri-
// state products.is_kitchen and the users->roles reshape are exactly the kind of
// mapping that breaks silently, so they get a test that fails when they regress.
import { parsePosFeatures } from './posFeatures';
import { rulesFromWire, type ReversalRules } from '@zaptill/core/reversalRules';
import { cleanShowDays } from '@zaptill/core/productDays';
import { supportWire } from '@zaptill/core/support';   // 0.6.35 (A384)
import { cleanHistoryMethods } from '@zaptill/core/cashierHistory';   // 0.6.37 (A387)
import { parseStockCountFreeze, type StockCountFreeze } from '@zaptill/core/stockCountFreeze';   // A394

/** A450: the receipt's "Buy Goods: 123456" line. A number is what makes it print; the label defaults to Buy Goods. */
export interface ReceiptPay { label: string; number: string }
export function cleanReceiptPay(label: unknown, number: unknown): ReceiptPay | null {
  const n = typeof number === 'string' ? number.trim().slice(0, 40) : '';
  if (!n) return null;
  const l = typeof label === 'string' ? label.trim().slice(0, 30) : '';
  return { label: l || 'Buy Goods', number: n };
}
/** A381 / A450: the business's branding as a pull carries it. */
export interface PulledBranding { accentHex: string | null; logoPng: string | null; logoReceipt?: string | null; receiptLogoEnabled?: boolean | null }

// ── Cloud-shaped output ──────────────────────────────────────────────────────
// Field names and value types match what pullCatalogue destructures, NOT the
// local column names. The two differ (local stores INTEGER 0/1 and role_name;
// the cloud sends booleans and roles:{name}); reproducing the cloud shape is the
// whole point, so the consumer stays identical online and node-fed.
export interface ReferenceBundle {
  // The subset pullCatalogue reads from `await /api/pos/init .json()`.
  posInit: {
    products: any[];
    categories: any[];
    /** A537: the business's menus (Food, Soft drinks …) as the cloud sent them. Absent from an older node. */
    menus?: any[];
    branchId: string | null;
    vatRate: number | null;
    ctlRate: number | null;
    maxDiscountPct: number | null;
    businessType: string | null;
    comboItems: Record<string, any[]>;
    receiptHeader: string | null;
    receiptFooter: string | null;
    kitchenExclusions: string[] | null;
    paymentMethods: Array<{ code: string; name: string }>;
    /** A445: the branch's offers (as the cloud sent them). Absent from an older node. */
    offers?: any[];
    continuousOperation: boolean | null;
    /** 0.6.34: when the business day ends (minutes after midnight); null = the node has not been told. */
    businessDayCutoff?: number | null;
    /** 0.6.35: the shop's own tech ({name, phone}, or null = none); undefined = the node has not been told. */
    support?: { name: string | null; phone: string | null } | null;
    /** 0.6.37: the payment methods a cashier's History shows ([] = every); undefined = the node has not been told. */
    cashierHistoryMethods?: string[];
    /** A394: the items a stock count freezes ({ref, productIds}; null = none); undefined = the node has not been told. */
    stockCount?: StockCountFreeze | null;
    /** A416: may a cashier see their sales at close? undefined = the node has not been told. */
    cashierSeesShiftSales?: boolean;
    /** A418: a cashier's History total. undefined = the node has not been told. */
    cashierHistoryTotals?: boolean;
    /** A429: the payment methods the branch takes. undefined = the node has not been told. */
    paymentMethodsEnabled?: string[];
    /** A346: the node's copy of the cloud's answer — does the business have the web POS? null = not known. */
    webPosEnabled?: boolean | null;
    /** A367: the owner's quick picks for order notes; null = the node has not been told. */
    noteQuickPicks?: string[] | null;
    /** A577: the scale label layout (shared/scaleBarcode.ts); null = the node has not been told. */
    scaleBarcodes?: unknown;
    /** 0.6.27: the per-client POS switches; null = the node has not been told. */
    posFeatures?: Record<string, boolean> | null;
    /** 0.6.30: the owner's void window and offline void/refund rules; null = the node has not been told. */
    reversalRules?: ReversalRules | null;
    /** A450: the business's name and currency as the server holds them (a rename on the web reaches its tills). */
    businessName?: string;
    currency?: string;
    /** A450: the receipt's Buy Goods / Paybill line ('' = none). Absent = the node has not been told. */
    receiptPayLabel?: string;
    receiptPayNumber?: string;
    /** A381: the business's branding (logo, accent) as the server holds it — a logo changed with no internet reaches
     *  every till of the branch. Absent = none on the server. */
    branding?: PulledBranding;
    /** A544: the effective action theme as the server holds it (null = themes off) and its branch's override of the
     *  theme, brand colour and receipt footer (null = none). Absent = an older server (the peer keeps its own). */
    themeId?: string | null;
    branchBranding?: unknown;
  };
  // The pieces pullCatalogue fetches separately (per-product loops + branch GETs).
  // Served flat here so a peer makes ONE node call instead of the cloud's 7 + N.
  variantGroups: any[];
  variantOptions: any[];
  modifierGroups: any[];
  modifierOptions: any[];
  stockLevels: any[];
  users: any[];
  tables: any[];
  pumps: any[];
  stations: any[];
  source: 'node';
}

// ── Raw input (what the node reads out of its local tables) ──────────────────
export interface ReferenceRows {
  products: any[];
  categories: any[];
  menus?: any[];            // A537: menus rows (id, name, sort_order, active, color, icon)
  comboItems: any[];        // combo_items rows
  paymentMethods: any[];    // payment_methods rows (code, name, sort_order)
  offers?: any[];           // A445: offers rows (id, data JSON)
  printStations: any[];     // print_stations rows
  categoryStations: any[];  // category_stations rows (category_id, station_id)
  variantGroups: any[];
  variantOptions: any[];
  modifierGroups: any[];
  modifierOptions: any[];
  stockLevels: any[];
  users: any[];             // local users rows (id, name, role_name, status)
  tables: any[];
  pumps: any[];
  config: {
    branchId: string | null;
    vatRate: number | null;
    ctlRate: number | null;
    maxDiscountPct: number | null;
    businessType: string | null;
    receiptHeader: string | null;
    receiptFooter: string | null;
    kitchenExclusions: string[] | null;
    continuousOperation: boolean | null;
    businessDayCutoff?: number | null; // 0.6.34
    support?: { name: string | null; phone: string | null } | null; // 0.6.35
    cashierHistoryMethods?: string[]; // 0.6.37
    stockCount?: StockCountFreeze | null; // A394
    cashierSeesShiftSales?: boolean;      // A416
    cashierHistoryTotals?: boolean;       // A418
    paymentMethodsEnabled?: string[];     // A429
    webPosEnabled?: boolean | null;   // A346
    noteQuickPicks?: string[] | null; // A367
    scaleBarcodes?: unknown;          // A577
    posFeatures?: Record<string, boolean> | null; // 0.6.27
    reversalRules?: ReversalRules | null;         // 0.6.30
    businessName?: string | null;                 // A450
    currency?: string | null;                     // A450
    receiptPay?: ReceiptPay | null;               // A450: undefined = the node has not been told
    branding?: PulledBranding | null;             // A381
    themeId?: string | null;                      // A544: undefined = the server has no branding row
    branchBranding?: unknown;                     // A544: undefined = an older local DB
  };
}

// SQLite has no boolean: an INTEGER column reads back as 0 | 1 (| null). The
// writer coerces `truthy ? 1 : 0`, so 0/1 survive — EXCEPT products.is_kitchen,
// which the writer treats as a tri-state and only stores when it is a real
// boolean (`typeof x === 'boolean'`). Read 0/1 back as numbers and the flag
// silently becomes null on every product. So: emit booleans, and keep null null.
const asBool = (v: any): boolean => v === 1 || v === true || v === '1';
const asTriBool = (v: any): boolean | null =>
  v === null || v === undefined ? null : asBool(v);

/**
 * PURE reshape: local rows -> the cloud-shaped ReferenceBundle. No DB, no I/O,
 * so it is unit-testable and mutation-checkable on a plain Node runtime. Every
 * shape decision that could silently corrupt the peer's catalogue lives here.
 */
export function mapReferenceBundle(rows: ReferenceRows): ReferenceBundle {
  // Stations: local print_stations rows + the category_stations link table ->
  // the cloud shape { ...station, category_ids: [...] } the writer expects.
  const stationCats = new Map<string, string[]>();
  for (const link of rows.categoryStations) {
    const arr = stationCats.get(link.station_id) ?? [];
    arr.push(link.category_id);
    stationCats.set(link.station_id, arr);
  }
  const stations = rows.printStations.map(st => ({
    id: st.id,
    name: st.name,
    kind: st.kind ?? 'kitchen',
    sort_order: Number(st.sort_order) || 0,
    active: asBool(st.active),
    category_ids: stationCats.get(st.id) ?? [],
  }));

  // Combos: flat combo_items rows -> Record<combo_id, component[]>, the exact
  // structure Object.entries(comboItems) walks in the writer.
  const comboItems: Record<string, any[]> = {};
  for (const it of rows.comboItems) {
    (comboItems[it.combo_id] ??= []).push({
      product_id: it.product_id,
      name: it.name,
      quantity: Number(it.quantity) || 1,
      is_kitchen: asBool(it.is_kitchen),
    });
  }

  const products = rows.products.map(p => ({
    id: p.id,
    category_id: p.category_id,
    name: p.name,
    description: p.description ?? null,
    base_price: p.base_price,
    branch_price: p.branch_price ?? null,
    image_url: p.image_url ?? null,
    has_variants: asBool(p.has_variants),
    has_modifiers: asBool(p.has_modifiers),
    track_stock: asBool(p.track_stock),
    status: p.status ?? 'active',
    barcode: p.barcode ?? null,
    plu: p.plu ?? null,
    sold_by: p.sold_by ?? null,         // A577: relayed so a peer sells weighed items by weight
    unit_label: p.unit_label ?? null,   // A577
    is_fuel: asBool(p.is_fuel),
    is_kitchen: asTriBool(p.is_kitchen),   // tri-state — see asTriBool
    show_days: cleanShowDays(p.show_days) ?? null,   // 0.6.31: relayed so a peer shows the same products each day
  }));

  const categories = rows.categories.map(c => ({
    id: c.id,
    name: c.name,
    color: c.color ?? null,
    icon: c.icon ?? null,
    sort_order: Number(c.sort_order) || 0,
    status: c.status ?? 'active',
    is_kitchen: asBool(c.is_kitchen),
    menu_id: c.menu_id ?? null,   // A537: relayed so a peer shows the same menus
  }));

  // Users: local {id,name,role_name,status} -> cloud {id,name,roles:{name},status}.
  // The writer reads `u.roles?.name`, so a flat role_name would drop every role.
  const users = rows.users.map(u => ({
    id: u.id,
    name: u.name ?? 'Staff',
    roles: u.role_name ? { name: u.role_name } : null,
    status: u.status ?? 'active',
  }));

  const paymentMethods = rows.paymentMethods.map(m => ({ code: m.code, name: m.name }));

  return {
    posInit: {
      products,
      categories,
      // A537: relayed so a peer's category panel shows the same menus.
      // A578: and each menu's hours (the JSON text → the object; null = always), so a peer opens and closes them too.
      menus: (rows.menus ?? []).map((m: any) => ({ id: m.id, name: m.name, sort_order: Number(m.sort_order) || 0, active: true, color: m.color ?? null, icon: m.icon ?? null,
        availability: (() => { try { return m.availability ? JSON.parse(m.availability) : null; } catch { return null; } })() })),
      branchId: rows.config.branchId,
      vatRate: rows.config.vatRate,
      ctlRate: rows.config.ctlRate,
      maxDiscountPct: rows.config.maxDiscountPct,
      businessType: rows.config.businessType,
      comboItems,
      receiptHeader: rows.config.receiptHeader,
      receiptFooter: rows.config.receiptFooter,
      kitchenExclusions: rows.config.kitchenExclusions,
      paymentMethods,
      // A445: relayed so a peer applies the branch's offers (each row's data is the offer as the cloud sent it).
      offers: (rows.offers ?? []).flatMap((r: any) => { try { return [JSON.parse(r.data)]; } catch { return []; } }),
      continuousOperation: rows.config.continuousOperation,
      businessDayCutoff: rows.config.businessDayCutoff ?? null,   // 0.6.34: relayed so a peer's day ends with the node's
      support: rows.config.support,                       // 0.6.35: relayed so a peer's Help shows the shop's tech
      cashierHistoryMethods: rows.config.cashierHistoryMethods,   // 0.6.37: relayed so a peer's History follows the manager
      stockCount: rows.config.stockCount,   // A394: relayed so a peer stops selling what the count freezes
      cashierSeesShiftSales: rows.config.cashierSeesShiftSales,   // A416: relayed so a peer's cashiers follow the switch
      cashierHistoryTotals: rows.config.cashierHistoryTotals,     // A418: relayed likewise
      paymentMethodsEnabled: rows.config.paymentMethodsEnabled,   // A429: relayed so a peer shows the branch's methods
      webPosEnabled: rows.config.webPosEnabled ?? null,   // A346: relayed so a peer shows Stock only when the node does
      noteQuickPicks: rows.config.noteQuickPicks ?? null, // A367: relayed so a peer offers the same quick picks
      scaleBarcodes: rows.config.scaleBarcodes ?? null,   // A577: relayed so a peer reads the same scale labels
      posFeatures: rows.config.posFeatures ?? null,       // 0.6.27: relayed so a peer follows the same switches
      reversalRules: rows.config.reversalRules ?? null,   // 0.6.30: relayed so a peer applies the owner's rules offline
      // A450: the business's name and currency, and the receipt's Buy Goods / Paybill line — relayed so a peer prints them.
      ...(rows.config.businessName ? { businessName: rows.config.businessName } : {}),
      ...(rows.config.currency ? { currency: rows.config.currency } : {}),
      ...(rows.config.receiptPay === undefined ? {}
        : { receiptPayLabel: rows.config.receiptPay?.label ?? '', receiptPayNumber: rows.config.receiptPay?.number ?? '' }),
      ...(rows.config.branding ? { branding: rows.config.branding } : {}),   // A381
      // A544: relayed so a peer wears its branch's look and prints its branch's footer, as the server does.
      ...(rows.config.themeId === undefined ? {} : { themeId: rows.config.themeId }),
      ...(rows.config.branchBranding === undefined ? {} : { branchBranding: rows.config.branchBranding }),
    },
    variantGroups: rows.variantGroups,
    variantOptions: rows.variantOptions,
    modifierGroups: rows.modifierGroups,
    modifierOptions: rows.modifierOptions,
    stockLevels: rows.stockLevels,
    users,
    tables: rows.tables,
    pumps: rows.pumps,
    stations,
    source: 'node',
  };
}

// Minimal shape of the better-sqlite3 handle this module needs — declared
// locally so the pure test never has to load the native module to type-check.
interface RefDb { prepare(sql: string): { all(...a: any[]): any[] }; }

/** A450 + A381: what the server itself holds of the business — its name and currency, the receipt's pay line, its
 *  branding. Each read on its own: a missing table (an older local DB) leaves that field out, never the bundle. */
function nodeIdentity(all: (sql: string) => any[]): Pick<ReferenceRows['config'], 'businessName' | 'currency' | 'receiptPay' | 'branding' | 'themeId' | 'branchBranding'> {
  const one = (sql: string): any => { try { return all(sql)[0]; } catch { return undefined; } };
  const sess = one(`SELECT business_name, currency FROM session WHERE id = 1`);
  const pay = one(`SELECT value FROM maintenance_state WHERE key = 'receipt_pay'`);
  const b = one(`SELECT accent_hex, logo_png, logo_receipt, receipt_logo_enabled, theme_id FROM branding LIMIT 1`);
  // A544: the server's own branch's override (the server and its tills are one branch). A database before 74 → not said.
  let branchBranding: unknown;
  try {
    const bb = all(`SELECT bb.branch_id, bb.theme_id, bb.accent_hex, bb.receipt_footer FROM branch_branding bb
                      JOIN device_config dc ON dc.id = 1 AND dc.branch_id = bb.branch_id LIMIT 1`)[0];
    branchBranding = bb ? { branchId: bb.branch_id, themeId: bb.theme_id ?? null, accentHex: bb.accent_hex ?? null, receiptFooter: bb.receipt_footer ?? null } : null;
  } catch { branchBranding = undefined; }
  let receiptPay: ReceiptPay | null | undefined;
  if (pay?.value) { try { const v = JSON.parse(pay.value); receiptPay = v ? cleanReceiptPay(v.label, v.number) : null; } catch { receiptPay = undefined; } }
  return {
    businessName: typeof sess?.business_name === 'string' && sess.business_name.trim() ? sess.business_name : null,
    currency: typeof sess?.currency === 'string' && sess.currency.trim() ? sess.currency : null,
    receiptPay,
    branding: b ? { accentHex: b.accent_hex ?? null, logoPng: b.logo_png ?? null, logoReceipt: b.logo_receipt ?? null,
      receiptLogoEnabled: b.receipt_logo_enabled === 1 || b.receipt_logo_enabled === true } : null,
    themeId: b ? (typeof b.theme_id === 'string' && b.theme_id ? b.theme_id : null) : undefined,   // A544
    branchBranding,                                                                               // A544
  };
}

/**
 * Read the node's local reference tables and shape them for a peer. Thin DB
 * wrapper around mapReferenceBundle; the reshape (and its test) is the pure part.
 *
 * cfg is the node's device_config — the config fields the cloud returns inside
 * /api/pos/init are cached there on every pull, so the node serves its own
 * last-known-good copy.
 */
export function buildReferenceBundle(db: RefDb, cfg: any): ReferenceBundle {
  const all = (sql: string) => db.prepare(sql).all();

  let kitchenExclusions: string[] | null = null;
  if (typeof cfg?.kitchen_exclusions === 'string' && cfg.kitchen_exclusions) {
    try { const p = JSON.parse(cfg.kitchen_exclusions); if (Array.isArray(p)) kitchenExclusions = p; }
    catch { kitchenExclusions = null; }
  }

  const rows: ReferenceRows = {
    products: all(`SELECT id, category_id, name, description, base_price, branch_price, image_url,
                          has_variants, has_modifiers, track_stock, status, barcode, plu, is_fuel, is_kitchen, show_days,
                          sold_by, unit_label
                   FROM products`),
    categories: all(`SELECT id, name, color, icon, sort_order, status, is_kitchen, menu_id FROM categories`),
    menus: all(`SELECT id, name, sort_order, active, color, icon, availability FROM menus WHERE active = 1 ORDER BY sort_order, name`),   // A537; A578 hours
    comboItems: all(`SELECT combo_id, product_id, name, quantity, sort_order, is_kitchen FROM combo_items ORDER BY combo_id, sort_order`),
    paymentMethods: all(`SELECT code, name, sort_order FROM payment_methods ORDER BY sort_order`),
    offers: all(`SELECT id, data FROM offers`),   // A445
    printStations: all(`SELECT id, name, kind, sort_order, active FROM print_stations`),
    categoryStations: all(`SELECT category_id, station_id FROM category_stations`),
    variantGroups: all(`SELECT id, product_id, name, required, sort_order FROM variant_groups`),
    variantOptions: all(`SELECT id, variant_group_id, name, price_adjustment, sort_order FROM variant_options`),
    modifierGroups: all(`SELECT id, product_id, name, min_select, max_select, sort_order FROM modifier_groups`),
    modifierOptions: all(`SELECT id, modifier_group_id, name, price, sort_order FROM modifier_options`),
    stockLevels: all(`SELECT product_id, branch_id, quantity, low_stock_threshold FROM stock_levels`),
    users: all(`SELECT id, name, role_name, status FROM users`),
    tables: all(`SELECT id, name, capacity, sort_order, slot_type, pos_x, pos_y, zone, shape FROM tables`),
    pumps: all(`SELECT id, branch_id, fuel_product_id, name, status, sort_order FROM pumps`),
    config: {
      branchId: cfg?.branch_id ?? null,
      vatRate: cfg?.vat_rate ?? null,
      ctlRate: cfg?.ctl_rate ?? null,
      maxDiscountPct: cfg?.max_discount_pct ?? null,
      businessType: cfg?.business_type ?? null,
      receiptHeader: cfg?.receipt_header ?? null,
      receiptFooter: cfg?.receipt_footer ?? null,
      kitchenExclusions,
      continuousOperation:
        typeof cfg?.continuous_operation === 'boolean' ? cfg.continuous_operation
        : cfg?.continuous_operation == null ? null
        : asBool(cfg.continuous_operation),
      // 0.6.34: the node's cut-off (0 = midnight — the node defaults to midnight until told, as a peer does).
      businessDayCutoff: typeof cfg?.business_day_cutoff === 'number' ? cfg.business_day_cutoff : null,
      // 0.6.37: undefined until the node itself has been told (a peer then keeps its own value).
      cashierHistoryMethods: typeof cfg?.cashier_history_methods === 'string'
        ? (cleanHistoryMethods(cfg.cashier_history_methods) ?? undefined) : undefined,
      // A394: undefined until the node itself has been told (a peer then keeps its own value).
      stockCount: typeof cfg?.stock_count_freeze === 'string' ? parseStockCountFreeze(cfg.stock_count_freeze) : undefined,
      // A416: undefined until the node itself has been told (a peer then keeps its own value).
      cashierSeesShiftSales: cfg?.cashier_sees_shift_sales == null ? undefined : cfg.cashier_sees_shift_sales === 1,
      cashierHistoryTotals: cfg?.cashier_history_totals == null ? undefined : cfg.cashier_history_totals === 1,   // A418
      // A429: undefined until the node itself has been told (a peer then keeps its own value).
      paymentMethodsEnabled: (() => {
        if (typeof cfg?.payment_methods_enabled !== 'string') return undefined;
        try { const v = JSON.parse(cfg.payment_methods_enabled); return Array.isArray(v) ? v.map(String) : undefined; } catch { return undefined; }
      })(),
      // 0.6.35: undefined until the node itself has heard from the cloud (a peer then keeps its own value).
      support: (() => {
        if (typeof cfg?.support_contact !== 'string') return undefined;
        try { return supportWire(JSON.parse(cfg.support_contact)); } catch { return undefined; }
      })(),
      webPosEnabled: typeof cfg?.web_pos_enabled === 'boolean' ? cfg.web_pos_enabled : null,
      noteQuickPicks: (() => {   // A367
        if (typeof cfg?.order_note_picks !== 'string') return null;
        try { const p = JSON.parse(cfg.order_note_picks); return Array.isArray(p) ? p.map(String) : null; } catch { return null; }
      })(),
      // A577: null until the node itself has heard from the cloud (a peer then keeps its own value).
      // (read from the table: getDeviceConfig's shape does not carry it)
      scaleBarcodes: (() => {
        try {
          const raw = all(`SELECT scale_barcodes FROM device_config WHERE id = 1`)[0]?.scale_barcodes;
          return typeof raw === 'string' && raw ? JSON.parse(raw) : null;
        } catch { return null; }   // a database before local schema 77
      })(),
      // 0.6.27: null until the node itself has heard from the cloud (a peer then keeps its own value).
      posFeatures: typeof cfg?.pos_features === 'string' ? parsePosFeatures(cfg.pos_features) : null,
      // 0.6.30: likewise null until the node has heard the owner's rules from the cloud.
      reversalRules: (() => {
        if (typeof cfg?.reversal_rules !== 'string') return null;
        try { return rulesFromWire(JSON.parse(cfg.reversal_rules)); } catch { return null; }
      })(),
      ...nodeIdentity(all),   // A450 + A381
    },
  };

  return mapReferenceBundle(rows);
}

// ── Peer side (batch -b): unpack a node bundle into pullCatalogue's shape ─────
// The peer feeds this straight into the SAME write transaction it uses for the
// cloud, so the fields mirror what pullCatalogue holds after its cloud fetches:
// `tablesFetched`/`pumpsFetched` and a nullable `stations`/`paymentMethods` are
// the DON'T-WIPE guards — a failed/absent fetch must never clear a good local
// table map, pump list, routing or tender set. A node on an OLD build that
// returns a partial bundle (a missing array) must read as "didn't fetch it",
// not "fetched an empty one", or the peer wipes data the node simply didn't send.
export interface AcquiredReference {
  products: any[];
  categories: any[];
  menus: any[] | null;       // A537: null = the source sent none (an older node) — leave the till's menus
  comboItems: Record<string, any[]>;
  paymentMethods: Array<{ code: string; name: string }> | null; // null = leave tenders
  offers: any[] | null;      // A445: null = the source sent none (an older node) — leave the till's offers
  stations: any[] | null;    // null = don't wipe routing
  variantGroups: any[];
  variantOptions: any[];
  modifierGroups: any[];
  modifierOptions: any[];
  stockLevels: any[];
  users: any[];
  diningTables: any[];
  tablesFetched: boolean;     // false = don't wipe the table map
  pumps: any[];
  pumpsFetched: boolean;      // false = don't wipe the pump list
  config: {
    branchId: string | null;
    vatRate: number | null;
    ctlRate: number | null;
    maxDiscountPct: number | null;
    businessType: string | null;
    receiptHeader: string | null;
    receiptFooter: string | null;
    kitchenExclusions: string[] | null;
    continuousOperation: boolean | null;
    /** 0.6.34: when the business day ends (minutes after midnight). undefined = not said (older cloud / node) → keep. */
    businessDayCutoff?: number;
    /** 0.6.35: the shop's own tech. undefined = not said (older cloud / node) → keep; null = none (SwiftPOS support). */
    support?: { name: string | null; phone: string | null } | null;
    /** 0.6.37: the payment methods a cashier's History shows. undefined = not said → keep. */
    cashierHistoryMethods?: string[];
    /** A394: the items a stock count freezes. undefined = not said (older cloud / node) → keep; null = none. */
    stockCount?: unknown;
    /** A416: a cashier sees their sales at close. undefined = not said (older cloud / node) → keep. */
    cashierSeesShiftSales?: boolean;
    /** A418: a cashier's History total. undefined = not said → keep. */
    cashierHistoryTotals?: boolean;
    /** A429: the payment methods the branch takes. undefined = not said → keep. */
    paymentMethodsEnabled?: string[];
    branding?: PulledBranding | null;
    /** A450: the business's name and currency (a rename on the web). undefined = not said → keep. */
    businessName?: string;
    currency?: string;
    /** A450: the receipt's Buy Goods / Paybill line. undefined = not said → keep; null = none. */
    receiptPay?: ReceiptPay | null;
    /** A325: the effective action theme. undefined = not sent (an older cloud, or a branch server before A544, which
     *  relayed no theme) → the till keeps its local value. A544: a branch server relays its own. */
    themeId?: string | null;
    /** A544: the branch's override of the theme, brand colour and receipt footer. undefined = not said → keep; null = none. */
    branchBranding?: unknown;
    /** A346: does the business have the web POS? undefined = not said (older cloud / older node) → keep the local value. */
    webPosEnabled?: boolean;
    /** A367: the owner's quick picks for order notes. undefined = not said (older cloud / older node) → keep. */
    noteQuickPicks?: string[];
    /** A577: the scale label layout. undefined = not said (older cloud / older node) → keep. */
    scaleBarcodes?: unknown;
    /** 0.6.27: the per-client POS switches. undefined = not said (older cloud / older node) → keep. */
    posFeatures?: Record<string, boolean>;
    /** 0.6.30: the owner's void/refund rules. undefined = not said (older cloud / older node) → keep. */
    reversalRules?: ReversalRules;
  };
}

export const numOrNull = (v: any): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * PURE: a /node/reference bundle -> the AcquiredReference pullCatalogue writes.
 * No I/O, so the don't-wipe guards are unit-testable. Tolerant of a partial or
 * old-build bundle: a missing array reads as "not fetched" (guard stays false /
 * value stays null), never as an empty fetch that would clear good local data.
 */
export function unpackNodeBundle(bundle: any): AcquiredReference {
  const pi = bundle?.posInit ?? {};
  const arr = (v: any): any[] => (Array.isArray(v) ? v : []);
  return {
    products: arr(pi.products),
    categories: arr(pi.categories),
    menus: Array.isArray(pi.menus) ? pi.menus : null,   // A537
    comboItems: pi.comboItems && typeof pi.comboItems === 'object' && !Array.isArray(pi.comboItems) ? pi.comboItems : {},
    paymentMethods: Array.isArray(pi.paymentMethods) ? pi.paymentMethods : null,
    offers: Array.isArray(pi.offers) ? pi.offers : null,   // A445
    stations: Array.isArray(bundle?.stations) ? bundle.stations : null,
    variantGroups: arr(bundle?.variantGroups),
    variantOptions: arr(bundle?.variantOptions),
    modifierGroups: arr(bundle?.modifierGroups),
    modifierOptions: arr(bundle?.modifierOptions),
    stockLevels: arr(bundle?.stockLevels),
    users: arr(bundle?.users),
    diningTables: arr(bundle?.tables),
    tablesFetched: Array.isArray(bundle?.tables),
    pumps: arr(bundle?.pumps),
    pumpsFetched: Array.isArray(bundle?.pumps),
    config: {
      branchId: pi.branchId ?? null,
      vatRate: numOrNull(pi.vatRate),
      ctlRate: numOrNull(pi.ctlRate),
      maxDiscountPct: numOrNull(pi.maxDiscountPct),
      businessType: typeof pi.businessType === 'string' && pi.businessType ? pi.businessType : null,
      receiptHeader: typeof pi.receiptHeader === 'string' ? pi.receiptHeader : null,
      receiptFooter: typeof pi.receiptFooter === 'string' ? pi.receiptFooter : null,
      kitchenExclusions: Array.isArray(pi.kitchenExclusions) ? pi.kitchenExclusions : null,
      continuousOperation: typeof pi.continuousOperation === 'boolean' ? pi.continuousOperation : null,
      businessDayCutoff: typeof pi.businessDayCutoff === 'number' ? pi.businessDayCutoff : undefined,   // 0.6.34
      support: pi && typeof pi === 'object' && 'support' in pi ? supportWire(pi.support) : undefined,   // 0.6.35
      cashierHistoryMethods: Array.isArray(pi.cashierHistoryMethods) ? (cleanHistoryMethods(pi.cashierHistoryMethods) ?? undefined) : undefined,   // 0.6.37
      stockCount: pi && typeof pi === 'object' && 'stockCount' in pi ? (pi.stockCount ?? null) : undefined,   // A394
      cashierSeesShiftSales: typeof pi.cashierSeesShiftSales === 'boolean' ? pi.cashierSeesShiftSales : undefined,   // A416
      cashierHistoryTotals: typeof pi.cashierHistoryTotals === 'boolean' ? pi.cashierHistoryTotals : undefined,   // A418
      paymentMethodsEnabled: Array.isArray(pi.paymentMethodsEnabled) ? pi.paymentMethodsEnabled.map(String) : undefined,   // A429
      // A346: only a real boolean counts; a node that has not heard from the cloud (null) or an older node says nothing.
      webPosEnabled: typeof pi.webPosEnabled === 'boolean' ? pi.webPosEnabled : undefined,
      noteQuickPicks: Array.isArray(pi.noteQuickPicks) ? pi.noteQuickPicks.map(String) : undefined,   // A367
      scaleBarcodes: pi.scaleBarcodes && typeof pi.scaleBarcodes === 'object' ? pi.scaleBarcodes : undefined,   // A577
      posFeatures: pi.posFeatures && typeof pi.posFeatures === 'object' ? parsePosFeatures(pi.posFeatures) : undefined,   // 0.6.27
      reversalRules: pi.reversalRules && typeof pi.reversalRules === 'object' ? rulesFromWire(pi.reversalRules) : undefined,   // 0.6.30
      ...identityFromWire(pi),   // A450 + A381
      // A544: the server's theme and its branch's override (an older server sends neither → the peer keeps its own).
      themeId: pi && typeof pi === 'object' && 'themeId' in pi ? (typeof pi.themeId === 'string' ? pi.themeId : null) : undefined,
      branchBranding: pi && typeof pi === 'object' && 'branchBranding' in pi ? (pi.branchBranding ?? null) : undefined,
    },
  };
}

/** A450 + A381: the business's name, currency, receipt pay line and branding from a pull (the cloud's /pos/init or a
 *  branch server's bundle — the same field names). Each undefined when not said, so the till keeps what it has. */
export function identityFromWire(pi: any): { businessName?: string; currency?: string; receiptPay?: ReceiptPay | null; branding?: PulledBranding } {
  const out: { businessName?: string; currency?: string; receiptPay?: ReceiptPay | null; branding?: PulledBranding } = {};
  if (typeof pi?.businessName === 'string' && pi.businessName.trim()) out.businessName = pi.businessName.trim();
  if (typeof pi?.currency === 'string' && pi.currency.trim()) out.currency = pi.currency.trim();
  if (pi && typeof pi === 'object' && 'receiptPayNumber' in pi) out.receiptPay = cleanReceiptPay(pi.receiptPayLabel, pi.receiptPayNumber);
  if (pi?.branding && typeof pi.branding === 'object') {
    out.branding = { accentHex: pi.branding.accentHex ?? null, logoPng: pi.branding.logoPng ?? null,
      logoReceipt: 'logoReceipt' in pi.branding ? (pi.branding.logoReceipt ?? null) : undefined,
      receiptLogoEnabled: 'receiptLogoEnabled' in pi.branding ? pi.branding.receiptLogoEnabled === true : undefined };
  }
  return out;
}
