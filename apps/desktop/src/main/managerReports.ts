/**
 * managerReports.ts — local SQLite report queries for the desktop manager screens.
 *
 * ── ON DECISION D9 ──────────────────────────────────────────────────────────
 * The architecture doc says "reporting is tiered, not gated": desktop = today
 * only, summary, view-only; web = any range, full slicing, export. This file has
 * been changed to support arbitrary date ranges and CSV export on the desktop,
 * at the owner's explicit request, because in practice the till is where managers
 * actually stand at closing time.
 *
 * The reason D9 existed is real and has NOT gone away, so it is handled rather
 * than ignored:
 *
 *   A TILL ONLY HOLDS ITS OWN SALES.
 *
 *   Each terminal has a standalone SQLite database. Orders reach a peer only via
 *   the aggregation node (POST /node/orders), so:
 *     • on a plain till, any report covers THAT TILL alone;
 *     • on the node, it covers the whole branch.
 *
 *   A manager reading a date-range total off till 2 and treating it as the shop's
 *   takings would be wrong by however much tills 1 and 3 sold — silently, with no
 *   indication anything was missing. That is worse than having no report.
 *
 *   So every range query is paired with getReportScope(), and the UI and the CSV
 *   both state which machine the figures came from and what they cover. The report
 *   is allowed to be partial; it is not allowed to be silently partial.
 *
 * Local history is never pruned, so a range can reach back to the first order this
 * terminal ever recorded — reported as `earliestOrder` so a range starting before
 * that is not mistaken for a quiet month.
 */

import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';

export type RangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'month' | 'custom';

export interface ReportRange {
  /** Inclusive ISO start. */
  from: string;
  /** Inclusive ISO end. */
  to: string;
  label: string;
}

/** Local midnight-to-midnight for a YYYY-MM-DD date, in the terminal's own time. */
function dayBounds(ymd: string): { start: Date; end: Date } {
  const [y, m, d] = ymd.split('-').map(Number);
  return {
    start: new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0),
    end: new Date(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999),
  };
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Turn a preset or an explicit pair of dates into a range.
 *
 * Local time throughout, deliberately — the same reasoning as business_date. A
 * trading day belongs to the shop's clock, and using UTC would cut the day at
 * 03:00 Nairobi and split an evening's takings across two dates.
 */
export function resolveRange(preset: RangePreset = 'today', from?: string, to?: string): ReportRange {
  const now = new Date();
  const today = ymd(now);

  const mk = (a: string, b: string, label: string): ReportRange => ({
    from: dayBounds(a).start.toISOString(),
    to: dayBounds(b).end.toISOString(),
    label,
  });

  switch (preset) {
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return mk(ymd(y), ymd(y), `Yesterday (${ymd(y)})`);
    }
    case 'last7': {
      const s = new Date(now); s.setDate(s.getDate() - 6);
      return mk(ymd(s), today, `Last 7 days (${ymd(s)} to ${today})`);
    }
    case 'last30': {
      const s = new Date(now); s.setDate(s.getDate() - 29);
      return mk(ymd(s), today, `Last 30 days (${ymd(s)} to ${today})`);
    }
    case 'month': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return mk(ymd(s), today, `This month (${ymd(s)} to ${today})`);
    }
    case 'custom': {
      // Swap rather than reject a reversed pair: a manager who picks the dates in
      // the wrong order means the range between them, and an empty report would
      // read as "no sales" rather than "you inverted the dates".
      const a = from || today;
      const b = to || today;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return mk(lo, hi, lo === hi ? lo : `${lo} to ${hi}`);
    }
    default:
      return mk(today, today, `Today (${today})`);
  }
}

export interface ReportScope {
  terminalCode: string | null;
  deviceRole: 'till' | 'node';
  /** True when this machine holds every till's orders, not just its own. */
  coversBranch: boolean;
  /** Plain-English scope, printed on the report and the CSV. */
  scopeLabel: string;
  /** ISO timestamp of the oldest order held locally, or null if there are none. */
  earliestOrder: string | null;
}

/**
 * What these figures actually cover. Must accompany every range report.
 *
 * Without this a manager cannot tell a quiet week from a report that only ever
 * had one till's data in it.
 */
