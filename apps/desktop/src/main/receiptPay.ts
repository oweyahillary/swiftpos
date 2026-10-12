/**
 * receiptPay.ts — A450: how a customer pays the business by M-Pesa, printed on the receipt under the payments
 * ("Buy Goods: 123456", "Paybill: 4098201"). Set on the web (Settings › Business profile, or a branch's own under Branches),
 * sent with every catalogue pull (the branch's own wins) and kept here so an offline till prints it too. Owner, 2026-10-12:
 * "on the receipt there is a section written payment method, how do I add till number there or buy goods? I can't find
 * that in settings" — the receipt had the line all along (shared/printing render.ts), but nothing ever filled it.
 */
import { getLocalDb } from './localDb';
import { cleanReceiptPay, type ReceiptPay } from './referenceBundle';

const KEY = 'receipt_pay';

/** What this till prints, or null (no number set — no line). */
export function getReceiptPay(): ReceiptPay | null {
  try {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(KEY) as { value?: string } | undefined;
    const v = row?.value ? JSON.parse(row.value) : null;
    return v ? cleanReceiptPay(v.label, v.number) : null;
  } catch { return null; }
}

/** undefined = not said (an older cloud or branch server) → keep; null = none. */
export function setReceiptPay(v: ReceiptPay | null | undefined): void {
  if (v === undefined) return;
  try {
    getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(KEY, JSON.stringify(v), new Date().toISOString());
  } catch { /* the next pull */ }
}
