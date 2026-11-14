/**
 * branchTabsUx.ts — the PURE decisions behind Till stage 3b shared tables in CashierScreen (no React, so it is
 * unit-tested without a browser — tests/branch-tabs-ux.test.mjs). The screen owns the IO (the branchTabsHost calls and
 * React state); these functions decide what a tap / a claim answer / an occupancy merge MEANS, so that logic is tested
 * and the screen wiring stays thin. Everything here is a no-op's worth of logic when shared tables are off (the caller
 * gates on `branchTabsHost() && isRestaurant`).
 */

/** Enough of a node tab to decide "Held by <name>". */
export interface TabLike { id: string; opened_by: string; last_changed_by: string | null }

/** A restaurant table is occupied if THIS till holds it locally OR the branch node has a tab for it (another till). */
export function tableOccupied(hasLocal: boolean, hasNodeTab: boolean): boolean {
  return hasLocal || hasNodeTab;
}

/** "Held by <name>" — the most recent editor, else the opener, else a neutral fallback. */
export function heldBy(tab: TabLike): string {
  const n = (tab.last_changed_by && tab.last_changed_by.trim()) || (tab.opened_by && tab.opened_by.trim());
  return n || 'another POS';
}

/** What a tap on a table means when shared tables are on. */
export type TapAction = 'resume-local' | 'take-node' | 'open-free';
export function tapAction(hasLocal: boolean, hasNodeTab: boolean, sharedOn: boolean): TapAction {
  if (hasLocal) return 'resume-local';                 // our own open order — the resume/clear modal (claims on resume)
  if (sharedOn && hasNodeTab) return 'take-node';      // held on the branch, not here — try to claim it
  return 'open-free';                                  // free — open covers as today
}

/** The claim answer (branchTabs ClaimOutcome shape) → what the screen does. */
export type ClaimOutcomeLike =
  | { outcome: 'claimed'; tab: { cart: unknown }; stole: boolean }
  | { outcome: 'locked'; lockedBy: string }
  | { outcome: 'unreachable' };
export type ClaimAction =
  | { kind: 'open'; cart: unknown[]; toast: string | null }   // we hold it — load the cart; toast if we took a lapsed lease
  | { kind: 'held' }                                          // a live foreign lock — read-only "Held by <name>"
  | { kind: 'fallback' };                                     // no server/answer — the caller stays local-only
export function claimAction(r: ClaimOutcomeLike, tableName: string): ClaimAction {
  if (r.outcome === 'claimed') {
    const cart = Array.isArray(r.tab.cart) ? (r.tab.cart as unknown[]) : [];
    return { kind: 'open', cart, toast: r.stole ? `Took over ${tableName} — it had been left idle.` : null };
  }
  if (r.outcome === 'locked') return { kind: 'held' };
  return { kind: 'fallback' };
}

/** A lease-renew (updateTab) answer → true when our lease was lost/stolen and the screen must drop the table. */
export function editLost(r: { outcome: 'ok' } | { outcome: 'lost'; lockedBy?: string } | { outcome: 'unreachable' }): boolean {
  return r.outcome === 'lost';
}
