/**
 * offlineSession.ts — A345 (2026-09-27): a staff member who signed in OFFLINE.
 *
 * Owner, v0.6.14 checklist: "we can sell this as an option fully offline till, thats why the manager has to log in confirm this
 * is true full offline once registered" — then "build all three as 0.6.15":
 *   (1) the back office's cloud-owned pages say what is really going on ("you signed in while offline"), not "not signed in";
 *   (2) offline, the Menu and Staff pages show what this till has saved, read-only;
 *   (3) when the network returns, the offline sign-in becomes a cloud sign-in in the background — no second PIN entry.
 *
 * An offline sign-in (ipcHandlers `signInLocal` — saved credential, branch node, node roster) has no cloud token: the
 * staff_session row carries token ''. Selling never needs one (sales push under the till's own token with the cashier's id). The
 * menu, staff, payment-method, station and receipt-text editors do: they call the cloud under the SIGNED-IN person's own token
 * so the cloud applies the role rules (A340). This module holds what (3) needs and the words (1) shows.
 *
 * The PIN is held in THIS process's memory only — never written to disk, never sent to the renderer — from an offline
 * sign-in until the first of: the upgrade succeeds; the cloud ANSWERS no (wrong PIN now, deactivated, device blocked); a
 * different sign-in; the till is locked; the app quits. It is sent only to the same cloud endpoint an online sign-in uses
 * (`/api/auth/verify-pin`), with the same body.
 */

/** Shown by every cloud-owned editor while the session is an offline one. */
export const OFFLINE_SESSION_MESSAGE =
  'You signed in while offline. Menu, staff and settings changes are saved on the cloud — once the till is online they ' +
  'unlock by themselves (or lock the till and sign in again). Selling is not affected.';

/** Shown when the session has a cloud token but the cloud cannot be reached. */
export const NO_CONNECTION_MESSAGE =
  'No connection — menu and staff changes need internet. Try again once you are back online.';

export type ManageOfflineReason = 'offline_session' | 'no_connection';

export interface HeldPin { staffId: string; branchId: string; pin: string }

let held: HeldPin | null = null;

export function holdOfflinePin(h: HeldPin): void { held = { ...h }; }
export function clearOfflinePin(): void { held = null; }
export function heldOfflinePin(): HeldPin | null { return held ? { ...held } : null; }

export type UpgradeOutcome =
  | 'nothing'        // no offline session waiting
  | 'upgraded'       // the cloud confirmed the PIN; the session now has a cloud token
  | 'unreachable'    // no network, or the cloud answered 5xx — keep the PIN, try again later
  | 'rejected'       // the cloud ANSWERED no — drop the PIN; the offline session carries on as before
  | 'mismatch'       // the session changed under us, or the cloud named someone else — drop the PIN
  | 'busy';          // an attempt is already in flight

export interface UpgradeDeps {
  /** The staff_session row's staff id and whether it already has a cloud token. null = nobody signed in. */
  currentSession(): { staffId: string; hasToken: boolean } | null;
  /** POST /api/auth/verify-pin exactly as an online sign-in sends it. Throws on a transport failure. */
  verifyAtCloud(pin: string, branchId: string): Promise<{ status: number; body: any }>;
  /** Persist the cloud's answer as the session's tokens (same writes as an online sign-in). */
  adopt(body: any, branchId: string): void;
  isUnreachableStatus(status: number): boolean;
  log?(line: string): void;
}

let inFlight = false;

/**
 * One attempt to turn the held offline sign-in into a cloud sign-in. Never throws. Never signs anyone out: a rejection only
 * stops the attempts (what the offline session could do before 0.6.15 it still can; locking the till is the manager's call).
 */
export async function upgradeOfflineSession(deps: UpgradeDeps): Promise<UpgradeOutcome> {
  const h = held;
  if (!h) return 'nothing';
  if (inFlight) return 'busy';
  const cur = deps.currentSession();
  if (!cur || cur.staffId !== h.staffId) { held = null; return 'mismatch'; }
  if (cur.hasToken) { held = null; return 'nothing'; }

  inFlight = true;
  try {
    let r: { status: number; body: any };
    try { r = await deps.verifyAtCloud(h.pin, h.branchId); }
    catch { return 'unreachable'; }
    if (deps.isUnreachableStatus(r.status)) return 'unreachable';
    // Whoever is signed in may have changed while the request was out.
    if (held !== h) return 'mismatch';
    const now = deps.currentSession();
    if (!now || now.staffId !== h.staffId) { held = null; return 'mismatch'; }
    if (r.status < 200 || r.status >= 300) {
      held = null;
      deps.log?.(`offline session not upgraded — the cloud answered ${r.status}: ${r.body?.error ?? ''}`);
      return 'rejected';
    }
    if (r.body?.staff?.id !== h.staffId || !(r.body?.accessToken ?? r.body?.token)) {
      held = null;
      deps.log?.('offline session not upgraded — the cloud named a different person or sent no token');
      return 'mismatch';
    }
    deps.adopt(r.body, h.branchId);
    held = null;
    deps.log?.(`offline session upgraded to a cloud sign-in for ${r.body.staff?.name ?? h.staffId}`);
    return 'upgraded';
  } finally { inFlight = false; }
}
