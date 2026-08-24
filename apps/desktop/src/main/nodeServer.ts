// nodeServer.ts — branch aggregation node (main process)
// ─────────────────────────────────────────────────────────────────────────────
// Runs ONLY on the device whose role is 'node' (the branch server). Other tills
// on the LAN push their completed orders here so this machine holds the whole
// branch's data and the manager can see combined totals.
//
// ── WHAT THIS NODE IS AND IS NOT (corrected 2026-08-09, register A18) ────────
// This header used to state that the node was "the SOLE uplink to the cloud",
// that "peer tills never push to the cloud directly", and that received peer
// orders were "re-enqueued into this node's sync_queue so the existing cloud
// push forwards them". NONE of that is true any more, and it had not been for
// some time — see syncEngine.ts:1138-1151, which records the change and its
// reason, and nodeIngest.ts:414-418.
//
// What is true now:
//
//   * A till pushes its own orders to TWO INDEPENDENT destinations — the cloud
//     via `sync_queue`, and the node via `node_queue`. One status column cannot
//     hold two destinations' opinions; the attempt to make it do so is what let
//     a peer close its shift against a server that did not have the sales.
//   * The node is a REPLICA, not a relay. `INSERT INTO sync_queue` exists in
//     exactly one place — syncEngine.ts:1566, at order creation on the till
//     that made the sale. **The node does not forward peer rows to the cloud.**
//   * Duplicates are prevented by stable client-generated UUIDs and
//     upsert-by-id / X-Idempotency-Key, NOT by there being a single path.
//
// CONSEQUENCE, and it is open as register A19: a peer till with no internet
// reaches the node over LAN, so branch totals here are right — but its own
// `sync_queue` never drains and nothing else drains it, so the CLOUD never sees
// those sales. Read A17/A19 before designing anything that assumes a peer can
// stay offline indefinitely; today it cannot, because auth is cloud-only too.
//
// A node is also a normal till; its own sales use the usual local path. Received
// peer orders are upserted into the same local tables so reports aggregate.
//
// Transport: Node's built-in http (no extra dependency). LAN-local; scoped by
// branch_id so a stray device from another branch can't inject orders.

import http from 'http';
import { isNodeRole } from './deviceConfig';
import crypto from 'crypto';
import { getLocalDb } from './localDb';
import { getDeviceConfig, ensureNodeSecret } from './deviceConfig';
import { getSalesSummary, getTopProducts, getRecentOrders, getStockLevels } from './managerReports';
import { applyPeerRows, isReplicatedTable, listPeers, collectDistribution, applyPendingEvents } from './nodeIngest';
import { verifyPinAtNode } from './branchStaff';
import { collectInstructions, recordAck, recordPeerState } from './branchClose';

const NODE_PORT = Number(process.env.SWIFTPOS_NODE_PORT ?? 4100);

// Tried in order when the one before is already in use. Kept short and
// contiguous deliberately: a human has to be able to read the number off one
// screen and type it into another, and a wide random range makes that worse.
const PORT_FALLBACKS = [NODE_PORT, NODE_PORT + 1, NODE_PORT + 2, NODE_PORT + 3];
let portAttempt = 0;
let boundPort: number | null = null;

