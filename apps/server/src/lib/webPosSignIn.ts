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
    error: hasWebAccess
      ? 'Managers sign in to the web dashboard with their email and password, not a PIN. Your PIN still works on the desktop POS.'
      : 'Managers sign in to the web dashboard with their email and password, not a PIN. Ask the owner to give you web dashboard access. Your PIN still works on the desktop POS.',
    code: USE_WEB_DASHBOARD,
    web_access: hasWebAccess,
    login: '/login',
  };
}
