// nodeClient.ts — till-side helpers for talking to the branch aggregation node
// ─────────────────────────────────────────────────────────────────────────────
// Used by tills whose config has a node_url (i.e. there's a branch server).
//
// The node is a REPLICA, not an uplink. A till pushes its own rows to the cloud
// and, separately, to the node — two destinations with their own state. It used
// to push orders to the node INSTEAD of the cloud, which made the branch server
// a single point of failure for every peer's sales and forced 'node_ack', a
// third sync state in a column that can only hold one destination's opinion.
//
// Everything here is best-effort and non-blocking: if the node is unreachable a
// till keeps selling and its orders stay queued locally until the node returns.

import { getDeviceConfig, isNodeRole } from './deviceConfig';
import { isUnreachableStatus } from './authTransport';

function nodeUrl(): string | null {
  const cfg = getDeviceConfig();
  // Only a plain till with a configured node has an uplink target. The node
  // itself (role 'node') pushes to the cloud directly, not to itself.
  if (!cfg || isNodeRole(cfg.device_role)) return null;
  return cfg.node_url ? cfg.node_url.replace(/\/+$/, '') : null;
}

// Every /node/* call carries the branch secret. A till without one will be
// refused by the node — which is the intended outcome, not a regression: it
// means this till was never given the branch access code at install.
function nodeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const secret = getDeviceConfig()?.node_secret ?? '';
  return { 'X-Node-Secret': secret, ...extra };
}

/** Is this till configured to push to a branch node? */
// A160: a peer that can't reach the cloud asks its NODE to refresh its session.
// The node (which has internet) proxies the refresh token upstream and hands the
// new pair back — so only the node needs internet. Returns null on any failure
// (node unreachable, cloud unreachable from the node, or a revoked token), which
// the caller treats as "couldn't refresh — keep trading offline".
export async function refreshViaNode(refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
  const base = nodeUrl();
  if (!base || !refreshToken) return null;
  try {
    const res = await fetch(`${base}/node/refresh`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ refreshToken }),
    });
    if (res.status !== 200) return null; // 401 revoked · 503 node offline — nothing usable
    const data = await res.json().catch(() => null);
    if (data?.accessToken && data?.refreshToken) {
      return { accessToken: data.accessToken, refreshToken: data.refreshToken };
    }
    return null;
  } catch {
    return null;
  }
}

export function hasNode(): boolean {
  return nodeUrl() !== null;
}

export async function isNodeReachable(timeoutMs = 2500): Promise<boolean> {
  const base = nodeUrl();
  if (!base) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${base}/node/health`, { signal: ctrl.signal, headers: nodeHeaders() });
    clearTimeout(t);
    if (res.status === 401) {
      console.error('[node] branch server rejected our access code — this till will not aggregate. Re-run install with the correct code.');
      return false;
    }
    return res.ok;
  } catch { return false; }
}

/** Per-table outcome of a /node/sync push. */
export interface NodeSyncResult {
  applied: number; duplicate: number; cursor: number;
  rejected: Array<{ id: string; table: string; reason: string }>;
}

/**
 * Offer a batch of this till's own rows to the node.
 *
 * Throws on a node that answered and refused, returns null on one that did not
 * answer at all. The caller must treat those differently: a branch server that
 * is rebooting should cost a retry, and one that refused a row on its merits
 * should surface the reason rather than loop on it forever.
 */
export async function pushRowsToNode(
  tables: Record<string, any[]>,
  timeoutMs = 15000,
): Promise<Record<string, NodeSyncResult> | null> {
  const base = nodeUrl();
  if (!base) return null;
  const cfg = getDeviceConfig();

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${base}/node/sync`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
        tables,
      }),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(t);
    return null;              // unreachable — not a refusal
  }
  clearTimeout(t);

  if (res.status === 401) {
    throw new Error('branch server rejected the access code — re-run install on this till with the code from the branch server');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => null as any);
    throw new Error(detail?.error ?? `branch server refused the batch (HTTP ${res.status})`);
  }
  const data = await res.json().catch(() => null as any);
  return (data && typeof data.results === 'object') ? data.results : null;
}

