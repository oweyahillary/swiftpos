// cashier.ts — A169, A415. Who a sale is credited to.
//
// ONLINE a cashier signs in by PIN and the order pushes under their own token (a person; userId = the cashier) — the
// subject IS the cashier and cannot be reattributed, so an online sale can never be spoofed.
//
// From the TILL'S OWN session (A415: the till, the business, the branch — no person, userId null) the till names the
// cashier who rang the sale as a payload `cashier_id`. The server trusts that claim only when it validates against the
// roster exactly as verify-pin does (an active user of this business with access to this branch — the caller supplies
// that result as `claimValid`). An owner's own session (the dashboard, the web POS) may name a cashier the same way.
// An invalid or missing claim credits the subject — for the till's own session that is nobody (null): never the owner.
//
// Residual risk (accepted): the till's session can attribute a sale to ANY branch-authorised cashier, not provably the
// one who rang it. It is attribution, not money movement.

export interface CashierResolutionInput {
  /** May this session name the cashier — the till's own session, or an owner's? (Not a person's PIN token.) */
  mayClaim: boolean;
  /** The token subject (req.userId) — the fallback and the online cashier. null for the till's own session. */
  subject: string | null;
  /** The payload `cashier_id` the till claims rang the sale (may be absent). */
  claimed: string | null | undefined;
  /** Did `claimed` validate against the roster (active, in business, branch access)? */
  claimValid: boolean;
}

/**
 * Resolve the cashier to credit. Pure so the decision is unit-tested directly.
 * The DB validation that produces `claimValid` lives in the route (it needs the
 * client) and mirrors verify-pin.
 */
export function pickCashier(x: CashierResolutionInput): string | null {
  // A person's PIN token: the subject IS the cashier and is authoritative.
  if (!x.mayClaim) return x.subject;
  // No claim, or it just echoes the subject → the subject.
  if (!x.claimed || x.claimed === x.subject) return x.subject;
  // A validated claim credits the real cashier; an invalid one falls back.
  return x.claimValid ? x.claimed : x.subject;
}

/** True only when we must hit the DB to validate a claim (avoids needless reads). */
export function claimNeedsValidation(x: Omit<CashierResolutionInput, 'claimValid'>): boolean {
  return x.mayClaim && !!x.claimed && x.claimed !== x.subject;
}