export function getReportScope(): ReportScope {
  const db = getLocalDb();
  const cfg = getDeviceConfig();
  const role = (cfg?.device_role ?? 'till') as 'till' | 'node';
  const code = cfg?.terminal_code ?? null;

  const earliest = (db.prepare(
    `SELECT MIN(created_at) AS m FROM orders WHERE status = 'completed'`,
  ).get() as { m: string | null } | undefined)?.m ?? null;

  const tills = (db.prepare(
    `SELECT COUNT(DISTINCT COALESCE(device_id,'')) AS n FROM orders WHERE status='completed'`,
  ).get() as { n: number } | undefined)?.n ?? 0;

  const coversBranch = role === 'node';
  return {
    terminalCode: code,
    deviceRole: role,
    coversBranch,
    scopeLabel: coversBranch
      ? `All tills at this branch (${tills} seen)`
      : `This till only${code ? ` (${code})` : ''} — other tills are not included`,
    earliestOrder: earliest,
  };
}

/** Kept so callers that want today can stay unchanged. */
function todayRange() {
  const r = resolveRange('today');
  return { from: r.from, to: r.to };
}

// ── Sales KPIs (today, this branch) ──────────────────────────────────────────
export function getSalesSummary(range?: ReportRange) {
  const db = getLocalDb();
  const { from, to } = range ?? todayRange();

  const row = db.prepare(`
    SELECT
      COUNT(*)                        AS order_count,
      COALESCE(SUM(total), 0)        AS total_revenue,
      COALESCE(SUM(vat_amount), 0)   AS total_vat,
      COALESCE(SUM(discount_amount),0) AS total_discount,
      COALESCE(AVG(total), 0)        AS avg_order_value
    FROM orders
    WHERE status = 'completed'
      AND created_at >= ? AND created_at <= ?
  `).get(from, to) as any;

  // Payment method split
  const methods = db.prepare(`
    SELECT p.method, COALESCE(SUM(p.amount), 0) AS amount
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE o.status = 'completed'
      AND o.created_at >= ? AND o.created_at <= ?
    GROUP BY p.method
  `).all(from, to) as { method: string; amount: number }[];

  // Hourly (last 12 hours)
  const hourly = db.prepare(`
    SELECT
      strftime('%H', created_at) AS hour,
      COUNT(*)                   AS order_count,
      COALESCE(SUM(total), 0)   AS revenue
    FROM orders
    WHERE status = 'completed'
      AND created_at >= ? AND created_at <= ?
    GROUP BY strftime('%H', created_at)
    ORDER BY hour
  `).all(from, to) as { hour: string; order_count: number; revenue: number }[];

  return {
    summary: {
      totalRevenue:   Number(row.total_revenue),
      totalOrders:    Number(row.order_count),
      avgOrderValue:  Number(row.avg_order_value),
      totalVat:       Number(row.total_vat),
      totalDiscount:  Number(row.total_discount),
    },
    paymentMethods: Object.fromEntries(methods.map(m => [m.method, Number(m.amount)])),
    hourly: hourly.map(h => ({ hour: parseInt(h.hour), revenue: Number(h.revenue), orders: Number(h.order_count) })),
  };
}

// ── Top products today ────────────────────────────────────────────────────────
export function getTopProducts(limit = 8, range?: ReportRange) {
  const db = getLocalDb();
  const { from, to } = range ?? todayRange();

  return db.prepare(`
    SELECT
      oi.product_name AS name,
      SUM(oi.quantity) AS qty,
      SUM(oi.subtotal) AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'completed'
      AND o.created_at >= ? AND o.created_at <= ?
    GROUP BY oi.product_name
    ORDER BY revenue DESC
    LIMIT ?
  `).all(from, to, limit) as { name: string; qty: number; revenue: number }[];
}

