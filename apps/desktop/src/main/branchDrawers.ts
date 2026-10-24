/**
 * branchDrawers.ts — A535: at a branch with a server, only the server asks the cloud about the branch's drawers.
 *
 * Owner, 2026-10-19: "for a setup like KRUNCH only the server does the communication to cloud, not all tills". After A531
 * the menu, staff and settings reached the tills through their server, but each till still asked the cloud — through the
 * server's gateway (A410), one request at a time — about its OWN drawers: the web's sales on them (20 s), whether the web
 * closed them (20 s, and again on the 90 s beat), whether a manager confirmed them (20 s), and on the 90 s beat the remote
 * day closes, the test-data clears and ZapTill support's log requests. A 4-till branch with every drawer open: ≈ 2,000
 * cloud requests an hour.
 *
 * Now:
 *   the branch server  asks GET /api/pos/branch-drawers once a beat for the WHOLE branch — every 60 s while its push
 *                      channel is up (a drawer changed on the web rings it: { type: 'changed', topics: ['drawers'] }, and
 *                      it asks at once), 20 s while the channel is down and a drawer is open (or a till asked lately),
 *                      60 s otherwise; the sales come incrementally (a cursor), the whole window again every 30 minutes.
 *                      It keeps the answer in memory and answers its own drawer checks from it — no cloud call of its own.
 *   a till behind it   asks the server on the shop network (POST /node/drawers — free) the same three questions; the server
 *                      answers from its copy, only about the till's OWN drawers (the device it proved). The web's sales and
 *                      own reversals are picked with the till's own sale ids exactly as the cloud's foreign-orders does.
 *                      Its 90 s beat asks its own day-close / log-request routes only when the server names it, and the
 *                      test-data clears only when the server knows a newer one.
 *   fallback           no branch server, a server older than this (its 404), a server whose cloud has no such route (its
 *                      404, asked again in an hour), or a copy too old (503): the till asks the cloud as before (A401,
 *                      A433, cross-sync stage 1) — never stranded.
 */
import { getDeviceConfig, isNodeRole } from './deviceConfig';
import { logLine } from './logFile';
import { lanFetch } from './lanTls';
import { nodeUrl, nodeHeaders } from './nodeClient';
import { liveCloudGet, setDrawerSource, type DrawerSource, type DrawerBeat, type DrawerWebSales } from './syncEngine';
import { liveStatus, openDrawers, setDrawersBell, notePeerLogRequest } from './liveSync';
import type { CloudShiftState } from './remoteShiftClose';
import type { WebOrder, OwnReversal } from './webSales';

export const BEAT_SOCKET_UP_MS = 60_000;
export const BEAT_BUSY_MS = 20_000;
export const BEAT_IDLE_MS = 60_000;
export const FULL_EVERY_MS = 30 * 60_000;
export const PEER_ASKED_KEEP_MS = 120_000;
export const UNSUPPORTED_WAIT_MS = 60 * 60_000;
const TICK_MS = 5_000;
const MAX_PAGES = 5;

type Beat = { day_close_devices: string[]; log_request_devices: string[]; test_clear_latest: string | null };
interface Copy {
  shifts: Map<string, any>;
  orders: Map<string, Map<string, any>>;
  beat: Beat;
  cursor: string | null;
  okAt: number;
  fullAt: number;
}
const empty = (): Copy => ({ shifts: new Map(), orders: new Map(), beat: { day_close_devices: [], log_request_devices: [], test_clear_latest: null }, cursor: null, okAt: 0, fullAt: 0 });
let copy: Copy = empty();
let unsupportedUntil = 0;
let lastPollAt = 0;
let lastPeerAskAt = 0;
let polling: Promise<boolean> | null = null;
let again = false;
let timer: NodeJS.Timeout | null = null;
let lastError = '';
let peerUnsupportedUntil = 0;
let polls = 0;
let lastPollOk: boolean | null = null;   // A542: the last poll's outcome, for the Tech page
const peerAsks = new Map<string, number>();   // A542: device → when it last asked (/node/drawers), for the Tech page

const isServer = (): boolean => isNodeRole(getDeviceConfig()?.device_role ?? null);
const isPeer = (): boolean => !isServer() && !!nodeUrl();
const ownId = (): string => getDeviceConfig()?.device_id ?? '';
const socketUp = (): boolean => { try { return liveStatus().channel === 'push'; } catch { return false; } };

/** How often the server asks now. */
export function beatMs(now = Date.now()): number {
  if (socketUp()) return BEAT_SOCKET_UP_MS;
  const busy = openDrawers() > 0 || now - lastPeerAskAt < PEER_ASKED_KEEP_MS;
  return busy ? BEAT_BUSY_MS : BEAT_IDLE_MS;
}
/** The copy is young enough to answer from (two and a half beats). */
function fresh(now: number): boolean { return copy.okAt > 0 && now - copy.okAt <= beatMs(now) * 2.5; }

