/**
 * shiftConfirm.ts — A365 (2026-09-29): a manager confirms every cashier's shift, on every payment method.
 *
 * Owner: "the managers should confirm shift before closing the day … it should block … They should recount incase the
 * cashier submitted less than the amount … applies to both [till and web] … on all payment method not just mpesa".
 * A manager who worked the shift may confirm it — "allowed, flagged".
 *
 * Pure (no database): the route and the tests run these exact rules.
 */
import { type ApproverRow } from './approver';
import { hasPermission, expandKeys } from './permissions';   // A490
import { isOwnerRoleName } from './ownerRole';
import { keysForRow } from './effectiveKeys';

/** A payment-method → amount map: {"cash": 5500, "mpesa": 3250}. */
export type MethodMap = Record<string, number>;

/**
 * Who may confirm a shift (and approve pay-outs and kitchen voids with their PIN): A490 — whoever holds `shifts.confirm`
 * (the owner, the owner's role, '*'; a role saved with orders.void / shifts.manage / settings.manage before migration
 * 134 holds it, expanded — shared permissions.ts LEGACY). Never a plain cashier.
 */
export function mayConfirm(row: ApproverRow, ownerId: string | null | undefined): boolean {
  if (ownerId && row.id === ownerId) return true;
  if (isOwnerRoleName(row.roles?.name)) return true;
  return hasPermission(keysForRow(row, false), 'shifts.confirm');
}

/** The same rule for the signed-in caller (the token's keys), so a manager on the dashboard confirms without a PIN. */
export function callerMayConfirm(req: { isOwner?: boolean; permissionKeys?: string[]; isTill?: boolean }): boolean {
  // A415: the till's own session is not a person — a manager confirms or approves with their own PIN.
  if (req.isTill) return false;
  return !!req.isOwner || hasPermission(expandKeys(req.permissionKeys ?? []), 'shifts.confirm');
}

/**
 * A clean method map, or null when the input is not one. Codes are trimmed and lower-cased; amounts are finite,
 * non-negative and rounded to cents. At most 30 methods (a business has a handful).
 */
export function methodMap(input: unknown): MethodMap | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: MethodMap = {};
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 30) return null;
  for (const [k, v] of entries) {
    const code = String(k).trim().toLowerCase();
    const n = Number(v);
    if (!code || code.length > 40 || v === null || v === '' || !Number.isFinite(n) || n < 0) return null;
    out[code] = Math.round(n * 100) / 100;
  }
  return out;
}

export interface MethodLine {
  method: string;
  declared: number | null;
  expected: number | null;
  confirmed: number | null;
  /** confirmed − expected (the official variance), or null before confirmation. */
  variance: number | null;
  /** The manager's recount differs from what the cashier declared. */
  mismatch: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** One line per method any of the three maps names, cash first, then by name. */
export function confirmationLines(declared: MethodMap | null, expected: MethodMap | null, confirmed: MethodMap | null): MethodLine[] {
  const codes = new Set<string>([...Object.keys(declared ?? {}), ...Object.keys(expected ?? {}), ...Object.keys(confirmed ?? {})]);
  const order = [...codes].sort((a, b) => (a === 'cash' ? -1 : b === 'cash' ? 1 : a.localeCompare(b)));
  return order.map((m) => {
    const d = declared ? (declared[m] ?? 0) : null;
    const e = expected ? (expected[m] ?? 0) : null;
    const c = confirmed ? (confirmed[m] ?? 0) : null;
    return {
      method: m, declared: d, expected: e, confirmed: c,
      variance: c !== null && e !== null ? r2(c - e) : null,
      mismatch: d !== null && c !== null && Math.round(d * 100) !== Math.round(c * 100),
    };
  });
}

/** Did the manager confirm a shift they worked themselves? */
export function isSelfConfirm(confirmerId: string, shift: { cashier_id?: string | null; opened_by?: string | null }): boolean {
  return confirmerId === shift.cashier_id || confirmerId === shift.opened_by;
}

/**
 * A replayed time from a till: kept when it is a real time no later than a few minutes from now (a till clock may
 * run slightly ahead); otherwise the cloud's own time.
 */
export function replayTime(iso: unknown, now: Date = new Date()): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isFinite(t) && t <= now.getTime() + 5 * 60_000) return new Date(t).toISOString();
  return now.toISOString();
}
