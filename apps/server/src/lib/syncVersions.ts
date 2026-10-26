/**
 * syncVersions.ts — A528: what a till polls is answered from ONE row per business, cached in memory.
 *
 * Render suspended production (2026-10-19): 5 GB of its bandwidth was the server's own requests to Supabase, and
 * Supabase was over its egress and log quotas. Every till asked GET /api/pos/catalogue-version every 20 s and each answer
 * ran 16 queries. Owner, 2026-10-19: "can we do it such that only a change can trigger data sync … we need a solution and
 * a quick one".
 *
 * public.sync_versions (migration 150) holds (business_id, topic) → version, bumped by triggers on every table a topic
 * covers ('catalogue': the 16 tables; 'staff': users, roles, grants, branches of people, tills joining or leaving). This
 * server runs one instance (WEB_CONCURRENCY=1), so one in-memory cache answers every till: one query per business per
 * 15 s, however many tills. A write this server handles drops the business's entry at once (forgetTopic — routes/index.ts),
 * so a web edit is not held back by the cache; the trigger stays the source of truth (a till's own push, SQL).
 *
 * The table may be missing (the server can deploy before migration 150 runs — Render and the db-migrate job run in
 * parallel on a merge): readTopicVersion answers null and the caller falls back to its old way, cached 60 s. Never an error.
 */
import { supabase } from './supabase';
import { traffic } from './trafficStats';
import { writeGen, memoEnabled } from './writeActivity';   // A591

export type SyncTopic = 'catalogue' | 'staff';

export const TOPIC_TTL_MS = 15_000;
/**
 * A591 (owner's System page, 2026-10-26: "Catalogue check 3.3% from memory" — tills before 1.0.20 ask every 20 s, so a
 * 15 s memory almost never answered): a version is also kept up to 5 minutes while nothing at all has been written for
 * the business through this server (lib/writeActivity.ts) since it was read. Every change a till or the web makes comes
 * through this server; only a change made straight in SQL waits (up to 5 minutes, as the old tills' 10-minute pull did).
 */
export const TOPIC_QUIET_TTL_MS = 5 * 60_000;
export const FALLBACK_TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;

interface Entry<T> { value: T; at: number; gen?: string }
const topicCache = new Map<string, Entry<number>>();
const fallbackCache = new Map<string, Entry<string | null>>();
/** The table is missing (or the read failed): until when not to ask again. */
let unavailableUntil = 0;
/** Moves on every forget: a read that started before a forget is answered but not cached (it may predate the change). */
let generation = 0;

const keyOf = (businessId: string, topic: string) => `${businessId}|${topic}`;
const prune = <T>(m: Map<string, T>) => {
  while (m.size > MAX_ENTRIES) { const k = m.keys().next().value; if (k === undefined) break; m.delete(k); }
};

/**
 * The business's version for a topic — from the cache (15 s), else one read. null when the table is missing or the read
 * failed (not cached as a version; the table is not asked again for 60 s). A business with no row yet is 0 (its first
 * change inserts version 1).
 */
export async function readTopicVersion(businessId: string | null | undefined, topic: SyncTopic, now = Date.now()): Promise<number | null> {
  if (!businessId) return null;
  const k = keyOf(businessId, topic);
  const hit = topicCache.get(k);
  if (hit && (now - hit.at < TOPIC_TTL_MS
    || (memoEnabled() && hit.gen === writeGen(businessId) && now - hit.at < TOPIC_QUIET_TTL_MS))) {
    traffic.count(`${topic}.version_cached`); return hit.value;
  }
  if (now < unavailableUntil) return null;
  traffic.count(`${topic}.version_read`); traffic.queries(1);
  const gen = generation;
  const wgen = writeGen(businessId);   // A591: taken before the read
  try {
    const { data, error } = await supabase.from('sync_versions').select('version')
      .eq('business_id', businessId).eq('topic', topic).maybeSingle();
    if (error) throw error;
    const value = Number((data as { version?: number | string } | null)?.version ?? 0);
    if (!Number.isFinite(value)) throw new Error('bad version');
    if (gen === generation) { topicCache.delete(k); topicCache.set(k, { value, at: now, gen: wgen }); prune(topicCache); }
    return value;
  } catch (e) {
    unavailableUntil = now + FALLBACK_TTL_MS;
    traffic.count(`${topic}.version_unavailable`);
    console.warn(`[syncVersions] sync_versions not readable — the old way for ${FALLBACK_TTL_MS / 1000} s (migration 150?): ${(e as Error)?.message ?? e}`);
    return null;
  }
}

/**
 * The old way's answer, cached 60 s per key (catalogue-version before migration 150: 16 queries). A null answer (every
 * read failed) is not cached.
 */
export async function cachedFallback(key: string, compute: () => Promise<string | null>, now = Date.now()): Promise<string | null> {
  const hit = fallbackCache.get(key);
  if (hit && now - hit.at < FALLBACK_TTL_MS) { traffic.count('catalogue.fallback_cached'); return hit.value; }
  traffic.count('catalogue.fallback_computed');
  const gen = generation;
  const value = await compute();
  if (value !== null && gen === generation) { fallbackCache.delete(key); fallbackCache.set(key, { value, at: now }); prune(fallbackCache); }
  return value;
}

/** A change this server made: the business's cached versions go (the next ask reads the row). null = every business. */
export function forgetTopic(businessId: string | null | undefined, topic?: SyncTopic): void {
  generation++;
  if (!businessId) { topicCache.clear(); fallbackCache.clear(); return; }
  for (const k of [...topicCache.keys()]) if (k.startsWith(`${businessId}|`) && (!topic || k.endsWith(`|${topic}`))) topicCache.delete(k);
  if (!topic || topic === 'catalogue') {
    for (const k of [...fallbackCache.keys()]) if (k.startsWith(`${businessId}|`)) fallbackCache.delete(k);
  }
}

/** Test seam. */
export function _resetSyncVersions(): void { topicCache.clear(); fallbackCache.clear(); unavailableUntil = 0; }
