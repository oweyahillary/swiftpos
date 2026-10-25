/**
 * creditApprovers — A585: who approves sales on account (Settings › Business › Credit approvals), and the Credit history
 * panel's words. Owner, 2026-10-23: "credit limit — the owner for now; they can assign to branch manager for approval but
 * they set the limit". The cloud decides (GET / PUT /api/credit/approvers, the owner only); kept apart from React so the
 * tests run these as they are.
 */

export interface ApprovalRule { on: boolean; branches: Record<string, string[]> }
export interface ApproverStaff { id: string; name: string; role: string | null; branch_ids: string[] }
export interface ApproversView { rule: ApprovalRule; branches: Array<{ id: string; name: string | null }>; staff: ApproverStaff[] }

// A585, owner change 2026-10-23 ("add the credit rights to the manager"): the owner or the built-in Manager role.
export const OWNER_SETS_LIMITS_LINE = 'Only the owner or a manager sets credit limits.';

/** The web POS manager screen: show the limit box to the Manager or General Manager role (A587) or the owner's role (the
 *  cloud decides: only the built-in Manager / General Manager roles and the real owner pass; anyone else is told so). */
export function limitBoxForRole(roleName: string | null | undefined): boolean {
  const r = String(roleName ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
  return r === 'manager' || r === 'general manager' || r === 'owner' || r === 'admin';
}

// A587 (owner, 2026-10-24: "Can a co-owner partner set credit limits? — yes for their selected branch"): on the dashboard
// the owner, or a partner with ONE of their branches picked (never "All my branches"). The cloud decides the same
// (lib/creditApprovers.ts maySetCreditLimits; PICK_ONE_BRANCH otherwise); customers are business-wide, the branch is recorded.
export const PICK_ONE_BRANCH_LINE = 'Pick one of your branches at the top of the page to set a credit limit.';

/** May the person on the dashboard give, change or remove a limit here? */
export function dashboardSetsLimits(x: { isOwner: boolean; isPartner: boolean; activeBranchId: string | null | undefined; allMine?: boolean }): boolean {
  if (x.isOwner && !x.isPartner) return true;
  return x.isPartner && !x.allMine && !!x.activeBranchId;
}

/** The line shown instead of the editor. */
export function limitLineFor(x: { isOwner: boolean; isPartner: boolean; activeBranchId: string | null | undefined; allMine?: boolean }): string {
  return x.isPartner && !dashboardSetsLimits(x) ? PICK_ONE_BRANCH_LINE : OWNER_SETS_LIMITS_LINE;
}

/** The staff who may be picked for a branch: they work there (no branch assigned = every branch). */
export function staffForBranch(staff: readonly ApproverStaff[], branchId: string): ApproverStaff[] {
  return staff.filter((s) => !s.branch_ids.length || s.branch_ids.includes(branchId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Tick / untick a person at a branch (a new rule — never the one passed in). */
export function toggleApprover(rule: ApprovalRule, branchId: string, userId: string): ApprovalRule {
  const cur = rule.branches[branchId] ?? [];
  const next = cur.includes(userId) ? cur.filter((x) => x !== userId) : [...cur, userId];
  const branches = { ...rule.branches };
  if (next.length) branches[branchId] = next; else delete branches[branchId];
  return { on: rule.on, branches };
}

/** What the switch means, in one line. */
export function approvalSummary(rule: ApprovalRule): string {
  if (!rule.on) return 'Off — anyone with the credit permission approves a sale on account, within the customer\'s limit.';
  const n = Object.values(rule.branches).reduce((t, ids) => t + ids.length, 0);
  return n
    ? 'On — every sale on account needs one of the people below (or you). The customer\'s limit still applies.'
    : 'On — nobody is chosen yet, so only you can approve a sale on account.';
}

/** The Credit history panel: a limit change in words. */
export function limitChangeWords(c: { action: string; from: number; to: number }, fmt: (n: number) => string): string {
  if (c.action === 'granted') return `Gave a limit of ${fmt(c.to)}`;
  if (c.action === 'removed' || c.to === 0) return `Removed the limit (was ${fmt(c.from)})`;
  return `Changed the limit ${fmt(c.from)} → ${fmt(c.to)}`;
}

/** The Credit history panel: who approved a sale on account. */
export function approvalWords(s: { approved_by_name: string | null; decided_by_name: string | null; state: string }): string {
  if (s.approved_by_name) return `Approved by ${s.approved_by_name}`;
  if (s.state === 'awaiting') return 'Waiting for a manager to confirm';
  if (s.state === 'disputed') return `Disputed${s.decided_by_name ? ` by ${s.decided_by_name}` : ''}`;
  return s.decided_by_name ? `Confirmed by ${s.decided_by_name}` : 'Confirmed';
}
