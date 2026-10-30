/**
 * access.ts — A490: the till's screens ask ONE rule what the signed-in person may see and do.
 *
 * Owner, 2026-10-14/15: "turn most of this features into permissions which can be set in one place" — "dont just focus
 * on reports break even other views and how to limit what users see". The screens used to decide on the role's NAME in
 * eight places (App hasManagerRights, ManagerPage isManagerRole / has(), POSPage canForceClose, the update bar's role
 * list, syncNotice maySeeSync, expenseTypes mayAddExpenseType, voidRefund mayVoidRefund). Now every gate names a FINE key
 * of the catalogue (shared/permissions.ts) and asks `can(session, key)`:
 *
 *   - the owner's role (named owner / admin — the cloud's own rule, and the ONE place a role name decides anything on a
 *     screen) may do everything;
 *   - anyone else holds expandMap(session.permissions): an older cloud's broad keys become the fine keys they stood for,
 *     and a map from before the catalogue keeps what nobody was refused before.
 *
 * The main process checks the same keys again (main/tillAccess.ts) — a hidden button is a courtesy, never the control.
 * Pure (no React, no posApi), so the tests run it.
 */
import {
  expandMap, hasPermission, hasAnyPermission, isBackOffice, maySetMpesa, MAP_MARKER, OPEN_BEFORE_A490,
} from '@zaptill/core/permissions';

export interface SessionLike {
  role?: string | null;
  permissions?: Record<string, unknown> | null;
}

/** The owner's role (owner / admin), as the cloud decides it. */
export function isOwnerRole(role: string | null | undefined): boolean {
  return ['owner', 'admin'].includes(String(role ?? '').trim().toLowerCase());
}

/** The fine keys this person holds ('*' for the owner). */
export function heldKeys(s: SessionLike | null | undefined): Set<string> {
  if (!s) return new Set();
  if (isOwnerRole(s.role)) return new Set(['*']);
  const p = s.permissions;
  return expandMap(p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {});
}

/** May this person do / see `key`? Nobody signed in → no. */
export function can(s: SessionLike | null | undefined, key: string): boolean {
  return !!s && hasPermission(heldKeys(s), key);
}

/** Holds ANY of these keys. */
export function canAny(s: SessionLike | null | undefined, ...keys: string[]): boolean {
  return !!s && hasAnyPermission(heldKeys(s), keys);
}

/** The owner (everything) — the owner-only rules (void / refund rules, offers for every branch). */
export function isOwner(s: SessionLike | null | undefined): boolean {
  return heldKeys(s).has('*');
}

/**
 * Back office: holds anything beyond the shop floor, or is the owner — the PIN screen opens the manager screens for them,
 * the POS offers "← Manager", they see the sync notice. What nobody was refused before A490 (OPEN_BEFORE_A490 — every
 * cashier holds it on an older map, and every role holds the staff list after migration 134) does not count.
 */
export function backOffice(s: SessionLike | null | undefined): boolean {
  return isBackOffice([...heldKeys(s)].filter((k) => !OPEN_BEFORE_A490.includes(k)));
}

/** A519: the words a person without "Sell" reads — the same as main's (main/sellGate.ts SELL_REFUSAL). */
export const SELL_REFUSAL = 'Your role can’t sell on this POS — ask a manager to add ‘Sell’ to your role in Settings › Roles.';

/**
 * A519: may this person START a sale on this till — main's rule (main/sellGate.ts maySell): the owner; a map from
 * before the catalogue (no marker — nobody was refused a sale before A490); else orders.create. Who may not is not
 * routed into a POS they cannot use (App.tsx), and a bill already open when the rights change can still be finished.
 */
export function maySell(s: SessionLike | null | undefined): boolean {
  if (!s) return false;
  if (isOwner(s)) return true;
  if (!hasMarker(s)) return true;
  return can(s, 'orders.create');
}

/** Cost prices and margins: menu.costs or reports.costs. */
export function seesCosts(s: SessionLike | null | undefined): boolean {
  return canAny(s, 'menu.costs', 'reports.costs');
}

/** A492: may this person set the branch's M-Pesa number? The owner; settings.mpesa; or, on a map from before the
 *  catalogue, receipt.manage (who set the receipt's payment line before) — the main process's rule. */
export function mayMpesa(s: SessionLike | null | undefined): boolean {
  if (!s) return false;
  if (isOwner(s)) return true;
  return maySetMpesa(heldKeys(s), !hasMarker(s));
}

/** Was this map made by a cloud that knows the catalogue (A490)? */
export function hasMarker(s: SessionLike | null | undefined): boolean {
  return !!s?.permissions && (s.permissions as Record<string, unknown>)[MAP_MARKER] === true;
}

/**
 * Cash in / out and drawer expenses (shifts.cash_movements) — the main process's rule (tillAccess mayMoveMoney): a map
 * from before the catalogue keeps the admin portal's 'cashier_no_money_out' switch unless the person may confirm.
 */
export function mayMoveMoney(s: SessionLike | null | undefined, cashierNoMoneyOut: boolean): boolean {
  if (!s) return false;
  if (isOwner(s)) return true;
  if (hasMarker(s)) return can(s, 'shifts.cash_movements');
  return !cashierNoMoneyOut || can(s, 'shifts.confirm');
}

