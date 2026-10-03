// webSales.ts — cross-sync stage 1 (2026-09-27): the web POS's sales on THIS till's drawer, held on the till.
//
// Owner: "what i sell on the web using the same till should appear on the till". The web POS can stand in
// for a till (A273: it adopts the till's device id and joins its open drawer), but its sales lived only in
// the cloud — the till's orders list, shift panel and Z-report never showed them, and the close only knew
// their cash (A334 foreign-cash).
//
// The till now downloads them (POST /api/shifts/:id/foreign-orders) and stores them:
//   - under the CLOUD id, with origin = 'web'. The till keeps sending that id in foreign-cash's order_ids,
//     so the cloud never counts them a second time as "cash the till does not hold";
//   - sync_status = 'synced', never in sync_queue — the cloud already has them; the till must never push
//     them back (that would mint a duplicate sale);
//   - never offered to the branch node (nodeIngest.fillNodeOutbox skips origin rows) — the node is fed by
//     the till that RANG a sale, and the web is not a till.
// A sale the till rang itself (origin NULL) is never touched here, even if an id ever collided.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';

export interface WebOrder {
  id: string; order_number: string; order_type?: string | null; status: string;
  subtotal: number | string; vat_amount: number | string; discount_amount?: number | string | null;
  total: number | string; tip_amount?: number | string | null; ctl_amount?: number | string | null;
  covers?: number | null; customer_id?: string | null; customer_name?: string | null; customer_phone?: string | null;
  idempotency_key?: string | null; cashier_id?: string | null; shift_id?: string | null; branch_id?: string | null;
  created_at: string; void_reason?: string | null; voided_at?: string | null; voided_by?: string | null;
  refunded_at?: string | null; refunded_amount?: number | string | null; refund_reason?: string | null;
  delivery_person?: string | null;
  notes?: string | null;   // A367
  order_items?: Array<{ id: string; product_id?: string | null; product_name: string; category_name?: string | null;
    unit_price: number | string; quantity: number | string; subtotal: number | string; course?: string | null; fire_status?: string | null;
    notes?: string | null }>;
  payments?: Array<{ id: string; method: string; amount: number | string; amount_tendered?: number | string | null;
    change_given?: number | string | null; reference?: string | null; status: string; created_at: string }>;
}

/** The sales this till RANG on a shift — what it tells the cloud is its own (the cloud's idempotency_key). */
export function ownOrderIds(shiftId: string, db: Database.Database = getLocalDb()): string[] {
  return (db.prepare(`SELECT id FROM orders WHERE shift_id = ? AND origin IS NULL`).all(shiftId) as { id: string }[])
    .map((r) => r.id);
}

/** This till's drawers still worth asking about: open, or closed and not yet reconciled with the cloud. */
export function webSaleShifts(db: Database.Database = getLocalDb()): Array<{ id: string; business_id: string; branch_id: string }> {
  return db.prepare(`
    SELECT id, business_id, branch_id FROM shifts
     WHERE COALESCE(device_id,'') = COALESCE(?,'')
       AND (status = 'open' OR sync_status = 'pending')
  `).all(getDeviceConfig()?.device_id ?? null) as Array<{ id: string; business_id: string; branch_id: string }>;
}

/**
 * Store (or refresh) the web's sales on one shift. Idempotent: a sale already held is updated in place —
 * that is how a void or refund made on the web reaches the till. Returns how many rows were new or changed.
 */
