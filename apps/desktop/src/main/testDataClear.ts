/**
 * testDataClear.ts — A404: when ZapTill clears a client's test data on the cloud (admin portal, A396), the till clears
 * the same period from its own database.
 *
 * Owner, 2026-10-04/05: the cloud clear removed test sales from the cloud, but every till still held them — its History,
 * shift reports and Z-reports showed them, and a test trading day left open on a till kept it locked ("Trading day
 * 2026-10-03 was never closed on this till"). On its sync the till now asks the cloud for clears it has not applied
 * (GET /api/pos/test-data-clears) and removes, for each period:
 *
 *   - sales made in it (and their items, payments, receipts, credit rows, kitchen voids, pending reversals), sent or not —
 *     an unsent test sale must not reach the cloud after the clear;
 *   - shifts opened in it, unless a sale AFTER the period belongs to one (that drawer was real — it stays);
 *   - trading days opened in it, unless a shift that stays belongs to one;
 *   - cash in / out and expenses in it, or on a removed shift; held orders and stock movements in it.
 *
 * Menu, staff, settings and printers are never touched. Stock levels come from the cloud on the next pull.
 *
 * Branch-wide on purpose: the cloud clear is for the whole business, so a branch node removes every terminal's rows of
 * the period, as the cloud did.
 */
import type Database from 'better-sqlite3';

export interface ClearPeriod { id: string; from_at: string; to_at: string }
export interface ClearCounts { sales: number; shifts: number; days: number; cash_moves: number; expenses: number; kept_shifts: number }

export function applyTestDataClear(db: Database.Database, p: ClearPeriod): ClearCounts {
  const from = p.from_at, to = p.to_at;
  const run = db.transaction((): ClearCounts => {
    // branch-wide: the cloud's clear covers the business — every terminal's rows of the period
    const orderIds = (db.prepare(`SELECT id FROM orders WHERE created_at >= ? AND created_at <= ?`).all(from, to) as Array<{ id: string }>).map((r) => r.id);
    // branch-wide: shifts of the period; one a later sale belongs to was real and stays
    const shifts = db.prepare(`
      SELECT s.id, s.business_day_id,
             EXISTS (SELECT 1 FROM orders o WHERE o.shift_id = s.id AND o.created_at > ?) AS used_after
        FROM shifts s WHERE s.opened_at >= ? AND s.opened_at <= ?`).all(to, from, to) as Array<{ id: string; business_day_id: string | null; used_after: number }>;
    const goShifts = shifts.filter((s) => !s.used_after).map((s) => s.id);
    const kept = shifts.length - goShifts.length;

    const inList = (ids: string[]) => ids.map(() => '?').join(',');
    let sales = 0;
    if (orderIds.length) {
      for (let i = 0; i < orderIds.length; i += 400) {
        const ids = orderIds.slice(i, i + 400); const q = inList(ids);
        db.prepare(`DELETE FROM order_item_variants  WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id IN (${q}))`).run(...ids);
        db.prepare(`DELETE FROM order_item_modifiers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id IN (${q}))`).run(...ids);
        db.prepare(`DELETE FROM order_items WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM payments WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM receipt_payloads WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM customer_credit_transactions WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM pending_reversals WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM kitchen_voids WHERE order_id IN (${q})`).run(...ids);
        db.prepare(`DELETE FROM sync_queue WHERE order_id IN (${q})`).run(...ids);
        // branch-wide: the period's sales, every terminal
        sales += db.prepare(`DELETE FROM orders WHERE id IN (${q})`).run(...ids).changes;
      }
    }

    let cash = 0, exp = 0;
    if (goShifts.length) {
      const q = inList(goShifts);
      // branch-wide: rows of the removed shifts
      cash += db.prepare(`DELETE FROM float_transactions WHERE shift_id IN (${q})`).run(...goShifts).changes;
      exp += db.prepare(`DELETE FROM expenses WHERE shift_id IN (${q})`).run(...goShifts).changes;
      db.prepare(`DELETE FROM kitchen_voids WHERE shift_id IN (${q})`).run(...goShifts);
      db.prepare(`DELETE FROM kitchen_lines WHERE shift_id IN (${q})`).run(...goShifts);
      db.prepare(`DELETE FROM shifts WHERE id IN (${q})`).run(...goShifts);
    }
    // branch-wide: the period's cash in / out and expenses not on any shift that stays
    cash += db.prepare(`DELETE FROM float_transactions WHERE created_at >= ? AND created_at <= ?
                          AND (shift_id IS NULL OR shift_id NOT IN (SELECT id FROM shifts))`).run(from, to).changes;
    exp += db.prepare(`DELETE FROM expenses WHERE created_at >= ? AND created_at <= ?
                         AND (shift_id IS NULL OR shift_id NOT IN (SELECT id FROM shifts))`).run(from, to).changes;
    // branch-wide: trading days of the period that no remaining shift belongs to
    const days = db.prepare(`DELETE FROM business_days WHERE opened_at >= ? AND opened_at <= ?
                               AND id NOT IN (SELECT business_day_id FROM shifts WHERE business_day_id IS NOT NULL)`).run(from, to).changes;
    db.prepare(`DELETE FROM held_orders WHERE held_at >= ? AND held_at <= ?`).run(from, to);
    db.prepare(`DELETE FROM stock_movements WHERE created_at >= ? AND created_at <= ?`).run(from, to);

    return { sales, shifts: goShifts.length, days, cash_moves: cash, expenses: exp, kept_shifts: kept };
  });
  return run();
}
