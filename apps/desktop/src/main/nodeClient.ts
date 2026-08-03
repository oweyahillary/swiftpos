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

import { getDeviceConfig } from './deviceConfig';

function nodeUrl(): string | null {
  const cfg = getDeviceConfig();
  // Only a plain till with a configured node has an uplink target. The node
  // itself (role 'node') pushes to the cloud directly, not to itself.
  if (!cfg || cfg.device_role === 'node') return null;
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
