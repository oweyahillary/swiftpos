/**
 * stkQuery.ts — ask Safaricom (Daraja STK Push Query) the REAL outcome of an STK prompt, so a LOST or LATE callback does
 * not leave a paid customer marked unpaid. Called from GET /api/mpesa/status (routes/mpesa.ts) when a prompt is still
 * pending past the query threshold. Uses the branch's own Daraja details (lib/branchMpesa.ts), exactly as the STK push
 * does. `fetch` is a parameter so the tests use a stand-in Safaricom.
 *
 * IMPORTANT: STK Push Query returns only ResultCode/ResultDesc — NOT the amount or the M-Pesa receipt number (only the
 * callback carries those). So a query-confirmed SUCCESS settles the sale WITHOUT a receipt (reconciled later, owner's
 * decision 2026-11-15); a FAILURE settles it failed with Safaricom's reason; anything unfinished stays PENDING for the
 * callback or a later query. This is RECOVERY only — the callback path (IP allow-list + amount check) is unchanged.
 */
import { darajaBase, darajaErrorText, type MpesaConfig, type MpesaEnvironment } from './branchMpesa';

export const STK_QUERY_TIMEOUT_MS = 15_000;
type Fetch = typeof fetch;

export type StkQueryOutcome =
  | { outcome: 'success' }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'pending'; reason?: string };

/** Safaricom's STK-query ResultCodes we put in plain words; anything else keeps its ResultDesc. */
export function describeStkFailure(resultCode: string, resultDesc?: string | null): string {
  switch (resultCode) {
    case '1032': return 'Cancelled by the customer';
    case '1037': return 'No response from the customer (timed out)';
    case '1':    return 'Insufficient M-Pesa balance';
    case '2001': return 'Wrong M-Pesa PIN';
    case '1019': return 'Transaction expired';
    case '1025':
    case '9999': return 'M-Pesa system error — try again';
    default:     return (resultDesc && String(resultDesc).trim()) || `M-Pesa declined (code ${resultCode})`;
  }
}

/**
 * The PURE decision: a Daraja STK-query answer → what the sale becomes. `httpOk` is whether the HTTP call itself was 2xx.
 *  - Daraja's "still processing" (an errorCode such as 500.001.1001, HTTP 500) is NOT a conclusion → pending.
 *  - A transient HTTP error (rate limit, 5xx, auth blip) is NOT a conclusion → pending; the 70 s fallback still ends it.
 *  - ResultCode '0' → success. Any OTHER finalised ResultCode → failed, with Safaricom's reason.
 *  - No ResultCode and no error → can't tell yet → pending.
 * Never concludes success/failed on anything it does not understand — a stuck prompt is recoverable; a wrong settle is not.
 */
export function readStkQueryOutcome(httpOk: boolean, body: unknown): StkQueryOutcome {
  const o = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  const errCode = o.errorCode != null ? String(o.errorCode) : '';
  if (errCode) return { outcome: 'pending', reason: String(o.errorMessage ?? errCode).slice(0, 200) };
  if (!httpOk) return { outcome: 'pending' };
  const rc = o.ResultCode != null ? String(o.ResultCode) : '';
  if (rc === '0') return { outcome: 'success' };
  if (rc === '') return { outcome: 'pending' };
  return { outcome: 'failed', reason: describeStkFailure(rc, o.ResultDesc as string | undefined) };
}

/** Daraja's 14-digit timestamp (YYYYMMDDHHMMSS). */
export function stkTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

/**
 * Query the real status of an STK prompt by its CheckoutRequestID, with the branch's Daraja details. Never throws — a
 * failure to reach Safaricom (timeout, network, auth) is `pending`, so the caller leaves the prompt for the callback or a
 * later query and the 70 s fallback still concludes it.
 */
export async function queryStkStatus(config: MpesaConfig, env: MpesaEnvironment, checkoutId: string, fetchImpl: Fetch = fetch): Promise<StkQueryOutcome> {
  try {
    const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
    const tokRes = await fetchImpl(`${darajaBase(env)}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(STK_QUERY_TIMEOUT_MS),
    });
    if (!tokRes.ok) return { outcome: 'pending', reason: darajaErrorText(tokRes.status, await tokRes.text()) };
    const token = (JSON.parse(await tokRes.text()) as { access_token?: unknown }).access_token;
    if (typeof token !== 'string' || !token) return { outcome: 'pending', reason: 'no access token' };

    const timestamp = stkTimestamp();
    const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64');
    const res = await fetchImpl(`${darajaBase(env)}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ BusinessShortCode: config.shortcode, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutId }),
      signal: AbortSignal.timeout(STK_QUERY_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = {};
    try { json = JSON.parse(text); } catch { /* unreadable body → pending via readStkQueryOutcome */ }
    return readStkQueryOutcome(res.ok, json);
  } catch (e: any) {
    return { outcome: 'pending', reason: String(e?.message ?? e).slice(0, 200) };
  }
}
