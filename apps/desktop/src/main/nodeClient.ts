// nodeClient.ts — till-side helpers for talking to the branch aggregation node
// ─────────────────────────────────────────────────────────────────────────────
// Used by tills whose config has a node_url (i.e. there's a branch server). A
// till pushes its completed orders to the node instead of the cloud, reads the
// combined branch report from the node for the manager view, and shares/receives
// the current tech token over the same LAN channel.
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

/**
 * Push one queued order to the node. `payload` is the verbatim cloud body, sent
 * intact so the node can forward it upward unchanged (no id re-minting). Returns
 * true if the node accepted it (created or duplicate).
 */
export async function pushOrderToNode(args: {
  orderId: string; createdAt: string; payload: string;
}): Promise<boolean> {
  const base = nodeUrl();
  if (!base) return false;
  // The node ingests order-level fields + items; we send the parsed payload plus
  // the stable id/createdAt and the original payload string for cloud forwarding.
  let parsed: any = {};
  try { parsed = JSON.parse(args.payload); } catch { /* keep {} */ }

  const body = JSON.stringify({
    ...parsed,
    _orderId:   args.orderId,
    _createdAt: args.createdAt,
    payload:    args.payload,   // verbatim cloud body for the node to forward
  });

  const res = await fetch(`${base}/node/orders`, {
    method: 'POST',
    headers: nodeHeaders({ 'Content-Type': 'application/json' }),
    body,
  });
  // Throw rather than return false so syncEngine's catch surfaces the real
  // reason. Returning false would record it as 'node unreachable', which sends
  // whoever is debugging at 8pm on a Friday to check network cables instead of
  // the access code.
  if (res.status === 401) {
    throw new Error('branch server rejected the access code — re-run install on this till with the code from the branch server');
  }
  if (res.ok) return true;   // 201 created or 200 duplicate both mean the node has it

  // Any other refusal is a real, specific answer — a bill-number conflict, a
  // branch mismatch, a malformed body. Returning false here would record it as
  // 'node unreachable' and retry silently forever; throwing puts the node's own
  // words in front of whoever is looking at the till.
  const detail = await res.json().catch(() => null as any);
  throw new Error(detail?.error ?? `branch server refused the order (HTTP ${res.status})`);
}

/**
 * Ask the node which of these orders it has actually forwarded to the cloud.
 *
 * A peer till marks orders 'node_ack' on node acceptance; they only become
 * 'synced' once the node confirms the cloud has them. Returns null when the node
 * is unreachable or the response is malformed — the caller must treat that as
 * "don't know", never as "delivered", or it would close a shift on a guess.
 */
export async function confirmNodeDelivery(orderIds: string[], timeoutMs = 5000): Promise<string[] | null> {
  const base = nodeUrl();
  if (!base || orderIds.length === 0) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/node/confirm`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ order_ids: orderIds }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.delivered) ? data.delivered.map(String) : null;
  } catch {
    clearTimeout(t);
    return null;
  }
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