// ── the server: one call for the whole branch ───────────────────────────────────────────────────────────────────────
async function pollOnce(why: string, now: number): Promise<boolean> {
  if (!isServer() || now < unsupportedUntil) return false;
  lastPollAt = now;
  lastPollOk = false;   // A542: true only when this poll gets to its end
  const full = !copy.fullAt || now - copy.fullAt >= FULL_EVERY_MS;
  let cursor = full ? null : copy.cursor;
  const next: Copy = full ? { ...empty(), fullAt: now } : { ...copy, orders: copy.orders };
  let changedSales = 0; let nowClosed = 0; let pages = 0;
  try {
    for (; pages < MAX_PAGES; pages++) {
      const res = await liveCloudGet(`/api/pos/branch-drawers${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`);
      polls++;
      if (res.status === 404 || res.status === 403 || res.status === 409) {
        unsupportedUntil = now + UNSUPPORTED_WAIT_MS;
        copy = empty();
        logLine('sync', `A535: the cloud does not answer the branch's drawers in one call (HTTP ${res.status}) — each till asks about its own, as before (asked again in an hour)`);
        return false;
      }
      if (!res.ok) { lastError = `branch drawers: HTTP ${res.status}`; return false; }
      const body = await res.json() as { shifts?: any[]; orders?: any[]; cursor?: string | null; more?: boolean; beat?: Partial<Beat> };
      // The drawers: the whole list every time (open, closed in 7 days, waiting for a confirmation).
      const shifts = new Map<string, any>();
      for (const s of body.shifts ?? []) {
        if (!s?.id) continue;
        const had = copy.shifts.get(String(s.id));
        if (had && had.status === 'open' && s.status !== 'open') nowClosed++;
        shifts.set(String(s.id), s);
      }
      next.shifts = shifts;
      for (const o of body.orders ?? []) {
        if (!o?.id || !o.shift_id) continue;
        const per = next.orders.get(String(o.shift_id)) ?? new Map<string, any>();
        const had = per.get(String(o.id));
        if (!had || had.updated_at !== o.updated_at) changedSales++;
        per.set(String(o.id), o);
        next.orders.set(String(o.shift_id), per);
      }
      for (const id of [...next.orders.keys()]) if (!shifts.has(id)) next.orders.delete(id);
      const prevLogs = new Set(copy.beat.log_request_devices);
      next.beat = {
        day_close_devices: Array.isArray(body.beat?.day_close_devices) ? body.beat!.day_close_devices.map(String) : [],
        log_request_devices: Array.isArray(body.beat?.log_request_devices) ? body.beat!.log_request_devices.map(String) : [],
        test_clear_latest: typeof body.beat?.test_clear_latest === 'string' ? body.beat.test_clear_latest : null,
      };
      // A log request newly waiting for one of this server's tills: passed on at its next /node/live (A533's bell).
      for (const d of next.beat.log_request_devices) if (!prevLogs.has(d) && d !== ownId()) notePeerLogRequest(d, now);
      cursor = body.cursor ?? cursor;
      next.cursor = cursor;
      if (!body.more) break;
    }
    next.okAt = Date.now();
    copy = next;
    lastError = '';
    lastPollOk = true;
    if (full || changedSales || nowClosed) {
      logLine('sync', `A535: the branch's drawers from the cloud in one call (${why}${full ? ', the whole window' : ''}) — ${copy.shifts.size} drawer(s), ${changedSales} sale(s) changed, ${nowClosed} closed on the cloud`);
    }
    return true;
  } catch (e: any) {
    lastError = e?.message ?? String(e);
    return false;
  }
}

/** Ask now (single-flight: a ring during a poll gets one more poll after it). */
export function pollBranchDrawers(why = 'asked'): Promise<boolean> {
  if (polling) { again = true; return polling; }
  polling = (async () => {
    let ok = false;
    do { again = false; ok = await pollOnce(why, Date.now()); } while (again);
    return ok;
  })().finally(() => { polling = null; });
  return polling;
}

/** The server's beat (every TICK_MS; asks when its interval has passed). */
export async function drawersTick(now = Date.now()): Promise<void> {
  if (!isServer() || now < unsupportedUntil) return;
  if (now - lastPollAt >= beatMs(now)) await pollBranchDrawers('the beat');
}

// ── answers: the server's own checks and /node/drawers ──────────────────────────────────────────────────────────────
export interface DrawersAsk { state_ids?: unknown; web_shift?: { id?: unknown; own_ids?: unknown } | null; beat?: unknown }
const UUID = /^[0-9a-f-]{36}$/i;