// ── Order history (last N orders) ────────────────────────────────────────────
export function getRecentOrders(limit = 30, range?: ReportRange) {
  const db = getLocalDb();

  // The N+1 below is deliberate and bounded for the on-screen list, but an export
  // can span a month. Payments are therefore fetched in ONE pass and grouped in
  // memory: at ~2,000 orders the per-order query was the difference between an
  // instant CSV and a visibly frozen window.
  const where = range ? 'WHERE created_at >= ? AND created_at <= ?' : '';
  const params: (string | number)[] = range ? [range.from, range.to] : [];

  const orders = db.prepare(`
    SELECT id, order_number, order_type, status, total, vat_amount, ctl_amount,
           discount_amount, tip_amount, created_at, cashier_id, shift_id, device_id
    FROM orders
    ${where}
    ORDER BY created_at DESC
    ${limit > 0 ? 'LIMIT ?' : ''}
  `).all(...(limit > 0 ? [...params, limit] : params)) as any[];

  if (!orders.length) return [];

  const ids = orders.map(o => o.id);
  const placeholders = ids.map(() => '?').join(',');
  const allPayments = db.prepare(`
    SELECT order_id, method, amount FROM payments WHERE order_id IN (${placeholders})
  `).all(...ids) as { order_id: string; method: string; amount: number }[];

  const byOrder = new Map<string, { method: string; amount: number }[]>();
  for (const p of allPayments) {
    const list = byOrder.get(p.order_id) ?? [];
    list.push({ method: p.method, amount: Number(p.amount) });
    byOrder.set(p.order_id, list);
  }

  // Cashier names resolved once. `users`, not `staff` — there is no local staff
  // table, only staff_session for whoever is signed in.
  const names = new Map<string, string>();
  for (const u of db.prepare(`SELECT id, name FROM users`).all() as { id: string; name: string }[]) {
    names.set(u.id, u.name);
  }

  return orders.map(o => ({
    ...o,
    cashier_name: o.cashier_id ? (names.get(o.cashier_id) ?? null) : null,
    payments: byOrder.get(o.id) ?? [],
  }));
}

// ── Stock levels ──────────────────────────────────────────────────────────────
export function getStockLevels() {
  const db = getLocalDb();

  return db.prepare(`
    SELECT sl.product_id, sl.quantity, sl.low_stock_threshold,
           p.name AS product_name, p.category_id,
           c.name AS category_name
    FROM stock_levels sl
    JOIN products p ON p.id = sl.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.status = 'active'
    ORDER BY sl.quantity ASC
  `).all() as {
    product_id: string; quantity: number; low_stock_threshold: number;
    product_name: string; category_name: string | null;
  }[];
}

