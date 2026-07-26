/**
 * mpesa.ts — M-Pesa Daraja Integration Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Full Safaricom Daraja API implementation for SwiftPOS.
 *
 * ROUTES
 * ──────
 *   POST /api/mpesa/stk-push          — initiate STK push to customer phone
 *   POST /api/mpesa/callback           — Daraja webhook (public, no auth)
 *   GET  /api/mpesa/status/:checkoutId — poll payment status
 *   GET  /api/mpesa/config             — check if M-Pesa is configured
 *
 * HOW IT WORKS
 * ────────────
 *   1. Cashier taps "M-Pesa" in PaymentModal → POST /api/mpesa/stk-push
 *   2. Server fetches OAuth token from Daraja, initiates STK push
 *   3. Customer sees payment prompt on their phone, enters PIN
 *   4. Daraja sends confirmation to POST /api/mpesa/callback
 *   5. Frontend polls GET /api/mpesa/status/:checkoutId every 3s
 *   6. On success, payment is marked complete and order is finalised
 *
 * BUSINESS SETTINGS REQUIRED (store in business_settings table)
 * ──────────────────────────────────────────────────────────────
 *   mpesa_consumer_key     — from Safaricom developer portal
 *   mpesa_consumer_secret  — from Safaricom developer portal
 *   mpesa_shortcode        — till number or paybill number
 *   mpesa_passkey          — from Safaricom
 *   mpesa_type             — 'CustomerBuyGoodsOnline' | 'CustomerPayBillOnline'
 *
 * ENVIRONMENT VARIABLES
 * ─────────────────────
 *   MPESA_ENVIRONMENT      — 'sandbox' | 'production' (default: sandbox)
 *   MPESA_CALLBACK_BASE_URL — public HTTPS base URL (e.g. https://api.swiftpos.co.ke)
 *
 * DEVELOPMENT SETUP
 * ──────────────────
 *   1. Use ngrok to expose local server: ngrok http 4000
 *   2. Set MPESA_CALLBACK_BASE_URL=https://xxxx.ngrok.io
 *   3. Use Daraja sandbox credentials from developer.safaricom.co.ke
 */

import { Router }    from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase }  from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { decryptSecret } from '../lib/crypto';

const router = safeRouter();

const ENV            = process.env.MPESA_ENVIRONMENT ?? 'sandbox';
const CALLBACK_BASE  = process.env.MPESA_CALLBACK_BASE_URL ?? 'https://api.swiftpos.co.ke';

const DARAJA_BASE = ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// ── Callback source allow-list ────────────────────────────────────────────────
// Daraja does NOT sign its callbacks, so IP allow-listing is the standard way to
// authenticate that a callback really came from Safaricom. Without it, anyone who
// knows the callback URL can POST a forged "success" and mark an order as paid.
//
// Safaricom occasionally changes these IPs, so they are env-overridable. Set
// MPESA_ALLOWED_IPS as a comma-separated list and VERIFY it against the current
// list in your Daraja portal / Safaricom onboarding docs before go-live. The
// defaults below are the commonly published production ranges — treat them as a
// starting point, not gospel. The check only runs in production (see below), so
// sandbox/ngrok testing is unaffected.
const DEFAULT_DARAJA_IPS = [
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74',  '196.201.212.69',
];
const ALLOWED_CALLBACK_IPS = new Set(
  (process.env.MPESA_ALLOWED_IPS ?? DEFAULT_DARAJA_IPS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean),
);

// Returns true if the request's source IP is a trusted Daraja IP.
// In non-production we skip the check (sandbox + ngrok source IPs vary).
// NOTE: relies on app.set('trust proxy', 1) in index.ts so req.ip is the real
// client IP behind Render/nginx, not the load-balancer's.
function isAllowedCallbackIp(ip: string | undefined): boolean {
  if (ENV !== 'production') return true;
  const normalized = (ip ?? '').replace(/^::ffff:/, ''); // strip IPv4-mapped IPv6
  return ALLOWED_CALLBACK_IPS.has(normalized);
}