/** The till `device`'s answers from this server's copy. 404: this server does not answer (its cloud is older); 503: stale. */
export function answerDrawers(device: string, ask: DrawersAsk, o: { self?: boolean; now?: number } = {}): { status: number; body: any } {
  const now = o.now ?? Date.now();
  if (!isServer()) return { status: 404, body: { error: 'not a branch server', code: 'DRAWERS_UNAVAILABLE' } };
  if (now < unsupportedUntil) return { status: 404, body: { error: 'This branch server\'s cloud does not answer the branch\'s drawers in one call - ask it yourself.', code: 'DRAWERS_UNAVAILABLE' } };
  if (!o.self) {
    lastPeerAskAt = now;
    if (device) { peerAsks.delete(device); peerAsks.set(device, now); if (peerAsks.size > 200) peerAsks.delete(peerAsks.keys().next().value as string); }   // A542
  }
  if (!fresh(now)) {
    void pollBranchDrawers('a POS asked').catch(() => false);
    return { status: 503, body: { error: 'The branch server is fetching the drawers - ask the cloud this time.', code: 'DRAWERS_STALE' } };
  }
  const out: Record<string, unknown> = { at: new Date(copy.okAt).toISOString() };
  if (Array.isArray(ask.state_ids)) {
    const ids = ask.state_ids.map(String).filter((x) => UUID.test(x)).slice(0, 50);
    out.states = ids.map((id) => copy.shifts.get(id)).filter((s) => s && String(s.device_id ?? '') === device);
  }
  if (ask.web_shift && typeof ask.web_shift === 'object') {
    const id = String(ask.web_shift.id ?? '');
    const s = copy.shifts.get(id);
    if (!s || String(s.device_id ?? '') !== device) out.web = 'unknown';
    else {
      const own = Array.isArray(ask.web_shift.own_ids) ? ask.web_shift.own_ids.filter((x): x is string => typeof x === 'string').slice(0, 20_000) : [];
      const rows = [...(copy.orders.get(id)?.values() ?? [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      out.web = { orders: foreignOrders(rows, own), own_reversals: ownReversals(rows, own) };
    }
  }
  if (ask.beat) {
    out.beat = { day_close: copy.beat.day_close_devices.includes(device), log_request: copy.beat.log_request_devices.includes(device),
      test_clear_latest: copy.beat.test_clear_latest } satisfies DrawerBeat;
  }
  return { status: 200, body: out };
}

/** The sales on a drawer the till did not ring (as the cloud's lib/foreignCash.ts foreignOrders). */
export function foreignOrders(orders: any[], ownIds: string[]): WebOrder[] {
  const own = new Set(ownIds);
  return orders.filter((o) => (o.status === 'completed' || o.status === 'voided') && !own.has(o.id) && !(o.idempotency_key && own.has(o.idempotency_key)))
    .map((o) => ({ ...o, order_items: o.order_items ?? [], payments: (o.payments ?? []).filter((p: any) => p.status === 'completed' || p.status === 'refunded') }));
}
/** The till's own sales the cloud voided or refunded (as lib/foreignCash.ts ownReversals). */
export function ownReversals(orders: any[], ownIds: string[]): OwnReversal[] {
  const own = new Set(ownIds);
  const out: OwnReversal[] = [];
  for (const o of orders) {
    const localId = o.idempotency_key && own.has(o.idempotency_key) ? o.idempotency_key : own.has(o.id) ? o.id : null;
    if (!localId) continue;
    const refunded = Number(o.refunded_amount ?? 0) || 0;
    if (o.status !== 'voided' && !(refunded > 0)) continue;
    out.push({
      local_id: localId, status: o.status === 'voided' ? 'voided' : 'completed',
      voided_at: o.voided_at ?? null, void_reason: o.void_reason ?? null,
      refunded_at: o.refunded_at ?? null, refunded_amount: refunded, refund_reason: o.refund_reason ?? null,
      refund_payments: (o.payments ?? []).filter((p: any) => p.status === 'refunded' && Number(p.amount) < 0)
        .map((p: any) => ({ id: String(p.id), method: String(p.method), amount: Number(p.amount), created_at: p.created_at ?? null })),
    });
  }
  return out;
}

// ── the till's side: ask the server (or, on the server, its own copy) ───────────────────────────────────────────────
async function askServer(ask: DrawersAsk): Promise<any | null> {
  const base = nodeUrl();
  const now = Date.now();
  if (!base || now < peerUnsupportedUntil) return null;
  try {
    const res = await lanFetch(`${base}/node/drawers`, {
      method: 'POST', headers: nodeHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(ask), signal: AbortSignal.timeout(8_000),
    } as any);
    if (res.status === 404) {
      peerUnsupportedUntil = now + UNSUPPORTED_WAIT_MS;
      logLine('sync', 'A535: the branch server does not answer drawer checks (an older server, or its cloud) — this till asks the cloud through it, as before (asked again in an hour)');
      return null;
    }
    if (!res.ok) return null;   // stale (503), refused, … — this call goes the old way
    return await res.json();
  } catch { return null; }
}
async function ask(a: DrawersAsk): Promise<any | null> {
  if (isServer()) { const r = answerDrawers(ownId(), a, { self: true }); return r.status === 200 ? r.body : null; }
  if (!isPeer()) return null;
  return askServer(a);
}

export const drawerSource: DrawerSource = {
  async states(ids: string[]): Promise<CloudShiftState[] | null> {
    const b = await ask({ state_ids: ids });
    return Array.isArray(b?.states) ? b.states as CloudShiftState[] : null;
  },
  async webSales(shiftId: string, ownIds: string[]): Promise<DrawerWebSales | null> {
    const b = await ask({ web_shift: { id: shiftId, own_ids: ownIds } });
    if (b?.web === 'unknown') return 'unknown';
    if (b?.web && typeof b.web === 'object' && Array.isArray(b.web.orders)) return { orders: b.web.orders, own_reversals: Array.isArray(b.web.own_reversals) ? b.web.own_reversals : [] };
    return null;
  },
  async beat(): Promise<DrawerBeat | null> {
    const b = await ask({ beat: true });
    const v = b?.beat;
    return v && typeof v === 'object' ? { day_close: v.day_close === true, log_request: v.log_request === true, test_clear_latest: typeof v.test_clear_latest === 'string' ? v.test_clear_latest : null } : null;
  },
};

export interface DrawersStatus {
  role: 'server' | 'peer' | 'direct'; mode: string; drawers: number; lastOkAt: string | null; polls: number; error: string | null;
  /** A542 (the branch server's Tech page): the last poll — when, and whether it got to its end. */
  lastPollAt: string | null; lastPollOk: boolean | null;
  /** The drawers held: open, and closed but still waiting for a manager's confirmation. */
  open: number; awaitingConfirmation: number;
  /** The tills that asked this server (/node/drawers) in the last hour. */
  peersLastHour: number;
  /** The push channel (A531 liveSync): 'push' = the cloud rings; otherwise the beat runs on the shorter fallback. */
  channel: string;
  /** On the fallback path: each till asks the cloud itself (an older cloud, or the copy too old to answer from). */
  fallback: boolean; fallbackUntil: string | null; fresh: boolean;
}
const HOUR_MS = 3_600_000;

/** The Tech page / the log pull: how the drawer checks go. */
export function drawersStatus(now = Date.now()): DrawersStatus {
  const role = isServer() ? 'server' : isPeer() ? 'peer' : 'direct';
  const mode = role === 'server' ? (now < unsupportedUntil ? 'each POS asks (older cloud)' : `one call for the branch every ${Math.round(beatMs(now) / 1000)} s`)
    : role === 'peer' ? (now < peerUnsupportedUntil ? 'through the gateway (older server)' : 'from the branch server') : 'the cloud';
  // A542: what the branch server's Tech page shows (DrawersCopyPanel).
  let open = 0, awaiting = 0;
  for (const s of copy.shifts.values()) {
    if (s?.status === 'open') open++;
    else if (!s?.confirmed_at) awaiting++;
  }
  let peersLastHour = 0;
  for (const at of peerAsks.values()) if (now - at < HOUR_MS) peersLastHour++;
  let channel = 'off';
  try { channel = liveStatus().channel; } catch { channel = 'off'; }
  const until = role === 'server' ? unsupportedUntil : role === 'peer' ? peerUnsupportedUntil : 0;
  return {
    role, mode, drawers: copy.shifts.size, lastOkAt: copy.okAt ? new Date(copy.okAt).toISOString() : null, polls, error: lastError || null,
    lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null, lastPollOk,
    open, awaitingConfirmation: awaiting, peersLastHour, channel,
    fallback: now < until, fallbackUntil: now < until ? new Date(until).toISOString() : null, fresh: fresh(now),
  };
}

export function startBranchDrawers(): void {
  if (timer) return;
  setDrawerSource(drawerSource);
  setDrawersBell((why) => { void pollBranchDrawers(why).catch(() => false); });
  timer = setInterval(() => { void drawersTick().catch(() => { /* next beat */ }); }, TICK_MS);
  timer.unref?.();
}
export function stopBranchDrawers(): void {
  if (timer) clearInterval(timer);
  timer = null;
  setDrawerSource(null); setDrawersBell(null);
}

/** Tests only. */
export function _resetBranchDrawers(): void {
  copy = empty(); unsupportedUntil = 0; lastPollAt = 0; lastPeerAskAt = 0; polling = null; again = false; lastError = '';
  peerUnsupportedUntil = 0; polls = 0; lastPollOk = null; peerAsks.clear();
}
