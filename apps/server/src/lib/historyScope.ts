/**
 * historyScope.ts — A490: whose sales a person's History shows, and who records cash in / out and drawer expenses.
 *
 * Before A490 two POS switches the admin portal set decided this for "cashiers" (anyone who could not confirm a drawer):
 *   cashier_own_history   — a cashier's History shows only the sales they rang
 *   cashier_no_money_out  — only a manager signed in records cash in / out and drawer expenses
 * Now each is a permission the owner gives per role: `sales.history_all` and `shifts.cash_movements`.
 *
 * Until migration 134 has run (permissionsOpenBefore — nobody's role holds those keys yet, so everybody is given them)
 * the switches still apply to anyone without `shifts.confirm`, exactly as before. Once 134 is recorded (it gives the
 * keys per role, honouring the switches, and turns the switches off) only the permission decides.
 *
 * One helper for routes/orders.ts (History) and routes/shifts.ts (cash movements) so the two cannot drift.
 */
import { hasPermission } from '@zaptill/core/permissions';
import { permissionsOpenBefore } from './permissionsState';
import { callerMayConfirm } from './shiftConfirm';

type Caller = { isOwner?: boolean; permissionKeys?: string[]; isTill?: boolean };

/** Holds `key` (the token's fine keys; the owner always). No till-scope logging here: these shape an answer, they do
 *  not refuse a route.
 *  A494: a till's own session (no person) holds NONE of them. Its token carries '*' (lib/deviceGrant.ts), so this
 *  answered "yes" to every key: a till token saw every cashier's sales unnarrowed (sales.history_all), the reprint
 *  switch, unblinded stock counts (inventory.adjust, lib/stockTakeAccess.may), and could record cash movements. A person
 *  signed in on the till uses their own session for those. */
export function holds(req: Caller, key: string): boolean {
  if (req.isTill) return false;
  return !!req.isOwner || hasPermission(req.permissionKeys ?? [], key);
}

/** History shows only the caller's own sales. */
export function ownHistoryOnly(req: Caller, features: { cashier_own_history?: boolean }, openBefore = permissionsOpenBefore()): boolean {
  if (!holds(req, 'sales.history_all')) return true;
  return openBefore && !!features.cashier_own_history && !callerMayConfirm(req);
}

/** May the caller record cash in / out or a drawer expense at the POS? */
export function mayMoveMoney(req: Caller, features: { cashier_no_money_out?: boolean }, openBefore = permissionsOpenBefore()): boolean {
  if (!holds(req, 'shifts.cash_movements')) return false;
  return !(openBefore && !!features.cashier_no_money_out && !callerMayConfirm(req));
}
