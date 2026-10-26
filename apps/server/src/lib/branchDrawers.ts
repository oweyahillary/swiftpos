/**
 * branchDrawers.ts — A535: GET /api/pos/branch-drawers — every drawer of a branch, for its branch server, in ONE call.
 *
 * Owner, 2026-10-19: "for a setup like KRUNCH only the server does the communication to cloud, not all tills". After A531
 * the menu, the staff and the settings reached a branch's tills through its server, but each till still asked the cloud
 * (through the server's gateway, one request at a time) about its OWN drawers: the web's sales on them every 20 s
 * (POST /api/shifts/:id/foreign-orders), whether the web closed them (GET /api/shifts/state, 20 s and again on the 90 s
 * beat), whether a manager confirmed them (the same, 20 s), and on the 90 s beat the remote day closes, the test-data
 * clears and ZapTill support's log requests. A 4-till branch with every drawer open: ≈ 2,000 cloud requests an hour.
 *
 * Now the branch server asks this once a beat (60 s while its push channel is up — a drawer changed on the web rings it,
 * lib/drawerBell.ts — 20 s while it is down) and answers its tills on the shop network (desktop branchDrawers.ts,
 * /node/drawers). One answer, for the server's OWN branch only (the device's branch on the cloud — never one it names):
 *
 *   shifts   every drawer of the branch that is open, closed in the last 7 days, or closed and still waiting for a
 *            manager's confirmation (any age, the 50 newest) — exactly the fields GET /api/shifts/state sends (its
 *            status, how and by whom it was closed, the confirmation), with the closer's and confirmer's names
 *   orders   the sales on the branch's drawers that are open or closed in the last 24 hours, changed after `since`
 *            (with 120 s of overlap — a sale written before another but committed after it is not skipped): the fields,
 *            lines and payments POST /api/shifts/:id/foreign-orders sends. The server picks each till's web sales and
 *            own reversals from them with the till's own ids, as foreign-orders does (lib/foreignCash.ts). `cursor` = the
 *            newest updated_at sent; `more` = ask again from it.
 *   beat     which devices of the branch have a remote day close waiting (day_close_instructions), which have a
 *            ZapTill log request waiting (log_requests, A533), and the newest test-data clear (test_data_purges) — a
 *            till asks its own route only when it is named (or the clear is newer than the one it applied).
 *
 * Read-only. Only a confirmed branch server of the business (A427: user_devices role node/office, role confirmed,
 * approved, not retired) with its own session; another business's rows are never read (every read by business_id and the
 * device's branch).
 *
 * A593 (owner, 2026-10-26: the System page — this answer was 747 Supabase calls in 69 asks, ~11 an ask; "logs are full
 * already"). The same answer from fewer reads:
 *   - the server's own row as the sign-in check keeps it (lib/authCache.ts readServerRow — kept only while it IS a
 *     confirmed branch server, forgotten at once when the business's tills change through this server);
 *   - the three drawer reads (open · closed in 7 days · awaiting a confirmation) as ONE read (an `or` of the three), the
 *     three lists then picked from its rows by the very same rules, limits and order; a branch whose rows reach the
 *     1,000-row page reads the three as before;
 *   - the closers' and confirmers' names kept per business while nobody's name can have changed (the people generation,
 *     lib/writeActivity.ts — a staff, PIN or device write moves it; at most 10 minutes) — only names not held are read;
 *   - the beat (the branch's devices, the day closes and log requests waiting, the newest test-data clear) kept while
 *     nothing is written for the business (lib/quietMemo.ts, at most 5 minutes; a log request's expiry is still decided
 *     at each ask) — every one of them is written through this server;
 *   - the whole answer for the same `since` kept while nothing is written for the business, at most 60 s (a change made
 *     straight in SQL is seen within a minute, as the beat always took).
 * A quiet beat: 2 reads (drawers, sales) — 0 within the minute. A591_MEMO=off: every read as before (one read of the
 * drawers stays: it is the same rows).
 */
import { supabase } from './supabase';
import { traffic } from './trafficStats';
import { readServerRow, type ServerRow } from './authCache';                      // A593
import { memoEnabled, peopleGen } from './writeActivity';                          // A593
import { quietMemo, quietNow } from './quietMemo';                                  // A593

