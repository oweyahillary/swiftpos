-- Migration 188 — M-Pesa payment notifications (Safaricom C2B) (A621)
--
-- Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
-- directly; what the cashier gets is a notification of the payments done, then they match it to the bill." Safaricom tells
-- the cloud of every payment made to a branch's Paybill or Buy Goods number; the POS lists them and the cashier taps the
-- one that belongs to the bill. Part of the online licence (premium), like the STK prompt (A607, A618).
--
-- What this adds (idempotent):
--   branch_c2b_settings   one row per branch the owner switched notifications on for: on/off, the Buy Goods STORE number
--                         when it differs from the STK details' shortcode, the SHA-256 of the branch's secret token (the
--                         token itself is only in the addresses registered with Safaricom — it authenticates Safaricom's
--                         unauthenticated calls), when and for which number and environment the addresses were registered,
--                         and Safaricom's last refusal. A branch deleted: its row goes with it.
--   mpesa_c2b_payments    every payment Safaricom confirmed for a branch: its M-Pesa code (UNIQUE — Safaricom's retries
--                         are one payment), the amount, when it was paid, the account number the customer typed (Paybill),
--                         the payer's first name and, at most, a MASKED number (never a full phone number). Its status:
--                           received  waiting for a cashier to tap it;
--                           held      a POS took it for a bill (held_by: the device or the person; held_ref: the sale's
--                                     own reference) — no other POS can take it;
--                           used      an order carrying it as its M-Pesa reference reached the cloud (order_id).
--                         A branch or business deleted: its payments go with it; an order deleted: the link is cleared.
-- Service role only (the server answers Safaricom and the POSs). Safe before or after the server deploy: until this runs the
-- server answers Safaricom "Accepted" and keeps nothing, and the POS shows nothing new.
-- Reversible: DROP TABLE mpesa_c2b_payments; DROP TABLE branch_c2b_settings; DELETE FROM schema_migrations WHERE
-- version = '188_mpesa_c2b'. (Safaricom keeps calling the registered addresses until they are registered elsewhere.)

CREATE TABLE IF NOT EXISTS public.branch_c2b_settings (
  branch_id               uuid        PRIMARY KEY REFERENCES public.branches(id) ON DELETE CASCADE,
  business_id             uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  enabled                 boolean     NOT NULL DEFAULT false,
  store_number            text        NULL,
  token_hash              text        NULL,
  registered_at           timestamptz NULL,
  registered_shortcode    text        NULL,
  registered_environment  text        NULL,
  last_error              text        NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        NULL,
  CONSTRAINT branch_c2b_settings_store_check CHECK (store_number IS NULL OR store_number ~ '^[0-9]{5,8}$'),
  CONSTRAINT branch_c2b_settings_token_check CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT branch_c2b_settings_shortcode_check CHECK (registered_shortcode IS NULL OR registered_shortcode ~ '^[0-9]{5,8}$'),
  CONSTRAINT branch_c2b_settings_environment_check CHECK (registered_environment IS NULL OR registered_environment IN ('sandbox', 'production'))
);
CREATE UNIQUE INDEX IF NOT EXISTS branch_c2b_settings_token ON public.branch_c2b_settings (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS branch_c2b_settings_business ON public.branch_c2b_settings (business_id);
ALTER TABLE public.branch_c2b_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.mpesa_c2b_payments (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id     uuid          NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  shortcode     text          NOT NULL,
  trans_id      text          NOT NULL,
  trans_type    text          NULL,
  amount        numeric(12,2) NOT NULL,
  trans_time    timestamptz   NULL,
  bill_ref      text          NULL,
  first_name    text          NULL,
  phone_masked  text          NULL,
  status        text          NOT NULL DEFAULT 'received',
  held_by       text          NULL,
  held_ref      text          NULL,
  held_at       timestamptz   NULL,
  order_id      uuid          NULL REFERENCES public.orders(id) ON DELETE SET NULL,
  used_at       timestamptz   NULL,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT mpesa_c2b_payments_trans_id_key UNIQUE (trans_id),
  CONSTRAINT mpesa_c2b_payments_amount_check CHECK (amount > 0),
  CONSTRAINT mpesa_c2b_payments_status_check CHECK (status IN ('received', 'held', 'used')),
  CONSTRAINT mpesa_c2b_payments_held_check CHECK (status <> 'held' OR (held_by IS NOT NULL AND held_at IS NOT NULL)),
  -- A full Kenyan number is never kept: only a masked one (or none).
  CONSTRAINT mpesa_c2b_payments_phone_check CHECK (phone_masked IS NULL OR phone_masked !~ '^\+?(254|0)[17][0-9]{8}$')
);
-- The POS's list (a branch's waiting payments, newest first) and the dashboard's day list.
CREATE INDEX IF NOT EXISTS mpesa_c2b_payments_branch_status ON public.mpesa_c2b_payments (branch_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS mpesa_c2b_payments_business_day ON public.mpesa_c2b_payments (business_id, created_at);
ALTER TABLE public.mpesa_c2b_payments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  REVOKE ALL ON public.branch_c2b_settings FROM anon, authenticated;
  REVOKE ALL ON public.mpesa_c2b_payments FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMENT ON TABLE public.branch_c2b_settings IS
  '188 (A621): a branch''s M-Pesa payment notifications (Safaricom C2B): on/off, the Buy Goods store number, the SHA-256 of its secret callback token, the registration. Service role only.';
COMMENT ON TABLE public.mpesa_c2b_payments IS
  '188 (A621): payments Safaricom confirmed to a branch''s Paybill / Buy Goods number; received → held (a POS took it for a bill) → used (the order arrived). Never a full phone number. Service role only.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('188_mpesa_c2b', 'A621: M-Pesa payment notifications (C2B) — the branch settings and the payments received')
ON CONFLICT (version) DO NOTHING;
