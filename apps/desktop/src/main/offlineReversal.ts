/**
 * offlineReversal.ts — 0.6.30 (A336 stage 3): void or refund a sale while the till cannot reach the cloud.
 *
 * Owner, 2026-10-01: "Void window yes let it remain 30 min but … owner to either increase or reduce the threshold …
 * manager only not cashier … for offline we will let the owner decide the refund method in the managers setting which
 * methods are allow … scope leave it to till own sales but let it be a feature on the owners page also".
 *
 * Until now a void or refund on the till was online only: authorising money leaving the drawer meant trusting a PIN the
 * till could not check. It can check one now — the same chain the A365 shift confirmation uses (the branch node, else
 * this till's saved sign-ins) — so, with the owner's rules (shared/reversalRules.ts, pulled with the catalogue):
 *   • only a manager or the owner may do it (the signed-in person), and a manager or the owner approves it (their PIN);
 *   • a VOID only within the owner's void window — the owner (as approver) at any age;
 *   • a REFUND only when every payment on the sale is a method the owner allows offline (default: cash);
 *   • only this till's own sales — a web sale on its drawer only when the owner has allowed it.
 * It is applied here at once, exactly as the online path applies the cloud's answer (the order voided, or the refund's
 * money-out rows), and queued in pending_reversals; the push stage replays it to the cloud — with who approved it and
 * when — once the sale itself is on the cloud (syncEngine pushOfflineReversals).
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getLocalDb } from './localDb';
import { mirrorTillRefund, reverseRiderPayout } from './webSales';
import {
  voidWindowOpen, minutesBetween, offlineRefundBlockedMethods, offlineScopeAllows, windowLabel, type ReversalRules,
} from './reversalRules';

export interface LocalPerson {
  id: string;
  name: string | null;
  roleName?: string | null;
  permissions?: unknown;
}

const perms = (p: LocalPerson | null | undefined): Record<string, unknown> => {
  const raw = p?.permissions;
  if (typeof raw === 'string') { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
  return (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
};

/** The owner (by role) — voids at any age. */
export function isOwnerLocal(p: LocalPerson | null | undefined): boolean {
  return String(p?.roleName ?? '').toLowerCase() === 'owner';
}

/** May this person void, refund, or approve one? Owner/admin, '*', or orders.void (managers) — never a cashier. */
export function mayReverseLocal(p: LocalPerson | null | undefined): boolean {
  if (!p?.id) return false;
  if (['owner', 'admin'].includes(String(p.roleName ?? '').toLowerCase())) return true;
  const k = perms(p);
  return k['*'] === true || k['orders.void'] === true;
}

const METHOD_NAMES: Record<string, string> = { cash: 'cash', mpesa: 'M-Pesa', card: 'card', credit: 'credit' };
const methodName = (m: string) => METHOD_NAMES[m] ?? m;
const list = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

export const OFFLINE_NOT_ON_TILL = 'This sale is not on this till. It can be voided or refunded when the till is back online.';

export interface OfflineReversalInput {
  kind: 'void' | 'refund';
  orderId: string;
  reason: string;
  /** The signed-in person doing it (must be a manager or the owner). */
  actor: LocalPerson | null;
  /** The person whose PIN approved it (checked by the caller). */
  approver: LocalPerson;
  rules: ReversalRules;
  deviceId: string | null;
  now?: Date;
}

export interface OfflineReversalResult {
  kind: 'void' | 'refund';
  orderId: string;
  at: string;
  refunded: number;
  queuedId: string;
}

/**
 * Apply a void or refund on this till and queue it for the cloud. Throws a message for the cashier's screen when the
 * owner's rules do not allow it offline; nothing is changed then.
 */
