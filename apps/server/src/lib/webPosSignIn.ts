/**
 * webPosSignIn.ts — A608: who may sign in to the WEB POS with a PIN (POST /api/auth/pos-login, the web POS's own sign-in).
 *
 * Owner, 2026-10-29: "Change the shop manager to use email on web — they don't key in a PIN on the web POS; PIN on the web
 * strictly remains for cashiers. On the desktop app the PIN remains for managers."
 *
 * Back office (isBackOffice — the same people the web used to send to its manager portal, posRouting.ts resolveRoute) is
 * refused here with USE_WEB_DASHBOARD: they sign in to the web dashboard with their email and password (A550 web access).
 * The owner is not refused (their PIN sign-in already lands on the dashboard's own sign-in). The DESKTOP POS never comes
 * here — it signs in with /api/auth/verify-pin and the branch server with its own roster — so a manager's PIN keeps
 * working there exactly as before. Pure: the route and its test read it.
 */
import { isBackOffice } from './permissions';

export const USE_WEB_DASHBOARD = 'USE_WEB_DASHBOARD';

/** True: this person's PIN does not open the web POS (back office, never the owner). */
export function refusesWebPosPin(held: ReadonlySet<string> | readonly string[], isOwner: boolean): boolean {
  return !isOwner && isBackOffice(held);
}

/** The answer (403): where they sign in instead — with web access given, the dashboard; without, ask the owner. */
export function webPosPinRefusal(hasWebAccess: boolean): { error: string; code: string; web_access: boolean; login: string } {
  return {
    // A608 (owner, 2026-10-29, managers sell on the web POS from the dashboard): "Open POS" there, no PIN.
    error: hasWebAccess
      ? 'Managers sign in to the web dashboard with their email and password, then use Open POS — no PIN on the web. Your PIN still works on the desktop POS.'
      : 'Managers sign in to the web dashboard with their email and password, then use Open POS — no PIN on the web. Ask the owner to give you web dashboard access. Your PIN still works on the desktop POS.',
    code: USE_WEB_DASHBOARD,
    web_access: hasWebAccess,
    login: '/login',
  };
}

/** A608: the right that makes a sale (routes/orders.ts `sells`) — who may open the web POS from the dashboard. */
export const SELL_KEY = 'orders.create';

/**
 * A608: is this (verified) token a web DASHBOARD session — the owner's password sign-in ('owner') or a partner's, i.e.
 * anyone the owner gave web access ('partner')? Anything else — a web POS session from /pos-login, a till, a person's PIN
 * sign-in on a till, a kitchen screen — is null: only a dashboard session is exchanged for a web POS one (/pos-session).
 */
export function dashboardSessionKind(p: Record<string, unknown> | null | undefined,
  isOwnerPasswordSession: (p: Record<string, unknown>) => boolean): 'owner' | 'partner' | null {
  if (!p || p.till === true || p.deviceId || p.pinSignIn === true || p.surface === 'kds' || p.surface === 'desktop') return null;
  if (p.isOwner === true) return p.webPartner !== true && isOwnerPasswordSession(p) ? 'owner' : null;
  return p.webPartner === true ? 'partner' : null;
}
