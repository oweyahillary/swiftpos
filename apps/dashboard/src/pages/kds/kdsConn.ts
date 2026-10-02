// A192 — classify a KDS tickets-fetch outcome so an auth failure can NEVER read
// as "all clear".
//
// The bug this guards: /kds polled `GET /api/kitchen/tickets`; a 401 (missing or
// expired display token) is NOT a thrown error, so the old code fell through,
// logged "unexpected response", set tickets = [] and rendered the green "connected"
// dot + "All clear — no pending tickets". A kitchen whose token expired therefore
// looked healthy while orders piled up unseen.
//
// This is the single decision point: given the fetch outcome, what state is the
// display actually in? The page drives its status dot and empty-state off this
// value — never off "the poll ran".
export type KdsConn = 'ok' | 'auth' | 'error';

/**
 * @param ok       res.ok (HTTP 2xx)
 * @param status   res.status (0 for a network failure with no response)
 * @param isArray  whether the parsed body was the expected tickets array
 *
 * ok    — a 2xx that actually returned the tickets array (genuinely reachable)
 * auth  — 401/403: the display token is missing/expired → must re-pair (RED, never "all clear")
 * error — anything else: other non-2xx, a 2xx with a malformed body, or a network
 *         failure. Data is stale/absent, so the display shows a connection warning,
 *         not an empty "all clear" board.
 */
export function classifyKdsFetch(ok: boolean, status: number, isArray: boolean): KdsConn {
  if (ok && isArray) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  return 'error';
}