// ── Pending-payment state lives in the DB (payments table) ────────────────────
// Previously this was an in-memory Map, which lost all pending payments on a
// server restart / cold start and didn't work across multiple instances. State
// is now tracked on the payments row itself, keyed by mpesa_checkout_id:
//   status ('pending'|'completed'|'failed') · reference (M-Pesa receipt) ·
//   amount · mpesa_phone · mpesa_result_desc · mpesa_requested_at
// Requires migration 21_mpesa_payment_tracking.sql.
//
// A payment left 'pending' longer than STK_TIMEOUT_MS is treated as timed out at
// read time (Daraja's STK prompt itself times out at ~60s), so no background
// timer or in-process state is needed for correctness.
const STK_TIMEOUT_MS = 70_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MpesaConfig {
  consumerKey:    string;
  consumerSecret: string;
  shortcode:      string;
  passkey:        string;
  type:           'CustomerBuyGoodsOnline' | 'CustomerPayBillOnline';
}

// Decrypt without throwing — a missing/rotated APP_ENCRYPTION_KEY or a
// corrupt value shouldn't crash the payment flow; getMpesaConfig() already
// treats a missing credential as "M-Pesa not configured", which is the
// correct, visible failure mode here (same pattern lib/etims/index.ts uses).
function safeDecrypt(v: string): string | null {
  try { return decryptSecret(v); } catch { return null; }
}

async function getMpesaConfig(businessId: string): Promise<MpesaConfig | null> {
  const { data, error } = await supabase
    .from('business_settings')
    .select('key, value')
    .eq('business_id', businessId)
    .in('key', [
      'mpesa_consumer_key',
      'mpesa_consumer_secret',
      'mpesa_shortcode',
      'mpesa_passkey',
      'mpesa_type',
    ]);

  if (error || !data?.length) return null;

  const cfg: Record<string, string> = {};
  data.forEach(row => { cfg[row.key] = row.value; });

  // H9: consumer_secret and passkey are encrypted at rest (business.ts write
  // path) — decrypt here. decryptSecret() itself passes any legacy plaintext
  // value through unchanged, so this also works for rows written before this
  // fix, without needing the one-time backfill to have run yet.
  const consumerSecret = cfg.mpesa_consumer_secret ? safeDecrypt(cfg.mpesa_consumer_secret) : null;
  const passkey        = cfg.mpesa_passkey ? safeDecrypt(cfg.mpesa_passkey) : null;

  if (!cfg.mpesa_consumer_key || !consumerSecret ||
      !cfg.mpesa_shortcode    || !passkey) {
    return null;
  }

  return {
    consumerKey:    cfg.mpesa_consumer_key,
    consumerSecret,
    shortcode:      cfg.mpesa_shortcode,
    passkey,
    type:           (cfg.mpesa_type as MpesaConfig['type']) ?? 'CustomerBuyGoodsOnline',
  };
}

