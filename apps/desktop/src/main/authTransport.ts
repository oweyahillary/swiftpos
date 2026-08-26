/**
 * authTransport.ts — classify an auth HTTP outcome as UNREACHABLE vs a real answer.
 *
 * A152. The offline auth chain (node → cloud → cache) must fall through to the
 * next authority ONLY when the current one could not be REACHED. A thrown fetch
 * error (DNS, refused, timeout) is obviously unreachable. The gap this closes is
 * the OTHER kind: an authority that ANSWERS but cannot serve — a 5xx. A process
 * down behind a live platform edge (Render 502/503), a gateway error (504), or
 * the authority's own DB unreachable (500) all return a real HTTP response with
 * a 5xx status, so the fetch does NOT throw.
 *
 * Before this, verify-pin treated that response as a rejection: `await res.json()`
 * threw on the gateway's HTML body (unhandled), or `!res.ok` read as "Invalid
 * PIN". Either way a valid offline cache/node never rescued the login, and the
 * shop was locked out during the 2026-08-23 Render outage even though the till is
 * meant to keep trading offline.
 *
 * A 5xx is therefore UNREACHABLE (fall through), never a rejection. A clean 4xx
 * (400/401/403) is a real, final authenticated answer and must NOT fall back —
 * otherwise a sacked cashier signs in by unplugging a cable.
 */
export function isUnreachableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * A168 — which token an order-push 401 must refresh.
 *
 * It MUST match the token pushAuthHeaders() actually sends (`_staffToken ||
 * _accessToken`), because the server attributes `cashier_id = req.userId` — the
 * token subject (apps/server/src/routes/orders.ts). Refreshing, and therefore
 * re-pushing under, the OTHER token would reattribute the sale: an online staff
 * order re-pushed on the owner token would be credited to the owner.
 *
 * So: a real staff token → refresh 'staff' (stay on the cashier's identity); no
 * staff token (an offline shift, where signInLocal sets it to '') → refresh
 * 'owner', the token the push is already using. Lives here beside the other pure
 * auth-transport decision so it is testable without Electron, and so it cannot
 * drift from `pushAuthHeaders` unnoticed.
 */
export function selectPushRefresh(staffToken: string): 'staff' | 'owner' {
  return staffToken ? 'staff' : 'owner';
}
