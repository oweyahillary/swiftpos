/**
 * supabaseMeter.ts — A591: how much this server pulls from Supabase, and who asks for it.
 *
 * Owner, 2026-10-26 (Supabase usage page): the organisation went over the Free plan's 5 GB egress last cycle and Supabase
 * restricts the projects from 20 Nov 2026 if it stays over; this cycle ran ~250-270 MB/day. Log ingestion (0.8 of 1 GB)
 * grows with the NUMBER of calls. The A528 counters (lib/trafficStats.ts) count what this server SENDS; most of the
 * Supabase egress is what it RECEIVES — rows read and filtered in Node, a job re-reading a week every hour.
 *
 * Every call the supabase-js clients make goes through `meteredFetch` (lib/supabase.ts createClient({ global: { fetch } })):
 * the answer's body is read once (supabase-js reads it whole anyway), its size is counted, and the same bytes are handed
 * back unchanged. Each call is counted against the caller's LABEL — the API route that is running (`GET /api/pos/changes`,
 * ids folded to :id) or the job (`job:watchdog`) — carried through every await by AsyncLocalStorage. No new dependency,
 * no extra request, nothing stored: hourly buckets in memory, the last 24 h on the admin System page (GET
 * /api/admin/ops/summary `traffic.supabase`). A restart starts from zero (started_at says when). One instance
 * (WEB_CONCURRENCY=1) — with more, each instance counts its own share.
 *
 *   bytes      the answer's body as supabase-js receives it (decoded — fetch inflates a gzip answer)
 *   wire       Content-Length when Supabase sent one (the compressed size of a gzip answer), else the decoded size
 *   calls      Supabase calls (each one is a line in Supabase's API logs — the log ingestion quota)
 *   api        how many requests of this route this server answered (jobs: how many runs)
 *
 * SUPABASE_METER=off turns the counting off (the fetch is then the plain one).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { noteWrite } from './writeActivity';

interface Store { label: string; quiet?: boolean }
const als = new AsyncLocalStorage<Store>();

export const HOUR_MS = 3_600_000;
export const WINDOW_HOURS = 24;
const MAX_LABELS_PER_HOUR = 300;

interface Cell { calls: number; bytes: number; wire: number; api: number; kinds: Record<string, number> }
/** hour index (ms / HOUR_MS) → label → counts. Only the last WINDOW_HOURS + 1 hours are kept. */
const hours = new Map<number, Map<string, Cell>>();
const startedAt = new Date().toISOString();
let enabled = String(process.env.SUPABASE_METER ?? '').toLowerCase() !== 'off';
let clock: () => number = () => Date.now();

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/shifts/9f…/foreign-orders?x=1 → "GET /api/shifts/:id/foreign-orders" (4 segments at most; ids and numbers folded). */
export function routeLabel(method: string, url: string): string {
  const segs = String(url || '/').split('?')[0].split('/').filter(Boolean).slice(0, 4)
    .map((s) => (UUIDISH.test(s) || /^\d+$/.test(s) || s.length > 40 || /[^a-z0-9._-]/i.test(s) ? ':id' : s.toLowerCase()));
  return `${String(method || 'GET').toUpperCase()} /${segs.join('/')}`;
}

/** Runs `fn` with every Supabase call inside it counted against `label`. `quiet`: its own table writes are not noted as
 *  writes (lib/writeActivity.ts) — for a job whose writes are only its own records (loss_alerts, notifications). */
export function withLabel<T>(label: string, fn: () => T, quiet = false): T { return als.run({ label, quiet }, fn); }
export function currentLabel(): string { return als.getStore()?.label ?? 'background'; }

/** The job wrapper: `cron.schedule(expr, meterJob('watchdog', run))` — each run counted, its calls labelled job:<name>. */
export function meterJob<A extends unknown[], R>(name: string, fn: (...a: A) => R, opts: { quietWrites?: boolean } = {}): (...a: A) => R {
  const label = `job:${name}`;
  return (...a: A) => withLabel(label, () => { if (enabled) cell(label).api++; return fn(...a); }, opts.quietWrites === true);
}

function cell(label: string, now = clock()): Cell {
  const h = Math.floor(now / HOUR_MS);
  let m = hours.get(h);
  if (!m) {
    m = new Map(); hours.set(h, m);
    for (const k of [...hours.keys()]) if (k <= h - WINDOW_HOURS - 1) hours.delete(k);
  }
  let key = label;
  if (!m.has(key) && m.size >= MAX_LABELS_PER_HOUR) key = 'other';
  let c = m.get(key);
  if (!c) { c = { calls: 0, bytes: 0, wire: 0, api: 0, kinds: {} }; m.set(key, c); }
  return c;
}

/** rest (PostgREST tables), rpc, auth, storage, functions, other — from the call's URL. */
export function callKind(url: string): string {
  const p = (() => { try { return new URL(url).pathname; } catch { return String(url); } })();
  if (p.startsWith('/rest/v1/rpc/')) return 'rpc';
  if (p.startsWith('/rest/v1/')) return 'rest';
  if (p.startsWith('/auth/v1/')) return 'auth';
  if (p.startsWith('/storage/v1/')) return 'storage';
  if (p.startsWith('/functions/v1/')) return 'functions';
  return 'other';
}

/** Counts one Supabase call. Exported for the tests and for a caller that reads Supabase without fetch. */
export function recordCall(label: string, kind: string, bytes: number, wire: number): void {
  if (!enabled) return;
  const c = cell(label);
  c.calls++;
  c.bytes += Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  c.wire += Number.isFinite(wire) && wire > 0 ? wire : 0;
  c.kinds[kind] = (c.kinds[kind] ?? 0) + 1;
}