async function getDarajaToken(config: MpesaConfig): Promise<string> {
  const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');

  const response = await fetch(`${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!response.ok) {
    throw new Error(`Daraja OAuth failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { access_token: string };
  return data.access_token;
}

function formatPhone(phone: string): string {
  // Normalise Kenyan phone → 2547XXXXXXXX format
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0'))   return '254' + cleaned.slice(1);
  if (cleaned.startsWith('254')) return cleaned;
  if (cleaned.startsWith('7') || cleaned.startsWith('1')) return '254' + cleaned;
  return cleaned;
}

function generateTimestamp(): string {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function generatePassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

// ── POST /api/mpesa/stk-push ──────────────────────────────────────────────────

router.post('/stk-push', requireAuth, async (req, res) => {
  const { phone, order_id, account_reference, description } = req.body;

  if (!phone || !order_id) {
    res.status(400).json({ error: 'phone and order_id are required' });
    return;
  }

  // ── H8: tenant scope + real amount ──────────────────────────────────────
  // Previously: order_id was never checked against req.businessId, and the
  // amount was whatever the request body said — a user in tenant A could flip
  // a payment row in tenant B, or a cashier could STK-push a customer for any
  // amount unrelated to the bill. The amount now comes ONLY from the pending
  // mpesa payment row that order creation already wrote (orders.ts), which
  // was itself derived from the order total there — never from this request.
  const { data: pendingLeg, error: legErr } = await supabase
    .from('payments')
    .select('id, amount, status')
    .eq('order_id', order_id)
    .eq('business_id', req.businessId)
    .eq('method', 'mpesa')
    .single();

  if (legErr || !pendingLeg) {
    res.status(404).json({ error: 'No M-Pesa payment leg found for that order' });
    return;
  }
  if ((pendingLeg as any).status === 'completed') {
    res.status(409).json({ error: 'This M-Pesa payment has already been completed' });
    return;
  }

  const amountInt = Math.ceil(Number((pendingLeg as any).amount)); // Daraja requires whole numbers
  if (amountInt < 1) {
    res.status(400).json({ error: 'Payment amount must be at least KES 1' });
    return;
  }

  const config = await getMpesaConfig(req.businessId);
  if (!config) {
    res.status(422).json({
      error: 'M-Pesa not configured for this business. Add M-Pesa credentials in Settings.',
    });
    return;
  }

  const formattedPhone = formatPhone(String(phone));
  if (!/^2547\d{8}$|^2541\d{8}$/.test(formattedPhone)) {
    res.status(400).json({ error: `Invalid Kenyan phone number: ${phone}` });
    return;
  }

  try {
    const token     = await getDarajaToken(config);
    const timestamp = generateTimestamp();
    const password  = generatePassword(config.shortcode, config.passkey, timestamp);

    const callbackUrl = `${CALLBACK_BASE}/api/mpesa/callback`;

    const stkBody = {
      BusinessShortCode: config.shortcode,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   config.type,
      Amount:            amountInt,
      PartyA:            formattedPhone,
      PartyB:            config.shortcode,
      PhoneNumber:       formattedPhone,
      CallBackURL:       callbackUrl,
      AccountReference:  (account_reference ?? order_id).slice(0, 12),
      TransactionDesc:   (description ?? 'SwiftPOS Payment').slice(0, 13),
    };

    const stkRes = await fetch(`${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(stkBody),
    });

    const stkData = await stkRes.json() as any;

    if (!stkRes.ok || stkData.ResponseCode !== '0') {
      console.error('[mpesa] STK push failed:', stkData);
      res.status(502).json({
        error:   'M-Pesa STK push failed',
        details: stkData.errorMessage ?? stkData.ResponseDescription ?? 'Unknown error',
      });
      return;
    }

    const checkoutId = stkData.CheckoutRequestID as string;

    // Persist the checkout ID + pending state on the payments row so the callback
    // can match it and /status can read it. mpesa_requested_at anchors the
    // read-time timeout. This is the single source of truth — survives restarts
    // and works across instances (replaces the old in-memory Map + setTimeout).
    await supabase
      .from('payments')
      .update({
        mpesa_checkout_id:  checkoutId,
        status:             'pending',
        mpesa_phone:        formattedPhone,
        mpesa_requested_at: new Date().toISOString(),
        mpesa_result_desc:  null,
      })
      .eq('id', (pendingLeg as any).id)
      .eq('business_id', req.businessId);

    res.json({
      checkoutRequestId:    checkoutId,
      merchantRequestId:    stkData.MerchantRequestID,
      responseDescription:  stkData.ResponseDescription,
    });

  } catch (err: any) {
    console.error('[mpesa] STK push error:', err.message);
    res.status(500).json({ error: 'Failed to initiate M-Pesa payment' });
  }
});

// ── POST /api/mpesa/callback ──────────────────────────────────────────────────
// PUBLIC — no requireAuth. Daraja calls this directly. Source is authenticated
// by IP allow-list (see isAllowedCallbackIp), amount is validated against the
// payments row, and processing is idempotent against Daraja retries.

router.post('/callback', async (req, res) => {
  // ── Source authentication ─────────────────────────────────────────────────
  // Reject anything that isn't coming from a trusted Daraja IP BEFORE doing any
  // work. This is what stops a forged "success" callback from marking an order
  // paid. See isAllowedCallbackIp / MPESA_ALLOWED_IPS above.
  if (!isAllowedCallbackIp(req.ip)) {
    console.warn('[mpesa] Rejected callback from untrusted IP:', req.ip);
    res.status(403).json({ ResultCode: 1, ResultDesc: 'Forbidden' });
    return;
  }

  // Always respond 200 immediately — Daraja retries if it doesn't get 200 fast
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) {
      console.warn('[mpesa] Callback received with unexpected shape:', JSON.stringify(req.body));
      return;
    }

    const checkoutId  = body.CheckoutRequestID as string;
    const resultCode  = Number(body.ResultCode);
    const resultDesc  = body.ResultDesc as string;

    if (resultCode === 0) {
      // ── SUCCESS ──────────────────────────────────────────────────────────
      const items    = body.CallbackMetadata?.Item ?? [];
      const getValue = (name: string) =>
        items.find((i: any) => i.Name === name)?.Value;

      const mpesaRef   = String(getValue('MpesaReceiptNumber') ?? '');
      const paidAmount = Number(getValue('Amount') ?? 0);
      const phone      = String(getValue('PhoneNumber') ?? '');

      // Look up the payment this checkout belongs to BEFORE trusting anything in
      // the callback. This gives us the expected amount and lets us de-duplicate.
      const { data: payment } = await supabase
        .from('payments')
        .select('id, order_id, amount, status, business_id')
        .eq('mpesa_checkout_id', checkoutId)
        .single();

      if (!payment) {
        console.warn(`[mpesa] Success callback for unknown checkout ${checkoutId} — ignored`);
        return;
      }

      // Idempotency — Daraja retries callbacks, and a replayed callback must not
      // re-run side effects. If we've already completed this payment, stop here.
      if ((payment as any).status === 'completed') {
        return;
      }

      // Amount validation — the STK push charged Math.ceil(expected), so a
      // genuine payment pays at least that. A shortfall means a tampered/forged
      // callback or an underpayment: do NOT complete the order — record it as
      // failed and flag it in payment_exceptions for a human to review, rather
      // than only a server log nobody's watching in real time.
      const expectedInt = Math.ceil(Number((payment as any).amount ?? 0));
      if (expectedInt > 0 && paidAmount < expectedInt) {
        const mismatchMsg = `Amount mismatch: paid ${paidAmount}, expected ${expectedInt}`;
        console.error(`[mpesa] AMOUNT MISMATCH on ${checkoutId}: ${mismatchMsg} — order NOT completed, flagged for review`);
        await supabase
          .from('payments')
          .update({
            status:            'failed',
            reference:         mpesaRef,
            mpesa_phone:       phone,
            mpesa_result_desc: mismatchMsg,
          })
          .eq('id', (payment as any).id);
        await supabase.from('payment_exceptions').insert({
          business_id:      (payment as any).business_id,
          payment_id:       (payment as any).id,
          order_id:         (payment as any).order_id,
          checkout_id:      checkoutId,
          expected_amount:  expectedInt,
          received_amount:  paidAmount,
          reason:           mismatchMsg,
        });
        return;
      }

      // Record the ACTUAL amount paid (from Safaricom), not a client-supplied
      // value. Keyed by the payment's own id (already resolved above).
      await supabase
        .from('payments')
        .update({
          status:            'completed',
          reference:         mpesaRef,
          amount:            paidAmount,
          mpesa_phone:       phone,
          mpesa_result_desc: null,
        })
        .eq('id', (payment as any).id);

      // H8: complete the order only once every leg on it is settled — a split
      // cash+M-Pesa bill must not be closed by the M-Pesa half alone if another
      // leg (e.g. a second, still-pending M-Pesa number on a shared bill) hasn't
      // cleared. Note: today every OTHER method is marked 'completed' at order
      // creation (synchronous by design — cash/card settle immediately at the
      // till), so in the common single-mpesa-leg case this resolves to "yes,
      // complete" exactly as before. This check earns its keep the moment a
      // second async leg exists, and costs nothing when one doesn't.
      if ((payment as any).order_id) {
        const { data: otherLegs } = await supabase
          .from('payments')
          .select('status')
          .eq('order_id', (payment as any).order_id)
          .neq('id', (payment as any).id);
        const allSettled = (otherLegs ?? []).every((l: any) => l.status === 'completed');
        if (allSettled) {
          await supabase
            .from('orders')
            .update({ status: 'completed' })
            .eq('id', (payment as any).order_id);
        } else {
          console.log(`[mpesa] Order ${(payment as any).order_id} has other unsettled legs — not marking completed yet`);
        }
      }

      console.log(`[mpesa] Payment completed: ${mpesaRef} — KES ${paidAmount}`);

    } else if (resultCode === 1032) {
      // Customer cancelled
      await supabase
        .from('payments')
        .update({ status: 'failed', mpesa_result_desc: 'Customer cancelled the payment request' })
        .eq('mpesa_checkout_id', checkoutId);

    } else {
      // Other failure
      await supabase
        .from('payments')
        .update({ status: 'failed', mpesa_result_desc: resultDesc })
        .eq('mpesa_checkout_id', checkoutId);

      console.warn(`[mpesa] Payment failed: ${resultDesc}`);
    }

  } catch (err: any) {
    console.error('[mpesa] Callback processing error:', err.message);
  }
});

// ── GET /api/mpesa/status/:checkoutId ────────────────────────────────────────
// Frontend polls this every 3 seconds while showing "Waiting for payment…"

router.get('/status/:checkoutId', requireAuth, async (req, res) => {
  const { checkoutId } = req.params;

  // Read from the payments row (source of truth). Scoped to the caller's
  // business so one tenant can't poll another's checkout id.
  const { data: payment } = await supabase
    .from('payments')
    .select('status, reference, amount, mpesa_phone, mpesa_result_desc, mpesa_requested_at')
    .eq('mpesa_checkout_id', checkoutId)
    .eq('business_id', req.businessId)
    .maybeSingle();

  if (!payment) {
    res.status(404).json({ status: 'not_found', error: 'No pending payment found for this checkout ID' });
    return;
  }

  const p = payment as any;
  let status: string = p.status;
  let error: string | null = p.mpesa_result_desc ?? null;

  // Derive a timeout at read time: a payment still 'pending' past the STK window
  // is treated as failed, without relying on any in-process timer. Best-effort
  // write-back so the row doesn't linger as 'pending' forever.
  if (status === 'pending' && p.mpesa_requested_at) {
    const age = Date.now() - new Date(p.mpesa_requested_at).getTime();
    if (age > STK_TIMEOUT_MS) {
      status = 'failed';
      error  = error ?? 'Timeout — customer did not respond';
      void supabase
        .from('payments')
        .update({ status: 'failed', mpesa_result_desc: error })
        .eq('mpesa_checkout_id', checkoutId)
        .eq('business_id', req.businessId)
        .eq('status', 'pending'); // only if still pending — avoid racing the callback
    }
  }

  res.json({
    status,
    mpesaRef:  p.reference ?? undefined,
    amount:    p.amount ?? undefined,
    phone:     p.mpesa_phone ?? undefined,
    error:     error ?? undefined,
  });
});

// ── GET /api/mpesa/config ─────────────────────────────────────────────────────
// Returns whether M-Pesa is configured — no secrets exposed.

router.get('/config', requireAuth, async (req, res) => {
  const config = await getMpesaConfig(req.businessId);
  res.json({
    configured: config !== null,
    type:       config?.type ?? null,
    shortcode:  config?.shortcode ?? null,
    environment: ENV,
  });
});

// ── GET /api/mpesa/exceptions ─────────────────────────────────────────────────
// Amount mismatches from the callback (audit H8) — was console.error only
// before, now persisted to payment_exceptions. This is the read endpoint for
// that table; no dashboard UI page consumes it yet (flagged as a follow-up,
// not built here). Same permission tier as the other financial-sensitive
// report reads (H6).
router.get('/exceptions', requireAuth, requirePermission('reports.financial'), async (req, res) => {
  const { resolved } = req.query as Record<string, string>;
  let query = supabase
    .from('payment_exceptions')
    .select('*')
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (resolved === 'false') query = query.is('resolved_at', null);
  if (resolved === 'true')  query = query.not('resolved_at', 'is', null);
  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

export default router;
