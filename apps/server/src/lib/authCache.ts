/**
 * authCache.ts — A528: the sign-in check's database reads, remembered for 30 s.
 *
 * requireAuth read the database on EVERY request: a till's own session its user_devices row, a person's session their
 * users row (and businesses.owner_id for an owner-role PIN sign-in), a Supabase session the business's roles. Every till
 * polls several routes every 20 s, so this was a large share of the server's Supabase traffic (Render suspended
 * production over bandwidth, 2026-10-19). One instance (WEB_CONCURRENCY=1), so one in-memory cache.
 *
 * Safe because:
 *   - Only a row that LETS the request in is kept (a joined till, an active person of this business). A refusal, a missing
 *     row and a failed read are never kept — a till rejoined or a person reactivated is let in on the very next request,
 *     and a failed read still answers 503.
 *   - Every path in this server that blocks a till or a person drops the entry AT ONCE (routes/index.ts: devices, staff,
 *     admin, business, changes, tills-days; lib/deviceBinding.ts, routes/auth.ts join). The next request reads again.
 *   - A change made directly in SQL (not through this server) takes up to 30 s.
 *   - Bounded: 5,000 entries per map, the oldest dropped first.
 */
import { traffic } from './trafficStats';
import { supabase } from './supabase';
import { tillBlockReason } from './deviceGrant';
import { memoEnabled, writeGen, QUIET_MAX_MS } from './writeActivity';   // A593

export const AUTH_TTL_MS = 30_000;
/**
 * A593 (owner, 2026-10-26: "logs are full already" — ~82,000 Supabase calls a day): a POS polls several routes every
 * 20 s, so the 30 s memory was read again twice a minute for every POS — a row that almost never changes. A row that let
 * the request in is now also used up to 5 minutes while NOTHING has been written for its business through this server
 * since it was read (lib/writeActivity.ts). Revocation is not weakened: every path in this server that blocks a POS or a
 * person still forgets the row AT ONCE (below), any write for the business ends the quiet rule (the 30 s rule again), a
 * refusal or a failed read is never kept, a token newer than the row still reads again, and A591_MEMO=off is the 30 s
 * rule alone. Only a change made straight in SQL — not through this server — waits up to 5 minutes instead of 30 s.
 */
export const AUTH_QUIET_TTL_MS = QUIET_MAX_MS;
const MAX_ENTRIES = 5_000;

export interface TillRow { status?: string | null; retired_at?: string | null; branch_id?: string | null }
export interface UserRow { permissions_version?: number | null; status?: string | null; business_id?: string | null }

interface Entry<T> { value: T; at: number; businessId: string; gen?: string }
const tills = new Map<string, Entry<TillRow>>();
const users = new Map<string, Entry<UserRow>>();
const owners = new Map<string, Entry<{ owner_id?: string | null } | null>>();
const ownerRoles = new Map<string, Entry<string | null>>();
/** A593: a branch server's own row (its role and confirmation) — GET /api/pos/branch-drawers' check, forgotten with the tills. */
const servers = new Map<string, Entry<ServerRow>>();
export interface ServerRow { branch_id?: string | null; device_role?: string | null; status?: string | null; role_confirmed_at?: string | null; retired_at?: string | null }
let generation = 0;
let authClock: () => number = () => Date.now();   // A593: a test seam

const put = <T>(m: Map<string, Entry<T>>, k: string, e: Entry<T>) => {
  m.delete(k); m.set(k, e);
  while (m.size > MAX_ENTRIES) { const first = m.keys().next().value; if (first === undefined) break; m.delete(first); }
};

/**
 * Read through the cache: a fresh entry answers (no query); otherwise `read` runs and its row is kept only when `keep`
 * says it lets the request in. A read's error is returned as it came (never kept).
 */
