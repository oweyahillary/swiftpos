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
 */
import { supabase } from './supabase';
import { traffic } from './trafficStats';

export const SHIFT_DAYS = 7;
export const ORDER_HOURS = 24;
export const OVERLAP_MS = 120_000;
export const ORDERS_PAGE = 2000;
export const AWAITING_MAX = 50;

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

/** The server's own branch, when the caller IS a confirmed branch server of the business; else why not. */
export async function serverBranch(c: DrawersCaller): Promise<{ branchId: string } | DrawersRefusal> {
  if (!c.isTill || c.surface !== 'desktop' || !c.deviceId) {
    return { status: 403, error: 'Only a branch server asks for its branch drawers.', code: 'not_a_server' };
  }
  traffic.queries(1);
  const { data, error } = await supabase.from('user_devices')
    .select('branch_id, device_role, status, role_confirmed_at, retired_at')
    .eq('business_id', c.businessId).eq('device_id', c.deviceId).maybeSingle();
  if (error) return { status: 503, error: 'The branch server could not be checked right now.', code: 'busy' };
  const d = data as { branch_id?: string | null; device_role?: string | null; status?: string; role_confirmed_at?: string | null; retired_at?: string | null } | null;
  if (!d || d.status !== 'approved' || d.retired_at || !['node', 'office'].includes(String(d.device_role ?? '')) || !d.role_confirmed_at) {
    return { status: 403, error: 'This machine is not confirmed as the branch server.', code: 'not_confirmed_server' };
  }
  if (!d.branch_id) return { status: 409, error: 'This branch server is not bound to a branch.', code: 'no_branch' };
  return { branchId: d.branch_id };
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

/** The answer (throws on a failed read — the route answers 503, the server asks again on its next beat). */
export async function branchDrawersAnswer(businessId: string, branchId: string, sinceRaw: unknown, nowMs = Date.now()): Promise<DrawersAnswer> {
  const since = cleanSince(sinceRaw);
  const now = new Date(nowMs);
  const shiftFrom = new Date(nowMs - SHIFT_DAYS * 86_400_000).toISOString();
  const base = () => supabase.from('shifts').select(STATE_COLS).eq('business_id', businessId).eq('branch_id', branchId);
  const [open, recent, awaiting] = await Promise.all([
    rowsOf<any>(base().eq('status', 'open').limit(500), 'open'),
    rowsOf<any>(base().neq('status', 'open').gte('closed_at', shiftFrom).order('closed_at', { ascending: false }).limit(500), 'recent'),
    rowsOf<any>(base().neq('status', 'open').is('confirmed_at', null).not('declared_methods', 'is', null)
      .order('closed_at', { ascending: false }).limit(AWAITING_MAX), 'awaiting'),
  ]);
  const byId = new Map<string, any>();
  for (const s of [...open, ...recent, ...awaiting]) byId.set(String(s.id), s);
  const shifts = [...byId.values()];

  // Names for "closed by" / "confirmed by" (as /state).
  const who = [...new Set(shifts.flatMap((s) => [s.closed_by, s.confirmed_by]).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (who.length) {
    for (const u of await rowsOf<{ id: string; name: string | null }>(supabase.from('users').select('id, name').eq('business_id', businessId).in('id', who), 'names')) names.set(String(u.id), u.name ?? '');
  }

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
  const soft = async <T>(f: () => Promise<T[]>): Promise<T[]> => { try { return await f(); } catch { return []; } };
  const devices = (await soft(() => rowsOf<{ device_id: string | null }>(supabase.from('user_devices').select('device_id')
    .eq('business_id', businessId).eq('branch_id', branchId).is('retired_at', null), 'devices')))
    .map((d) => d.device_id).filter((x): x is string => !!x);
  const [closes, logs, clears] = await Promise.all([
    devices.length ? soft(() => rowsOf<{ device_id: string }>(supabase.from('day_close_instructions').select('device_id')
      .eq('business_id', businessId).eq('status', 'pending').in('device_id', devices), 'day closes')) : Promise.resolve([]),
    devices.length ? soft(() => rowsOf<{ device_id: string }>(supabase.from('log_requests').select('device_id')
      .eq('business_id', businessId).eq('status', 'waiting').gt('expires_at', now.toISOString()).in('device_id', devices), 'log requests')) : Promise.resolve([]),
    soft(() => rowsOf<{ created_at: string }>(supabase.from('test_data_purges').select('created_at')
      .eq('business_id', businessId).order('created_at', { ascending: false }).limit(1), 'clears')),
  ]);

  return {
    branch_id: branchId,
    at: now.toISOString(),
    cursor: newest ?? since,
    ...(more ? { more: true } : {}),
    shifts: shifts.map((s) => ({
      ...s,
      closed_by_name: s.closed_by ? names.get(String(s.closed_by)) || null : null,
      confirmed_by_name: s.confirmed_by ? names.get(String(s.confirmed_by)) || null : null,
    })),
    orders,
    beat: {
      day_close_devices: [...new Set(closes.map((r) => String(r.device_id)))],
      log_request_devices: [...new Set(logs.map((r) => String(r.device_id)))],
      test_clear_latest: clears[0]?.created_at ?? null,
    },
  };
}
