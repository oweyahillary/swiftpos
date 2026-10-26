/**
 * writeActivity.ts — A591: has anything been written for this business since a remembered read?
 *
 * The polled answers that re-read the same rows every 20 s (a drawer's web sales, lib/shiftOrdersMemo.ts) and the 5 s
 * change-log read (lib/liveHub.ts) only need the database when something could have changed. Every write a client makes
 * goes through this server, so this server can tell: after any non-GET request finishes, its business's generation moves
 * (a request with no business of its own — an M-Pesa callback, an admin portal write, a webhook — moves every business);
 * a job's own write to Supabase (lib/supabaseMeter.ts sees it) moves every business too.
 *
 * A remembered answer is used only while the generation it was read under is still current AND it is younger than its own
 * short limit — so a change made directly in SQL (not through this server) is still seen within that limit.
 *
 * Not counted as writes (they write nothing those answers read): signing in or renewing (a PIN sign-in on a till is
 * frequent and names no business before it succeeds — counted, it would forget every business), uploading a support log, a till's
 * update-state report, an ops event, and the read-only POSTs (a drawer's web sales and cash — the poll itself).
 *
 * In memory, one instance (WEB_CONCURRENCY=1). With more than one instance each would see only its own writes — the
 * remembered answers must then be turned off (A591_MEMO=off) or moved to a shared store (docs: the Redis note in A591).
 */
import type { Request, Response, NextFunction } from 'express';

const biz = new Map<string, { gen: number; at: number }>();
let globalGen = 0;
let globalAt = 0;
let lastAny = 0;
let clock: () => number = () => Date.now();
const MAX = 20_000;

/** Paths whose writes touch nothing a remembered answer holds. */
const NOT_A_WRITE = /^\/api\/(auth\/(refresh|refresh\/ack|logout|verify-pin|login|pos-login|device-token|enrol\/redeem|otp\/[a-z/]+|password\/(forgot|reset))$|support\/|desktop-update\/|ops\/events|notifications\/)/;
/** Read-only POSTs (a body too long for a query string): a drawer's web sales and cash, a confirmer's PIN check. */
const READ_POST = /^\/api\/shifts\/([^/]+\/(foreign-orders|foreign-cash)|confirmer)$/;

/** Set when index.ts mounts trackWrites(): without it no write is seen, so nothing may be answered from memory on its
 *  strength (a test app, a script that mounts a router alone — the old reads, every time). */
let tracking = false;
export function memoEnabled(): boolean { return tracking && String(process.env.A591_MEMO ?? '').toLowerCase() !== 'off'; }

/** Something was written for this business (null = it may be any business). */
export function noteWrite(businessId: string | null): void {
  const now = clock();
  lastAny = now;
  if (!businessId) { globalGen++; globalAt = now; return; }
  const e = biz.get(businessId);
  biz.delete(businessId);
  biz.set(businessId, { gen: (e?.gen ?? 0) + 1, at: now });
  while (biz.size > MAX) {
    const first = biz.keys().next().value;
    if (first === undefined) break;
    biz.delete(first);
    globalGen++;   // forgetting a business's count must never make an old answer look current
  }
}

/**
 * The CATALOGUE generation — moved only by a write through a router that changes what a till keeps (products, variants,
 * modifiers, menus, settings, … — routes/index.ts forgetOnWrite({ catalogue })), by an admin portal write, and by any
 * client write with no business. A sale does not move it, nor a job's own write (no job writes variants or modifiers;
 * what a job changes in a versioned table moves the catalogue version, which /init is keyed on). For answers the catalogue version (sync_versions) does not cover:
 * /init's variants and a till's per-product choices (lib/posInit.ts, lib/choiceGroups.ts).
 */
const cat = new Map<string, number>();
let catGlobal = 0;
export function noteCatalogueWrite(businessId: string | null): void {
  if (!businessId) { catGlobal++; return; }
  cat.set(businessId, (cat.get(businessId) ?? 0) + 1);
  if (cat.size > MAX) { cat.clear(); catGlobal++; }
}
export function catalogueGen(businessId: string): string { return `${catGlobal}:${cat.get(businessId) ?? 0}`; }

/**
 * A593: the PEOPLE generation — moved only by a write through a router that changes people (routes/index.ts
 * forgetOnWrite({ staff }) / ({ people }): staff, roles, PINs, devices, admin) and by a write with no business. For the
 * closers' and confirmers' names a branch server's drawers answer carries (lib/branchDrawers.ts): a sale does not rename
 * anybody.
 */
const ppl = new Map<string, number>();
let pplGlobal = 0;
export function notePeopleWrite(businessId: string | null): void {
  if (!businessId) { pplGlobal++; return; }
  ppl.set(businessId, (ppl.get(businessId) ?? 0) + 1);
  if (ppl.size > MAX) { ppl.clear(); pplGlobal++; }
}
export function peopleGen(businessId: string): string { return `${pplGlobal}:${ppl.get(businessId) ?? 0}`; }

/**
 * A593: how long a polled answer read under a write generation may be used while nothing is written for its business
 * (lib/quietMemo.ts, the sign-in check, the cloud-plan gate). Every change a POS or the web makes comes through this
 * server and moves the generation at once; only a change made straight in SQL waits this long.
 */
export const QUIET_MAX_MS = 5 * 60_000;

/** The business's write generation — compare the one a read was made under with the current one. */
export function writeGen(businessId: string): string { return `${globalGen}:${biz.get(businessId)?.gen ?? 0}`; }

/** When the last write was seen (for this business, or for any business when none is named). 0 = none since start. */
export function lastWriteAt(businessId?: string): number {
  if (!businessId) return lastAny;
  return Math.max(globalAt, biz.get(businessId)?.at ?? 0);
}

/** Express: after a non-GET request finishes, its business's generation moves. Mounting it (index.ts) is what lets the
 *  remembered answers be used. */
export function trackWrites(): (req: Request, res: Response, next: NextFunction) => void {
  tracking = true;
  return trackWrite;
}
function trackWrite(req: Request, res: Response, next: NextFunction): void {
  const m = String(req.method).toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') { next(); return; }
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (NOT_A_WRITE.test(path) || READ_POST.test(path)) { next(); return; }
  res.on('finish', () => {
    const b = (req as { businessId?: string }).businessId ?? null;
    // Never signed in (refused before any route ran): nothing of any business was written.
    if (!b && (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429)) return;
    noteWrite(b);
    if (!b) { noteCatalogueWrite(null); notePeopleWrite(null); }
  });
  next();
}

/** Test seams. */
export function _resetWrites(): void { biz.clear(); cat.clear(); ppl.clear(); globalGen = 0; catGlobal = 0; pplGlobal = 0; globalAt = 0; lastAny = 0; }
export function _setTracking(on: boolean): void { tracking = on; }
export function _setWriteClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }
