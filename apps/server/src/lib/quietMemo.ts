/**
 * quietMemo.ts — A593: a polled answer kept while nothing is written for its business.
 *
 * Owner, 2026-10-26 (the System page's Supabase card: ~82,000 Supabase calls a day — "logs are full already"; Free plan
 * log ingestion 1 GB a month): most of what a POS polls every 20–90 s (its drawers' state, the day-close instructions
 * waiting for it, the test-data clears, its print stations) is the same answer as the last one, because nothing was
 * written. Every write a POS or the web makes comes through this server and moves the business's write generation
 * (lib/writeActivity.ts) — so an answer read under the current generation is still the answer.
 *
 * A kept answer is used only while (a) the A591 memories are on (index.ts mounted trackWrites, A591_MEMO is not off),
 * (b) its business's write generation (or, for `catalogue`, the catalogue generation) is the one it was read under, and
 * (c) it is younger than its own limit (a change made straight in SQL is seen within that). The generation is taken
 * BEFORE the read: a write that lands while the read runs makes the next ask read again. A read that failed is never
 * kept. Bounded (least recently used out first). One instance (WEB_CONCURRENCY=1) — see A591's Redis note.
 */
import { memoEnabled, writeGen, catalogueGen, QUIET_MAX_MS } from './writeActivity';
import { traffic } from './trafficStats';

interface Kept<T> { value: T; gen: string; at: number }

let moduleClock: () => number = () => Date.now();
/** The time the polled answers decide by (a test sets it with _setQuietClock). */
export function quietNow(): number { return moduleClock(); }

export class QuietMemo<T> {
  private kept = new Map<string, Kept<T>>();
  constructor(
    private readonly name: string,
    private readonly opts: { maxMs?: number; max?: number; catalogue?: boolean; clock?: () => number } = {},
  ) {}

  private gen(businessId: string): string { return this.opts.catalogue ? catalogueGen(businessId) : writeGen(businessId); }
  private now(): number { return (this.opts.clock ?? moduleClock)(); }

  /** The kept answer for `key` of `businessId`, or undefined (off, another generation, too old, none). */
  get(businessId: string, key: string): T | undefined {
    if (!memoEnabled()) return undefined;
    const k = `${businessId}|${key}`;
    const e = this.kept.get(k);
    if (!e) return undefined;
    if (e.gen !== this.gen(businessId) || this.now() - e.at >= (this.opts.maxMs ?? QUIET_MAX_MS)) { this.kept.delete(k); return undefined; }
    this.kept.delete(k); this.kept.set(k, e);   // most recently used
    traffic.count(`${this.name}.from_memory`);
    return e.value;
  }

  /** The generation to read under — take it BEFORE the read, hand it to set(). */
  mark(businessId: string): { gen: string; at: number } { return { gen: this.gen(businessId), at: this.now() }; }

  set(businessId: string, key: string, value: T, mark: { gen: string; at: number }): void {
    if (!memoEnabled()) return;
    const k = `${businessId}|${key}`;
    this.kept.delete(k);
    this.kept.set(k, { value, gen: mark.gen, at: mark.at });
    const max = this.opts.max ?? 5_000;
    while (this.kept.size > max) { const first = this.kept.keys().next().value; if (first === undefined) break; this.kept.delete(first); }
    traffic.count(`${this.name}.read`);
  }

  /** Read through: the kept answer, else `read()` (kept unless it throws or `keep` says no). */
  async through(businessId: string, key: string, read: () => Promise<T>, keep: (v: T) => boolean = () => true): Promise<T> {
    const hit = this.get(businessId, key);
    if (hit !== undefined) return hit;
    const m = this.mark(businessId);
    const v = await read();
    if (keep(v)) this.set(businessId, key, v, m);
    return v;
  }

  forget(businessId?: string): void {
    if (!businessId) { this.kept.clear(); return; }
    for (const k of [...this.kept.keys()]) if (k.startsWith(`${businessId}|`)) this.kept.delete(k);
  }
  size(): number { return this.kept.size; }
  /** Test seam. */
  _setClock(fn: (() => number) | null): void { (this.opts as { clock?: () => number }).clock = fn ?? undefined; }
}

/** Every QuietMemo made by the routes, so a test (or a restart of the tracking) can empty them all. */
const all: QuietMemo<unknown>[] = [];
export function quietMemo<T>(name: string, opts: ConstructorParameters<typeof QuietMemo>[1] = {}): QuietMemo<T> {
  const m = new QuietMemo<T>(name, opts);
  all.push(m as QuietMemo<unknown>);
  return m;
}
/** Test seams. */
export function _resetQuietMemos(): void { for (const m of all) m.forget(); }
export function _setQuietClock(fn: (() => number) | null): void { moduleClock = fn ?? (() => Date.now()); for (const m of all) m._setClock(null); }