async function through<T>(m: Map<string, Entry<T>>, key: string, businessId: string,
  read: () => Promise<{ data: T | null; error: unknown }>, keep: (row: T | null) => boolean, now = authClock()): Promise<{ data: T | null; error: unknown }> {
  const hit = m.get(key);
  if (hit && now - hit.at < AUTH_TTL_MS) { traffic.count('auth.hit'); return { data: hit.value, error: null }; }
  // A593: the quiet rule — nothing written for the business since the row was read, and under 5 minutes old.
  if (hit && memoEnabled() && hit.gen === writeGen(businessId) && now - hit.at < AUTH_QUIET_TTL_MS) {
    traffic.count('auth.hit_quiet'); return { data: hit.value, error: null };
  }
  traffic.count('auth.miss'); traffic.queries(1);
  const gen = generation;
  const wgen = writeGen(businessId);   // A593: taken before the read
  const r = await read();
  if (!r.error && keep(r.data) && gen === generation) put(m, key, { value: r.data as T, at: now, businessId, gen: wgen });
  return r;
}

export function cachedTill(businessId: string, deviceId: string, read: () => Promise<{ data: TillRow | null; error: unknown }>,
  joined: (row: TillRow | null) => boolean) {
  return through(tills, `${businessId}|${deviceId}`, businessId, read, joined);
}
/** A till's own row (status, retired_at, branch_id) — kept only while it is joined (requireAuth, pos/branch-staff). */
export function readTill(businessId: string, deviceId: string) {
  return cachedTill(businessId, deviceId, async () => await supabase
    .from('user_devices')
    .select('status, retired_at, branch_id')
    .eq('business_id', businessId)
    .eq('device_id', deviceId)
    .maybeSingle(), (row) => !tillBlockReason(row));
}
/**
 * A593: a branch server's own row for GET /api/pos/branch-drawers — kept only while it IS a confirmed branch server (the
 * same rule as lib/branchDrawers.ts serverBranch); forgotten with the business's tills (a role changed, a till blocked).
 */
export function readServerRow(businessId: string, deviceId: string, isServer: (row: ServerRow | null) => boolean) {
  return through(servers, `${businessId}|${deviceId}`, businessId, async () => await supabase
    .from('user_devices')
    .select('branch_id, device_role, status, role_confirmed_at, retired_at')
    .eq('business_id', businessId)
    .eq('device_id', deviceId)
    .maybeSingle(), isServer);
}
export function cachedUser(userId: string, businessId: string, read: () => Promise<{ data: UserRow | null; error: unknown }>,
  active: (row: UserRow | null) => boolean) {
  return through(users, userId, businessId, read, active);
}
export function cachedOwner(businessId: string, read: () => Promise<{ data: { owner_id?: string | null } | null; error: unknown }>) {
  return through(owners, businessId, businessId, read, (row) => !!row);
}
export function cachedOwnerRole(businessId: string, read: () => Promise<{ data: string | null; error: unknown }>) {
  return through(ownerRoles, businessId, businessId, read, () => true);
}

const dropWhere = <T>(m: Map<string, Entry<T>>, businessId: string | null) => {
  for (const [k, e] of [...m.entries()]) if (!businessId || e.businessId === businessId) m.delete(k);
};

/** A till's row changed (blocked, retired, rejoined, moved). */
export function forgetTill(businessId: string, deviceId: string): void { generation++; tills.delete(`${businessId}|${deviceId}`); servers.delete(`${businessId}|${deviceId}`); }
/** One person's row (a token newer than the remembered row). */
export function forgetUser(userId: string): void { generation++; users.delete(userId); }
/** A business's tills (a device route wrote; the row id is known, the device id is not). null = every business. */
export function forgetTillsOf(businessId: string | null): void { generation++; dropWhere(tills, businessId); dropWhere(servers, businessId); }
/** A business's people (deactivated, role or grants changed) and its owner and roles. null = every business. */
export function forgetPeopleOf(businessId: string | null): void {
  generation++; dropWhere(users, businessId); dropWhere(owners, businessId); dropWhere(ownerRoles, businessId);
}
/** Everything (an admin portal write: it may touch any business). */
export function forgetAllAuth(): void { generation++; tills.clear(); users.clear(); owners.clear(); ownerRoles.clear(); servers.clear(); }

/** Test seam. */
export function _resetAuthCache(): void { forgetAllAuth(); }
export function _setAuthClock(fn: (() => number) | null): void { authClock = fn ?? (() => Date.now()); }
