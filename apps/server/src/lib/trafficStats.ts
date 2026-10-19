/**
 * trafficStats.ts — A528: what this server has answered since it started, and what the polled answers cost the database.
 *
 * Render suspended production (2026-10-19) over bandwidth, most of it the server's own requests to Supabase. These
 * counters let the owner see the effect of A528 on the admin portal's System page (GET /api/admin/ops/summary `traffic`,
 * super admins only): requests and bytes per route family (/api/pos, /api/auth, …), and for the polled paths — catalogue
 * version, branch staff, the sign-in check — how often the answer came from memory and how many database queries they
 * made. In memory only: a restart starts again from zero (started_at says when).
 */
import type { Request, Response, NextFunction } from 'express';

const MAX_FAMILIES = 60;
const startedAt = new Date().toISOString();
const families = new Map<string, { requests: number; bytes: number }>();
const counters = new Map<string, number>();
let dbQueries = 0;

/** /api/pos/catalogue-version?x → /api/pos; /health → /health. A path past the first 60 families counts as 'other'. */
export function routeFamily(url: string): string {
  const parts = String(url || '/').split('?')[0].split('/').filter(Boolean).slice(0, 2);
  const fam = `/${parts.join('/')}`.toLowerCase();
  return /^\/[a-z0-9/_-]{0,60}$/.test(fam) ? fam : 'other';
}

export const traffic = {
  count(name: string, by = 1): void { counters.set(name, (counters.get(name) ?? 0) + by); },
  /** Database queries made by the polled paths (catalogue version, branch staff, the sign-in check). */
  queries(n: number): void { dbQueries += n; },
  request(url: string, bytes: number): void {
    let fam = routeFamily(url);
    if (!families.has(fam) && families.size >= MAX_FAMILIES) fam = 'other';
    const f = families.get(fam) ?? { requests: 0, bytes: 0 };
    f.requests++; f.bytes += Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    families.set(fam, f);
  },
};

/** Counts every request by its family, and the bytes of its answer when the length is known — after it is sent. */
export function countTraffic(req: Request, res: Response, next: NextFunction): void {
  const url = req.originalUrl || req.url || '';
  res.on('finish', () => traffic.request(url, Number(res.getHeader('content-length') ?? 0)));
  next();
}

const rate = (hits: number, misses: number) => (hits + misses > 0 ? Math.round((hits / (hits + misses)) * 1000) / 10 : null);
const c = (k: string) => counters.get(k) ?? 0;

export interface TrafficSnapshot {
  started_at: string;
  routes: Array<{ family: string; requests: number; bytes: number }>;
  catalogue_version: { answered: number; from_memory: number; db_reads: number; fallback_computed: number; fallback_cached: number; hit_rate: number | null };
  branch_staff: { full: number; unchanged_from_memory: number; unchanged_after_read: number };
  auth_cache: { hits: number; misses: number; hit_rate: number | null };
  db_queries_polled: number;
  counters: Record<string, number>;
}

export function trafficSnapshot(): TrafficSnapshot {
  const routes = [...families.entries()].map(([family, v]) => ({ family, ...v })).sort((a, b) => b.requests - a.requests);
  const cvHits = c('catalogue.version_cached') + c('catalogue.fallback_cached');
  const cvMiss = c('catalogue.version_read') + c('catalogue.fallback_computed');
  return {
    started_at: startedAt,
    routes,
    catalogue_version: {
      answered: c('catalogue.answered'), from_memory: c('catalogue.version_cached'), db_reads: c('catalogue.version_read'),
      fallback_computed: c('catalogue.fallback_computed'), fallback_cached: c('catalogue.fallback_cached'),
      hit_rate: rate(cvHits, cvMiss),
    },
    branch_staff: { full: c('staff.roster_full'), unchanged_from_memory: c('staff.roster_unchanged_memory'), unchanged_after_read: c('staff.roster_unchanged_read') },
    auth_cache: { hits: c('auth.hit'), misses: c('auth.miss'), hit_rate: rate(c('auth.hit'), c('auth.miss')) },
    db_queries_polled: dbQueries,
    counters: Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Test seam. */
export function _resetTraffic(): void { families.clear(); counters.clear(); dbQueries = 0; }