let server: http.Server | null = null;

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ── LAN authentication ───────────────────────────────────────────────────────
// Every /node/* request must present the branch secret in X-Node-Secret.
//
// This server binds to all interfaces on port 4100. Before this check existed,
// anyone on the same network — which in a shop means the customer wifi — could
// POST a fabricated order (ingested locally AND forwarded to Supabase as a real
// sale), GET the branch's full sales report, and read or overwrite the live
// tech token. The branch_id comparison in the orders handler is not a substitute:
// it compares against a value the caller supplies.
//
// Fails closed. No secret configured means no requests served, rather than
// falling back to the previous open behaviour.
function authorised(req: http.IncomingMessage): boolean {
  const expected = getDeviceConfig()?.node_secret;
  if (!expected) return false;

  const raw = req.headers['x-node-secret'];
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (!presented) return false;

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, so compare lengths first. That
  // leaks only the length of a secret whose length is fixed and public anyway.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function json(res: http.ServerResponse, status: number, body: any) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

// Order ingest now goes through /node/sync like every other replicated table,
// so the bespoke ingestOrder path that used to live here is gone. It carried its
// own column list, its own dedupe and its own attribution rules, all of which
// had to agree with the ones in nodeIngest and had no way of proving they did.
//
// The bill-number conflict it handled (a reinstalled till restarting its counter
// and re-minting numbers this node already holds) surfaces through the ordinary
// rejection path now — applyPeerRows reports the insert error against the row,
// the peer escalates it to 'failed' after five attempts, and the reason reaches
// a person instead of a count that never clears.

export function startNodeServer(): void {
  if (server) return;                              // already running
  const cfg = getDeviceConfig();
  if (!isNodeRole(cfg?.device_role)) return;        // node OR office — both serve the branch

  // Mint on first start if absent — covers installs upgraded from a build that
  // predates the node_secret column, which would otherwise come up unauthenticated.
  // Logged so the code is recoverable from the node's own machine if the install
  // slip is lost; see also the SQLite query in the deploy notes.
  const secret = ensureNodeSecret();
  console.log(`[node] branch access code: ${secret}`);

  server = http.createServer(async (req, res) => {
    try {
      const url = (req.url ?? '').split('?')[0];

      // Applied before routing, so it covers health, orders, report and the
      // tech-session pair without any route being able to opt out by omission.
      if (!authorised(req)) {
        return json(res, 401, { error: 'unauthorised — bad or missing X-Node-Secret' });
      }

      // Health — tills probe this to decide reachability.
      if (req.method === 'GET' && url === '/node/health') {
        const c = getDeviceConfig();
        return json(res, 200, { ok: true, branch_id: c?.branch_id ?? null, device_id: c?.device_id ?? null, role: 'node' });
      }

      // Receive a peer till's cash records: shifts, floats, expenses, trading
      // days — and orders, once the till stops routing them through the cloud
      // branch below.
      //
      // This is the endpoint that makes a branch cash reconciliation possible.
      // Until now only orders crossed the LAN, so a manager could see the
      // branch's sales and none of the drawers behind them.
      //
      // Every row keeps the PEER's device_id and the PEER's seq. Stamping this
      // node's own would make peer drawers indistinguishable from its own in
      // getOpenShift, which the sell gate reads. applyPeerRows refuses rather
      // than guesses; see nodeIngest.ts.
      // PHASE5 §4c (A17): authenticate a peer's cashier against this node's
      // roster when the cloud is unreachable. Guarded by the same X-Node-Secret
      // + branch scope as every /node/* route (checked centrally above). Scans
      // all candidates and refuses on two, exactly as the server does. No JWT is
      // minted — the peer gets the identity + permissions and pushes orders under
      // its own owner token with this cashier_id, unchanged from the online path.
      if (req.method === 'POST' && url === '/node/verify-pin') {
        const body = await readBody(req);
        const c = getDeviceConfig();
        const branchId = String(body?.branch_id ?? c?.branch_id ?? '');
        const pin = String(body?.pin ?? '');
        if (c?.branch_id && body?.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        if (!pin || !branchId) return json(res, 400, { error: 'pin and branch_id are required' });

        const verdict = verifyPinAtNode(pin, branchId);
        if (verdict.ok) return json(res, 200, { ok: true, staff: verdict.staff });
        // A rejection is FINAL (the peer must not fall back to another authority
        // on a 'no'): 401 for a bad/ambiguous PIN, 503 only when the node cannot
        // read its own roster (a transport-like failure the peer may retry).
        const status = verdict.reason === 'unavailable' ? 503 : 401;
        return json(res, status, { ok: false, reason: verdict.reason, error: verdict.message });
      }

      // A160: broker a token refresh for a peer that can't reach the cloud but can
      // reach this node. Proxy the peer's refresh token upstream and pass the
      // cloud's verdict straight back (200 = new pair, 401 = revoked). If THIS
      // node can't reach the cloud either, 503 so the peer keeps trading offline
      // and retries. Authenticated by X-Node-Secret (checked above). Only the
      // node needs the internet.
      if (req.method === 'POST' && url === '/node/refresh') {
        const body = await readBody(req);
        const token = body?.refreshToken;
        if (!token) return json(res, 400, { error: 'refreshToken is required' });
        const serverUrl = getDeviceConfig()?.server_url;
        if (!serverUrl) return json(res, 503, { error: 'node has no cloud URL configured' });
        try {
          const up = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: token }),
          });
          const data = await up.json().catch(() => ({}));
          return json(res, up.status, data);
        } catch {
          return json(res, 503, { error: 'node cannot reach the cloud right now' });
        }
      }

      if (req.method === 'POST' && url === '/node/sync') {
        const body = await readBody(req);
        const c = getDeviceConfig();
        const peerDeviceId = String(body?.device_id ?? '');

        if (c?.branch_id && body.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }

        const results: Record<string, any> = {};
        for (const [table, rows] of Object.entries(body?.tables ?? {})) {
          if (!isReplicatedTable(table)) {
            // Named rather than ignored. A peer on a newer build sending a table
            // this node does not replicate must find out, or it will mark those
            // rows delivered and never offer them again.
            results[table] = { applied: 0, duplicate: 0, cursor: 0,
                               rejected: [{ id: '*', table, reason: 'this branch server does not replicate that table' }] };
            continue;
          }
          if (!Array.isArray(rows)) continue;
          results[table] = applyPeerRows(table, peerDeviceId, rows);
        }
        // Phase 2b: newly-ingested events mutate their replicas now, and any
        // event that arrived BEFORE its target row gets another chance —
        // repetition after every ingest is the whole answer to cross-table
        // ordering. Idempotent, so a round with nothing to do costs one SELECT.
        applyPendingEvents();
        return json(res, 200, { ok: true, results });
      }

      // What this node already holds from a given device, per table. A peer that
      // was reinstalled, or one whose outbox cursor was lost, can resume from
      // here instead of re-offering its whole history.
      if (req.method === 'GET' && url === '/node/cursors') {
        const device = new URL(req.url ?? '', 'http://node').searchParams.get('device');
        const all = listPeers();
        return json(res, 200, {
          cursors: device ? all.filter(p => p.device_id === device) : all,
        });
      }

      // Central day close (Phase 4) — a peer collects its pending instructions
      // and reports its own day state in the same request. PULL, never push:
      // the node cannot reach a peer, so this poll is the only channel, and the
      // piggybacked state is what the manager screen shows instead of the
      // node's replicated copies (which go stale after a close).
      if (req.method === 'POST' && url === '/node/instructions/poll') {
        const body = await readBody(req);
        const deviceId = String(body?.device_id ?? '');
        if (!deviceId) return json(res, 400, { error: 'device_id is required' });
        const c = getDeviceConfig();
        if (c?.branch_id && body.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        if (body.state) recordPeerState(deviceId, body.state);
        return json(res, 200, { instructions: collectInstructions(deviceId) });
      }

      // The peer's verdict. Only an ack retires an instruction — delivery alone
      // never does, so a peer that crashed mid-execution is re-offered it.
      if (req.method === 'POST' && url === '/node/instructions/ack') {
        const body = await readBody(req);
        const id = Number(body?.instruction_id);
        if (!Number.isInteger(id)) return json(res, 400, { error: 'instruction_id is required' });
        recordAck(id, {
          ok: body?.ok === true,
          error: body?.error ?? undefined,
          summary: body?.summary ?? undefined,
        });
        return json(res, 200, { ok: true });
      }

      // Phase 2a — distribution. A peer pulls every OTHER device's rows so the
      // whole branch lives on every till. Origin device_id and seq are served
      // as held; the requester's own rows are excluded at the source.
      if (req.method === 'POST' && url === '/node/since') {
        const body = await readBody(req);
        const deviceId = String(body?.device_id ?? '');
        if (!deviceId) return json(res, 400, { error: 'device_id is required' });
        const c = getDeviceConfig();
        if (c?.branch_id && body.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        const out = collectDistribution(deviceId, body?.cursors ?? {}, Number(body?.limit) || 500);
        return json(res, 200, out);
      }

      // Node-served time.
      //
      // Peers compare this against their own clock and warn above two minutes'
      // drift. The failure it heads off is not cosmetic: business_date is taken
      // from each till's own clock, so two tills that disagree by a few minutes
      // either side of midnight put the same evening's takings into two
      // different trading days, and no report will ever reconcile them.
      //
      // Advisory only — the node does not set anyone's clock, and a till whose
      // time is wrong keeps selling. A POS that stops trading because of NTP is
      // worse than one that reports a date its manager can correct.
      if (req.method === 'GET' && url === '/node/time') {
        return json(res, 200, { now: new Date().toISOString() });
      }

      // Combined branch report — any till's manager view reads this.
      if (req.method === 'GET' && url === '/node/report') {
        return json(res, 200, {
          salesSummary: getSalesSummary(),
          topProducts:  getTopProducts(),
          recentOrders: getRecentOrders(),
          stockLevels:  getStockLevels(),
          source: 'node',
        });
      }

      // Tech session broadcast: hold the latest tech token so peers can pick it
      // up and verify it themselves (self-validating, so no shared clock needed).
      if (req.method === 'POST' && url === '/node/tech-session') {
        const body = await readBody(req);
        setNodeTechToken(body.token ?? null);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url === '/node/tech-session') {
        return json(res, 200, { token: getNodeTechToken() });
      }

      json(res, 404, { error: 'not found' });
    } catch (err: any) {
      json(res, 500, { error: err?.message ?? 'node error' });
    }
  });

  // ── Port conflict ────────────────────────────────────────────────────────
  // This used to null the server and log to a console nobody reads on a shop
  // floor PC. If 4100 was already taken — another SwiftPOS instance, a portable
  // build left running, any unrelated service — the branch server silently did
  // not start, and tills 2 and 3 then failed with 'node unreachable' every 60
  // seconds with nothing on any screen explaining why.
  //
  // Now it walks up to the next few ports and REMEMBERS which one it got, so the
  // setup screen can show the address the other tills actually need to enter.
  // A branch server on a non-default port is unusual but recoverable; a branch
  // server that is not running at all is neither.
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && portAttempt < PORT_FALLBACKS.length - 1) {
      portAttempt++;
      const next = PORT_FALLBACKS[portAttempt];
      console.warn(`[node] port ${PORT_FALLBACKS[portAttempt - 1]} in use, trying ${next}`);
      setTimeout(() => server?.listen(next), 150);
      return;
    }
    console.error('[node] server error', e);
    boundPort = null;
    server = null;
  });

  server.listen(PORT_FALLBACKS[portAttempt], () => {
    boundPort = PORT_FALLBACKS[portAttempt];
    if (boundPort !== NODE_PORT) {
      console.warn(`[node] listening on :${boundPort} — NOT the default ${NODE_PORT}. ` +
                   `Other tills must use this port in their branch server address.`);
    } else {
      console.log(`[node] aggregation node listening on :${boundPort}`);
    }
  });
}

/**
 * The port the node server actually bound to, or null if it is not running.
 *
 * The setup screen shows this rather than the constant, because the number the
 * other tills need is the one that succeeded, not the one that was asked for.
 */
export function getNodePort(): number | null {
  return boundPort;
}

export function stopNodeServer(): void {
  if (server) { server.close(); server = null; }
  boundPort = null;
  portAttempt = 0;
}

// ── Broadcast tech token store (singleton row on the node) ──────────────────
function ensureNodeState() {
  getLocalDb().exec(`
    CREATE TABLE IF NOT EXISTS node_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tech_token TEXT,
      updated_at TEXT
    );
    INSERT OR IGNORE INTO node_state (id, updated_at) VALUES (1, datetime('now'));
  `);
}
function setNodeTechToken(token: string | null) {
  ensureNodeState();
  getLocalDb().prepare(`UPDATE node_state SET tech_token=?, updated_at=datetime('now') WHERE id=1`).run(token);
}
function getNodeTechToken(): string | null {
  ensureNodeState();
  return (getLocalDb().prepare(`SELECT tech_token FROM node_state WHERE id=1`).get() as any)?.tech_token ?? null;
}
