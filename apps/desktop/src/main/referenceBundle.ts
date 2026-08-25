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
    continuousOperation: boolean | null;
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
  comboItems: any[];        // combo_items rows
  paymentMethods: any[];    // payment_methods rows (code, name, sort_order)
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
    is_fuel: asBool(p.is_fuel),
    is_kitchen: asTriBool(p.is_kitchen),   // tri-state — see asTriBool
  }));

  const categories = rows.categories.map(c => ({
    id: c.id,
    name: c.name,
    color: c.color ?? null,
    icon: c.icon ?? null,
    sort_order: Number(c.sort_order) || 0,
    status: c.status ?? 'active',
    is_kitchen: asBool(c.is_kitchen),
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
      continuousOperation: rows.config.continuousOperation,
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
                          has_variants, has_modifiers, track_stock, status, barcode, plu, is_fuel, is_kitchen
                   FROM products`),
    categories: all(`SELECT id, name, color, icon, sort_order, status, is_kitchen FROM categories`),
    comboItems: all(`SELECT combo_id, product_id, name, quantity, sort_order, is_kitchen FROM combo_items ORDER BY combo_id, sort_order`),
    paymentMethods: all(`SELECT code, name, sort_order FROM payment_methods ORDER BY sort_order`),
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
  comboItems: Record<string, any[]>;
  paymentMethods: Array<{ code: string; name: string }> | null; // null = leave tenders
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
    comboItems: pi.comboItems && typeof pi.comboItems === 'object' && !Array.isArray(pi.comboItems) ? pi.comboItems : {},
    paymentMethods: Array.isArray(pi.paymentMethods) ? pi.paymentMethods : null,
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
    },
  };
}
