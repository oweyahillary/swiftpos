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

const router = safeRouter();

const ENV            = process.env.MPESA_ENVIRONMENT ?? 'sandbox';
const CALLBACK_BASE  = process.env.MPESA_CALLBACK_BASE_URL ?? 'https://api.swiftpos.co.ke';

const DARAJA_BASE = ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// ── In-memory pending payments map ────────────────────────────────────────────
// Maps checkoutRequestId → status for fast polling.
// In production, replace with Redis for multi-instance deployments.
const pendingPayments = new Map<string, {
  status:    'pending' | 'completed' | 'failed' | 'cancelled';
  mpesaRef?: string;
  amount?:   number;
  phone?:    string;
  error?:    string;
  updatedAt: number;
}>();

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MpesaConfig {
  consumerKey:    string;
  consumerSecret: string;
  shortcode:      string;
  passkey:        string;
  type:           'CustomerBuyGoodsOnline' | 'CustomerPayBillOnline';
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

  if (!cfg.mpesa_consumer_key || !cfg.mpesa_consumer_secret ||
      !cfg.mpesa_shortcode    || !cfg.mpesa_passkey) {
    return null;
  }

  return {
    consumerKey:    cfg.mpesa_consumer_key,
    consumerSecret: cfg.mpesa_consumer_secret,
    shortcode:      cfg.mpesa_shortcode,
    passkey:        cfg.mpesa_passkey,
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
  const { phone, amount, order_id, account_reference, description } = req.body;

  if (!phone || !amount || !order_id) {
    res.status(400).json({ error: 'phone, amount, and order_id are required' });
    return;
  }

  const amountInt = Math.ceil(Number(amount)); // Daraja requires whole numbers
  if (amountInt < 1) {
    res.status(400).json({ error: 'Amount must be at least KES 1' });
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

    // Store pending status
    pendingPayments.set(checkoutId, {
      status:    'pending',
      phone:     formattedPhone,
      amount:    amountInt,
      updatedAt: Date.now(),
    });

    // Persist checkout ID to payments table so we can match the callback
    await supabase
      .from('payments')
      .update({ mpesa_checkout_id: checkoutId, status: 'pending' })
      .eq('order_id', order_id)
      .eq('method', 'mpesa');

    // Auto-expire pending after 70 seconds (Daraja timeout is 60s)
    setTimeout(() => {
      const entry = pendingPayments.get(checkoutId);
      if (entry?.status === 'pending') {
        pendingPayments.set(checkoutId, { ...entry, status: 'failed', error: 'Timeout — customer did not respond', updatedAt: Date.now() });
      }
    }, 70_000);

    res.json({
      checkoutRequestId:    checkoutId,
      merchantRequestId:    stkData.MerchantRequestID,
      responseDescription:  stkData.ResponseDescription,
    });

  } catch (err: any) {
    console.error('[mpesa] STK push error:', err.message);
    res.status(500).json({ error: 'Failed to initiate M-Pesa payment', details: err.message });
  }
});

// ── POST /api/mpesa/callback ──────────────────────────────────────────────────
// PUBLIC — no requireAuth. Daraja calls this directly.
// IMPORTANT: validate the source IP in production (Daraja IP ranges).

router.post('/callback', async (req, res) => {
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

    const existing = pendingPayments.get(checkoutId);

    if (resultCode === 0) {
      // SUCCESS
      const items    = body.CallbackMetadata?.Item ?? [];
      const getValue = (name: string) =>
        items.find((i: any) => i.Name === name)?.Value;

      const mpesaRef = String(getValue('MpesaReceiptNumber') ?? '');
      const amount   = Number(getValue('Amount') ?? 0);
      const phone    = String(getValue('PhoneNumber') ?? '');

      pendingPayments.set(checkoutId, {
        status:    'completed',
        mpesaRef,
        amount,
        phone,
        updatedAt: Date.now(),
      });

      // Update payments table
      await supabase
        .from('payments')
        .update({
          status:    'completed',
          reference: mpesaRef,
          amount,
        })
        .eq('mpesa_checkout_id', checkoutId);

      // Update the parent order status to completed
      const { data: payment } = await supabase
        .from('payments')
        .select('order_id')
        .eq('mpesa_checkout_id', checkoutId)
        .single();

      if (payment?.order_id) {
        await supabase
          .from('orders')
          .update({ status: 'completed' })
          .eq('id', payment.order_id);
      }

      console.log(`[mpesa] Payment completed: ${mpesaRef} — KES ${amount}`);

    } else if (resultCode === 1032) {
      // Customer cancelled
      pendingPayments.set(checkoutId, {
        ...(existing ?? { amount: 0, phone: '', updatedAt: 0 }),
        status:    'cancelled',
        error:     'Customer cancelled the payment request',
        updatedAt: Date.now(),
      });

      await supabase
        .from('payments')
        .update({ status: 'failed' })
        .eq('mpesa_checkout_id', checkoutId);

    } else {
      // Other failure
      pendingPayments.set(checkoutId, {
        ...(existing ?? { amount: 0, phone: '', updatedAt: 0 }),
        status:    'failed',
        error:     resultDesc,
        updatedAt: Date.now(),
      });

      await supabase
        .from('payments')
        .update({ status: 'failed' })
        .eq('mpesa_checkout_id', checkoutId);

      console.warn(`[mpesa] Payment failed: ${resultDesc}`);
    }

  } catch (err: any) {
    console.error('[mpesa] Callback processing error:', err.message);
  }
});

// ── GET /api/mpesa/status/:checkoutId ────────────────────────────────────────
// Frontend polls this every 3 seconds while showing "Waiting for payment…"

router.get('/status/:checkoutId', requireAuth, (req, res) => {
  const { checkoutId } = req.params;
  const entry = pendingPayments.get(checkoutId);

  if (!entry) {
    res.status(404).json({ status: 'not_found', error: 'No pending payment found for this checkout ID' });
    return;
  }

  res.json({
    status:    entry.status,
    mpesaRef:  entry.mpesaRef,
    amount:    entry.amount,
    phone:     entry.phone,
    error:     entry.error,
    updatedAt: entry.updatedAt,
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

export default router;
