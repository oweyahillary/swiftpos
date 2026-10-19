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
 * order re-pushed on the till's own token would be credited to whoever the till names, not the person's own token.
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

// ── A529: who answered? ───────────────────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-19 (Render suspended production): "some users were not able to log in … and I thought we had said when
// the desktop is offline or render unavailable all users should be able to log in", and "the could not sync error some
// clients did not like it". A suspended Render service, a Cloudflare error page or a captive portal answers with ITS OWN
// page — a 404, a 403, a 410, a 200 HTML. A152 covered a 5xx only, so the till read such a page as the cloud's verdict:
// "Invalid PIN" at the PIN pad, sales counted towards 'failed' (red for the managers) though they were safe.
//
// THE RULE: since A529 every answer from our cloud carries `X-ZapTill-Server` (apps/server/src/lib/serverSignature.ts).
// An answer WITHOUT it is not the cloud's, whatever its status — it is treated exactly like no connection: cloudFetch
// (cloudGateway.ts) throws ForeignPageError, a "fetch failed" every caller already handles as the line (sign-in falls back
// to the till's own staff list / saved sign-ins, a push stays pending with no attempt counted, a renewal "could not
// reach" — never "refused", a void/refund goes the offline-reversal path, a manager screen says "no connection"). A 5xx
// WITH it keeps A152 (unreachable); a 4xx WITH it is a real answer (a wrong PIN stays final — "a sacked cashier signs in
// by unplugging a cable" stays impossible).
//
// BACKWARD COMPATIBILITY (the cloud deploys before every till updates; in development tills update first): the rule
// applies only once THIS cloud (its origin) has been seen to sign an answer. Until then an unsigned answer is judged by
// today's status rules, so a 1.0.20 till on a cloud from before A529 works exactly as 1.0.19 did. "Seen to sign" is
// remembered on disk (maintenance_state, per cloud origin) — a till restarted DURING an outage (the case that locked
// people out) still knows its cloud signs. One way back: an unsigned 2xx JSON answer from a cloud that signed before is
// a cloud rolled back below A529 (a portal or a suspended service answers HTML) — the till forgets, and today's rules
// apply again until it signs again. That answer itself is passed on as the cloud's.

/** A529: the header our cloud sets on every answer (lower case: fetch Headers are case-insensitive). */
export const SERVER_SIGNATURE = 'x-zaptill-server';

type HeaderLike = { headers?: { get(name: string): string | null } | null } | null | undefined;

/** A529: does this answer carry our cloud's signature? */
export function fromOurCloud(res: HeaderLike): boolean {
  try { return !!res?.headers?.get?.(SERVER_SIGNATURE); } catch { return false; }
}

/** A529: an answer that is not our cloud's — thrown like a failed fetch, so every caller's "no connection" path applies. */
export class ForeignPageError extends Error {
  // A plain field, not a parameter property: tests import this file type-stripped (tests/push-refresh-selection).
  status: number;
  constructor(status: number) {
    super(`fetch failed: the cloud did not answer (another server's page, HTTP ${status})`);
    this.name = 'ForeignPageError';
    this.status = status;
  }
}

/** Where "this cloud signs its answers" is kept between runs (cloudGateway wires maintenance_state). */
export interface SignatureStore { load(origin: string): boolean; save(origin: string): void; forget(origin: string): void }

const _signs = new Map<string, boolean>();

/** A529: has this cloud (origin) been seen to sign its answers? Read from the store once per run, then from memory. */
export function cloudSigns(origin: string, store?: SignatureStore | null): boolean {
  const known = _signs.get(origin);
  if (known !== undefined) return known;
  let v = false;
  if (store) { try { v = store.load(origin); } catch { v = false; } }
  _signs.set(origin, v);
  return v;
}

/** A529: what an answer from the cloud's address is. 'ours' signed; 'foreign' unsigned from a cloud that signs (= no
 *  connection); 'rolled-back' unsigned 2xx JSON from a cloud that signed before (forgotten, passed on); 'unproven'
 *  unsigned from a cloud never seen to sign (today's status rules). Records what it learns. */
export type CloudVerdict = 'ours' | 'foreign' | 'rolled-back' | 'unproven';
export function judgeCloudAnswer(res: HeaderLike & { status: number; ok?: boolean }, origin: string,
  store?: SignatureStore | null, now = Date.now()): CloudVerdict {
  if (fromOurCloud(res)) {
    if (_signs.get(origin) !== true) {
      _signs.set(origin, true);
      if (store) { try { store.save(origin); } catch { /* memory holds it for this run */ } }
    }
    noteCloudAnswered(res.status, now, true);
    return 'ours';
  }
  if (!cloudSigns(origin, store)) { noteCloudAnswered(res.status, now, false); return 'unproven'; }
  const ok = res.ok ?? (res.status >= 200 && res.status < 300);
  const type = (() => { try { return String(res?.headers?.get?.('content-type') ?? ''); } catch { return ''; } })();
  if (ok && /json/i.test(type)) {
    _signs.set(origin, false);
    if (store) { try { store.forget(origin); } catch { /* memory holds it */ } }
    noteCloudAnswered(res.status, now, false);
    return 'rolled-back';
  }
  noteCloudUnreachable(`another server's page (HTTP ${res.status})`, now);
  return 'foreign';
}

// What the manager's notice says about the cloud right now: unreachable since when, and why — set by a foreign page, a
// signed 5xx or a thrown fetch to the cloud's address; cleared by any other signed answer.
let _unreachable: { since: string; why: string } | null = null;
let _lastSignedAt = 0;
let _lastAnswerAt = 0;
export function noteCloudUnreachable(why: string, now = Date.now()): void {
  if (!_unreachable) _unreachable = { since: new Date(now).toISOString(), why };
  else _unreachable = { since: _unreachable.since, why };
}
export function noteCloudAnswered(status: number, now = Date.now(), signed = true): void {
  if (isUnreachableStatus(status)) { noteCloudUnreachable(`the cloud answered HTTP ${status}`, now); return; }
  _unreachable = null;
  _lastAnswerAt = now;
  if (signed) _lastSignedAt = now;
}
/** A529: the cloud could not be reached on the last try (null when it answered). */
export function cloudUnreachableNow(): { since: string; why: string } | null { return _unreachable; }
/** A529: when the cloud last answered with its signature (ms; 0 = not in this run). */
export function lastSignedAnswerAt(): number { return _lastSignedAt; }

/** A529: when the cloud last gave an answer that counts as its own (signed, or unsigned from a cloud never seen to sign),
 *  other than a 5xx (ms; 0 = not in this run). */
export function lastCloudAnswerAt(): number { return _lastAnswerAt; }

/** Tests only. */
export function _resetSignatureMemory(): void { _signs.clear(); _unreachable = null; _lastSignedAt = 0; _lastAnswerAt = 0; }
