// cashier.ts — A169. Who a sale is credited to.
//
// The server writes `cashier_id = req.userId` (the token subject). That is right
// ONLINE: a cashier signs in by PIN and the order pushes under their staff token
// (isOwner:false, userId = the cashier). It is WRONG OFFLINE: the till has no
// staff token, so the order pushes under the enrol/owner token (isOwner:true,
// userId = the owner), and every offline sale is credited to the owner.
//
// Fix (Option A): the till already knows the real cashier offline (it stores the
// signed-in staff's users.id) and now sends it as a payload `cashier_id`. The
// server trusts that claim ONLY when the push is under an owner/device token
// (isOwner) AND the claim validates against the roster exactly as verify-pin
// does (active user in this business with access to this branch — the caller
// supplies that result as `claimValid`). A staff-PIN token stays authoritative:
// its subject cannot be reattributed, so an online sale can never be spoofed.
//
// Residual risk (accepted with Option A): an owner-token push can attribute a
// sale to ANY branch-authorised cashier, not provably the one who rang it. It is
// attribution, not money movement, and strictly better than "all offline → owner".
//
// A164 interaction (documented, not yet live): when the till cuts over to the
// device-scoped token (isOwner:false, userId = owner, currently INERT), this
// `isOwner` gate would route it down the "staff token" path and mis-credit the
// owner again. That cutover MUST revisit this resolver (make the device token
// carry a distinguishing claim, or gate on that instead of isOwner).

export interface CashierResolutionInput {
  /** Is the pushing token an owner/device token (not a staff-PIN token)? */
  isOwner: boolean;
  /** The token subject (req.userId) — the fallback and the online cashier. */
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
  // Staff-PIN token: the subject IS the cashier and is authoritative.
  if (!x.isOwner) return x.subject;
  // Owner/device token: no claim, or it just echoes the subject → use the subject.
  if (!x.claimed || x.claimed === x.subject) return x.subject;
  // A validated claim credits the real cashier; an invalid one falls back.
  return x.claimValid ? x.claimed : x.subject;
}

/** True only when we must hit the DB to validate a claim (avoids needless reads). */
export function claimNeedsValidation(x: Omit<CashierResolutionInput, 'claimValid'>): boolean {
  return x.isOwner && !!x.claimed && x.claimed !== x.subject;
}
