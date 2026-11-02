/**
 * backfill.ts — A602: "going online later". The rules of POST /api/sync/backfill (routes/backfill.ts).
 *
 * Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 6): a desktop-only business that buys the online licence
 * (or is given the cloud_backup flag) has a year or more of sales queued on its POS. The normal push sends them one call
 * per sale, 50 per pass, oldest first — days of uploading, today's sales last, hundreds of thousands of calls and log
 * lines. Decided: new sales first (the POS's normal push, from the last 48 hours); the history as a bulk backfill in quiet
 * hours, as far back as the owner chooses; interruptions safe.
 *
 * One backfill call carries up to BACKFILL_MAX_SALES sales (each its /api/orders body and its order id) plus the drawers,
 * days, floats, expenses and kitchen voids they need, gzip'd. The cloud writes the cash rows through the /api/sync/push
 * handler and each sale through the /api/orders handler (lib/internalCall.ts) — the same validation, the same idempotency
 * (the order id is the X-Idempotency-Key: a sale sent twice is a duplicate), the same effects — and answers each sale
 * accepted, duplicate, waiting (its drawer is not on the cloud: 424, as the normal push), refused (with its HTTP status
 * and words) or later (the cloud could not reach it this call: a 5xx, the time budget). One call, one log line.
 */
import express from 'express';
import type { Request } from 'express';

/** Sales per call (the POS sends at most this many). */
export const BACKFILL_MAX_SALES = 500;
/** Rows per cash table per call. */
export const BACKFILL_MAX_CASH_ROWS = 2000;
/** The body's size once inflated (express.json inflates gzip / deflate and applies the limit to what it inflates, so a
 *  small gzip that inflates past this is refused too). The POS halves a batch that would pass 8 MB. */
export const BACKFILL_JSON_LIMIT = '12mb';
export const BACKFILL_JSON_LIMIT_BYTES = 12 * 1024 * 1024;
/** Sales written side by side (each is the normal push's ~10-20 database calls; one at a time would take minutes). */
export const BACKFILL_CONCURRENCY = 6;
/** The cloud stops starting sales after this long and answers the rest "later" (a branch server's gateway waits 60 s). */
export const BACKFILL_BUDGET_MS = 40_000;

/** The body parser for /api/sync/backfill — mounted before the app's 1 MB one (index.ts), which then leaves it alone. */
export const backfillBodyParser = express.json({ limit: BACKFILL_JSON_LIMIT });

/** What createOrder keeps quiet during a backfill (one summary line instead of a line per sale). */
export interface BackfillQuiet { knownNew: boolean; repriced: number; cashierClaims: number }
const QUIET = Symbol.for('zaptill.a602.backfillQuiet');
export const BACKFILL_QUIET_KEY: symbol = QUIET;
/** The backfill's marks on one sale's request, or null for every normal request. */
export function backfillQuiet(req: Request | unknown): BackfillQuiet | null {
  const v = (req as Record<symbol, unknown> | null | undefined)?.[QUIET];
  return v && typeof v === 'object' ? v as BackfillQuiet : null;
}

export type SaleOutcome = 'accepted' | 'duplicate' | 'waiting' | 'refused' | 'later';
export interface SaleResult { id: string; status: SaleOutcome; http: number; orderId?: string; code?: string; error?: string }

/** The /api/orders handler's answer for one sale, as the POS's normal push reads it (syncEngine pushPendingOrders). Pure. */
export function classifySaleAnswer(status: number, body: any): SaleOutcome {
  const ok = status >= 200 && status < 300;
  if (ok && body?.duplicate === true) return 'duplicate';
  if (ok && (typeof body?.orderId === 'string' || typeof body?.id === 'string')) return 'accepted';
  if (ok) return 'later';                                         // F14: a 2xx without the order is not proof it is stored
  if (status === 424) return 'waiting';                            // A338: its drawer is not on the cloud yet
  if (status >= 500 || status === 429 || status === 408 || status === 401) return 'later';   // A446: passing, not the sale's
  return 'refused';
}

export type BackfillBody = {
  orders: { id: string; body: Record<string, unknown> }[];
  cash: { business_days: unknown[]; shifts: unknown[]; floats: unknown[]; expenses: unknown[]; kitchen_voids: unknown[] };
};
const CASH_KEYS = ['business_days', 'shifts', 'floats', 'expenses', 'kitchen_voids'] as const;

/** The body, checked. Pure. */
export function readBackfillBody(b: unknown): { ok: true; value: BackfillBody } | { ok: false; status: number; code: string; error: string } {
  const bad = (status: number, code: string, error: string) => ({ ok: false as const, status, code, error });
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad(400, 'BACKFILL_INVALID', 'The history upload could not be read.');
  const o = b as Record<string, unknown>;
  const orders = o.orders === undefined ? [] : o.orders;
  if (!Array.isArray(orders)) return bad(400, 'BACKFILL_INVALID', 'orders must be a list.');
  if (orders.length > BACKFILL_MAX_SALES) return bad(413, 'BACKFILL_TOO_MANY', `At most ${BACKFILL_MAX_SALES} sales per upload (this one has ${orders.length}).`);
  const seen = new Set<string>();
  const out: BackfillBody['orders'] = [];
  for (const x of orders) {
    const id = (x as { id?: unknown })?.id; const body = (x as { body?: unknown })?.body;
    if (typeof id !== 'string' || !id.trim() || id.length > 100 || !body || typeof body !== 'object' || Array.isArray(body)) {
      return bad(400, 'BACKFILL_INVALID', 'Each sale needs its order id and its body.');
    }
    if (seen.has(id)) return bad(400, 'BACKFILL_INVALID', `Sale ${id.slice(0, 40)} is in this upload twice.`);
    seen.add(id);
    out.push({ id, body: body as Record<string, unknown> });
  }
  const cash = { business_days: [] as unknown[], shifts: [] as unknown[], floats: [] as unknown[], expenses: [] as unknown[], kitchen_voids: [] as unknown[] };
  for (const k of CASH_KEYS) {
    const v = o[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) return bad(400, 'BACKFILL_INVALID', `${k} must be a list.`);
    if (v.length > BACKFILL_MAX_CASH_ROWS) return bad(413, 'BACKFILL_TOO_MANY', `At most ${BACKFILL_MAX_CASH_ROWS} ${k} per upload.`);
    cash[k] = v;
  }
  return { ok: true, value: { orders: out, cash } };
}

/**
 * Work through `items` with `n` side by side; an item not STARTED by `deadline` is answered by `late` (never half done).
 * Results in the items' order. Never throws (fn's throw is the caller's to catch).
 */
export async function inPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>, late: (x: T) => R, deadline: number, now: () => number = Date.now): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = now() >= deadline ? late(items[i]) : await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/** Counts by outcome, for the answer and the one log line. Pure. */
export function countOutcomes(r: SaleResult[]): Record<SaleOutcome, number> {
  const c: Record<SaleOutcome, number> = { accepted: 0, duplicate: 0, waiting: 0, refused: 0, later: 0 };
  for (const x of r) c[x.status]++;
  return c;
}
