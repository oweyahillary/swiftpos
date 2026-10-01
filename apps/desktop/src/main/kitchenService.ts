/**
 * kitchenService.ts — 0.6.28: what went to the kitchen on this till, and what was taken back (kitchen voids).
 *
 * Owner, 2026-10-01: a sent order could be cancelled after the customer paid in cash — "the cashier pockets the money
 * … the kitchen staff proceed to prepare the meal". Decided:
 *   - once sent, every item ends PAID or as a recorded KITCHEN VOID (reason, cooked or not, who rang it, who approved);
 *   - a void prints a VOID ticket so the kitchen stops, and is on the Z-report;
 *   - 'kitchen_void_approval': a manager approves every void (signed in, or their PIN — "no grace period, the manager
 *     has to know and cancel"), and End Shift is refused while a sent order is unpaid;
 *   - 'pay_before_kitchen': takeaway / delivery / counter orders reach the kitchen only when paid (renderer + payment).
 *
 * kitchen_lines (local only) is the ledger: one row per cart line per order number. Clear, a crash or a restart cannot
 * lose a sent order, because the row stays 'open' until the sale is rung ('paid') or every sent item is voided.
 * kitchen_voids is pushed to the cloud (/api/sync/push → migration 112).
 */
import { v4 as uuid } from 'uuid';
import { getLocalDb } from './localDb';
import { getOpenShift } from './syncEngine';
import { getDeviceConfig, getPosFeatures } from './deviceConfig';
import { cleanVoidReason, cleanVoidNote, summariseKitchenVoids, type KitchenVoidSummary } from './kitchenLines';

const qty = (n: unknown) => Math.max(0, Math.round((Number(n) || 0) * 1000) / 1000);
const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

export interface KitchenLineIn {
  line_id: string;
  product_id?: string | null;
  product_name: string;
  unit_price: number;          // per item, modifiers included (lineTotal / quantity)
  qty: number;                 // sent now (a send) or taken back (a void)
  item?: unknown;              // the cart line, so a lost order can be rebuilt
}

function who(): { id: string | null; name: string | null } {
  const st = getLocalDb().prepare(`SELECT staff_id, staff_name FROM staff_session WHERE id=1`).get() as
    { staff_id?: string; staff_name?: string } | undefined;
  return { id: st?.staff_id ?? null, name: st?.staff_name ?? null };
}

function cleanLines(raw: unknown): KitchenLineIn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l: any) => ({
      line_id: String(l?.line_id ?? '').trim().slice(0, 80),
      product_id: l?.product_id ? String(l.product_id) : null,
      product_name: String(l?.product_name ?? '').trim().slice(0, 200) || 'Item',
      unit_price: money(l?.unit_price),
      qty: qty(l?.qty),
      item: l?.item,
    }))
    .filter((l) => l.line_id && l.qty > 0);
}

/** Send to kitchen: add what just went out to each line's sent count. */
export function recordKitchenSend(orderNumber: string, rawLines: unknown,
                                  ctx: { order_type?: string | null; table_number?: string | null } = {}): number {
  const num = String(orderNumber ?? '').trim();
  const lines = cleanLines(rawLines);
  if (!num || !lines.length) return 0;
  const db = getLocalDb();
  const now = new Date().toISOString();
  const shift = getOpenShift();
  const me = who();
  const up = db.prepare(`
    INSERT INTO kitchen_lines (order_number, line_id, product_id, product_name, unit_price, sent_qty, voided_qty, item_json,
                               order_type, table_number, shift_id, cashier_id, device_id, status, first_sent_at, updated_at)
    VALUES (@num, @line_id, @product_id, @product_name, @unit_price, @qty, 0, @item, @order_type, @table, @shift, @cashier,
            @device, 'open', @now, @now)
    ON CONFLICT(order_number, line_id) DO UPDATE SET
      sent_qty = kitchen_lines.sent_qty + excluded.sent_qty,
      unit_price = excluded.unit_price, item_json = COALESCE(excluded.item_json, kitchen_lines.item_json),
      order_type = COALESCE(excluded.order_type, kitchen_lines.order_type),
      table_number = COALESCE(excluded.table_number, kitchen_lines.table_number),
      status = 'open', updated_at = excluded.updated_at`);
  db.transaction(() => {
    for (const l of lines) {
      up.run({
        num, line_id: l.line_id, product_id: l.product_id, product_name: l.product_name, unit_price: l.unit_price,
        qty: l.qty, item: l.item === undefined ? null : JSON.stringify(l.item),
        order_type: ctx.order_type ?? null, table: ctx.table_number ?? null,
        shift: shift?.id ?? null, cashier: me.id, device: getDeviceConfig()?.device_id ?? null, now,
      });
    }
  })();
  return lines.length;
}