/**
 * The node's clock, as milliseconds this till is ahead of it (negative = behind).
 * null when the node did not answer.
 *
 * Measured against the midpoint of the round trip so LAN latency is not counted
 * as drift. On a shop LAN that is a millisecond or two and the threshold is two
 * minutes, so it barely matters — but a naive measurement makes a slow node look
 * like a drifting one, and then the warning gets ignored.
 */
export async function measureNodeDrift(timeoutMs = 4000): Promise<number | null> {
  const base = nodeUrl();
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const sent = Date.now();
    const res = await fetch(`${base}/node/time`, { signal: ctrl.signal, headers: nodeHeaders() });
    const received = Date.now();
    clearTimeout(t);
    if (!res.ok) return null;
    const nodeNow = Date.parse((await res.json())?.now ?? '');
    if (!Number.isFinite(nodeNow)) return null;
    return Math.round((sent + received) / 2) - nodeNow;
  } catch { return null; }
}

/** Fetch the combined branch report from the node (manager view). null if down. */
export async function fetchNodeReport(timeoutMs = 4000): Promise<any | null> {
  const base = nodeUrl();
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${base}/node/report`, { signal: ctrl.signal, headers: nodeHeaders() });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Share the current tech token with the node so peers can pick it up. */
export async function broadcastTechToken(token: string): Promise<void> {
  const base = nodeUrl();
  if (!base) return;
  try {
    await fetch(`${base}/node/tech-session`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ token }),
    });
  } catch { /* best-effort */ }
}

/** Ask the node for the current broadcast tech token (peers adopt it locally). */
export async function fetchNodeTechToken(timeoutMs = 2500): Promise<string | null> {
  const base = nodeUrl();
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${base}/node/tech-session`, { signal: ctrl.signal, headers: nodeHeaders() });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json())?.token ?? null;
  } catch { return null; }
}

// ── Central day close (Phase 4) — peer side ──────────────────────────────────

/**
 * Collect pending instructions from the node, reporting this till's own day
 * state in the same request. Returns null when the node is unreachable — the
 * caller simply tries again next tick; there is nothing to repair.
 */
export async function pollNodeInstructions(
  state: unknown, timeoutMs = 5000,
): Promise<Array<{ id: number; kind: string; payload: any }> | null> {
  const base = nodeUrl();
  if (!base) return null;
  const cfg = getDeviceConfig();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/node/instructions/poll`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
        state,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null as any);
    return Array.isArray(data?.instructions) ? data.instructions : [];
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Report an instruction's outcome. Fire-and-forget is NOT acceptable here —
 *  an unacked instruction is re-offered forever — so the executor retries the
 *  ack on the next poll tick if this returns false. */
export async function ackNodeInstruction(
  instructionId: number,
  ack: { ok: boolean; error?: string; summary?: unknown },
  timeoutMs = 5000,
): Promise<boolean> {
  const base = nodeUrl();
  if (!base) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/node/instructions/ack`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ instruction_id: instructionId, ...ack }),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// ── Phase 2a — distribution pull ─────────────────────────────────────────────

/** Pull every other device's new rows from the node. Null = unreachable; try
 *  next tick, nothing to repair. */
