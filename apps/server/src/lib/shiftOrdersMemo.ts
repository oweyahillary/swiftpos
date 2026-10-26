/**
 * shiftOrdersMemo.ts — A591: a drawer's web sales without re-reading every sale on the drawer every 20 seconds.
 *
 * POST /api/shifts/:id/foreign-orders (cross-sync stage 1) is asked by every till for each of its open drawers every ~20 s.
 * It read EVERY completed or voided sale on the drawer — with all its lines and payments — then kept, in Node, only the
 * few the till did not ring (the web POS standing in) and the till's own sales voided or refunded on the web. A busy
 * drawer of 300 sales was ~450 KB from Supabase per ask, ~2,500 asks a day per till: the largest single share of the
 * Supabase egress (owner, 2026-10-26: the Free plan's 5 GB went over; projects restricted from 20 Nov).
 *
 * Now:
 *   1. a LIGHT list of the drawer's sales (id, status, idempotency_key, refunded_amount, created_at, updated_at) is kept
 *      per drawer; after the first read only the sales changed since (updated_at, with 2 minutes of overlap for a late
 *      commit) are read; the whole list again every 10 minutes;
 *   2. only the sales the answer can contain are read in full (the same columns, lines and payments as before) — the
 *      ones the till did not ring, and its own that were voided or refunded;
 *   3. while nothing has been written for the business through this server (lib/writeActivity.ts) and the last read is
 *      under 5 minutes old (A593; it was 60 s), the answer comes from memory with no read at all.
 * The answer is the same rows, in the same order, through the same foreignOrders / ownReversals (lib/foreignCash.ts).
 * A591_MEMO=off reads as before (every ask: the whole drawer, in full).
 */
import { supabase } from './supabase';
import { chunkIn } from './pgQuery';
import { memoEnabled, writeGen, QUIET_MAX_MS } from './writeActivity';   // A593: QUIET_MAX_MS
import { traffic } from './trafficStats';
import type { CloudOrder } from './foreignCash';

/** A593: 5 minutes while nothing is written for the business (was 60 s) — a web sale or void comes through this server
 *  and moves the generation at once; only a change made straight in SQL waits this long. */
export const FRESH_MS = QUIET_MAX_MS;
export const FULL_EVERY_MS = 10 * 60_000;
export const OVERLAP_MS = 120_000;
/** As the route always read: the drawer's first 2,000 sales. */
export const SHIFT_ORDER_CAP = 2000;
const MAX_SHIFTS = 2_000;

export const FULL_COLS = `
        id, order_number, order_type, status, subtotal, vat_amount, discount_amount, total, tip_amount,
        ctl_amount, covers, customer_id, customer_name, customer_phone, idempotency_key, cashier_id,
        shift_id, branch_id, created_at, void_reason, voided_at, voided_by, refunded_at,
        refunded_amount, refund_reason, delivery_person, notes, delivery_fee, delivery_free,
        order_items ( id, product_id, product_name, category_name, unit_price, quantity, subtotal, course, fire_status, notes ),
        payments ( id, method, amount, amount_tendered, change_given, reference, status, created_at )
      `;
const LIGHT_COLS = 'id, status, idempotency_key, refunded_amount, created_at, updated_at';

export interface ShiftRow { id: string; device_id: string | null; terminal_code: string | null; branch_id: string | null; opened_by: string | null; cashier_id: string | null }
interface Light { id: string; status: string; idempotency_key: string | null; refunded_amount: number | string | null; created_at: string | null; updated_at: string | null }
interface Memo {
  businessId: string;
  shift: ShiftRow;
  light: Map<string, Light>;
  cursor: string | null;
  fullAt: number;
  readAt: number;
  gen: string;
  /** the full rows last read, by id (only the ones the answer can contain) */
  rows: Map<string, CloudOrder>;
}
const memos = new Map<string, Memo>();
let clock: () => number = () => Date.now();

const fresh = (m: Memo | undefined, businessId: string, now: number): boolean =>
  !!m && m.businessId === businessId && m.gen === writeGen(businessId) && now - m.readAt < FRESH_MS;

function keep(id: string, m: Memo): void {
  memos.delete(id); memos.set(id, m);
  while (memos.size > MAX_SHIFTS) { const first = memos.keys().next().value; if (first === undefined) break; memos.delete(first); }
}

/** The drawer (the route's authorisation reads it) — from memory while nothing was written. null = not this business's. */
export async function readShift(businessId: string, shiftId: string): Promise<ShiftRow | null> {
  const now = clock();
  const m = memos.get(shiftId);
  if (m && memoEnabled() && fresh(m, businessId, now)) { traffic.count('foreign.shift_memory'); return m.shift; }
  const { data } = await supabase
    .from('shifts').select('id, device_id, terminal_code, branch_id, opened_by, cashier_id')
    .eq('id', shiftId).eq('business_id', businessId).maybeSingle();
  if (m && data) m.shift = data as ShiftRow;   // kept current; the memo's freshness is the orders' own
  return (data as ShiftRow | null) ?? null;
}

