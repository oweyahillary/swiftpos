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
 * Every row a query returns, page by page in id order (so no row is read twice or missed), up to `maxRows`. `build` makes
 * a FRESH query each page (a builder is spent once awaited). Throws on a database error.
 *
 *     const products = await pageAll<Product>(() => supabase.from('products').select('*').eq('business_id', id));
 */
export async function pageAll<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
  pageSize = 500,
  maxRows = 200_000,
  orderColumn = 'id',
): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; at < maxRows; at += pageSize) {
    const { data, error } = await build().order(orderColumn, { ascending: true }).range(at, at + pageSize - 1);
    if (error) throw new Error(`pageAll: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < pageSize) break;
  }
  return out;
}

/** chunkIn and pageAll together: an id list of any length, each chunk read page by page (a chunk can pass the row cap). */
export async function chunkPaged<T>(
  ids: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: (chunk: string[]) => any,
  chunkSize: number = SAFE_CHUNK,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    out.push(...await pageAll<T>(() => build(chunk)));
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
 *
 * TWO THINGS THAT LOOK LIKE DETAIL AND ARE NOT
 *
 * 1. THE ORDER BY IS LOAD-BEARING (audit C1). PostgreSQL guarantees NO row
 *    order without one, and it is free to return a different order on each of
 *    the queries that make up a page walk. Rows then appear on two pages, or on
 *    none. Every caller of this function is cash reconciliation, so a duplicated
 *    id double-counts a payment and a dropped one loses it — which is the
 *    phantom variance this function was written to prevent, arriving past 1000
 *    orders instead of at the row cap. Ordering on the id makes the walk
 *    deterministic; it is unique, indexed, and never NULL.
 *
 * 2. THE PAGE SIZE MUST BE BELOW THE ROW CAP (audit C2). The loop stops when a
 *    page comes back shorter than requested. If Supabase's db-max-rows is set
 *    LOWER than pageSize, the very first response is short, the loop exits, and
 *    the list is silently truncated — the exact bug this exists to prevent, by
 *    another road. 500 sits under every default worth worrying about (PostgREST
 *    ships unlimited; Supabase's dashboard default is 1000). The cost is one
 *    extra round trip per 500 rows; the cost of guessing high is a wrong number
 *    at close of business with nothing to say it is wrong.
 */
export async function fetchAllIds(
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refine: (q: any) => any,
  idColumn = 'id',
  pageSize = 500,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await refine(
      supabase.from(table).select(idColumn),
    )
      .order(idColumn, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetchAllIds(${table}.${idColumn}): ${error.message}`);
    const page = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of page) {
      const v = r[idColumn];
      // Belt and braces on top of the ORDER BY: if a page boundary ever does
      // repeat a row, count it once. Silent double-counting is the failure mode
      // that costs money here.
      if (typeof v === 'string' && !seen.has(v)) { seen.add(v); ids.push(v); }
    }
    if (page.length < pageSize) return ids;   // short page = last page
  }
}
