/**
 * terminalWrites.ts — A159: which WRITES a till (surface 'desktop') may make to the cloud.
 *
 * A till holds two kinds of token:
 *   • the DEVICE token — the enrolment session (`/enrol/redeem`): the owner's scope ('*'), no person behind it, kept on
 *     the till's disk for sync. Stolen, it must not be able to edit the business — products, prices, staff, settings.
 *     It may make only the till's own writes (TILL_WRITES): sales, sync, shift close, the replays.
 *   • a PERSON's token — a staff PIN sign-in on the till (`/verify-pin`, `pinSignIn: true`). A manager signed in on the
 *     till uses the manager screens (Menu, Staff, Payment methods, Stations, Settings, Expense types), which write the
 *     same routes the web dashboard does (MANAGER_WRITES). Each of those routes still checks the person's own
 *     permissions (requirePermission), so a person's token can do on the till only what that person may do anyway.
 * Every other desktop write is denied — a new dashboard route is closed to tills by default.
 *
 * Pure (no env, no database), so the tests run this exact rule — and tests/terminal-write-guard.test.mjs also reads
 * every cloud write in the till's source and fails when one is not covered here.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The till's own writes — allowed for either token. */
export const TILL_WRITES: RegExp[] = [
  /^\/api\/orders(\/|$)/,                 // sales push, /:id/void, /:id/refund (incl. 0.6.30 offline replays)
  /^\/api\/sync\/push$/,                  // business_days / shifts / floats / expenses / kitchen voids
  /^\/api\/branch-prices\/sync$/,         // price reconciliation
  // shift close / force-close (server-reconciled), A365 confirm (the till replays a manager's confirmation), A342
  // foreign-cash / foreign-orders (read-only POSTs for the web's part of the drawer). NOT a blanket /api/shifts: a shift
  // DELETE or create from a till stays denied.
  /^\/api\/shifts\/[^/]+\/(close|force-close|foreign-cash|foreign-orders|confirm)$/,
  /^\/api\/shifts\/confirmer$/,           // A365: whose PIN this is (read-only; the till confirms locally)
  /^\/api\/day-close\/ack$/,              // the till acknowledges a day close the web asked for
  /^\/api\/business\/branding$/,          // 0.6.25 (owner's decision): a logo uploaded on the till is saved to the cloud
  /^\/api\/auth\//,                       // enrol, verify-pin, set-pin, refresh, logout, device-token
  /^\/api\/tech\//,                       // tech audit / session (also tech-token gated)
];

/** The manager screens on the till — allowed only for a person's PIN sign-in, never the device token. */
export const MANAGER_WRITES: RegExp[] = [
  /^\/api\/products(\/[^/]+)?$/,                           // create, edit, bulk
  /^\/api\/categories(\/[^/]+)?$/,
  /^\/api\/combos(\/[^/]+(\/items)?)?$/,
  /^\/api\/variants\/(groups|options)(\/[^/]+)?$/,
  /^\/api\/modifiers\/groups(\/[^/]+)?$/,
  /^\/api\/stations(\/[^/]+(\/categories)?)?$/,            // incl. seed-defaults
  /^\/api\/payment-methods(\/[^/]+)?$/,
  /^\/api\/staff(\/[^/]+)?$/,                              // managers cannot create or promote owners (A10, the route)
  /^\/api\/business\/settings$/,                           // per key: receipt.manage / settings.manage / owner-only rules
  /^\/api\/expenses\/categories$/,                         // 0.6.18: a manager adds an expense type
];

export type TerminalWriteVerdict = 'not-gated' | 'till' | 'manager' | 'denied';

/** What the guard decides for one request. `pinSignIn` = the token is a person's PIN sign-in on the till. */
export function terminalWriteVerdict(
  surface: string | null | undefined, method: string, path: string, pinSignIn = false,
): TerminalWriteVerdict {
  if (surface !== 'desktop') return 'not-gated';           // only till tokens are gated
  if (!WRITE_METHODS.has(String(method).toUpperCase())) return 'not-gated';   // reads are always allowed
  const p = String(path || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (TILL_WRITES.some((re) => re.test(p))) return 'till';
  if (MANAGER_WRITES.some((re) => re.test(p))) return pinSignIn ? 'manager' : 'denied';
  return 'denied';
}

export function terminalWriteDenied(surface: string | null | undefined, method: string, path: string, pinSignIn = false): boolean {
  return terminalWriteVerdict(surface, method, path, pinSignIn) === 'denied';
}
