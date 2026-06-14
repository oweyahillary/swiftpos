/**
 * managerReports.ts — Local SQLite report queries for the desktop manager dashboard.
 *
 * Decision D9 (architecture doc): "Reporting is tiered, not gated."
 * Desktop = today/shift/branch, summary, view-only.
 * Web     = any range, full slicing, cross-branch, export.
 *
 * All queries run against the local SQLite DB. No server calls here.
 */

import { getLocalDb } from './localDb';

function todayRange() {
  const now  = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const to   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
  return { from, to };
}

// ── Sales KPIs (today, this branch) ──────────────────────────────────────────
export function getSalesSummary() {
  const db = getLocalDb();
  const { from, to } = todayRange();

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
export function getTopProducts(limit = 8) {
  const db = getLocalDb();
  const { from, to } = todayRange();

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
export function getRecentOrders(limit = 30) {
  const db = getLocalDb();

  const orders = db.prepare(`
    SELECT id, order_number, order_type, status, total, vat_amount,
           discount_amount, created_at, cashier_id, shift_id
    FROM orders
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];

  // Enrich with payment method(s)
  return orders.map(o => {
    const payments = db.prepare(`
      SELECT method, amount FROM payments WHERE order_id = ?
    `).all(o.id) as { method: string; amount: number }[];
    return { ...o, payments };
  });
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
export function getFuelSalesToday() {
  const db = getLocalDb();
  const { from, to } = todayRange();

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
           pr.name AS product_name, pr.base_price AS price_per_litre
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
