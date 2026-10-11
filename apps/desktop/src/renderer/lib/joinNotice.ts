/**
 * joinNotice.ts — A436 (owner, 2026-10-10: "on the till a message should tell the technician to accept on the server").
 *
 * What the till says while it waits for the branch server to allow it: where to go, what they will see there, what to
 * press, and how long the request waits. Kept apart from React so the test runs it as it is.
 */

/** How long the server keeps a request — the same as JOIN_TTL_MS in main/serverJoin.ts (the test holds them equal). */
export const JOIN_WAIT_MINUTES = 10;

export interface JoinServer { ip: string; server: string | null; business: string | null }

export function joinWaitNotice(tillName: string, srv: JoinServer, minutesLeft: number = JOIN_WAIT_MINUTES):
  { title: string; steps: string[]; footer: string } {
  const where = srv.server ? `"${srv.server}" (${srv.ip})` : `the branch server (${srv.ip})`;
  const left = Math.max(0, Math.ceil(minutesLeft));
  return {
    title: 'Now go to the branch server and press Allow',
    steps: [
      `Go to ${where}${srv.business ? `, ${srv.business}` : ''}.`,
      `On its screen: "A till wants to join this branch server" — with this till's name, "${tillName}". If ZapTill is hidden, click its icon by the clock, or the notification.`,
      'Press Allow. This till carries on by itself once it is allowed.',
    ],
    footer: left > 0
      ? `The request waits ${left} more minute${left === 1 ? '' : 's'}.`
      : 'The request has run out — ask again.',
  };
}
