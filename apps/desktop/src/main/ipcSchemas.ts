/**
 * ipcSchemas.ts — the single, complete registry of what every IPC channel's
 * payload must look like (register D7).
 *
 * The gap D7 names: `check-ipc-parity` proves a channel is bridged AND handled,
 * but nothing proved the two sides agreed on the PAYLOAD. 149 channels crossed
 * the preload boundary; a renderer sending the wrong shape surfaced as an
 * undefined-dereference deep in a handler — or a silent wrong write. Four
 * money-adjacent channels were validated by hand; the rest were open.
 *
 * This registry closes it for ALL of them, and `check-ipc-validation.mjs`
 * enforces that it STAYS closed: every channel handled in main must appear here
 * with an explicit decision, so a channel added tomorrow cannot ship
 * unvalidated — CI rejects it. That enforcement is the point. "We validated the
 * 149 today" rots the moment someone adds 150; the gate is what makes D7 a close
 * rather than a snapshot.
 *
 * Each entry is exactly one of:
 *   - a Schema        — an object payload; fields validated (incl. nested via
 *                       the object/objectArray specs in ipcValidate).
 *   - a Bare<...>     — a single non-bag payload: a scalar, a string[], an
 *                       arbitrary object, or an array of objects.
 *   - NO_PAYLOAD      — the handler takes no second argument; nothing to check.
 *
 * A schema names only the fields a handler DEPENDS on — extra fields pass
 * through untouched, so adding a field to a caller never trips a handler that
 * ignores it. Schemas prove STRUCTURE (right fields, right kinds), not business
 * rules; those stay in the handlers/services where they already live.
 *
 * order:create is validated against createLocalOrder's real shape
 * (syncEngine.ts) — the required money fields plus the nested items[] — but it
 * is listed in NEEDS_LIVE_TEST: it is the primary sale path and could not be run
 * on the bench (no Electron, no live sale), so ring ONE real order on a
 * dev-flavour till before trusting it in production. It IS validated; it simply
 * carries a one-order confirmation the others don't.
 */
import type { Schema } from './ipcValidate';

export const NO_PAYLOAD = Symbol('NO_PAYLOAD');

/**
 * A channel whose payload is a single value rather than a named-field bag.
 *   scalar/stringArray  — the obvious bare cases.
 *   object              — must be a non-null, non-array object, any fields
 *                         (an opaque bag the handler reads defensively).
 *   objectArray         — must be an array whose elements are objects.
 *   nullableEnum        — a string enum OR null (idle:setSurface).
 */
export type Bare =
  | { kind: 'string'; min?: number }
  | { kind: 'number'; int?: boolean }
  | { kind: 'boolean' }
  | { kind: 'stringArray' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'nullableEnum'; values: readonly string[] }
  | { kind: 'object' }
  | { kind: 'objectArray'; minLen?: number };

export type ChannelSpec = Schema | Bare | typeof NO_PAYLOAD;

/** Structurally validated, but not yet confirmed on a live till. */
export const NEEDS_LIVE_TEST: ReadonlySet<string> = new Set(['order:create']);

// Reusable fragments ---------------------------------------------------------
const idPatch: Schema = { id: { t: 'string' }, patch: { t: 'any' } };
const rangeArg: Schema = {
  preset: { t: 'enum', optional: true, values: ['today','yesterday','last7','last30','month','custom'] },
  from:   { t: 'string', optional: true },
  to:     { t: 'string', optional: true },
  limit:  { t: 'number', optional: true, int: true },
};
const stationTarget: Schema = {
  stationId:    { t: 'string' },
  paperWidthMm: { t: 'number', int: true },
};