/** The sale was rung: its sent lines are paid for. Called from order:create. */
export function markKitchenPaid(orderNumber: string | null | undefined): number {
  const num = String(orderNumber ?? '').trim();
  if (!num) return 0;
  return getLocalDb().prepare(`UPDATE kitchen_lines SET status='paid', updated_at=? WHERE order_number=? AND status='open'`)
    .run(new Date().toISOString(), num).changes;
}

export interface KitchenVoidIn {
  order_number: string;
  lines: unknown;
  reason: unknown;
  note?: unknown;
  cooked?: unknown;
}

/**
 * Take sent items back. The approver is decided by the caller (ipcHandlers: the signed-in manager, or the PIN's owner;
 * null when the client has no 'kitchen_void_approval' — still recorded, under the cashier).
 */
export function recordKitchenVoid(input: KitchenVoidIn, approver: { id: string; name: string | null } | null) {
  const num = String(input.order_number ?? '').trim();
  const lines = cleanLines(input.lines);
  const reason = cleanVoidReason(input.reason);
  if (!num) throw new Error('The order number is missing.');
  if (!lines.length) throw new Error('Nothing to void.');
  if (!reason) throw new Error('Choose why these items are being taken back.');
  const note = cleanVoidNote(input.note);
  const cooked = input.cooked === true ? 1 : 0;
  const db = getLocalDb();
  const now = new Date().toISOString();
  const shift = getOpenShift();
  const me = who();
  const session = db.prepare(`SELECT business_id FROM session WHERE id=1`).get() as { business_id?: string } | undefined;
  const branchId = getDeviceConfig()?.branch_id
    ?? (db.prepare(`SELECT branch_id FROM staff_session WHERE id=1`).get() as { branch_id?: string } | undefined)?.branch_id
    ?? null;
  const device = getDeviceConfig()?.device_id ?? null;
  const ins = db.prepare(`
    INSERT INTO kitchen_voids (id, business_id, branch_id, shift_id, order_number, order_id, product_id, product_name,
                               quantity, unit_price, amount, reason, note, cooked, cashier_id, cashier_name, approved_by,
                               approved_by_name, device_id, created_at, sync_status)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
  // A line sent before 0.6.28 (a held tab) has no ledger row: it is created as sent, then voided.
  const ledger = db.prepare(`
    INSERT INTO kitchen_lines (order_number, line_id, product_id, product_name, unit_price, sent_qty, voided_qty, item_json,
                               shift_id, cashier_id, device_id, status, first_sent_at, updated_at)
    VALUES (@num, @line_id, @product_id, @product_name, @unit_price, @qty, @qty, NULL, @shift, @cashier, @device,
            'voided', @now, @now)
    ON CONFLICT(order_number, line_id) DO UPDATE SET
      sent_qty   = MAX(kitchen_lines.sent_qty, kitchen_lines.voided_qty + excluded.voided_qty),
      voided_qty = kitchen_lines.voided_qty + excluded.voided_qty,
      updated_at = excluded.updated_at`);
  const settle = db.prepare(`
    UPDATE kitchen_lines SET status='voided' WHERE order_number=? AND line_id=? AND status='open' AND voided_qty >= sent_qty`);
  const ids: string[] = [];
  let total = 0;
  db.transaction(() => {
    for (const l of lines) {
      const id = uuid();
      const amount = money(l.unit_price * l.qty);
      ins.run(id, session?.business_id ?? null, branchId, shift?.id ?? null, num, l.product_id, l.product_name, l.qty,
        l.unit_price, amount, reason, note, cooked, me.id, me.name, approver?.id ?? null, approver?.name ?? null, device, now);
      ledger.run({ num, line_id: l.line_id, product_id: l.product_id, product_name: l.product_name,
        unit_price: l.unit_price, qty: l.qty, shift: shift?.id ?? null, cashier: me.id, device, now });
      settle.run(num, l.line_id);
      ids.push(id);
      total += amount;
    }
  })();
  return { ids, total: money(total), reason, cooked: cooked === 1, lines };
}

export interface OpenKitchenOrder {
  order_number: string;
  order_type: string | null;
  table_number: string | null;
  first_sent_at: string;
  cashier_id: string | null;
  held: boolean;                  // parked as a tab (recall it) — otherwise it was on screen when the till lost it
  value: number;
  lines: Array<{ line_id: string; product_id: string | null; product_name: string; unit_price: number; qty: number;
                 item: unknown }>;
}

/**
 * Sent orders not yet paid, with what is still on a ticket (sent − voided). `shiftId` given: that shift's only (End
 * Shift); omitted: every one this till has (recovery).
 */
export function openKitchenOrders(shiftId?: string | null): OpenKitchenOrder[] {
  const db = getLocalDb();
  const rows = db.prepare(`
    SELECT * FROM kitchen_lines WHERE status='open' AND sent_qty > voided_qty
      ${shiftId !== undefined ? 'AND COALESCE(shift_id,\'\') = COALESCE(?,\'\')' : ''}
    ORDER BY first_sent_at, order_number`).all(...(shiftId !== undefined ? [shiftId ?? null] : [])) as any[];
  const held = new Set((db.prepare(`SELECT order_number FROM held_orders`).all() as { order_number: string }[])
    .map((r) => r.order_number));
  const by = new Map<string, OpenKitchenOrder>();
  for (const r of rows) {
    let o = by.get(r.order_number);
    if (!o) {
      o = { order_number: r.order_number, order_type: r.order_type ?? null, table_number: r.table_number ?? null,
            first_sent_at: r.first_sent_at, cashier_id: r.cashier_id ?? null, held: held.has(r.order_number),
            value: 0, lines: [] };
      by.set(r.order_number, o);
    }
    const q = qty(r.sent_qty - r.voided_qty);
    let item: unknown = null;
    try { item = r.item_json ? JSON.parse(r.item_json) : null; } catch { item = null; }
    o.lines.push({ line_id: r.line_id, product_id: r.product_id ?? null, product_name: r.product_name,
                   unit_price: Number(r.unit_price) || 0, qty: q, item });
    o.value = money(o.value + (Number(r.unit_price) || 0) * q);
    if (r.first_sent_at < o.first_sent_at) o.first_sent_at = r.first_sent_at;
  }
  return [...by.values()];
}

/** End Shift with 'kitchen_void_approval': refused while this shift has a sent order unpaid. null = may close. */
export function kitchenCloseBlock(shiftId: string): string | null {
  if (!getPosFeatures().kitchen_void_approval) return null;
  const open = openKitchenOrders(shiftId);
  if (!open.length) return null;
  const list = open.slice(0, 4).map((o) => `#${o.order_number}`).join(', ') + (open.length > 4 ? ` and ${open.length - 4} more` : '');
  return `${open.length} order${open.length === 1 ? ' was' : 's were'} sent to the kitchen and not paid (${list}). ` +
    'Charge them, or have a manager void them, before ending the shift.';
}

export interface KitchenVoidLine {
  id: string; order_number: string; product_name: string; quantity: number; amount: number; reason: string;
  note: string | null; cooked: boolean; cashier_name: string | null; approved_by_name: string | null; created_at: string;
}

/** The Z-report's kitchen voids for a shift: the lines and their sums. */
export function kitchenVoidsForShift(shiftId: string): { summary: KitchenVoidSummary; lines: KitchenVoidLine[] } {
  const rows = getLocalDb().prepare(`
    SELECT id, order_number, product_name, quantity, amount, reason, note, cooked, cashier_name, approved_by_name, created_at
      FROM kitchen_voids WHERE shift_id = ? ORDER BY created_at`).all(shiftId) as any[];
  return {
    summary: summariseKitchenVoids(rows),
    lines: rows.map((r) => ({ ...r, quantity: Number(r.quantity) || 0, amount: Number(r.amount) || 0, cooked: r.cooked === 1 })),
  };
}
