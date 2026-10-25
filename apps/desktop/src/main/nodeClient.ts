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
// A410 (2026-10-05): the till's CLOUD calls also go through the node now (cloudGateway.ts → /node/cloud), so a peer
// never talks to the cloud itself; the two destinations (the node's replica, the cloud) keep their own state as above.
//
// Everything here is best-effort and non-blocking: if the node is unreachable a
// till keeps selling and its orders stay queued locally until the node returns.

import crypto from 'crypto';
import { getDeviceConfig, isNodeRole } from './deviceConfig';
import { isUnreachableStatus } from './authTransport';
import { noteNodeRefused, noteNodeAccepted, refusalReasonFor } from './cloudGateway';   // A448, A501
import { noteChannelOk, noteChannelError, noteKeyedRefusal, noteServerInfo, type NodeChannel, type ServerInfo } from './nodeHealth';   // A501
import { getLocalDb } from './localDb';
// A489: every call to the branch server goes through lanFetch — TLS, pinned to the server's certificate, once this till
// holds it; plain HTTP only before (a server on an older build). Never a plain fetch to the server from here.
import { lanFetch, readServerCert, pinnedFetch, securityCode } from './lanTls';
import { joinProofFor } from './serverJoin';   // A503

export function nodeUrl(): string | null {
  const cfg = getDeviceConfig();
  // Only a plain till with a configured node has an uplink target. The node
  // itself (role 'node') pushes to the cloud directly, not to itself.
  if (!cfg || isNodeRole(cfg.device_role)) return null;
  return cfg.node_url ? cfg.node_url.replace(/\/+$/, '') : null;
}

// ── A501: every answer from the server is recorded for its channel (nodeHealth.ts) ─────────────────────────────────
/** The server's own words from an error answer (its JSON `error`), or null. Never consumes the caller's body. */
async function serverSaid(res: Response): Promise<string | null> {
  try { const b: any = await res.clone().json(); return typeof b?.error === 'string' ? b.error.slice(0, 300) : null; }
  catch { return null; }
}
/** A thrown fetch, in a few words for the Tech page. */
export function describeFetchError(e: any): string {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'no answer in time';
  if (e?.name === 'NodeIdentityError') return String(e.message ?? e);
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause ? `the branch server did not answer (${cause})` : String(e?.message ?? e ?? 'failed');
}
/**
 * A501: record an answer from a route that checks this till's access code, device key and branch. A refusal is noted
 * by its reason (the manager's notice names the right one) and a 401 is logged once in a plain sentence.
 */
async function noteKeyedAnswer(ch: NodeChannel, route: string, res: Response): Promise<void> {
  if (res.ok) { noteChannelOk(ch); noteNodeAccepted('keyed'); return; }
  const said = await serverSaid(res);
  noteChannelError(ch, res.status, said ?? `the branch server answered HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403 || res.status === 426) {
    noteNodeRefused(res.status, Date.now(), refusalReasonFor(res.status, said));
    if (res.status === 401) noteKeyedRefusal(route, res.status, said);
  }
}

// Every /node/* call carries the branch secret. A till without one will be
// refused by the node — which is the intended outcome, not a regression: it
// means this till was never given the branch access code at install.
export function nodeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const cfg = getDeviceConfig();
  const secret = cfg?.node_secret ?? '';
  // F7 (2026-10-14): this till's own key and id travel with the branch code, so the server can tell its tills apart —
  // a holder of the branch code alone can no longer speak as another till (/node/sync, /node/changes, /node/verify-pin).
  const token = nodeDeviceToken();
  const who: Record<string, string> = {};
  if (cfg?.device_id) who['X-Device-Id'] = cfg.device_id;
  if (token) who['X-Device-Token'] = token;
  return { 'X-Node-Secret': secret, ...who, ...extra };
}

/**
 * F7: this till's device key for the branch server — 32 random bytes, made once and kept in maintenance_state. The
 * server keeps only its hash. A till that joined through the server holds the key the server issued at Allow; a till
 * set up with the typed access code makes its own, and the server records it the first time it sees it (back-compat
 * for every till installed before this build). Never throws: no key means the server treats this as an older till.
 */
export function nodeDeviceToken(): string | null {
  try {
    const db = getLocalDb();
    const row = db.prepare(`SELECT value FROM maintenance_state WHERE key = 'node_device_token'`).get() as { value?: string } | undefined;
    if (row?.value && /^[0-9a-f]{64}$/.test(row.value)) return row.value;
    const made = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('node_device_token', ?, ?)`).run(made, new Date().toISOString());
    return made;
  } catch { return null; }
}

/**
 * A503: the headers a join request carries so a server that already holds this till's key lets it ask again (a till
 * signed out and rejoining through its own server — A436 — or one whose last join did not complete). A proof, never the
 * key: an HMAC over this device and THAT server's security code (`cert` as read before the join; null for an older server),
 * so what one server receives proves nothing to another. No key held yet → no header (a new till needs none).
 */
export function joinProofHeaders(deviceId: string | null | undefined, cert: string | null): Record<string, string> {
  try {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = 'node_device_token'`).get() as { value?: string } | undefined;
    const token = row?.value && /^[0-9a-f]{64}$/.test(row.value) ? row.value : null;
    if (!token || !deviceId) return {};
    return { 'X-Join-Proof': joinProofFor(token, String(deviceId), securityCode(cert)) };
  } catch { return {}; }
}

/** F7: keep the key the branch server issued when it allowed this till to join. */
export function setNodeDeviceToken(token: string): void {
  if (!/^[0-9a-f]{64}$/.test(String(token ?? ''))) return;
  getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('node_device_token', ?, ?)`)
    .run(token, new Date().toISOString());
}

/** Is this till configured to push to a branch node? */
// A160: a peer that can't reach the cloud asks its NODE to refresh its session.
// The node (which has internet) proxies the refresh token upstream and hands the
// new pair back — so only the node needs internet. Returns null on any failure
// (node unreachable, cloud unreachable from the node, or a revoked token), which
// the caller treats as "couldn't refresh — keep trading offline".
export interface NodeRenewal { accessToken: string; refreshToken: string; deviceSecret?: string; ack?: boolean }

/** The till's own headers a renewal carries to the cloud (A477: which machine, whether its device secret is lost). */
const forwardable = (h: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (/^x-device-/i.test(k) && v) out[k] = String(v);
  return out;
};

export async function refreshViaNode(refreshToken: string, headers: Record<string, string> = {}): Promise<NodeRenewal | null> {
  const base = nodeUrl();
  if (!base || !refreshToken) return null;
  try {
    const res = await lanFetch(`${base}/node/refresh`, {
      method: 'POST',
      // A477: the branch server passes the till's X-Device-* headers on, so the cloud checks THIS till's machine.
      headers: nodeHeaders({ 'Content-Type': 'application/json', 'X-Device-Id': getDeviceConfig()?.device_id ?? '', ...forwardable(headers) }),
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(12_000),   // A446: a branch server that answers nothing must not hang the refresh
    });
    if (res.status !== 200) return null; // 401 revoked · 503 node offline — nothing usable
    const data = await res.json().catch(() => null);
    if (data?.accessToken && data?.refreshToken) {
      return {
        accessToken: data.accessToken, refreshToken: data.refreshToken,
        ...(typeof data.deviceSecret === 'string' && data.deviceSecret ? { deviceSecret: data.deviceSecret } : {}),
        ...(data.ack === true ? { ack: true } : {}),   // A477: the cloud asks for the ack — sent through the node too
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** A477: the renewal's ack, through the branch server (the A160 path). True when the cloud confirmed it. */
export async function ackViaNode(refreshToken: string, headers: Record<string, string> = {}): Promise<boolean> {
  const base = nodeUrl();
  if (!base || !refreshToken) return false;
  try {
    const res = await lanFetch(`${base}/node/refresh/ack`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json', ...forwardable(headers) }),
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(12_000),
    });
    return res.status === 200;
  } catch {
    return false;
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
    const res = await lanFetch(`${base}/node/health`, { signal: ctrl.signal, headers: nodeHeaders() });
    clearTimeout(t);
    if (res.status === 401) {
      console.error('[node] branch server rejected our access code — this till will not aggregate. Re-run install with the correct code.');
      noteNodeRefused(401, Date.now(), refusalReasonFor(401, await serverSaid(res)));   // A448: the manager is told (sync notice), not only the log
      return false;
    }
    if (res.ok) noteNodeAccepted('any');   // A501: /node/health checks only the access code
    return res.ok;
  } catch { return false; }
}

/**
 * A501: ask the server about itself (GET /node/health) and record it — its device id and branch (the identity a failed
 * row is re-armed on), its protocol and capabilities (the Tech page says "Update the branch server" when it is older
 * than this till). Never throws; `info` is null when it did not answer 200.
 */
export async function checkNodeHealth(timeoutMs = 4000): Promise<{ ok: boolean; status: number | null; info: ServerInfo | null; error?: string }> {
  const base = nodeUrl();
  if (!base) return { ok: false, status: null, info: null, error: 'no branch server configured' };
  try {
    const res = await lanFetch(`${base}/node/health`, { headers: nodeHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const said = await serverSaid(res);
      noteChannelError('health', res.status, said ?? `the branch server answered HTTP ${res.status}`);
      if (res.status === 401 || res.status === 426) noteNodeRefused(res.status, Date.now(), refusalReasonFor(res.status, said));
      return { ok: false, status: res.status, info: null, error: said ?? `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    noteChannelOk('health');
    noteNodeAccepted('any');
    return { ok: true, status: res.status, info: noteServerInfo(body) };
  } catch (e: any) {
    const error = describeFetchError(e);
    noteChannelError('health', null, error);
    return { ok: false, status: null, info: null, error };
  }
}

/** Per-table outcome of a /node/sync push. */
export interface NodeSyncResult {
  applied: number; duplicate: number; cursor: number;
  rejected: Array<{ id: string; table: string; reason: string }>;
  /** F1: the ids the server now holds. Absent from a server on an older build. */
  applied_ids?: string[];
}

/**
 * What a /node/sync came back with. F3 (2026-10-14): three kinds, and only one of them is about the rows.
 *   ok        — the server answered per row (`results`).
 *   transport — no answer, a 5xx, or a 401 (the access code / device key: a till-level problem the next code fixes,
 *               never a verdict on a row). Retried without counting an attempt. A501: and a 400, 403 or 426 — the
 *               server refusing the TILL (its branch, its connection), never a row: a cloud sign-in that rebinds the
 *               till to another branch used to fail its whole outbox after five passes, for good.
 *   too_large — 413: the batch was over the server's body limit; send smaller.
 *   refused   — any other answer the server gives the batch as such. Counts.
 */
export type NodePushOutcome =
  | { kind: 'ok'; results: Record<string, NodeSyncResult> }
  | { kind: 'transport'; status: number | null; error: string }
  | { kind: 'too_large'; error: string }
  | { kind: 'refused'; status: number; error: string };

/** Offer a batch of this till's own rows to the node. Never throws. */
export async function pushRowsToNode(
  tables: Record<string, any[]>,
  timeoutMs = 15000,
): Promise<NodePushOutcome> {
  const base = nodeUrl();
  if (!base) return { kind: 'transport', status: null, error: 'no branch server configured' };
  const cfg = getDeviceConfig();

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await lanFetch(`${base}/node/sync`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
        tables,
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(t);
    noteChannelError('sync', null, describeFetchError(e));   // A501
    return { kind: 'transport', status: null, error: 'branch server unreachable' };
  }
  clearTimeout(t);

  await noteKeyedAnswer('sync', '/node/sync', res);   // A501: the channel's record, a refusal by its reason
  const detail = await res.json().catch(() => null as any);
  if (res.status === 401) {
    // A448: the manager is told (sync notice), not only the log — A501: by its reason (noteKeyedAnswer).
    return { kind: 'transport', status: 401, error: detail?.error ?? 'branch server rejected the access code — re-run install on this POS with the code from the branch server' };
  }
  if (res.status === 413) return { kind: 'too_large', error: detail?.error ?? 'the batch was too large for the branch server' };
  if (isUnreachableStatus(res.status)) return { kind: 'transport', status: res.status, error: detail?.error ?? `branch server could not take the batch (HTTP ${res.status})` };
  // A501: the server refusing the TILL, not the rows — retried, never counted (see NodePushOutcome).
  if (res.status === 400 || res.status === 403 || res.status === 426) {
    const what = res.status === 403
      ? `the branch server serves another branch than this POS's (${cfg?.branch_id ?? 'none'})`
      : res.status === 426 ? 'the branch server accepts only encrypted connections' : 'the branch server could not read this POS\'s request';
    return { kind: 'transport', status: res.status, error: `${what}${detail?.error ? ` — it said: ${detail.error}` : ''}` };
  }
  if (!res.ok) return { kind: 'refused', status: res.status, error: detail?.error ?? `branch server refused the batch (HTTP ${res.status})` };
  if (!detail || typeof detail.results !== 'object' || detail.results === null) {
    return { kind: 'transport', status: res.status, error: 'branch server sent an answer this POS could not read' };
  }
  return { kind: 'ok', results: detail.results };
}

/** F2: what the server already holds from THIS till, per table (GET /node/cursors). null = no answer. */
export async function fetchNodeCursors(timeoutMs = 5000): Promise<Array<{ table_name: string; last_seq: number }> | null> {
  const base = nodeUrl();
  const device = getDeviceConfig()?.device_id;
  if (!base || !device) return null;
  try {
    const res = await lanFetch(`${base}/node/cursors?device=${encodeURIComponent(device)}`, { headers: nodeHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null as any);
    return Array.isArray(data?.cursors) ? data.cursors.filter((c: any) => c?.device_id === undefined || c.device_id === device) : null;
  } catch { return null; }
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
  return (await measureNodeClock(timeoutMs))?.driftMs ?? null;
}

/**
 * F15 (2026-10-14): the clock AND the time zone. Two tills on the same instant but different Windows time zones date
 * their trading days differently just as surely as two drifting clocks do — and drift (UTC instants) cannot see it.
 * `tzMismatch` is set when the server reported its zone (an older server does not) and it differs from this till's.
 * Offsets are Date#getTimezoneOffset() — minutes, positive WEST of UTC (Nairobi is -180).
 */
export async function measureNodeClock(timeoutMs = 4000):
  Promise<{ driftMs: number; nodeTzOffset: number | null; tzOffset: number; tzMismatch: boolean } | null> {
  const base = nodeUrl();
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const sent = Date.now();
    const res = await lanFetch(`${base}/node/time`, { signal: ctrl.signal, headers: nodeHeaders() });
    const received = Date.now();
    clearTimeout(t);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null as any);
    const nodeNow = Date.parse(body?.now ?? '');
    if (!Number.isFinite(nodeNow)) return null;
    const tzOffset = new Date().getTimezoneOffset();
    const nodeTzOffset = Number.isFinite(Number(body?.tz_offset)) && body?.tz_offset !== null ? Number(body.tz_offset) : null;
    return { driftMs: Math.round((sent + received) / 2) - nodeNow, nodeTzOffset, tzOffset,
      tzMismatch: nodeTzOffset !== null && nodeTzOffset !== tzOffset };
  } catch { return null; }
}

/** Fetch the combined branch report from the node (manager view). null if down. */
export async function fetchNodeReport(timeoutMs = 4000): Promise<any | null> {
  const base = nodeUrl();
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await lanFetch(`${base}/node/report`, { signal: ctrl.signal, headers: nodeHeaders() });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Share the current tech token with the node so peers can pick it up. */
export async function broadcastTechToken(token: string): Promise<void> {
  // A503 (E2): closing is "no token" — null. tech:closeSession sends '', which the A496 server refuses as "not a valid
  // tech token" (only null clears), so a closed session stayed on offer to the branch's tills until it expired.
  const t = typeof token === 'string' && token.trim() ? token : null;
  const cfg = getDeviceConfig();
  if (cfg && isNodeRole(cfg.device_role)) {
    // A503 (E2): on the branch server itself there is no server to tell — nodeUrl() is null here, so a session opened or
    // closed AT the server never reached (or never left) what it holds for its tills. Written locally, as /node/tech-session does.
    try { holdTechTokenHere(t); } catch { /* best-effort */ }
    return;
  }
  const base = nodeUrl();
  if (!base) return;
  try {
    await lanFetch(`${base}/node/tech-session`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ token: t }),
    });
  } catch { /* best-effort */ }
}

/** A503 (E2): the branch server's own copy of the tech token it offers its tills (node_state, as nodeServer keeps it). */
export function holdTechTokenHere(token: string | null): void {
  const db = getLocalDb();
  db.exec(`CREATE TABLE IF NOT EXISTS node_state (id INTEGER PRIMARY KEY CHECK (id = 1), tech_token TEXT, updated_at TEXT);
           INSERT OR IGNORE INTO node_state (id, updated_at) VALUES (1, datetime('now'));`);
  db.prepare(`UPDATE node_state SET tech_token=?, updated_at=datetime('now') WHERE id=1`).run(token);
}

/** Ask the node for the current broadcast tech token (peers adopt it locally). */
export async function fetchNodeTechToken(timeoutMs = 2500): Promise<string | null> {
  const base = nodeUrl();
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await lanFetch(`${base}/node/tech-session`, { signal: ctrl.signal, headers: nodeHeaders() });
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
): Promise<Array<{ id: number; uid?: string | null; kind: string; payload: any }> | null> {
  const base = nodeUrl();
  if (!base) return null;
  const cfg = getDeviceConfig();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await lanFetch(`${base}/node/instructions/poll`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
        state,
      }),
      signal: ctrl.signal,
    });
    await noteKeyedAnswer('poll', '/node/instructions/poll', res);   // A501
    if (!res.ok) return null;
    const data = await res.json().catch(() => null as any);
    return Array.isArray(data?.instructions) ? data.instructions : [];
  } catch (e: any) {
    noteChannelError('poll', null, describeFetchError(e));   // A501
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
  ack: { ok: boolean; error?: string; summary?: unknown; wait?: boolean },   // A521: wait = "not yet" (money waits here)
  timeoutMs = 5000,
  uid: string | null = null,
): Promise<boolean> {
  const base = nodeUrl();
  if (!base) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // F12 (2026-10-14): the ack names this till and the instruction's uid. Ids alone restart at 1 on a reinstalled
    // server, so an ack held across that matched SOMEONE ELSE's instruction with the same number.
    const res = await lanFetch(`${base}/node/instructions/ack`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ instruction_id: instructionId, instruction_uid: uid ?? undefined,
        device_id: getDeviceConfig()?.device_id ?? null, ...ack }),
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
    const res = await lanFetch(`${base}/node/since`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
        cursors, limit,
      }),
      signal: ctrl.signal,
    });
    await noteKeyedAnswer('since', '/node/since', res);   // A501
    if (!res.ok) return null;
    const data = await res.json().catch(() => null as any);
    return Array.isArray(data?.batches) ? { batches: data.batches, has_more: !!data.has_more } : null;
  } catch (e: any) {
    noteChannelError('since', null, describeFetchError(e));   // A501
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
    const res = await lanFetch(`${base}/node/reference`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
      }),
      signal: ctrl.signal,
    });
    await noteKeyedAnswer('reference', '/node/reference', res);   // A501
    if (!res.ok) return null;
    const data = await res.json().catch(() => null as any);
    // A well-formed bundle always carries source:'node' and a posInit object.
    return (data && data.source === 'node' && data.posInit) ? data : null;
  } catch (e: any) {
    noteChannelError('reference', null, describeFetchError(e));   // A501
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
    const res = await lanFetch(`${base}/node/roster`, {
      method: 'POST',
      headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        device_id: cfg?.device_id ?? null,
        branch_id: cfg?.branch_id ?? null,
      }),
      signal: ctrl.signal,
    });
    await noteKeyedAnswer('roster', '/node/roster', res);   // A501
    if (!res.ok) return null;
    const data = await res.json().catch(() => null as any);
    return (data && data.source === 'node' && Array.isArray(data.roster)) ? data : null;
  } catch (e: any) {
    noteChannelError('roster', null, describeFetchError(e));   // A501
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── Phase 3 — promotion support ──────────────────────────────────────────────
/** Probe a CANDIDATE node address (not the configured one) with this till's
 *  branch secret. Used by the repoint flow: test before save, because writing
 *  a wrong address is a till that silently stops replicating. */
export async function probeNode(url: string, timeoutMs = 4000): Promise<{ ok: boolean; error?: string; cert?: string | null; code?: string | null }> {
  const base = String(url ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return { ok: false, error: 'Address must start with http://' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // A489: a server that hands out a certificate is probed over TLS with it (the access code never crosses the network
    // in the clear), and the certificate comes back for the caller to pin with the new address. An older server: plain.
    const { cert } = await readServerCert(base, timeoutMs);
    const res = cert
      ? await pinnedFetch(`${base}/node/health`, { signal: ctrl.signal, headers: nodeHeaders() }, cert)
      : await globalThis.fetch(`${base}/node/health`, { signal: ctrl.signal, headers: nodeHeaders() });
    if (res.status === 401) return { ok: false, error: 'That machine refused this POS\'s branch access code' };
    if (!res.ok) return { ok: false, error: `The machine answered ${res.status} — is it the branch server?` };
    return { ok: true, cert, code: securityCode(cert) };
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
    const res = await lanFetch(`${base}/node/verify-pin`, {
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

// ── A448: changes made on a till, shared with the branch over the LAN ────────────────────────────────────────────────
/** The branch server's own change counter (it moves when a till of the branch hands it a change). null = no answer. */
export async function nodeChangeVersion(timeoutMs = 3000): Promise<string | null> {
  const base = nodeUrl();
  if (!base) return null;
  try {
    const res = await lanFetch(`${base}/node/changes/version`, { headers: nodeHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const b = await res.json().catch(() => null) as { version?: string } | null;
    return b?.version ?? null;
  } catch { return null; }
}

/** Hand changes made on this till to the branch server: it applies them too (its other tills see them with no internet)
 *  and sends them to the cloud itself. Best-effort: this till sends them to the cloud as well. */
/** A381: a logo (or accent) set on this till — handed to the branch server, so the branch's other tills take it from
 *  there at once, with no internet. False when there is no server or it did not answer (the cloud still gets it). */
export async function relayBrandingToNode(b: { accentHex: string | null; logoPng: string | null; logoReceipt: string | null; receiptLogoEnabled: boolean },
  timeoutMs = 6000): Promise<boolean> {
  const base = nodeUrl();
  if (!base) return false;
  try {
    const res = await lanFetch(`${base}/node/branding`, { method: 'POST', headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(b), signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

export async function relayChangesToNode(changes: Record<string, unknown>[], timeoutMs = 4000): Promise<boolean> {
  const base = nodeUrl();
  if (!base || !changes.length) return false;
  try {
    const res = await lanFetch(`${base}/node/changes`, { method: 'POST', headers: nodeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ changes }), signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}