export async function pullNodeDistribution(
  cursors: Record<string, Record<string, number>>,
  limit = 500,
  timeoutMs = 8000,
): Promise<{ batches: Array<{ device_id: string; table: string; rows: any[] }>; has_more: boolean } | null> {
  const base = nodeUrl();
  if (!base) return null;
  const cfg = getDeviceConfig();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/node/since`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
        cursors, limit,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null as any);
    return Array.isArray(data?.batches) ? { batches: data.batches, has_more: !!data.has_more } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── A24 — downstream reference snapshot pull ─────────────────────────────────

/** Pull the branch reference snapshot (catalogue, prices, variants, modifiers,
 *  stock, tables, pumps, print routing) from the node. Non-credential only.
 *
 *  Null = the node did not answer (unreachable, refused, or malformed): the
 *  caller falls back to the cloud, exactly as it does today, so a missing or old
 *  node never blocks a reference refresh. A peer with no node_url gets null too. */
export async function fetchReferenceFromNode(timeoutMs = 8000): Promise<any | null> {
  const base = nodeUrl();
  if (!base) return null;
  const cfg = getDeviceConfig();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/node/reference`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null as any);
    // A well-formed bundle always carries source:'node' and a posInit object.
    return (data && data.source === 'node' && data.posInit) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * A20: pull the branch staff roster from the node (peers only). Mirrors
 * fetchReferenceFromNode — null for a node device, no node_url, or any node
 * problem, so the caller keeps its existing roster. A well-formed snapshot
 * carries source:'node' and a roster array; the caller validates further
 * (unpackRosterSnapshot) before replacing anything, so an empty/failed pull can
 * never wipe the local roster.
 */
export async function fetchRosterFromNode(timeoutMs = 6000): Promise<any | null> {
  const base = nodeUrl();
  if (!base) return null;
  const cfg = getDeviceConfig();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/node/roster`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null as any);
    return (data && data.source === 'node' && Array.isArray(data.roster)) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── Phase 3 — promotion support ──────────────────────────────────────────────
/** Probe a CANDIDATE node address (not the configured one) with this till's
 *  branch secret. Used by the repoint flow: test before save, because writing
 *  a wrong address is a till that silently stops replicating. */
export async function probeNode(url: string, timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {
  const base = String(url ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return { ok: false, error: 'Address must start with http://' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/node/health`, { signal: ctrl.signal, headers: nodeHeaders() });
    if (res.status === 401) return { ok: false, error: 'That machine refused this till\'s branch access code' };
    if (!res.ok) return { ok: false, error: `The machine answered ${res.status} — is it the branch server?` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'No branch server answered at that address' };
  } finally {
    clearTimeout(t);
  }
}

/** Result of asking the node to verify a cashier's PIN (PHASE5 §4d / A17).
 *  'ok' and 'rejected' are both ANSWERS — a rejection is final and the caller
 *  must NOT fall back to another authority. 'transport' means the node could not
 *  be reached (or cannot read its roster), and only then does the caller fall
 *  through to the cloud. */
export type NodePinResult =
  | { status: 'ok'; staff: { staffId: string; name: string; roleName: string | null; permissions: unknown } }
  | { status: 'rejected'; message: string }
  | { status: 'transport' };

export async function verifyPinAtNodeClient(pin: string, branchId: string, timeoutMs = 3000): Promise<NodePinResult> {
  const base = nodeUrl();
  if (!base) return { status: 'transport' };   // no node configured → treat as unreachable
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/node/verify-pin`, {
      method:  'POST',
      signal:  ctrl.signal,
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify({ pin, branch_id: branchId }),
    });
    // Any 5xx = the node answered but cannot serve (roster unreadable, its own
    // proxy/DB down): transport-like, retry elsewhere. Was 503-only, which let a
    // 500/502/504 read as a final rejection — the A152 class, on the node leg.
    if (isUnreachableStatus(res.status)) return { status: 'transport' };
    const data = await res.json().catch(() => ({} as any));
    if (res.ok && data?.ok) return { status: 'ok', staff: data.staff };
    // Any other answer (401 bad/ambiguous PIN) is FINAL.
    return { status: 'rejected', message: data?.error ?? 'Invalid PIN' };
  } catch {
    return { status: 'transport' };   // unreachable → fall through to cloud
  } finally {
    clearTimeout(t);
  }
}
