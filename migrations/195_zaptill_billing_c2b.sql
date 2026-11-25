-- Migration 195 — ZapTill cloud-billing M-Pesa Paybill: the C2B pipe (A626 Phase 1)
--
-- Owner, 2026-11-25: ZapTill gets its OWN Paybill; clients pay their cloud subscription with a code as the account number;
-- Daraja's C2B confirmation callback feeds the cloud. Phase 1 proves the pipe end-to-end: register the callback with
-- Safaricom, receive a payment, record it raw. Matching to a client, the credit wallet and allocation come later (A626
-- Phase 2). (docs/tasks/A626-paybill-cloud-billing.md)
--
-- Distinct from A621 (migration 188): that is a CUSTOMER paying a CLIENT's branch Till/Paybill (branch_c2b_settings /
-- mpesa_c2b_payments, per branch). This is ONE ZapTill Paybill for CLIENTS paying ZapTill — a single registration row and a
-- raw receipts feed. The callback path is /api/cloud-billing/c2b/... (A621 uses /api/payments/c2b/...), so they never collide.
--
-- Additive, idempotent, reversible: DROP TABLE public.cloud_billing_receipts, public.zaptill_billing_c2b.

-- 1. The single ZapTill C2B registration (one row — enforced by the singleton primary key). ZapTill's Daraja CREDENTIALS
--    are deployment config (env vars), never stored here; this keeps only the registration STATE and the callback token's
--    SHA-256 (the plaintext token lives only in Safaricom's saved URL, so a stolen row cannot forge a callback).
CREATE TABLE IF NOT EXISTS public.zaptill_billing_c2b (
  singleton              boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  token_hash             text        NULL CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  registered_at          timestamptz NULL,
  registered_shortcode   text        NULL CHECK (registered_shortcode IS NULL OR registered_shortcode ~ '^[0-9]{5,8}$'),
  registered_environment text        NULL CHECK (registered_environment IS NULL OR registered_environment IN ('sandbox','production')),
  last_error             text        NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NULL
);
COMMENT ON TABLE public.zaptill_billing_c2b IS
  'A626: ZapTill''s single cloud-billing Paybill C2B registration (one row). Daraja keys are env vars; this keeps only the registration state + the callback token hash. Service role only.';
CREATE UNIQUE INDEX IF NOT EXISTS zaptill_billing_c2b_token ON public.zaptill_billing_c2b (token_hash) WHERE token_hash IS NOT NULL;

-- 2. The raw receipts feed: every payment Safaricom confirms on ZapTill's Paybill, deduped on the M-Pesa code. Phase 1
--    records it raw (business_id null, status 'received'); Phase 2 matches bill_ref_norm to a client's billing code and
--    allocates. Never a full phone number (mirrors migration 188's mpesa_c2b_payments).
CREATE TABLE IF NOT EXISTS public.cloud_billing_receipts (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  trans_id      text          NOT NULL,
  shortcode     text          NOT NULL,
  trans_type    text          NULL,
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  trans_time    timestamptz   NULL,
  bill_ref      text          NULL,
  bill_ref_norm text          NULL,
  first_name    text          NULL,
  phone_masked  text          NULL CHECK (phone_masked IS NULL OR phone_masked !~ '^\+?(254|0)[17][0-9]{8}$'),
  status        text          NOT NULL DEFAULT 'received' CHECK (status IN ('received','unmatched','matched','allocated')),
  business_id   uuid          NULL REFERENCES public.businesses(id) ON DELETE SET NULL,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT cloud_billing_receipts_trans_id_key UNIQUE (trans_id)
);
COMMENT ON TABLE public.cloud_billing_receipts IS
  'A626: raw M-Pesa C2B receipts on ZapTill''s cloud-billing Paybill, deduped on trans_id. Phase 1 = received; Phase 2 matches bill_ref_norm to a client and allocates. No full phone number. Service role only.';
CREATE INDEX IF NOT EXISTS cloud_billing_receipts_recent ON public.cloud_billing_receipts (created_at DESC);
CREATE INDEX IF NOT EXISTS cloud_billing_receipts_bill_ref ON public.cloud_billing_receipts (bill_ref_norm);

-- 3. RLS on, no policies: only the service role (the server answering Safaricom and the admin portal) ever reads or writes.
ALTER TABLE public.zaptill_billing_c2b     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_billing_receipts  ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.zaptill_billing_c2b    FROM anon, authenticated;
  REVOKE ALL ON public.cloud_billing_receipts FROM anon, authenticated;
EXCEPTION WHEN others THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('195_zaptill_billing_c2b', 'A626 Phase 1: ZapTill cloud-billing Paybill C2B — the registration row + raw receipts feed (the pipe); matching/wallet/allocation in Phase 2')
ON CONFLICT (version) DO NOTHING;