export function reverseOffline(input: OfflineReversalInput, db: Database.Database = getLocalDb()): OfflineReversalResult {
  const { kind, orderId, rules } = input;
  const reason = String(input.reason ?? '').trim();
  if (!reason) throw new Error(kind === 'refund' ? 'A reason is required to refund an order' : 'A reason is required to void an order');
  if (!mayReverseLocal(input.actor)) throw new Error('Only a manager or the owner can void or refund a sale.');
  if (!mayReverseLocal(input.approver)) throw new Error('That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.');

  const order = db.prepare(`SELECT id, status, created_at, origin, refunded_at FROM orders WHERE id = ?`).get(orderId) as
    { id: string; status: string; created_at: string; origin: string | null; refunded_at: string | null } | undefined;
  if (!order) throw new Error(OFFLINE_NOT_ON_TILL);
  if (!offlineScopeAllows(order.origin, rules)) {
    throw new Error('Offline, this till can only void or refund the sales it rang itself. This is a web sale — do it when the till is back online.');
  }
  if (order.status === 'voided') throw new Error('Order is already voided');
  if (order.refunded_at) throw new Error('That order has already been refunded');
  if (kind === 'refund' && order.status !== 'completed') throw new Error('Only a completed sale can be refunded');

  const now = input.now ?? new Date();
  const at = now.toISOString();

  if (kind === 'void') {
    const age = minutesBetween(order.created_at, now.getTime());
    if (!voidWindowOpen(age, rules, isOwnerLocal(input.approver))) {
      throw new Error(`This sale is ${age} minutes old — past the ${windowLabel(rules.voidWindowMinutes)} void window. Refund it instead.`);
    }
  }

  const legs = db.prepare(`SELECT method, amount FROM payments WHERE order_id = ? AND status = 'completed'`).all(orderId) as
    Array<{ method: string; amount: number }>;
  const taken = Math.round(legs.reduce((s, l) => s + (Number(l.amount) || 0), 0) * 100) / 100;
  if (kind === 'refund') {
    if (taken <= 0) throw new Error('No completed payment on that order — nothing was taken');
    const blocked = offlineRefundBlockedMethods(legs, rules);
    if (blocked.length) {
      const allowed = rules.offlineRefundMethods.map(methodName);
      throw new Error(
        `Offline, this till can refund only ${allowed.length ? list(allowed) : 'nothing (the owner has allowed no method)'}. `
        + `This sale was paid by ${list(blocked.map(methodName))} — refund it when the till is back online.`);
    }
  }

  const queuedId = randomUUID();
  db.transaction(() => {
    if (kind === 'void') {
      db.prepare(`UPDATE orders SET status = 'voided', voided_at = ?, void_reason = ? WHERE id = ?`).run(at, reason, orderId);
      reverseRiderPayout(orderId, db);   // 0.6.27: a voided delivery's rider pay-out goes back in
    } else {
      mirrorTillRefund(orderId, legs, taken, reason, db, at);
    }
    db.prepare(`
      INSERT INTO pending_reversals (id, order_id, kind, reason, approved_by, approved_by_name, done_by, amount, device_id, approved_at, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(queuedId, orderId, kind, reason, input.approver.id, input.approver.name ?? null, input.actor?.id ?? null,
           kind === 'refund' ? taken : 0, input.deviceId, at);
  })();
  return { kind, orderId, at, refunded: kind === 'refund' ? taken : 0, queuedId };
}

/**
 * What to do with the cloud's answer to a replay: 'done' (accepted, or it already had it), 'refused' (nothing a retry
 * fixes — the till that holds the sale or the approver was refused, or the sale cannot take it), or 'retry' (the sale
 * is not on the cloud yet, a cloud before 0.6.30, a network or server error).
 */
export function replayOutcome(kind: 'void' | 'refund', status: number, body: any): 'done' | 'refused' | 'retry' {
  if (status >= 200 && status < 300) return 'done';
  const code = String(body?.code ?? '');
  const text = `${body?.error ?? ''} ${body?.detail ?? ''}`;
  if (code === 'ALREADY_VOIDED' || code === 'ALREADY_REFUNDED') return 'done';
  if (kind === 'void' && /already voided/i.test(text)) return 'done';
  if (kind === 'refund' && /already been refunded/i.test(text)) return 'done';
  if (code === 'NOT_THIS_TILL' || code === 'NOT_AN_APPROVER') return 'refused';
  // A business-rule 400 without a code (e.g. "That order was voided — there is nothing to refund").
  if (status === 400 && !code) return 'refused';
  return 'retry';
}