export const SHIFT_DAYS = 7;
export const ORDER_HOURS = 24;
export const OVERLAP_MS = 120_000;
export const ORDERS_PAGE = 2000;
export const AWAITING_MAX = 50;
/** A593: the most rows one read returns (Supabase's db-max-rows) — a combined drawers read that reaches it reads the three as before. */
export const ROW_PAGE = 1000;
/**
 * A593: the whole answer, kept at most this long — 60 s (the beat's own), so a change made straight in SQL is seen within a
 * minute. BRANCH_DRAWERS_MEMO_S (60–300) lets the owner keep it longer: the branch server asks every 60 s, so a 60 s
 * memory seldom answers a beat — at 300 s a quiet branch is read about once in 5 minutes instead of every minute (every
 * write through this server, and a web change that rings the server, still reads at once).
 */
export const ANSWER_MAX_MS = (() => { const n = Number(process.env.BRANCH_DRAWERS_MEMO_S); return Number.isFinite(n) && n >= 60 ? Math.min(n, 300) * 1000 : 60_000; })();
export const NAMES_MAX_MS = 10 * 60_000;

const STATE_COLS = 'id, device_id, branch_id, status, opened_at, closed_at, close_method, closed_by, closing_float, cash_variance, expected_cash, notes, confirmed_at, confirmed_by, confirmed_methods, expected_methods, confirm_reasons, confirm_self, declared_methods';
const ORDER_COLS = `
  id, order_number, order_type, status, subtotal, vat_amount, discount_amount, total, tip_amount,
  ctl_amount, covers, customer_id, customer_name, customer_phone, idempotency_key, cashier_id,
  shift_id, branch_id, created_at, updated_at, void_reason, voided_at, voided_by, refunded_at,
  refunded_amount, refund_reason, delivery_person, notes, delivery_fee, delivery_free,
  order_items ( id, product_id, product_name, category_name, unit_price, quantity, subtotal, course, fire_status, notes ),
  payments ( id, method, amount, amount_tendered, change_given, reference, status, created_at )
`;

export interface DrawersCaller { businessId: string; deviceId: string | null; isTill: boolean; surface: string | null }
export type DrawersRefusal = { status: number; error: string; code: string };
export interface DrawersAnswer {
  branch_id: string;
  at: string;
  cursor: string | null;
  more?: boolean;
  shifts: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  beat: { day_close_devices: string[]; log_request_devices: string[]; test_clear_latest: string | null };
}

function refusal(d: ServerRow | null): DrawersRefusal | null {
  if (!d || d.status !== 'approved' || d.retired_at || !['node', 'office'].includes(String(d.device_role ?? '')) || !d.role_confirmed_at) {
    return { status: 403, error: 'This machine is not confirmed as the branch server.', code: 'not_confirmed_server' };
  }
  if (!d.branch_id) return { status: 409, error: 'This branch server is not bound to a branch.', code: 'no_branch' };
  return null;
}

/** The server's own branch, when the caller IS a confirmed branch server of the business; else why not. */
export async function serverBranch(c: DrawersCaller): Promise<{ branchId: string } | DrawersRefusal> {
  if (!c.isTill || c.surface !== 'desktop' || !c.deviceId) {
    return { status: 403, error: 'Only a branch server asks for its branch drawers.', code: 'not_a_server' };
  }
  traffic.queries(1);
  // A593: kept (lib/authCache.ts) only while the row passes this very check; forgotten with the business's tills.
  const { data, error } = await readServerRow(c.businessId, c.deviceId, (row) => !refusal(row));
  if (error) return { status: 503, error: 'The branch server could not be checked right now.', code: 'busy' };
  const why = refusal(data as ServerRow | null);
  if (why) return why;
  return { branchId: (data as ServerRow).branch_id as string };
}

/** `since` as a time the database compares (null = everything in the window). Anything unparsable is null. */
export function cleanSince(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function rowsOf<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  traffic.queries(1);
  const { data, error } = await q;
  if (error) throw new Error(`branch drawers ${what}: ${error.message}`);
  return (data ?? []) as T[];
}

const ms = (x: unknown) => (x ? Date.parse(String(x)) : Number.NaN);
/** ORDER BY closed_at DESC as Postgres does it (NULLs first). Stable for ties. */
const closedDesc = (a: any, b: any) => {
  const x = ms(a.closed_at), y = ms(b.closed_at);
  const xn = Number.isNaN(x), yn = Number.isNaN(y);
  if (xn || yn) return xn === yn ? 0 : xn ? -1 : 1;
  return y - x;
};

/**
 * The branch's drawers — open (500), closed in the last 7 days (the 500 newest), closed and awaiting a confirmation (the
 * 50 newest) — in the order the three reads gave them (open, then recent, then awaiting; each drawer once). Exported for
 * the tests: `combined` false is the three reads (the way before A593, and the fallback).
 */