// ── Fuel sales today (petrol) — from local order_items ────────────────────────
export function getFuelSalesToday(range?: ReportRange) {
  const db = getLocalDb();
  const { from, to } = range ?? todayRange();

  // Grade breakdown
  const grades = db.prepare(`
    SELECT
      oi.product_name AS grade,
      SUM(oi.quantity) AS litres,
      SUM(oi.subtotal) AS revenue,
      COUNT(DISTINCT oi.order_id) AS transactions
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'completed'
      AND o.order_type = 'fuel_sale'
      AND o.created_at >= ? AND o.created_at <= ?
    GROUP BY oi.product_name
    ORDER BY revenue DESC
  `).all(from, to) as { grade: string; litres: number; revenue: number; transactions: number }[];

  // Summary
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS transactions,
      COALESCE(SUM(o.total), 0) AS revenue
    FROM orders o
    WHERE o.status = 'completed'
      AND o.order_type = 'fuel_sale'
      AND o.created_at >= ? AND o.created_at <= ?
  `).get(from, to) as { transactions: number; revenue: number };

  const totalLitres = grades.reduce((s, g) => s + Number(g.litres), 0);

  return {
    summary: {
      totalRevenue: Number(summary.revenue),
      totalLitres,
      totalTransactions: Number(summary.transactions),
    },
    grades: grades.map(g => ({ ...g, litres: Number(g.litres), revenue: Number(g.revenue) })),
  };
}

// ── Pump status (petrol) — from local pumps table ────────────────────────────
export function getPumpStatus() {
  const db = getLocalDb();
  const { from, to } = todayRange();

  const pumps = db.prepare(`
    SELECT p.id, p.name, p.status, p.fuel_product_id,
           pr.name AS product_name, COALESCE(pr.branch_price, pr.base_price) AS price_per_litre
    FROM pumps p
    LEFT JOIN products pr ON pr.id = p.fuel_product_id
    ORDER BY p.sort_order
  `).all() as any[];

  // Sold today per fuel product
  const soldByProduct = db.prepare(`
    SELECT oi.product_id,
           SUM(oi.quantity) AS litres,
           SUM(oi.subtotal) AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'completed'
      AND o.order_type = 'fuel_sale'
      AND o.created_at >= ? AND o.created_at <= ?
    GROUP BY oi.product_id
  `).all(from, to) as { product_id: string; litres: number; revenue: number }[];

  const soldMap = Object.fromEntries(soldByProduct.map(s => [s.product_id, s]));

  return pumps.map(pump => ({
    pump_id:       pump.id,
    pump_name:     pump.name,
    pump_status:   pump.status,
    product_name:  pump.product_name ?? null,
    price_per_litre: pump.price_per_litre ? Number(pump.price_per_litre) : null,
    sold_litres:   Number(soldMap[pump.fuel_product_id]?.litres ?? 0),
    revenue_today: Number(soldMap[pump.fuel_product_id]?.revenue ?? 0),
  }));
}

// ── Table occupancy (restaurant) — from held orders ─────────────────────────
export function getTableOccupancy() {
  const db = getLocalDb();

  const tables = db.prepare(`
    SELECT id, name, capacity, slot_type, pos_x, pos_y, zone, shape, sort_order
    FROM tables
    WHERE slot_type = 'dining'
    ORDER BY sort_order, name
  `).all() as any[];

  return tables;
}

// ── Branch price management (manager = branch authority) ─────────────────────
// Read/write the branch's own prices, LOCALLY. The manager owns these offline;
// they take effect on this device immediately and are queued (local_price_edits,
// synced=0) for the cloud up-sync (step 6). Effective price = branch_price ??
// base_price. See BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6.

export interface PriceRow {
  product_id:     string;
  product_name:   string;
  category_name:  string | null;
  base_price:     number;
  branch_price:   number | null;   // null → using base_price
  effective_price: number;
  pending:        boolean;          // edited locally, not yet synced up
}

export function getPriceList(): PriceRow[] {
  const db = getLocalDb();
  return db.prepare(`
    SELECT p.id            AS product_id,
           p.name          AS product_name,
           c.name          AS category_name,
           p.base_price    AS base_price,
           p.branch_price  AS branch_price,
           COALESCE(p.branch_price, p.base_price) AS effective_price,
           CASE WHEN lpe.product_id IS NOT NULL THEN 1 ELSE 0 END AS pending
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN local_price_edits lpe ON lpe.product_id = p.id AND lpe.synced = 0
    WHERE p.status = 'active' AND COALESCE(p.is_fuel, 0) = 0
    ORDER BY c.name, p.name
  `).all().map((r: any) => ({
    product_id:      r.product_id,
    product_name:    r.product_name,
    category_name:   r.category_name ?? null,
    base_price:      Number(r.base_price),
    branch_price:    r.branch_price === null || r.branch_price === undefined ? null : Number(r.branch_price),
    effective_price: Number(r.effective_price),
    pending:         !!r.pending,
  }));
}

// Set this branch's price for a product. Writes the live value AND records an
// unsynced local edit so it survives catalogue pulls and is ready to sync up.
export function setBranchPrice(productId: string, price: number): { ok: true } {
  if (!Number.isFinite(price) || price < 0) throw new Error('Price must be a number ≥ 0');
  const db  = getLocalDb();
  const now = new Date().toISOString();
  const exists = db.prepare(`SELECT 1 FROM products WHERE id = ?`).get(productId);
  if (!exists) throw new Error('Unknown product');

  const tx = db.transaction(() => {
    db.prepare(`UPDATE products SET branch_price = ? WHERE id = ?`).run(price, productId);
    db.prepare(`
      INSERT INTO local_price_edits (product_id, price, updated_at, updated_by, synced)
      VALUES (@product_id, @price, @updated_at, 'pc', 0)
      ON CONFLICT(product_id) DO UPDATE SET
        price = excluded.price, updated_at = excluded.updated_at, updated_by = 'pc', synced = 0
    `).run({ product_id: productId, price, updated_at: now });
  });
  tx();
  return { ok: true };
}

// Clear the override → revert to base_price. Recorded as a pending edit (price
// NULL) so the cloud override is also removed on up-sync.
export function clearBranchPrice(productId: string): { ok: true } {
  const db  = getLocalDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE products SET branch_price = NULL WHERE id = ?`).run(productId);
    db.prepare(`
      INSERT INTO local_price_edits (product_id, price, updated_at, updated_by, synced)
      VALUES (@product_id, NULL, @updated_at, 'pc', 0)
      ON CONFLICT(product_id) DO UPDATE SET
        price = NULL, updated_at = excluded.updated_at, updated_by = 'pc', synced = 0
    `).run({ product_id: productId, updated_at: now });
  });
  tx();
  return { ok: true };
}
