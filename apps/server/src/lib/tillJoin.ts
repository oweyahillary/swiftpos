/**
 * tillJoin.ts — A427: a till joins its branch through the branch server, no code typed.
 *
 * Owner, 2026-10-09: "when installing the app should be scanning from a local server and pick configs from it, i should
 * not be configuring each till after enrolling, it should only ask if i allow it to join the server or not".
 *
 * The branch server is already enrolled, licensed and confirmed as its branch's server. When someone at the server
 * allows a new till to join, the server asks the cloud (POST /api/pos/join-code) for ONE ordinary enrolment code for
 * its own branch — the same single-use, 15-minute, branch-bound code the admin portal issues — and hands it to that
 * till over the shop network. The till redeems it itself, so it still gets its own session (A415). Terminal codes and the rest of setup are unchanged — the technician sets them as before.
 * Only a confirmed
 * branch server can ask, only for its own licensed branch, and a few times an hour at most.
 */

export const JOIN_CODES_PER_HOUR = 10;
const issued = new Map<string, number[]>();

/** In-memory, per server device: a stuck or abused server cannot mint codes in a loop. */
export function mayIssueJoinCode(deviceId: string, now: number = Date.now()): boolean {
  const recent = (issued.get(deviceId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= JOIN_CODES_PER_HOUR) { issued.set(deviceId, recent); return false; }
  recent.push(now); issued.set(deviceId, recent);
  return true;
}

/** Tests only. */
export function _resetJoinLimits(): void { issued.clear(); }
