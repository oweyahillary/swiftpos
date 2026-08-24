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