/** One API request answered under this label (the Express middleware below). */
export function recordApi(label: string): void { if (enabled) cell(label).api++; }

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
type FetchLike = (input: any, init?: any) => Promise<Response>;

/**
 * The fetch the Supabase clients use. Reads the answer once, counts it, returns a Response with the same status, headers
 * and bytes. A failed fetch (no answer) is counted as a call of 0 bytes and rethrown unchanged.
 */
export function meteredFetch(base?: FetchLike): FetchLike {
  return async (input: any, init?: any): Promise<Response> => {
    const f: FetchLike = base ?? ((i, o) => globalThis.fetch(i, o));
    const label = currentLabel();
    const url = typeof input === 'string' ? input : String(input?.url ?? input?.href ?? input);
    const kind = callKind(url);
    // A table write made by a job, a timer or a GET route: every remembered answer is read again (lib/writeActivity.ts).
    // A POST/PUT/PATCH/DELETE request's writes are counted when it finishes, for its business. (An rpc is not counted:
    // the 5 s change-log read is one, and the only rpc a job writes with prunes the change log.)
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    // Noted before (a read made meanwhile is not taken as current) and after (nor one made before it committed).
    const jobWrite = !als.getStore()?.quiet && kind === 'rest' && method !== 'GET' && method !== 'HEAD' && !/^(POST|PUT|PATCH|DELETE) \//.test(label);
    if (jobWrite) noteWrite(null);
    if (!enabled) { try { return await f(input, init); } finally { if (jobWrite) noteWrite(null); } }
    let res: Response;
    try { res = await f(input, init); } catch (e) { recordCall(label, kind, 0, 0); throw e; } finally { if (jobWrite) noteWrite(null); }
    if (!res.body || NULL_BODY.has(res.status)) { recordCall(label, kind, 0, 0); return res; }
    const buf = await res.arrayBuffer();
    const len = Number(res.headers.get('content-length'));
    recordCall(label, kind, buf.byteLength, Number.isFinite(len) && len > 0 ? len : buf.byteLength);
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** Express: every request's Supabase calls carry its route label; the request itself is counted under it. */
export function labelRequests(req: { method: string; originalUrl?: string; url?: string }, _res: unknown, next: () => void): void {
  const label = routeLabel(req.method, req.originalUrl || req.url || '/');
  recordApi(label);
  withLabel(label, next);
}

export interface MeterRow { label: string; calls: number; bytes: number; wire: number; api: number; kinds: Record<string, number> }
export interface MeterSnapshot {
  started_at: string;
  window_hours: number;
  /** the hours actually covered (less than 24 after a restart) */
  covered_hours: number;
  totals: { calls: number; bytes: number; wire: number };
  /** the window's totals scaled to a day (covered_hours < 24 → an estimate) */
  per_day: { calls: number; bytes: number; wire: number };
  rows: MeterRow[];
  enabled: boolean;
}

/** The last 24 h, largest first (by bytes). `top` rows, the rest summed as "(the rest)". */
export function meterSnapshot(top = 40, now = clock()): MeterSnapshot {
  const h = Math.floor(now / HOUR_MS);
  const sum = new Map<string, MeterRow>();
  for (const [k, m] of hours) {
    if (k <= h - WINDOW_HOURS) continue;
    for (const [label, c] of m) {
      const r = sum.get(label) ?? { label, calls: 0, bytes: 0, wire: 0, api: 0, kinds: {} };
      r.calls += c.calls; r.bytes += c.bytes; r.wire += c.wire; r.api += c.api;
      for (const [kk, v] of Object.entries(c.kinds)) r.kinds[kk] = (r.kinds[kk] ?? 0) + v;
      sum.set(label, r);
    }
  }
  const all = [...sum.values()].sort((a, b) => b.bytes - a.bytes || b.calls - a.calls);
  const totals = all.reduce((t, r) => ({ calls: t.calls + r.calls, bytes: t.bytes + r.bytes, wire: t.wire + r.wire }), { calls: 0, bytes: 0, wire: 0 });
  const startMs = Date.parse(startedAt);
  const coveredMs = Math.max(60_000, Math.min(WINDOW_HOURS * HOUR_MS, now - (Number.isFinite(startMs) ? startMs : now)));
  const scale = (WINDOW_HOURS * HOUR_MS) / coveredMs;
  const rows = all.slice(0, top);
  if (all.length > top) {
    const rest = all.slice(top).reduce<MeterRow>((t, r) => ({ ...t, calls: t.calls + r.calls, bytes: t.bytes + r.bytes, wire: t.wire + r.wire, api: t.api + r.api }),
      { label: '(the rest)', calls: 0, bytes: 0, wire: 0, api: 0, kinds: {} });
    rows.push(rest);
  }
  return {
    started_at: startedAt,
    window_hours: WINDOW_HOURS,
    covered_hours: Math.round((coveredMs / HOUR_MS) * 10) / 10,
    totals,
    per_day: { calls: Math.round(totals.calls * scale), bytes: Math.round(totals.bytes * scale), wire: Math.round(totals.wire * scale) },
    rows,
    enabled,
  };
}

/** Test seams. */
export function _resetMeter(): void { hours.clear(); }
export function _setMeterClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }
export function _setMeterEnabled(on: boolean): void { enabled = on; }
