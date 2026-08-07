/**
 * pgQuery.ts — helpers for queries whose size depends on how busy the shop was.
 *
 * TWO WAYS A PERFECTLY CORRECT QUERY BREAKS ON A GOOD DAY
 *
 * 1. URL LENGTH. PostgREST puts filters in the query string, so
 *    .in('order_id', ids) becomes  ?order_id=in.(uuid,uuid,uuid,…)  — 37 chars
 *    per id including the comma. Kong (nginx) requires the request line to fit
 *    one large_client_header_buffer, 8 KB by default:
 *
 *        100 ids →  3.8 KB   OK
 *        200 ids →  7.5 KB   OK
 *        220 ids →  8.3 KB   OVER
 *        500 ids → 18.6 KB   OVER
 *
 *    /shifts/:id/close passed EVERY order in the shift. Somewhere around 220
 *    orders — an ordinary lunch service at a busy counter — closing the shift
 *    starts failing. Not a slow query: a rejected request.
 *
 *    chunkIn already existed for exactly this, in reports.ts. It had never been
 *    called from anywhere, and its default chunk size was 500, which is itself
 *    over the limit. A helper that is never used cannot be discovered to be
 *    wrong.
 *
 * 2. ROW LIMIT. Supabase can cap rows per response (db-max-rows). A plain
 *    .select('id') hits that cap and returns a TRUNCATED list with no error.
 *    Expected cash then gets computed from the first N orders of the shift and
 *    the drawer reports a large phantom SURPLUS — silently, which is worse than
 *    failing.
 *
 * fetchAllIds pages explicitly with .range() so neither can happen.
 */
import { supabase } from './supabase';

/**
 * 150 ids ≈ 5.7 KB of URL, comfortably inside the 8 KB request line every proxy
 * in the path allows. Deliberately not 200: that is 7.5 KB, and leaves nothing
 * for a longer table name, extra filters, or a project ref longer than this
 * one's. The cost of a smaller chunk is one extra round trip; the cost of a
 * larger one is a 414 at close of business.
 */
export const SAFE_CHUNK = 150;

/**
 * Run a filtered query in chunks, so the id list can never overflow the URL.
 *
 *     const rows = await chunkIn<PaymentRow>('payments', 'order_id', orderIds,
 *       q => q.select('amount, status').eq('method', 'cash'));
 */
export async function chunkIn<T>(
  table: string,
  column: string,
  ids: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refine: (q: any) => any,
  chunkSize: number = SAFE_CHUNK,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (refine(supabase.from(table)) as any).in(column, chunk);
    if (error) throw new Error(`chunkIn(${table}.${column}): ${error.message}`);
    if (data) out.push(...(data as T[]));
  }
  return out;
}

/**
 * Read every matching id, paging explicitly rather than trusting one response
 * to hold them all.
 *
 *     const orderIds = await fetchAllIds('orders', q =>
 *       q.eq('shift_id', id).eq('status', 'completed'));
 *
 * Pages until a short page comes back, so it stops after one round trip on a
 * quiet shift and keeps going on a busy one.
 */
export async function fetchAllIds(
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refine: (q: any) => any,
  idColumn = 'id',
  pageSize = 1000,
): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await refine(
      supabase.from(table).select(idColumn),
    ).range(from, from + pageSize - 1);
    if (error) throw new Error(`fetchAllIds(${table}.${idColumn}): ${error.message}`);
    const page = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of page) {
      const v = r[idColumn];
      if (typeof v === 'string') ids.push(v);
    }
    if (page.length < pageSize) return ids;   // short page = last page
  }
}
