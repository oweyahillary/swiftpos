// A588 (owner, 2026-10-24: "FIX the petrol pos shop item, make it feel petrol-like, you can add gauges"): what the pumps
// screen shows beside each pump and grade — read from what this POS really holds, never made up.
//
//   - litres sold today per pump and per grade, and yesterday per grade (the fallback gauge "today vs yesterday"), and
//     each pump's last sale — from this POS's own completed fuel sales (its device_id) (orders.order_type 'fuel_sale', the fuel lines);
//   - the tanks' levels, when the cloud can say (GET /api/fuel-tanks, read with orders.create; this branch's tanks and
//     the business-wide ones), only with the online licence (A460: stock is premium on the desktop), bounded to 2 s and
//     asked at most once a minute. Offline, signed out, no licence or no tanks set up → null: the screen then shows the
//     litres gauge and never a level it does not know. The last answer is kept with the time it was read ("as of").
import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import { resolveRange } from './managerReports';

export interface ForecourtPumpDay {
  pump_id: string;
  litres_today: number;
  last_sale_at: string | null;
  last_sale_litres: number | null;
  last_sale_amount: number | null;
}
export interface ForecourtGradeDay { product_id: string; litres_today: number; litres_yesterday: number }
export interface ForecourtTank {
  id: string; name: string; product_id: string;
  capacity_litres: number; current_level: number; reorder_level: number | null;
}
export interface Forecourt {
  pumps: ForecourtPumpDay[];
  grades: ForecourtGradeDay[];
  /** null = the levels are not known on this POS now (see the header) — never zeros. */
  tanks: ForecourtTank[] | null;
  /** When the cloud last answered with the tanks (ISO), else null. */
  tanksAt: string | null;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** This POS's fuel sold today (per pump, per grade) and yesterday (per grade), and each pump's last sale. */
export function forecourtSales(): Pick<Forecourt, 'pumps' | 'grades'> {
  const db = getLocalDb();
  const today = resolveRange('today'), yesterday = resolveRange('yesterday');
  // This POS's own sales (on a POS that is also the branch server the table holds every POS's) — the screen says so.
  const dev = getDeviceConfig()?.device_id ?? null;
  // The fuel lines of completed fuel sales: a line is a pump's when it is that pump's grade on an order the pump is on
  // (orders.pump_id — the first fuel line's pump, as the server keeps it).
  const byGrade = (from: string, to: string) => db.prepare(`
    SELECT oi.product_id AS product_id, SUM(oi.quantity) AS litres
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    WHERE o.status = 'completed' AND o.order_type = 'fuel_sale' AND COALESCE(o.device_id,'') = COALESCE(?,'') AND p.is_fuel = 1
      AND o.created_at >= ? AND o.created_at <= ?
    GROUP BY oi.product_id
  `).all(dev, from, to) as { product_id: string; litres: number }[];
  const t = byGrade(today.from, today.to), y = byGrade(yesterday.from, yesterday.to);
  const ids = new Set([...t.map((r) => r.product_id), ...y.map((r) => r.product_id)]);
  const grades = [...ids].map((id) => ({
    product_id: id,
    litres_today: num(t.find((r) => r.product_id === id)?.litres),
    litres_yesterday: num(y.find((r) => r.product_id === id)?.litres),
  }));

  const pumpRows = db.prepare(`SELECT id, fuel_product_id FROM pumps`).all() as { id: string; fuel_product_id: string | null }[];
  const litresToday = db.prepare(`
    SELECT COALESCE(SUM(oi.quantity), 0) AS litres
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'completed' AND o.order_type = 'fuel_sale' AND COALESCE(o.device_id,'') = COALESCE(?,'') AND o.pump_id = ? AND oi.product_id = ?
      AND o.created_at >= ? AND o.created_at <= ?
  `);
  const lastSale = db.prepare(`
    SELECT o.created_at AS at, SUM(oi.quantity) AS litres, SUM(oi.subtotal) AS amount
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status = 'completed' AND o.order_type = 'fuel_sale' AND COALESCE(o.device_id,'') = COALESCE(?,'') AND o.pump_id = ? AND oi.product_id = ?
    GROUP BY o.id ORDER BY o.created_at DESC LIMIT 1
  `);
  const pumps = pumpRows.map((p) => {
    if (!p.fuel_product_id) return { pump_id: p.id, litres_today: 0, last_sale_at: null, last_sale_litres: null, last_sale_amount: null };
    const l = litresToday.get(dev, p.id, p.fuel_product_id, today.from, today.to) as { litres: number } | undefined;
    const s = lastSale.get(dev, p.id, p.fuel_product_id) as { at: string; litres: number; amount: number } | undefined;
    return {
      pump_id: p.id, litres_today: num(l?.litres),
      last_sale_at: s?.at ?? null, last_sale_litres: s ? num(s.litres) : null, last_sale_amount: s ? num(s.amount) : null,
    };
  });
  return { pumps, grades };
}

/** The cloud's tank rows for this branch (and the business-wide ones), cleaned; anything unreadable → null. */
export function cleanTanks(raw: unknown, branchId: string | null): ForecourtTank[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ForecourtTank[] = [];
  for (const r of raw as any[]) {
    if (!r || typeof r !== 'object') continue;
    if (r.branch_id && branchId && r.branch_id !== branchId) continue;   // another branch's tank
    const capacity = Number(r.capacity_litres), level = Number(r.current_level);
    const product = r.fuel_product_id ?? r.products?.id;
    if (!product || !Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(level)) continue;
    const reorder = r.reorder_level === null || r.reorder_level === undefined ? null : Number(r.reorder_level);
    out.push({ id: String(r.id), name: String(r.name ?? ''), product_id: String(product), capacity_litres: capacity,
      current_level: Math.max(0, level), reorder_level: reorder !== null && Number.isFinite(reorder) ? reorder : null });
  }
  return out;
}

export const TANKS_EVERY_MS = 60_000;
let lastTanks: { tanks: ForecourtTank[]; at: string; askedAt: number } | null = null;
let lastAskedAt = 0;

/** The tanks' levels: asked of the cloud at most once a minute (with the online licence), else the last answer. */
export async function forecourtTanks(ask: () => Promise<unknown>, now = Date.now()): Promise<Pick<Forecourt, 'tanks' | 'tanksAt'>> {
  const cfg = getDeviceConfig();
  if (cfg?.web_pos_enabled !== true) return { tanks: null, tanksAt: null };   // A460: stock is the online licence's
  if (now - lastAskedAt >= TANKS_EVERY_MS) {
    lastAskedAt = now;
    try {
      const tanks = cleanTanks(await ask(), cfg?.branch_id ?? null);
      if (tanks) lastTanks = { tanks, at: new Date(now).toISOString(), askedAt: now };
    } catch { /* offline, slow, signed out or not the cloud — keep the last answer */ }
  }
  return lastTanks ? { tanks: lastTanks.tanks, tanksAt: lastTanks.at } : { tanks: null, tanksAt: null };
}

/** Tests: forget the last answer. */
export function _resetForecourtTanks() { lastTanks = null; lastAskedAt = 0; }
