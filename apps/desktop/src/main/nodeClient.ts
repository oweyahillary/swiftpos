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
    const res = await fetch(`${base}/node/health`, { signal: ctrl.signal });
    clearTimeout(t);
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
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return res.ok;   // 201 created or 200 duplicate both mean the node has it
}

/** Fetch the combined branch report from the node (manager view). null if down. */
export async function fetchNodeReport(timeoutMs = 4000): Promise<any | null> {
  const base = nodeUrl();
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${base}/node/report`, { signal: ctrl.signal });
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
      headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch(`${base}/node/tech-session`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json())?.token ?? null;
  } catch { return null; }
}