// order:create — designed against createLocalOrder (syncEngine.ts). Required:
// branch_id, order_number, subtotal, vat_amount, total, and items[] where each
// item has product.{id,name}, unitPrice, quantity, lineTotal. Everything else is
// optional with a handler default. Structure only — the amounts' correctness is
// enforced server-side, not here.
const orderCreate: Schema = {
  branch_id:    { t: 'string' },
  order_number: { t: 'string' },
  subtotal:     { t: 'number' },
  vat_amount:   { t: 'number' },
  total:        { t: 'number' },
  items: {
    t: 'objectArray', minLen: 1,
    item: {
      product:   { t: 'object', schema: { id: { t: 'string' }, name: { t: 'string' } } },
      unitPrice: { t: 'number' },
      quantity:  { t: 'number' },
      lineTotal: { t: 'number' },
    },
  },
};

export const IPC_SCHEMAS: Record<string, ChannelSpec> = {
  // ── auth / session ────────────────────────────────────────────────────────
  'auth:enrolDevice':       { business_id: { t: 'string', min: 1 }, code: { t: 'string', min: 1 } },
  'auth:logout':            NO_PAYLOAD,
  'auth:getSession':        NO_PAYLOAD,
  'auth:listBranches':      NO_PAYLOAD,
  'auth:verifyPin':         { pin: { t: 'string', min: 1 }, branch_id: { t: 'string', min: 1 } },
  'auth:getStaffSession':   NO_PAYLOAD,
  'auth:clearStaffSession': NO_PAYLOAD,

  // ── held orders ───────────────────────────────────────────────────────────
  'held:list':   NO_PAYLOAD,
  'held:hold':   { kind: 'object' },          // the whole order bag
  'held:recall': { id: { t: 'string' } },
  'held:delete': { id: { t: 'string' } },
  'held:import': { orders: { t: 'objectArray', item: {} } },

  // ── idle ──────────────────────────────────────────────────────────────────
  'idle:setSurface': { kind: 'nullableEnum', values: ['manager','pos'] },
  'idle:clear':      NO_PAYLOAD,
  'idle:suppress':   NO_PAYLOAD,
  'idle:release':    { kind: 'number', int: true },

  // ── pos ───────────────────────────────────────────────────────────────────
  'pos:getTables':      NO_PAYLOAD,
  'pos:paymentMethods': NO_PAYLOAD,
  'pos:getPumps':       NO_PAYLOAD,
  'pos:init':           NO_PAYLOAD,
  'pos:getVariants':    { kind: 'string' },
  'pos:getModifiers':   { kind: 'string' },

  // ── escpos (kitchen exclusions + production + spool) ──────────────────────
  'escpos:kitchenExclusions':      NO_PAYLOAD,
  'escpos:setKitchenExclusions':   { kind: 'stringArray' },
  'escpos:clearKitchenExclusions': NO_PAYLOAD,
  'escpos:printProduction':        { kind: 'object' },   // production bag
  'escpos:reprintReceipt':         NO_PAYLOAD,
  'escpos:reprintReceiptForOrder': { kind: 'string' },
  'escpos:printShiftReport':       { kind: 'object' },   // shift payload
  'escpos:assignments':            NO_PAYLOAD,
  'escpos:assign':                 { stationId: { t: 'string' }, target: { t: 'string' }, paperWidthMm: { t: 'number', int: true } },
  'escpos:unassign':               { kind: 'string' },
  'escpos:status':                 NO_PAYLOAD,
  'escpos:enabled':                NO_PAYLOAD,
  'escpos:setEnabled':             { kind: 'boolean' },
  'escpos:retry':                  { kind: 'string' },
  'escpos:preview':                stationTarget,
  'escpos:canPrint':               { kind: 'enum', values: ['kitchen','dispatch','receipt'] },
  'escpos:test':                   stationTarget,

  // ── order (money path) ────────────────────────────────────────────────────
  'order:create': orderCreate,           // NEEDS_LIVE_TEST — see header note
  'order:void':   { orderId: { t: 'string', min: 1 }, reason: { t: 'string', min: 1 }, supervisor_pin: { t: 'string', optional: true }, override_pin: { t: 'string', optional: true }, authorizer_id: { t: 'string', optional: true } },
  'order:refund': { orderId: { t: 'string', min: 1 }, reason: { t: 'string', min: 1 }, override_pin: { t: 'string', optional: true }, authorizer_id: { t: 'string', optional: true } },

  // ── print (native) ────────────────────────────────────────────────────────
  'print:list':     NO_PAYLOAD,
  'print:shares':   NO_PAYLOAD,
  'print:probe':    { kind: 'string' },
  'print:geometry': { kind: 'string' },
  'print:preview':  { kind: 'object' },   // opts bag
  'print:html':     { kind: 'object' },   // opts bag

  // ── sync / net ────────────────────────────────────────────────────────────
  'sync:trigger':     NO_PAYLOAD,
  'sync:retryFailed': NO_PAYLOAD,
  'sync:status':      NO_PAYLOAD,
  'net:changed':      { kind: 'boolean' },

  // ── config ────────────────────────────────────────────────────────────────
  'config:get':            NO_PAYLOAD,
  'config:isConfigured':   NO_PAYLOAD,
  'config:save':           { kind: 'object' },  // config patch bag
  'config:clear':          NO_PAYLOAD,
  'config:testConnection': { kind: 'string' },
  'orders:nextBillNumber': NO_PAYLOAD,

  // ── device ────────────────────────────────────────────────────────────────
  'device:resetPreview': NO_PAYLOAD,
  'device:reset':        { force: { t: 'boolean', optional: true } },
  'device:identity':     NO_PAYLOAD,

  // ── shift / day / branch close ────────────────────────────────────────────
  'shift:current':          NO_PAYLOAD,
  'shift:stale':            NO_PAYLOAD,
  'day:gate':               NO_PAYLOAD,
  'day:current':            NO_PAYLOAD,
  'branchClose:overview':   NO_PAYLOAD,
  'branchClose:closeTill':  { device_id: { t: 'string' }, counted_cash: { t: 'number' }, notes: { t: 'string', optional: true } },
  'day:summary':            NO_PAYLOAD,
  'day:isManager':          NO_PAYLOAD,
  'day:conflicts':          NO_PAYLOAD,
  'day:retryConflict':      { shiftId: { t: 'string' } },
  'day:close':              { countedCash: { t: 'number' }, notes: { t: 'string', optional: true } },
  'shift:forceClose':       { reason: { t: 'string' } },
  'shift:open':             { opening_float: { t: 'number' }, drawer_label: { t: 'string', optional: true } },
  'shift:float':            { type: { t: 'enum', values: ['float_in','float_out'] }, amount: { t: 'number' }, reason: { t: 'string', optional: true } },
  'shift:close':            { closing_float: { t: 'number' }, notes: { t: 'string', optional: true } },
  'shift:zreport':          { kind: 'string' },

  // ── manage (catalogue) ────────────────────────────────────────────────────
  'manage:listProducts':        NO_PAYLOAD,
  'manage:createProduct':       { name: { t: 'string' } },
  'manage:updateProduct':       idPatch,
  'manage:listCategories':      NO_PAYLOAD,
  'manage:listStations':        NO_PAYLOAD,
  'manage:listPaymentMethods':  NO_PAYLOAD,
  'manage:createPaymentMethod': { name: { t: 'string' } },
  'manage:updatePaymentMethod': idPatch,
  'manage:deletePaymentMethod': { kind: 'string' },
  'manage:unassignedCategories':NO_PAYLOAD,
  'manage:createStation':       { name: { t: 'string' } },
  'manage:seedDefaultStations': NO_PAYLOAD,
  'manage:updateStation':       idPatch,
  'manage:deleteStation':       { kind: 'string' },
  'manage:setStationCategories':{ id: { t: 'string' }, categoryIds: { t: 'stringArray' } },
  'manage:createCategory':      { name: { t: 'string' } },
  'manage:updateCategory':      idPatch,
  'manage:bulkProducts':        { kind: 'objectArray' },   // rows: object[]
  'manage:listCombos':          NO_PAYLOAD,
  'manage:createCombo':         { name: { t: 'string' } },
  'manage:updateCombo':         idPatch,
  'manage:setComboItems':       { id: { t: 'string' }, items: { t: 'objectArray', item: {} } },
  'manage:listVariantGroups':   { kind: 'string' },
  'manage:updateVariantGroup':  idPatch,
  'manage:createVariantOption': { name: { t: 'string' } },
  'manage:updateVariantOption': idPatch,
  'manage:deleteVariantOption': { kind: 'string' },
  'manage:createVariantGroup':  { name: { t: 'string' } },
  'manage:deleteVariantGroup':  { kind: 'string' },
  'manage:listModifierGroups':  { kind: 'string' },
  'manage:createModifierGroup': { name: { t: 'string' } },
  'manage:deleteModifierGroup': { kind: 'string' },
  'manage:listStaff':           NO_PAYLOAD,
  'manage:listRoles':           NO_PAYLOAD,
  'manage:createStaff':         { name: { t: 'string' } },
  'manage:updateStaff':         idPatch,
  'manage:getReceiptText':      NO_PAYLOAD,
  'manage:setReceiptText':      { header: { t: 'string' }, footer: { t: 'string' } },
  'manage:getContinuousOperation': NO_PAYLOAD,
  'manage:setContinuousOperation': { kind: 'boolean' },

  // ── manager (reports) ─────────────────────────────────────────────────────
  // salesSummary/topProducts/recentOrders take r?: RangeArg. The whole arg is
  // optional and every field within RangeArg is optional, so a fully-optional
  // bag accepts both an absent payload and a present partial one.
  'manager:salesSummary':   { ...rangeArg },
  'manager:topProducts':    { ...rangeArg },
  'manager:recentOrders':   { ...rangeArg },
  'manager:reportScope':    NO_PAYLOAD,
  'manager:resolveRange':   rangeArg,
  'manager:exportCsv':      { kind: 'object' },  // req bag
  'manager:dailyReport':    { kind: 'object' },  // req bag
  'manager:stockLevels':    NO_PAYLOAD,
  'manager:fuelSales':      NO_PAYLOAD,
  'manager:pumpStatus':     NO_PAYLOAD,
  'manager:tableOccupancy': NO_PAYLOAD,
  'manager:priceList':      NO_PAYLOAD,
  'manager:setBranchPrice': { product_id: { t: 'string' }, price: { t: 'number' } },
  'manager:clearBranchPrice':{ product_id: { t: 'string' } },
  'manager:branchReport':   NO_PAYLOAD,

  // ── expense ───────────────────────────────────────────────────────────────
  'expense:categories': NO_PAYLOAD,
  'expense:create':     { description: { t: 'string' }, amount: { t: 'number' }, expense_category_id: { t: 'string', optional: true }, paid_by: { t: 'string', optional: true } },
  'expense:list':       NO_PAYLOAD,

  // ── tech ──────────────────────────────────────────────────────────────────
  'tech:checkReveal':   { kind: 'string' },
  'tech:openSession':   { kind: 'string' },
  'tech:adoptFromNode': NO_PAYLOAD,
  'tech:getSession':    NO_PAYLOAD,
  'tech:closeSession':  NO_PAYLOAD,
  'tech:logAction':     { action: { t: 'string' }, detail: { t: 'any', optional: true } },
  'tech:promoteToNode': NO_PAYLOAD,
  'tech:setNodeUrl':    { url: { t: 'string' } },
  'tech:backupNow':     NO_PAYLOAD,
  'tech:maintenance':   NO_PAYLOAD,
  'tech:query':         { sql: { t: 'string' } },
  'tech:status':        NO_PAYLOAD,
  'tech:testConnection':NO_PAYLOAD,
  'tech:logTail':       { lines: { t: 'number', optional: true, int: true } },
};
