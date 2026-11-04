-- Migration 186 — M-Pesa (STK push) details per branch (A618)
--
-- Owner, 2026-11-01: "it should be per branch since different branches might have different payment method some paybill
-- some buy goods". The Daraja details (Lipa Na M-Pesa Online) were the business's only, in business_settings, and could be
-- put in only by SQL. A branch may now have its own; a branch without its own uses the business's (business_settings, as
-- before — nothing there moves).
--
-- What this adds (idempotent):
--   branch_mpesa_settings   one row per branch that has its own details: Paybill or Buy Goods, the shortcode that signs the
--                           request (Buy Goods: Safaricom's store number), the Buy Goods Till number customers pay to (NULL:
--                           the shortcode itself), the consumer key, the consumer secret and the passkey (both ENCRYPTED by
--                           the server, lib/crypto.ts — never plain text here), and the environment the details are for
--                           ('sandbox' | 'production', shown to the owner and used by "Test connection").
--                           A branch deleted: its row goes with it.
-- Service role only. Safe before or after the server deploy: the server reads the business's details while this table is
-- missing. Reversible: DROP TABLE branch_mpesa_settings.

CREATE TABLE IF NOT EXISTS public.branch_mpesa_settings (
  branch_id        uuid        PRIMARY KEY REFERENCES public.branches(id) ON DELETE CASCADE,
  business_id      uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  type             text        NOT NULL,
  shortcode        text        NOT NULL,
  till_number      text        NULL,
  consumer_key     text        NOT NULL,
  consumer_secret  text        NOT NULL,
  passkey          text        NOT NULL,
  environment      text        NOT NULL DEFAULT 'production',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NULL,
  CONSTRAINT branch_mpesa_settings_type_check CHECK (type IN ('CustomerPayBillOnline', 'CustomerBuyGoodsOnline')),
  CONSTRAINT branch_mpesa_settings_shortcode_check CHECK (shortcode ~ '^[0-9]{5,8}$'),
  CONSTRAINT branch_mpesa_settings_till_check CHECK (till_number IS NULL OR till_number ~ '^[0-9]{5,8}$'),
  CONSTRAINT branch_mpesa_settings_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT branch_mpesa_settings_key_check CHECK (length(btrim(consumer_key)) > 0)
);
CREATE INDEX IF NOT EXISTS branch_mpesa_settings_business ON public.branch_mpesa_settings (business_id);
ALTER TABLE public.branch_mpesa_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.branch_mpesa_settings FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
COMMENT ON TABLE public.branch_mpesa_settings IS
  '186 (A618): a branch''s own M-Pesa STK push (Daraja) details; no row = the business''s (business_settings mpesa_*). consumer_secret and passkey encrypted by the server. Service role only.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('186_branch_mpesa', 'A618: M-Pesa STK push details per branch, the business''s as the default')
ON CONFLICT (version) DO NOTHING;
