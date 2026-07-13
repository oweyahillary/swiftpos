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
import { getDeviceConfig } from './deviceConfig';
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

  const cfg = getDeviceConfig();
  const createdAt = body._createdAt ?? new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (id, business_id, branch_id, order_number, order_type, status, subtotal, vat_amount, discount_amount, tip_amount, total, cashier_id, shift_id, customer_id, customer_name, customer_phone, created_at, device_id, sync_status)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      orderId, body.business_id ?? cfg?.branch_id ?? null, body.branch_id, body.order_number,
      body.order_type ?? 'retail', body.subtotal ?? 0, body.vat_amount ?? 0,
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

  server = http.createServer(async (req, res) => {
    try {
      const url = (req.url ?? '').split('?')[0];

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
        const { duplicate } = ingestOrder(body);
        return json(res, duplicate ? 200 : 201, { ok: true, duplicate });
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