export async function branchShifts(businessId: string, branchId: string, shiftFrom: string, combined = true): Promise<any[]> {
  const base = () => supabase.from('shifts').select(STATE_COLS).eq('business_id', businessId).eq('branch_id', branchId);
  let open: any[] | null = null, recent: any[] | null = null, awaiting: any[] | null = null;
  if (combined) {
    const rows = await rowsOf<any>(base()
      .or(`status.eq.open,closed_at.gte.${shiftFrom},and(confirmed_at.is.null,declared_methods.not.is.null)`)
      .limit(ROW_PAGE), 'drawers');
    if (rows.length < ROW_PAGE) {
      traffic.count('branch_drawers.shifts_one_read');
      const closed = rows.filter((s) => s.status != null && s.status !== 'open');
      open = rows.filter((s) => s.status === 'open').slice(0, 500);
      recent = closed.filter((s) => ms(s.closed_at) >= ms(shiftFrom)).sort(closedDesc).slice(0, 500);
      awaiting = closed.filter((s) => s.confirmed_at == null && s.declared_methods != null).sort(closedDesc).slice(0, AWAITING_MAX);
    }
  }
  if (!open || !recent || !awaiting) {
    [open, recent, awaiting] = await Promise.all([
      rowsOf<any>(base().eq('status', 'open').limit(500), 'open'),
      rowsOf<any>(base().neq('status', 'open').gte('closed_at', shiftFrom).order('closed_at', { ascending: false }).limit(500), 'recent'),
      rowsOf<any>(base().neq('status', 'open').is('confirmed_at', null).not('declared_methods', 'is', null)
        .order('closed_at', { ascending: false }).limit(AWAITING_MAX), 'awaiting'),
    ]);
  }
  const byId = new Map<string, any>();
  for (const s of [...open, ...recent, ...awaiting]) byId.set(String(s.id), s);
  return [...byId.values()];
}

/** A593: per business, the names read so far and the people generation they were read under. */
const namesKept = new Map<string, { gen: string; at: number; names: Map<string, string> }>();
async function namesOf(businessId: string, who: string[], nowMs: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!who.length) return out;
  let k = memoEnabled() ? namesKept.get(businessId) : undefined;
  if (k && (k.gen !== peopleGen(businessId) || nowMs - k.at >= NAMES_MAX_MS)) { namesKept.delete(businessId); k = undefined; }
  const missing = who.filter((id) => !k?.names.has(id));
  if (missing.length) {
    const gen = peopleGen(businessId);
    const rows = await rowsOf<{ id: string; name: string | null }>(supabase.from('users').select('id, name').eq('business_id', businessId).in('id', missing), 'names');
    if (memoEnabled()) {
      const keep = k ?? { gen, at: nowMs, names: new Map<string, string>() };
      // an id with no users row of this business is kept as "no name" (the answer then says null, as before)
      for (const id of missing) keep.names.set(id, '');
      for (const u of rows) keep.names.set(String(u.id), u.name ?? '');
      if (keep.gen === gen) { namesKept.delete(businessId); namesKept.set(businessId, keep); }
      while (namesKept.size > 2000) { const first = namesKept.keys().next().value; if (first === undefined) break; namesKept.delete(first); }
    }
    for (const u of rows) out.set(String(u.id), u.name ?? '');
  }
  for (const id of who) if (!out.has(id) && k?.names.has(id)) out.set(id, k.names.get(id)!);
  return out;
}

interface Beat { devices: string[]; closes: string[]; logs: Array<{ device_id: string; expires_at: string | null }>; clear: string | null }
const beatMemo = quietMemo<Beat>('branch_drawers.beat');
const answerMemo = quietMemo<DrawersAnswer>('branch_drawers.answer', { maxMs: ANSWER_MAX_MS, max: 2000 });

async function readBeat(businessId: string, branchId: string, nowIso: string): Promise<Beat> {
  // Each fail-soft, as before: a failed read is an empty list (and then not kept).
  let failed = false;
  const soft = async <T>(f: () => Promise<T[]>): Promise<T[]> => { try { return await f(); } catch { failed = true; return []; } };
  const devices = (await soft(() => rowsOf<{ device_id: string | null }>(supabase.from('user_devices').select('device_id')
    .eq('business_id', businessId).eq('branch_id', branchId).is('retired_at', null), 'devices')))
    .map((d) => d.device_id).filter((x): x is string => !!x);
  const [closes, logs, clears] = await Promise.all([
    devices.length ? soft(() => rowsOf<{ device_id: string }>(supabase.from('day_close_instructions').select('device_id')
      .eq('business_id', businessId).eq('status', 'pending').in('device_id', devices), 'day closes')) : Promise.resolve([]),
    devices.length ? soft(() => rowsOf<{ device_id: string; expires_at?: string | null }>(supabase.from('log_requests').select('device_id, expires_at')
      .eq('business_id', businessId).eq('status', 'waiting').gt('expires_at', nowIso).in('device_id', devices), 'log requests')) : Promise.resolve([]),
    soft(() => rowsOf<{ created_at: string }>(supabase.from('test_data_purges').select('created_at')
      .eq('business_id', businessId).order('created_at', { ascending: false }).limit(1), 'clears')),
  ]);
  const beat: Beat = {
    devices,
    closes: closes.map((r) => String(r.device_id)),
    logs: logs.map((r) => ({ device_id: String(r.device_id), expires_at: r.expires_at ?? null })),
    clear: clears[0]?.created_at ?? null,
  };
  return failed ? Object.assign(beat, { failed: true }) : beat;
}

