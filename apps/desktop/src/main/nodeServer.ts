// nodeServer.ts — branch aggregation node (main process)
// ─────────────────────────────────────────────────────────────────────────────
// Runs ONLY on the device whose role is 'node' (the branch server). Other tills
// on the LAN push their completed orders here so this machine holds the whole
// branch's data and the manager can see combined totals. The node is also the
// SOLE uplink to the cloud: peer tills never push to the cloud directly, so an
// order reaches the cloud by exactly one path (till → node → cloud), which —
// together with stable UUIDs and upsert-by-id — makes duplicates impossible.
//
// A node is also a normal till; its own sales use the usual local path. Received
// peer orders are upserted into the same local tables (so reports aggregate) and
// re-enqueued into this node's sync_queue so the existing cloud push forwards
// them with their ORIGINAL id/idempotency key (never re-minted).
//
// Transport: Node's built-in http (no extra dependency). LAN-local; scoped by
// branch_id so a stray device from another branch can't inject orders.

import http from 'http';
import crypto from 'crypto';
import { getLocalDb } from './localDb';
import { getDeviceConfig, ensureNodeSecret } from './deviceConfig';
import { getSalesSummary, getTopProducts, getRecentOrders, getStockLevels } from './managerReports';

const NODE_PORT = Number(process.env.SWIFTPOS_NODE_PORT ?? 4100);

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

// ── Upsert a received order into the node's local tables (order-level + items) ──
// Order-level is enough for combined sales/per-till/per-cashier totals; items are
// stored too so top-products works on the aggregate. Idempotent on order id.
function ingestOrder(body: any): { duplicate: boolean } {
  const db = getLocalDb();
  const orderId = body._orderId ?? body.idempotency_key ?? body._localOrderId;
  if (!orderId) throw new Error('order id missing');

  const existing = db.prepare(`SELECT id FROM orders WHERE id=?`).get(orderId) as any;
  if (existing) return { duplicate: true };  // already have it — no-op (dedupe)

  const createdAt = body._createdAt ?? new Date().toISOString();
  // Fall back to the node's OWN business, not its branch. The previous fallback
  // was `cfg?.branch_id`, which wrote a branch id into the business_id column
  // whenever a peer omitted business_id — wrong tenant on the row, and it then
  // propagated to Supabase on forward.
  const sessionRow = db.prepare(`SELECT business_id FROM session WHERE id=1`).get() as any;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (id, business_id, branch_id, order_number, order_type, delivery_person, status, subtotal, vat_amount, ctl_amount, discount_amount, tip_amount, total, cashier_id, shift_id, customer_id, customer_name, customer_phone, created_at, device_id, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      orderId, body.business_id ?? sessionRow?.business_id ?? null, body.branch_id, body.order_number,
      body.order_type ?? 'retail',
      // Both were dropped here while the verbatim cloud payload kept them, so
      // Supabase was right and the node's own branch report was not.
      body.order_type === 'delivery' ? (body.delivery_person ?? null) : null,
      body.subtotal ?? 0, body.vat_amount ?? 0, body.ctl_amount ?? 0,
      body.discount_amount ?? 0, body.tip_amount ?? 0, body.total ?? 0,
      body.cashier_id ?? null, body.shift_id ?? null,
      body.customer_id ?? null, body.customer_name ?? null, body.customer_phone ?? null,
      createdAt, body.device_id ?? null,
    );

    for (const item of body.items ?? []) {
      // Items arrive in the same shape createLocalOrder produced for the cloud.
      const pid   = item.product?.id ?? item.product_id ?? null;
      const pname = item.product?.name ?? item.product_name ?? '';
      const cat   = item.product?.categories?.name ?? item.category_name ?? null;
      const price = item.unitPrice ?? item.unit_price ?? 0;
      const qty   = item.quantity ?? 0;
      const line  = item.lineTotal ?? item.subtotal ?? 0;
      db.prepare(`
        INSERT INTO order_items (id, order_id, product_id, product_name, category_name, unit_price, quantity, subtotal, course, fire_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fired')
      `).run(crypto.randomUUID(), orderId, pid, pname, cat, price, qty, line, item.course ?? null);
    }

    // Re-enqueue the ORIGINAL cloud payload so this node forwards it upward with
    // the same id/idempotency key. body.payload is the verbatim till→cloud body.
    const cloudPayload = body.payload ?? JSON.stringify(body);
    db.prepare(`
      INSERT OR IGNORE INTO sync_queue (order_id, payload, created_at, status)
      VALUES (?, ?, ?, 'pending')
    `).run(orderId, cloudPayload, createdAt);
  })();

  return { duplicate: false };
}