export function applyWebOrders(
  shift: { id: string; business_id: string; branch_id: string },
  orders: WebOrder[],
  db: Database.Database = getLocalDb(),
): number {
  const own = getDeviceConfig()?.device_id ?? null;
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const existing = db.prepare(`SELECT origin, status, refunded_amount FROM orders WHERE id = ?`);
  const upsert = db.prepare(`
    INSERT INTO orders (id, business_id, branch_id, order_number, order_type, status, subtotal, vat_amount,
      discount_amount, total, created_at, device_id, sync_status, covers, tip_amount, customer_id, customer_name,
      customer_phone, idempotency_key, cashier_id, shift_id, void_reason, voided_at, voided_by, refunded_at,
      refunded_amount, refund_reason, delivery_person, ctl_amount, notes, delivery_fee, delivery_free, origin)
    VALUES (@id, @business_id, @branch_id, @order_number, @order_type, @status, @subtotal, @vat_amount,
      @discount_amount, @total, @created_at, @device_id, 'synced', @covers, @tip_amount, @customer_id, @customer_name,
      @customer_phone, @idempotency_key, @cashier_id, @shift_id, @void_reason, @voided_at, @voided_by, @refunded_at,
      @refunded_amount, @refund_reason, @delivery_person, @ctl_amount, @notes, @delivery_fee, @delivery_free, 'web')
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, void_reason = excluded.void_reason, voided_at = excluded.voided_at,
      voided_by = excluded.voided_by, refunded_at = excluded.refunded_at, refunded_amount = excluded.refunded_amount,
      refund_reason = excluded.refund_reason
  `);
  const delItems = db.prepare(`DELETE FROM order_items WHERE order_id = ?`);
  const delPays = db.prepare(`DELETE FROM payments WHERE order_id = ?`);
  const addItem = db.prepare(`
    INSERT INTO order_items (id, order_id, product_id, product_name, category_name, unit_price, quantity, subtotal, course, fire_status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addPay = db.prepare(`
    INSERT INTO payments (id, order_id, method, amount, amount_tendered, change_given, reference, status, created_at, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
  `);

  let changed = 0;
  db.transaction(() => {
    for (const o of orders) {
      if (o.status !== 'completed' && o.status !== 'voided') continue;
      const had = existing.get(o.id) as { origin: string | null; status: string; refunded_amount: number } | undefined;
      if (had && had.origin == null) continue;          // the till's own sale — never overwritten from the cloud
      const pays = (o.payments ?? []).filter((p) => p.status === 'completed' || p.status === 'refunded');
      if (had && had.status === o.status && n(had.refunded_amount) === n(o.refunded_amount)) {
        // Unchanged — but a refund's negative rows may have arrived after the sale; keep payments exact.
        const count = (db.prepare(`SELECT COUNT(*) AS c FROM payments WHERE order_id = ?`).get(o.id) as { c: number }).c;
        if (count === pays.length) continue;
      }
      upsert.run({
        id: o.id, business_id: shift.business_id, branch_id: o.branch_id ?? shift.branch_id,
        order_number: o.order_number, order_type: o.order_type ?? 'retail', status: o.status,
        subtotal: n(o.subtotal), vat_amount: n(o.vat_amount), discount_amount: n(o.discount_amount), total: n(o.total),
        created_at: o.created_at,
        // On THIS till's drawer, so on this till: its reports, day close and retention treat it as the till's.
        device_id: own,
        covers: o.covers ?? 1, tip_amount: n(o.tip_amount), customer_id: o.customer_id ?? null,
        customer_name: o.customer_name ?? null, customer_phone: o.customer_phone ?? null,
        idempotency_key: o.idempotency_key ?? null, cashier_id: o.cashier_id ?? null, shift_id: shift.id,
        void_reason: o.void_reason ?? null, voided_at: o.voided_at ?? null, voided_by: o.voided_by ?? null,
        refunded_at: o.refunded_at ?? null, refunded_amount: n(o.refunded_amount), refund_reason: o.refund_reason ?? null,
        delivery_person: o.delivery_person ?? null, ctl_amount: n(o.ctl_amount),
        notes: o.notes ?? null,   // A367
        delivery_fee: n((o as any).delivery_fee),   // 0.6.27
        delivery_free: (o as any).delivery_free === true ? 1 : 0,   // 0.6.33
      });
      delItems.run(o.id); delPays.run(o.id);
      for (const it of o.order_items ?? []) {
        addItem.run(it.id, o.id, it.product_id ?? '', it.product_name, it.category_name ?? null, n(it.unit_price),
          n(it.quantity), n(it.subtotal), it.course ?? null, it.fire_status ?? 'fired', it.notes ?? null);
      }
      for (const p of pays) {
        addPay.run(p.id, o.id, p.method, n(p.amount), n(p.amount_tendered), n(p.change_given), p.reference ?? null,
          p.status, p.created_at);
      }
      changed++;
    }
  })();
  return changed;
}

/**
 * The manager's "All tills at this branch" list, read from the cloud (GET /api/orders), in the shape the
 * local list uses. Owner (2026-09-27): a sale rung on a DIFFERENT till shows in the branch view, read
 * from the cloud. Payments as the close counts them (completed and refunded rows only).
 */
export function cloudBranchOrders(
  rows: Array<{ id: string; order_number: string; order_type?: string | null; status: string; total: number | string;
    created_at: string; device_id?: string | null; payments?: Array<{ method: string; amount: number | string; status: string }> }>,
  ownDeviceId: string | null,
): Array<Record<string, unknown>> {
  return rows.map((o) => ({
    id: o.id, order_number: o.order_number, order_type: o.order_type ?? 'retail', status: o.status,
    total: Number(o.total) || 0, created_at: o.created_at, device_id: o.device_id ?? null,
    this_till: !!ownDeviceId && o.device_id === ownDeviceId,
    payments: (o.payments ?? []).filter((p) => p.status === 'completed' || p.status === 'refunded')
      .map((p) => ({ method: p.method, amount: Number(p.amount) || 0 })),
  }));
}

// ── A336 follow-up (0.6.26): a void or refund made on the WEB of a sale this TILL rang ──
// The cloud reports them with the web-sales pull (`own_reversals`); applied here exactly as the till applies its own void
// or refund (ipcHandlers order:void / order:refund), so the Z-report, shift figures, day close and History agree with the
// cloud. Idempotent: a void only once; a refund only when the till has not refunded the sale itself, each money-out row
// under the cloud's own row id (INSERT OR IGNORE).
export interface OwnReversal {
  local_id: string; status: 'completed' | 'voided';
  voided_at: string | null; void_reason: string | null;
  refunded_at: string | null; refunded_amount: number | string; refund_reason: string | null;
  refund_payments?: Array<{ id: string; method: string; amount: number | string; created_at: string | null }>;
}

export function applyOwnReversals(
  reversals: OwnReversal[],
  db: Database.Database = getLocalDb(),
  onVoided: (orderId: string, voidedAt: string, reason: string | null) => void = () => {},
): number {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const own = db.prepare(`SELECT id, status, refunded_at, order_number FROM orders WHERE id = ? AND origin IS NULL`);
  const setVoid = db.prepare(`UPDATE orders SET status = 'voided', voided_at = ?, void_reason = COALESCE(void_reason, ?) WHERE id = ?`);
  const setRefund = db.prepare(`UPDATE orders SET refunded_at = ?, refunded_amount = ?, refund_reason = ? WHERE id = ?`);
  const addPay = db.prepare(`
    INSERT OR IGNORE INTO payments (id, order_id, method, amount, amount_tendered, change_given, reference, status, created_at, sync_status)
    VALUES (?, ?, ?, ?, 0, 0, ?, 'refunded', ?, 'synced')
  `);
  let changed = 0;
  const voided: Array<[string, string, string | null]> = [];
  db.transaction(() => {
    for (const r of reversals ?? []) {
      const row = own.get(String(r.local_id)) as { id: string; status: string; refunded_at: string | null; order_number: string } | undefined;
      if (!row) continue;                                   // not this till's sale (or a web-rung one — those come as orders)
      if (r.status === 'voided' && row.status !== 'voided') {
        const at = r.voided_at ?? new Date().toISOString();
        setVoid.run(at, r.void_reason ?? null, row.id);
        reverseRiderPayout(row.id, db);   // 0.6.27: a voided delivery's rider pay-out goes back in
        voided.push([row.id, at, r.void_reason ?? null]);
        changed++;
        continue;
      }
      if (n(r.refunded_amount) > 0 && !row.refunded_at && row.status !== 'voided') {
        const at = r.refunded_at ?? new Date().toISOString();
        for (const p of r.refund_payments ?? []) {
          addPay.run(String(p.id), row.id, String(p.method), -Math.abs(n(p.amount)), `REFUND-${row.order_number ?? ''}`, p.created_at ?? at);
        }
        setRefund.run(at, n(r.refunded_amount), r.refund_reason ?? '', row.id);
        changed++;
      }
    }
  })();
  // After the transaction: tell the branch node (the same event the till's own void emits).
  for (const [id, at, reason] of voided) { try { onVoided(id, at, reason); } catch { /* the local row is right regardless */ } }
  return changed;
}

/**
 * The till's own refund (ipcHandlers order:refund), mirrored locally once the cloud accepted it: the money-out rows and the
 * refunded fields. Skipped when the sale is already refunded here — the web-sales pull (`applyOwnReversals`, or
 * `applyWebOrders` for a web-rung sale) runs every ~20 s and can store the cloud's copy of THIS refund between the cloud
 * accepting it and its answer reaching the till; writing again would take the money out of the drawer twice.
 */
export function mirrorTillRefund(
  orderId: string,
  legs: Array<{ method: string; amount: number | string }>,
  refunded: number,
  reason: string,
  db: Database.Database = getLocalDb(),
  now: string = new Date().toISOString(),
): boolean {
  const insert = db.prepare(`
    INSERT INTO payments (id, order_id, method, amount, amount_tendered, change_given, reference, status, created_at, sync_status)
    VALUES (?, ?, ?, ?, 0, 0, ?, 'refunded', ?, 'synced')
  `);
  return db.transaction(() => {
    const row = db.prepare(`SELECT order_number, refunded_at FROM orders WHERE id = ?`).get(orderId) as
      { order_number: string | null; refunded_at: string | null } | undefined;
    if (row?.refunded_at) return false;                     // the pull got there first — already counted
    for (const leg of legs) {
      insert.run(randomUUID(), orderId, leg.method, -Math.abs(Number(leg.amount) || 0), `REFUND-${row?.order_number ?? ''}`, now);
    }
    db.prepare(`UPDATE orders SET refunded_at=?, refunded_amount=?, refund_reason=? WHERE id=?`).run(now, refunded, reason, orderId);
    return true;
  })();
}

/**
 * 0.6.27: a voided delivery sale's rider pay-out goes back in (a matching pay-in), so the drawer's expected cash does
 * not stay the fee lower for a sale that never happened. Only while the shift is open (a closed shift's figures are
 * final), and once (a second call finds the pay-in). Returns the amount put back (0 = nothing to do).
 */
export function reverseRiderPayout(orderId: string, db: Database.Database = getLocalDb()): number {
  const out = db.prepare(`
    SELECT f.id, f.shift_id, f.branch_id, f.cashier_id, f.amount, f.device_id, o.order_number
      FROM float_transactions f JOIN shifts s ON s.id = f.shift_id LEFT JOIN orders o ON o.id = f.order_id
     WHERE f.order_id = ? AND f.type = 'float_out' AND s.status = 'open'
  `).get(orderId) as { id: string; shift_id: string; branch_id: string; cashier_id: string; amount: number; device_id: string | null; order_number: string | null } | undefined;
  if (!out) return 0;
  const back = db.prepare(`SELECT 1 FROM float_transactions WHERE order_id = ? AND type = 'float_in'`).get(orderId);
  if (back) return 0;
  db.prepare(`
    INSERT INTO float_transactions (id, shift_id, branch_id, cashier_id, type, amount, reason, created_at, device_id, order_id, sync_status)
    VALUES (?, ?, ?, ?, 'float_in', ?, ?, ?, ?, ?, 'pending')
  `).run(randomUUID(), out.shift_id, out.branch_id, out.cashier_id, Number(out.amount),
         `Delivery fee back — sale voided${out.order_number ? ` (#${out.order_number})` : ''}`, new Date().toISOString(), out.device_id, orderId);
  return Number(out.amount);
}
