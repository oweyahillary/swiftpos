-- Migration 196 — a billing code per business: the Paybill account number clients pay with (A626 Phase 2a)
--
-- Owner, 2026-11-25: each client gets a code as their account/reference number on ZapTill's Paybill; a payment's account
-- number is matched to it. (docs/tasks/A626-paybill-cloud-billing.md). Phase 1 (migration 195) lands the raw payments;
-- this adds the code so a payment can be matched to a client (Phase 2a); the credit wallet + allocation are Phase 2b.
--
-- billing_code is what is printed on the invoice; billing_code_norm is its matched form (upper-cased, non-alphanumerics
-- stripped), the server keeps both in step, and the unique index on the normalised form stops two clients sharing a code
-- after a typo-tolerant match. Backfill: a code for every current business, unique, derived from its name.
--
-- Additive, idempotent, reversible: DROP the two columns.

ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS billing_code      text;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS billing_code_norm text;
CREATE UNIQUE INDEX IF NOT EXISTS businesses_billing_code_norm ON public.businesses (billing_code_norm) WHERE billing_code_norm IS NOT NULL;

-- Backfill: every business without a code gets one from its name (first 6 alphanumerics, upper-cased), made unique on the
-- normalised form by appending a number on a clash. Runs once (only where billing_code IS NULL), so it is idempotent.
DO $a626$
DECLARE b RECORD; base text; cand text; norm text; n int;
BEGIN
  FOR b IN SELECT id, name FROM public.businesses WHERE billing_code IS NULL ORDER BY created_at, id LOOP
    base := upper(regexp_replace(coalesce(b.name, ''), '[^A-Za-z0-9]', '', 'g'));
    base := nullif(substring(base from 1 for 6), '');
    IF base IS NULL THEN base := 'BIZ'; END IF;
    cand := base; n := 1;
    LOOP
      norm := upper(regexp_replace(cand, '[^A-Za-z0-9]', '', 'g'));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.businesses WHERE billing_code_norm = norm);
      n := n + 1; cand := base || n::text;
    END LOOP;
    UPDATE public.businesses SET billing_code = cand, billing_code_norm = norm WHERE id = b.id;
  END LOOP;
END $a626$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('196_business_billing_code', 'A626 Phase 2a: businesses.billing_code (+ _norm, unique) — the Paybill account number a client pays with; backfilled from the name')
ON CONFLICT (version) DO NOTHING;