export function startNodeServer(): void {
  if (server) return;                              // already running
  const cfg = getDeviceConfig();
  if (cfg?.device_role !== 'node') return;          // only the branch server runs this

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

      // Cloud-delivery confirmation.
      //
      // A peer till marks its orders 'node_ack' when THIS node accepts them, but
      // the node still has to forward them to Supabase. Until that happens the
      // cloud has no record of those sales — and a till that closed its shift on
      // node acceptance alone would have the server compute expected cash short
      // and report a variance that never existed.
      //
      // The till sends the ids it is waiting on; we answer with the subset whose
      // queue row is 'synced' — i.e. the cloud has accepted them. An id with no
      // queue row at all also counts as delivered: the only way to reach this
      // call is for the node to have accepted the order, and ingestOrder always
      // enqueues, so an absent row means the queue was pruned after a successful
      // push rather than that the order was lost.
      if (url === '/node/confirm' && req.method === 'POST') {
        const body = await readBody(req);
        const ids: string[] = Array.isArray(body?.order_ids) ? body.order_ids.map(String) : [];
        if (ids.length === 0) return json(res, 200, { delivered: [] });

        const db = getLocalDb();
        const placeholders = ids.map(() => '?').join(',');
        const stillQueued = db.prepare(
          `SELECT order_id FROM sync_queue WHERE order_id IN (${placeholders}) AND status != 'synced'`
        ).all(...ids) as Array<{ order_id: string }>;

        const waiting = new Set(stillQueued.map(r => r.order_id));
        return json(res, 200, { delivered: ids.filter(id => !waiting.has(id)) });
      }

      // Health — tills probe this to decide reachability.
      if (req.method === 'GET' && url === '/node/health') {
        const c = getDeviceConfig();
        return json(res, 200, { ok: true, branch_id: c?.branch_id ?? null, device_id: c?.device_id ?? null, role: 'node' });
      }

      // Receive a peer till's order.
      if (req.method === 'POST' && url === '/node/orders') {
        const body = await readBody(req);
        const c = getDeviceConfig();
        if (c?.branch_id && body.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        try {
          const { duplicate } = ingestOrder(body);
          return json(res, duplicate ? 200 : 201, { ok: true, duplicate });
        } catch (err: any) {
          // orders.order_number is UNIQUE locally. A till that was wiped and
          // reinstalled restarts its bill counter at 1, so it re-mints numbers
          // this node already holds from before the wipe. Left as a generic 500
          // the till just retried forever, showing only a pending count that
          // never cleared and no way to find out why.
          if (String(err?.message ?? '').includes('UNIQUE') && /order_number/i.test(String(err?.message))) {
            return json(res, 409, {
              error: `bill number ${body.order_number} already exists on this branch server — `
                   + 'that till was probably reinstalled and restarted its counter. '
                   + 'Give it a different terminal code and re-run setup on that till only.',
              conflict: 'order_number',
            });
          }
          throw err;
        }
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

  server.on('error', (e) => { console.error('[node] server error', e); server = null; });
  server.listen(NODE_PORT, () => console.log(`[node] aggregation node listening on :${NODE_PORT}`));
}

export function stopNodeServer(): void {
  if (server) { server.close(); server = null; }
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