/** Same order as the route's .order('created_at'): oldest first (ties by id, so a page boundary never reorders). */
const byCreated = (a: { created_at?: unknown; id: string }, b: { created_at?: unknown; id: string }) => {
  const x = String(a.created_at ?? ''), y = String(b.created_at ?? '');
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** The sales the answer can contain: the drawer's completed or voided sales (its first 2,000) the till did not ring, or
 *  rang and the cloud voided or refunded. Exported for the tests. */
export function neededIds(light: Iterable<Light>, ownIds: string[]): string[] {
  const own = new Set(ownIds);
  const sales = [...light].filter((o) => o.status === 'completed' || o.status === 'voided').sort(byCreated).slice(0, SHIFT_ORDER_CAP);
  return sales.filter((o) => {
    const mine = own.has(o.id) || (!!o.idempotency_key && own.has(o.idempotency_key));
    return !mine || o.status === 'voided' || Number(o.refunded_amount ?? 0) > 0;
  }).map((o) => o.id);
}

async function readLight(businessId: string, shiftId: string, after: string | null): Promise<Light[]> {
  const out: Light[] = [];
  for (let at = 0; at < 20_000; at += 1000) {
    let q = supabase.from('orders').select(LIGHT_COLS).eq('shift_id', shiftId).eq('business_id', businessId);
    if (after) q = q.gt('updated_at', after);
    const { data, error } = await q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(at, at + 999);
    if (error) throw error;
    out.push(...((data ?? []) as Light[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function readFull(businessId: string, shiftId: string, ids: string[]): Promise<CloudOrder[]> {
  return chunkIn<CloudOrder>('orders', 'id', ids,
    (q) => q.select(FULL_COLS).eq('shift_id', shiftId).eq('business_id', businessId).in('status', ['completed', 'voided']));
}

/**
 * The rows the old read returned that foreignOrders / ownReversals can keep — every other row they would have dropped.
 * Throws on a database error (the route answers it as before).
 */
export async function shiftOrdersFor(businessId: string, shiftId: string, shift: ShiftRow, ownIds: string[]): Promise<CloudOrder[]> {
  const now = clock();
  if (!memoEnabled()) {
    const { data, error } = await supabase.from('orders').select(FULL_COLS)
      .eq('shift_id', shiftId).eq('business_id', businessId).in('status', ['completed', 'voided'])
      .order('created_at', { ascending: true }).limit(SHIFT_ORDER_CAP);
    if (error) throw error;
    return (data ?? []) as unknown as CloudOrder[];
  }
  let m = memos.get(shiftId);
  if (m && m.businessId !== businessId) m = undefined;

  if (m && fresh(m, businessId, now)) {
    const want = neededIds(m.light.values(), ownIds);
    const missing = want.filter((id) => !m!.rows.has(id));
    if (!missing.length) { traffic.count('foreign.memory'); return want.map((id) => m!.rows.get(id)!).sort(byCreated); }
    // The till's own list changed (rare): read only the sales not yet held.
    for (const r of await readFull(businessId, shiftId, missing)) m.rows.set(r.id, r);
    traffic.count('foreign.memory_plus');
    return want.map((id) => m!.rows.get(id)).filter((r): r is CloudOrder => !!r).sort(byCreated);
  }

  const gen = writeGen(businessId);   // taken BEFORE the reads: a write that lands meanwhile makes the next ask read again
  const whole = !m || now - m.fullAt >= FULL_EVERY_MS;
  const after = !whole && m!.cursor ? new Date(Date.parse(m!.cursor) - OVERLAP_MS).toISOString() : null;
  const rows = await readLight(businessId, shiftId, whole ? null : after);
  const light = whole ? new Map<string, Light>() : m!.light;
  let cursor = whole ? null : m!.cursor;
  for (const r of rows) {
    light.set(r.id, r);
    if (r.updated_at && (!cursor || Date.parse(r.updated_at) > Date.parse(cursor))) cursor = r.updated_at;
  }
  const want = neededIds(light.values(), ownIds);
  const full = await readFull(businessId, shiftId, want);
  const byId = new Map(full.map((r) => [r.id, r]));
  traffic.count(whole ? 'foreign.whole' : 'foreign.delta');
  keep(shiftId, { businessId, shift, light, cursor, fullAt: whole ? now : m!.fullAt, readAt: now, gen, rows: byId });
  return want.map((id) => byId.get(id)).filter((r): r is CloudOrder => !!r).sort(byCreated);
}

/** Test seams. */
export function _resetShiftMemo(): void { memos.clear(); }
export function _setShiftMemoClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }
