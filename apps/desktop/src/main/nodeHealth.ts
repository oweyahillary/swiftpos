/**
 * nodeHealth.ts — A501: what a till knows about each of its conversations with the branch server, for the Tech page.
 *
 * Owner, 2026-10-15: "there exists a problem between a node and a server syncing … fix it once and for all … some tills
 * are misbehaving and clients are not happy". Every call to the branch server (nodeClient.ts) was best-effort and
 * returned null on any failure — the right thing for the till's selling, and the reason nobody could tell WHICH part of
 * the conversation was failing, since when, or why: a till refused on /node/since for a week looked exactly like a
 * quiet branch. Each channel now keeps its last success, its last error (with the server's own words) and how many
 * times in a row it failed. Kept in memory (it describes this run of the app; a restart starts a fresh record) apart
 * from what the server said about itself, which is kept so a restart still knows which server it was.
 *
 * Nothing here is shown to a cashier — the Tech page reads it (node:syncHealth), and the manager's existing notice
 * reads only the refusal the server named (cloudGateway.nodeRefusal) and the backlog.
 */
import { getLocalDb } from './localDb';
import { logLine } from './logFile';

/** The conversations a till has with its branch server. */
export const NODE_CHANNELS = ['health', 'sync', 'since', 'poll', 'roster', 'reference', 'gateway', 'tls'] as const;
export type NodeChannel = typeof NODE_CHANNELS[number];

export interface ChannelHealth {
  channel: NodeChannel;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastStatus: number | null;
  /** Failures in a row since the last success (0 = the last attempt worked). */
  failures: number;
}

const channels = new Map<NodeChannel, ChannelHealth>();
const blank = (channel: NodeChannel): ChannelHealth =>
  ({ channel, lastOkAt: null, lastErrorAt: null, lastError: null, lastStatus: null, failures: 0 });

/** A conversation with the server worked. */
export function noteChannelOk(ch: NodeChannel, now = Date.now()): void {
  const c = channels.get(ch) ?? blank(ch);
  c.lastOkAt = new Date(now).toISOString();
  c.failures = 0;
  channels.set(ch, c);
}

/** A conversation with the server failed — `status` is the server's HTTP answer, null when there was none. */
export function noteChannelError(ch: NodeChannel, status: number | null, error: string, now = Date.now()): void {
  const c = channels.get(ch) ?? blank(ch);
  c.lastErrorAt = new Date(now).toISOString();
  c.lastError = String(error ?? '').slice(0, 300) || 'failed';
  c.lastStatus = status;
  c.failures++;
  channels.set(ch, c);
}

/** Every channel, in a fixed order (never-used ones as blanks), for the Tech page. */
export function channelHealth(): ChannelHealth[] {
  return NODE_CHANNELS.map((ch) => ({ ...(channels.get(ch) ?? blank(ch)) }));
}
export function channelState(ch: NodeChannel): ChannelHealth { return { ...(channels.get(ch) ?? blank(ch)) }; }

// ── What the server says about itself (GET /node/health) ─────────────────────────────────────────────────────────────
/**
 * The branch-server protocol this build speaks. Bumped when a till needs something an older server does not do:
 *   1 — every server before A501 (it does not report a protocol at all);
 *   2 — A501: /node/health reports protocol, capabilities and min_till_protocol; the beacon names the server and its
 *       security code (so a till follows its own server to a new address); /node/sync retries rows refused only
 *       because of the order within one batch.
 */
export const NODE_PROTOCOL = 2;
/** What a server on this build can do — reported on /node/health so a till can say exactly what it is missing. */
export const NODE_CAPABILITIES = ['tls', 'device_keys', 'applied_ids', 'cursors', 'distribution', 'events', 'gateway',
  'instructions', 'roster', 'reference', 'changes', 'update_share', 'beacon_identity', 'retry_after_events'];
/** The oldest till protocol a server on this build serves fully. A till below it is told, in one sentence, to update. */
export const MIN_TILL_PROTOCOL = 1;

export interface ServerInfo {
  device_id: string | null; branch_id: string | null; protocol: number;
  capabilities: string[]; min_till_protocol: number; seenAt: string;
}
const SERVER_KEY = 'node_server_info';

/** Record what the server's /node/health said (kept across restarts — which server this till last talked to). */
export function noteServerInfo(body: any, now = Date.now()): ServerInfo {
  const proto = Number(body?.protocol);
  const minTill = Number(body?.min_till_protocol);
  const info: ServerInfo = {
    device_id: typeof body?.device_id === 'string' && body.device_id ? body.device_id.slice(0, 64) : null,
    branch_id: typeof body?.branch_id === 'string' && body.branch_id ? body.branch_id.slice(0, 64) : null,
    // A server before A501 reports no protocol: it is protocol 1.
    protocol: Number.isInteger(proto) && proto > 0 ? proto : 1,
    capabilities: Array.isArray(body?.capabilities) ? body.capabilities.filter((c: unknown) => typeof c === 'string').slice(0, 50) : [],
    min_till_protocol: Number.isInteger(minTill) && minTill > 0 ? minTill : 1,
    seenAt: new Date(now).toISOString(),
  };
  const before = serverInfo();
  try {
    getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(SERVER_KEY, JSON.stringify(info), info.seenAt);
  } catch { /* memory only this time */ }
  memo = info;
  // One clear sentence each, when it first becomes true — not every minute.
  if (info.min_till_protocol > NODE_PROTOCOL && (!before || before.min_till_protocol !== info.min_till_protocol)) {
    logLine('node', `A501: this till is older than the branch server expects (this till speaks protocol ${NODE_PROTOCOL}, the server needs ${info.min_till_protocol}) — update this till`);
  }
  if (info.protocol < NODE_PROTOCOL && (!before || before.protocol !== info.protocol)) {
    logLine('node', `A501: the branch server runs an older build (protocol ${info.protocol}; this till speaks ${NODE_PROTOCOL}) — update the branch server`);
  }
  return info;
}

let memo: ServerInfo | null | undefined;
/** What the server last said about itself, or null (never answered on this machine). */
export function serverInfo(): ServerInfo | null {
  if (memo !== undefined) return memo;
  try {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(SERVER_KEY) as { value?: string } | undefined;
    memo = row?.value ? JSON.parse(row.value) as ServerInfo : null;
  } catch { memo = null; }
  return memo ?? null;
}

/** What the Tech page says about versions: the server is older than this till, or this till is older than the server. */
export function protocolVerdict(info: ServerInfo | null = serverInfo()): { serverOlder: boolean; tillOlder: boolean } {
  if (!info) return { serverOlder: false, tillOlder: false };
  return { serverOlder: info.protocol < NODE_PROTOCOL, tillOlder: info.min_till_protocol > NODE_PROTOCOL };
}

// ── A refusal on a keyed route, said once in plain words ────────────────────────────────────────────────────────────
const refusalLogged = new Map<string, number>();
/**
 * A501: the server answered 401 on a route that needs this till's device key. Logged in one clear sentence (at most
 * once per 10 minutes per route) — with the reason when the server is newer than this till.
 */
export function noteKeyedRefusal(route: string, status: number, serverError: string | null, now = Date.now()): void {
  const k = `${route}|${status}`;
  if ((refusalLogged.get(k) ?? 0) > now - 10 * 60_000) return;
  refusalLogged.set(k, now);
  const v = protocolVerdict();
  const why = v.tillOlder
    ? `this POS is older than the branch server expects (protocol ${NODE_PROTOCOL}, the server needs ${serverInfo()?.min_till_protocol}) — update this POS`
    : (serverError || `HTTP ${status}`);
  logLine('node', `A501: the branch server refused this till on ${route} (HTTP ${status}): ${why}`);
}

/** Tests only. */
export function _resetNodeHealth(): void { channels.clear(); memo = undefined; refusalLogged.clear(); }
