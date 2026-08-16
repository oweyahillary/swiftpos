// Pure decision for refresh-token rotation with lost-response tolerance
// (register A88 / D13). No DB, no side effects — the /refresh handler resolves
// the row + successor and calls this so the rule lives in one tested place.
//
// The D13 crash window: the server revokes the consumed refresh token BEFORE the
// till persists the new one. If the response is lost (crash, power cut, dropped
// connection), the till still holds the OLD token and, on retry, the old code
// saw `revoked_at` and revoked EVERY session for the user "for security" — so a
// dropped packet logged the owner out of the till. That punished the honest
// client for the attacker's failure mode.
//
// Chain-based (not time-based) reuse detection tells the two apart, and survives
// a power-cut-for-hours where a time window would not:
//
//   - A rotation links the consumed token to its replacement (`replaced_by`).
//   - If the presented (revoked) token's replacement is STILL the live head
//     (successor exists and is itself not revoked), the client never advanced
//     past it — it never received the rotation response. That is a LOST RESPONSE,
//     not a replay: reissue a fresh pair instead of nuking.
//   - If there is no successor (the token was revoked by logout, not rotation),
//     or the successor was itself already used to rotate (the chain moved on, so
//     the client DID receive it), presenting the old token now is a genuine
//     REPLAY — revoke the session.

export type RefreshDecision = 'valid' | 'reissue' | 'replay';

export function refreshGraceDecision(opts: {
  revokedAt: string | null | undefined;
  successorExists: boolean;
  successorRevokedAt: string | null | undefined;
}): RefreshDecision {
  if (!opts.revokedAt) return 'valid';                       // not revoked → normal rotation
  if (opts.successorExists && !opts.successorRevokedAt) return 'reissue'; // lost response
  return 'replay';                                           // logout revoke, or chain advanced
}
