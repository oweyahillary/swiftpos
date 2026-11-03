/**
 * c2bDaraja.ts — A621: the two Safaricom (Daraja) calls M-Pesa payment notifications need, with the branch's own Daraja
 * details (lib/branchMpesa.ts — the same as its STK prompt):
 *   - Register URL (POST /mpesa/c2b/v2/registerurl): "tell these two addresses of every payment to this shortcode". ONE set
 *     of addresses per shortcode: registering replaces whatever was there — a bank or accounting system already using the
 *     number stops hearing of payments. The settings screen says so before the owner registers.
 *   - Simulate (POST /mpesa/c2b/v2/simulate, SANDBOX ONLY): a test payment from Safaricom's test number, so the owner can
 *     see it arrive on the POS without real money.
 * fetch is a parameter so the tests use a stand-in Safaricom.
 */
import { darajaBase, darajaErrorText, type MpesaConfig, type MpesaEnvironment } from './branchMpesa';

export const DARAJA_TIMEOUT_MS = 15_000;
/** Safaricom's sandbox test payer (documented on the Daraja portal). */
export const SANDBOX_TEST_MSISDN = '254708374149';

type Fetch = typeof fetch;
type Outcome = { ok: true } | { ok: false; error: string };

async function accessToken(cfg: Pick<MpesaConfig, 'consumerKey' | 'consumerSecret'>, env: MpesaEnvironment, fetchImpl: Fetch): Promise<string> {
  const auth = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
  const r = await fetchImpl(`${darajaBase(env)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(DARAJA_TIMEOUT_MS),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(darajaErrorText(r.status, body));
  const token = (JSON.parse(body) as { access_token?: unknown }).access_token;
  if (typeof token !== 'string' || !token) throw new Error('Safaricom answered without an access token.');
  return token;
}

/** One authorised POST to Daraja; Safaricom's refusal in its own words. Never throws. */
async function darajaPost(cfg: Pick<MpesaConfig, 'consumerKey' | 'consumerSecret'>, env: MpesaEnvironment, path: string, body: unknown, fetchImpl: Fetch): Promise<Outcome> {
  try {
    const token = await accessToken(cfg, env, fetchImpl);
    const r = await fetchImpl(`${darajaBase(env)}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DARAJA_TIMEOUT_MS),
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: darajaErrorText(r.status, text) };
    return acceptedByDaraja(text);
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, error: `Safaricom did not answer within ${DARAJA_TIMEOUT_MS / 1000} seconds.` };
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Daraja answers 200 with ResponseCode "0" when it took the request (an older answer names no code: taken). */
export function acceptedByDaraja(body: string): Outcome {
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(body) as Record<string, unknown>; } catch { return { ok: false, error: 'Safaricom\'s answer could not be read.' }; }
  const code = j.ResponseCode ?? j.responseCode;
  if (code === undefined || String(code) === '0') return { ok: true };
  return { ok: false, error: String(j.ResponseDescription ?? j.errorMessage ?? `Safaricom answered code ${code}.`).slice(0, 300) };
}

export function registerC2bUrls(
  cfg: Pick<MpesaConfig, 'consumerKey' | 'consumerSecret'>, env: MpesaEnvironment,
  p: { shortcode: string; confirm: string; validate: string }, fetchImpl: Fetch = fetch,
): Promise<Outcome> {
  return darajaPost(cfg, env, '/mpesa/c2b/v2/registerurl', {
    ShortCode: p.shortcode, ResponseType: 'Completed', ConfirmationURL: p.confirm, ValidationURL: p.validate,
  }, fetchImpl);
}

export function simulateC2bPayment(
  cfg: Pick<MpesaConfig, 'consumerKey' | 'consumerSecret' | 'type'>,
  p: { shortcode: string; amount: number; billRef: string | null }, fetchImpl: Fetch = fetch,
): Promise<Outcome> {
  const paybill = cfg.type === 'CustomerPayBillOnline';
  return darajaPost(cfg, 'sandbox', '/mpesa/c2b/v2/simulate', {
    ShortCode: p.shortcode,
    CommandID: paybill ? 'CustomerPayBillOnline' : 'CustomerBuyGoodsOnline',
    Amount: p.amount,
    Msisdn: SANDBOX_TEST_MSISDN,
    BillRefNumber: paybill ? (p.billRef ?? 'TEST') : '',
  }, fetchImpl);
}