/** The answer (throws on a failed read — the route answers 503, the server asks again on its next beat). */
export async function branchDrawersAnswer(businessId: string, branchId: string, sinceRaw: unknown, nowMs = quietNow()): Promise<DrawersAnswer> {
  const since = cleanSince(sinceRaw);
  const answerKey = `${branchId}|${since ?? ''}`;
  const kept = answerMemo.get(businessId, answerKey);   // A593: nothing written for the business in the last minute
  if (kept) return kept;
  const answerMark = answerMemo.mark(businessId);

  const now = new Date(nowMs);
  const shiftFrom = new Date(nowMs - SHIFT_DAYS * 86_400_000).toISOString();
  const shifts = await branchShifts(businessId, branchId, shiftFrom);

  // Names for "closed by" / "confirmed by" (as /state).
  const who = [...new Set(shifts.flatMap((s) => [s.closed_by, s.confirmed_by]).filter((x): x is string => !!x))];
  const names = await namesOf(businessId, who.map(String), nowMs);

  // Sales on the drawers that are open or closed in the last 24 h, changed after the cursor (with the overlap).
  const orderFrom = nowMs - ORDER_HOURS * 3_600_000;
  const salesShifts = shifts.filter((s) => s.status === 'open' || (s.closed_at && Date.parse(s.closed_at) >= orderFrom)).map((s) => String(s.id));
  let orders: any[] = [];
  let more = false;
  if (salesShifts.length) {
    let q = supabase.from('orders').select(ORDER_COLS).eq('business_id', businessId).eq('branch_id', branchId)
      .in('shift_id', salesShifts).in('status', ['completed', 'voided']);
    if (since) q = q.gt('updated_at', new Date(Date.parse(since) - OVERLAP_MS).toISOString());
    orders = await rowsOf<any>(q.order('updated_at', { ascending: true }).limit(ORDERS_PAGE), 'orders');
    more = orders.length >= ORDERS_PAGE;
    for (const o of orders) {
      o.order_items = o.order_items ?? [];
      // The close's arithmetic: completed and refunded rows only (a pending M-Pesa push is not money) — as foreign-orders.
      o.payments = (o.payments ?? []).filter((p: { status?: string }) => p.status === 'completed' || p.status === 'refunded');
    }
  }
  const newest = orders.reduce<string | null>((m, o) => (o.updated_at && (!m || o.updated_at > m) ? o.updated_at : m), null);

  // The beat: who has a remote day close or a log request waiting; the newest test-data clear. Each fail-soft.
  // A593: kept while nothing is written for the business (≤ 5 min); a failed read is not kept.
  const nowIso = now.toISOString();
  const beat = await beatMemo.through(businessId, branchId, () => readBeat(businessId, branchId, nowIso), (b) => !(b as { failed?: boolean }).failed);
  const logsWaiting = beat.logs.filter((r) => !r.expires_at || Date.parse(r.expires_at) > nowMs);   // the expiry, at THIS ask

  const answer: DrawersAnswer = {
    branch_id: branchId,
    at: nowIso,
    cursor: newest ?? since,
    ...(more ? { more: true } : {}),
    shifts: shifts.map((s) => ({
      ...s,
      closed_by_name: s.closed_by ? names.get(String(s.closed_by)) || null : null,
      confirmed_by_name: s.confirmed_by ? names.get(String(s.confirmed_by)) || null : null,
    })),
    orders,
    beat: {
      day_close_devices: [...new Set(beat.closes)],
      log_request_devices: [...new Set(logsWaiting.map((r) => r.device_id))],
      test_clear_latest: beat.clear,
    },
  };
  answerMemo.set(businessId, answerKey, answer, answerMark);
  return answer;
}

/** Test seam. */
export function _resetBranchDrawersMemo(): void { namesKept.clear(); beatMemo.forget(); answerMemo.forget(); }
