/**
 * stockGateLocal.ts — A563: the owner's "When an item's stock reaches zero" choice on this till (shared rules in
 * stockGate.ts).
 *
 * The source of truth is this till's own copy of its branch's stock levels (stock_levels): the cloud's level, kept current
 * by the change log (A535, topic `stock`) and every catalogue pull, less this till's own sales that have not reached the
 * cloud yet (createLocalOrder takes each tracked line off at once; the delta merge keeps it off until the cloud has it).
 * The choice itself is a POS switch pair (device_config.pos_features), so it arrives like every POS switch.
 *
 * The race: two tills selling the last item while offline both see 1 and both sell it — a till knows only what it has
 * synced. The level goes to -1 and the next sync shows it; neither sale is lost, and the cloud never refuses a till's sale.
 * A level this till has never heard is unknown and SELLS: the till never blocks what it cannot verify. That includes a
 * row this till made up itself (synced_at NULL — createLocalOrder's first sale of an item with no level writes 0 − qty):
 * only a level that came from the cloud or the branch server (a pull, the change log, A535) counts as known.
 *
 * Known limits: a combo's items are taken off this till's levels only when the cloud's level comes back (createLocalOrder
 * takes off the combo line itself), so offline a combo is judged on the items' last synced levels; a product sold by the
 * piece is judged on its units (the till does not hold sold_by); fuel is never gated (its stock is the tank's).
 */
import type Database from 'better-sqlite3';
import { getLocalDb } from './localDb';
import { getPosFeatures, tillBranchId } from './deviceConfig';
import {
  outOfStockMode, stockRefusals, refusalText,
  type OutOfStockMode, type StockView, type GateLine, type StockRefusal,
} from './stockGate';

export interface TillStockView extends StockView { mode: OutOfStockMode; branchId: string | null }

/** The levels of TRACKED, non-fuel products at the branch (known ones only) and the combos' items. */
export function readStockView(db: Database.Database, branchId: string | null): StockView {
  const levels: Record<string, number> = {};
  const combos: Record<string, Array<{ product_id: string; quantity: number }>> = {};
  if (!branchId) return { levels, combos };
  const rows = db.prepare(`
    SELECT s.product_id AS product_id, s.quantity AS quantity
      FROM stock_levels s JOIN products p ON p.id = s.product_id
     WHERE s.branch_id = ? AND p.track_stock = 1 AND COALESCE(p.is_fuel, 0) = 0 AND s.synced_at IS NOT NULL`).all(branchId) as Array<{ product_id: string; quantity: unknown }>;
  for (const r of rows) {
    if (r.quantity === null || r.quantity === undefined || r.quantity === '') continue;   // a blind count hides it: unknown
    const q = Number(r.quantity);
    if (Number.isFinite(q)) levels[r.product_id] = q;
  }
  const parts = db.prepare(`SELECT combo_id, product_id, quantity FROM combo_items`).all() as Array<{ combo_id: string; product_id: string; quantity: unknown }>;
  for (const c of parts) (combos[c.combo_id] ??= []).push({ product_id: c.product_id, quantity: Number(c.quantity) || 1 });
  return { levels, combos };
}

/** What the sale screen needs: the choice, and (only when it is not "sell") the levels it judges by. */
export function tillStockView(): TillStockView {
  const mode = outOfStockMode(getPosFeatures() as unknown as Record<string, unknown>);
  const branchId = tillBranchId();
  if (mode === 'sell') return { mode, branchId, levels: {}, combos: {} };
  try { return { mode, branchId, ...readStockView(getLocalDb(), branchId) }; }
  catch { return { mode, branchId, levels: {}, combos: {} }; }   // unreadable = unknown = sell
}

/** A sale's lines as the gate reads them — fuel (litres from a pump) and lines with no product left out. */
export function gateLines(orderPayload: any): GateLine[] {
  const items: any[] = Array.isArray(orderPayload?.items) ? orderPayload.items : [];
  return items.map((i) => (i?.isFuel || i?.pumpId)
    ? { product_id: null, quantity: 0 }
    : { product_id: i?.product?.id ?? i?.product_id ?? null, name: i?.product?.name ?? i?.product_name ?? null, quantity: Number(i?.quantity) || 0 });
}

/**
 * order:create's check (main enforces; the screen only keeps in step): the lines the owner's choice refuses, judged on
 * this till's levels for the sale's branch. [] with "sell", and for anything not known.
 */
export function saleStockRefusals(orderPayload: any, db: Database.Database = getLocalDb()): StockRefusal[] {
  const mode = outOfStockMode(getPosFeatures() as unknown as Record<string, unknown>);
  if (mode === 'sell') return [];
  const branchId = (typeof orderPayload?.branch_id === 'string' && orderPayload.branch_id) || tillBranchId();
  let view: StockView;
  try { view = readStockView(db, branchId); } catch { return []; }
  return stockRefusals(mode, view, gateLines(orderPayload));
}

/** The refusal sentence, or null when the sale may go ahead. */
export function saleStockRefusal(orderPayload: any): string | null {
  const r = saleStockRefusals(orderPayload);
  return r.length ? refusalText(r) : null;
}
