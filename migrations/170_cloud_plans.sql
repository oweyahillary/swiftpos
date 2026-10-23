-- 170_cloud_plans.sql — A581: the cloud's payment plan per business — the period and amount, every payment recorded, and
-- the reminders sent.
--
-- Owner, 2026-10-23: "if a client stops paying for the cloud … yes till continues to work, but the cloud stops syncing and
-- the till cannot be re-registered until the client pays again. add payment plan option such that i can select month on
-- month and always remind me on email about expiry and also the client". The cloud is month to month, charged PER
-- BUSINESS (KES 3,000 a month by default); 3 / 6 / 12 months ahead recommended, no discount for paying ahead.
--
-- ONE CLOCK: the paid-until is businesses.web_access_expires_at (the date the dashboard's ladder already reads — A147,
-- A569). No new date column; these tables hold what goes round it (apps/server/src/lib/cloudPlan.ts):
--
-- public.cloud_plans — one row per business on the plan (a row = the business is "on the plan": its tills stop syncing
--   once it lapses past the grace). period monthly / 3_months / 6_months / 12_months / custom; amount per period (any, the
--   admin types it — never hard-coded per plan); custom_until the default end for a custom period.
-- public.cloud_payments — every payment recorded by ZapTill (manual: M-Pesa Daraja later): amount, method, the reference
--   (an M-Pesa code is unique — a code recorded twice, on any client, is refused), when it was paid, the paid-until before
--   and after (the payment moved it on by one period from the later of now and the old paid-until), the invoice raised
--   for it, and who recorded it (the admin's id and email).
-- public.cloud_plan_reminders — one row per (business, paid-until, milestone) sent: 14 / 7 / 3 / 1 day(s) before, the
--   day it lapses, every 7 days while lapsed (at most 8). UNIQUE, so a milestone is sent once; a new paid-until starts
--   afresh. Whether the owner's and ZapTill's copies went, and why not.
--
-- RLS: the business's owner may read its own plan and payments (its billing); nobody but the server reads the reminders.
-- Writes go through the server (the service role bypasses RLS).
-- Idempotent: safe to run twice. Additive - nothing existing changes.

CREATE TABLE IF NOT EXISTS public.cloud_plans (
  business_id   uuid          PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  period        text          NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly', '3_months', '6_months', '12_months', 'custom')),
  amount        numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency      text          NOT NULL DEFAULT 'KES' CHECK (char_length(currency) BETWEEN 3 AND 10),
  custom_until  timestamptz   NULL,
  notes         text          NULL CHECK (notes IS NULL OR char_length(notes) <= 500),
  updated_by    text          NULL CHECK (updated_by IS NULL OR char_length(updated_by) <= 200),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.cloud_plans IS
  'A581: a business''s cloud payment plan - period (monthly, 3/6/12 months, custom) and amount per period. The paid-until is businesses.web_access_expires_at. A row puts the business on the plan: its tills stop syncing once it lapses past the grace.';

DROP TRIGGER IF EXISTS cloud_plans_set_updated_at ON public.cloud_plans;
CREATE TRIGGER cloud_plans_set_updated_at BEFORE UPDATE ON public.cloud_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.cloud_payments (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  amount             numeric(12,2) NOT NULL CHECK (amount > 0),
  currency           text          NOT NULL DEFAULT 'KES' CHECK (char_length(currency) BETWEEN 3 AND 10),
  period             text          NOT NULL CHECK (period IN ('monthly', '3_months', '6_months', '12_months', 'custom')),
  method             text          NOT NULL DEFAULT 'mpesa' CHECK (method IN ('mpesa', 'bank', 'cash', 'other')),
  reference          text          NULL CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 60),
  paid_at            timestamptz   NOT NULL DEFAULT now(),
  paid_until_before  timestamptz   NULL,
  paid_until_after   timestamptz   NOT NULL,
  invoice_id         uuid          NULL REFERENCES public.invoices(id) ON DELETE SET NULL,
  recorded_by        uuid          NULL REFERENCES public.admin_users(id) ON DELETE SET NULL,
  recorded_by_email  text          NOT NULL CHECK (char_length(recorded_by_email) BETWEEN 1 AND 200),
  recorded_at        timestamptz   NOT NULL DEFAULT now(),
  note               text          NULL CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT cloud_payments_moves_forward CHECK (paid_until_before IS NULL OR paid_until_after > paid_until_before),
  CONSTRAINT cloud_payments_mpesa_reference CHECK (method <> 'mpesa' OR reference IS NOT NULL)
);
COMMENT ON TABLE public.cloud_payments IS
  'A581: each cloud payment recorded by ZapTill - amount, method, reference (an M-Pesa code once only), when paid, the paid-until before and after, the invoice, who recorded it.';

CREATE INDEX IF NOT EXISTS cloud_payments_business ON public.cloud_payments (business_id, recorded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_payments_one_mpesa_code ON public.cloud_payments (upper(reference))
  WHERE method = 'mpesa' AND reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.cloud_plan_reminders (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid         NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  paid_until   timestamptz  NOT NULL,
  milestone    text         NOT NULL CHECK (milestone ~ '^(before_(14|7|3|1)|lapse_day|lapsed_w[1-9])$'),
  sent_at      timestamptz  NOT NULL DEFAULT now(),
  owner_email  text         NULL CHECK (owner_email IS NULL OR char_length(owner_email) <= 320),
  owner_sent   boolean      NOT NULL DEFAULT false,
  admin_sent   boolean      NOT NULL DEFAULT false,
  error        text         NULL CHECK (error IS NULL OR char_length(error) <= 500),
  CONSTRAINT cloud_plan_reminders_once UNIQUE (business_id, paid_until, milestone)
);
COMMENT ON TABLE public.cloud_plan_reminders IS
  'A581: the cloud plan reminders sent - one per business, paid-until and milestone (14/7/3/1 days before, the lapse day, weekly while lapsed up to 8), to the owner and to ZapTill.';

ALTER TABLE public.cloud_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_plan_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cloud_plans_owner_reads ON public.cloud_plans;
CREATE POLICY cloud_plans_owner_reads ON public.cloud_plans FOR SELECT
  USING (business_id IN (SELECT b.id FROM public.businesses b WHERE b.owner_id = auth.uid()));
DROP POLICY IF EXISTS cloud_payments_owner_reads ON public.cloud_payments;
CREATE POLICY cloud_payments_owner_reads ON public.cloud_payments FOR SELECT
  USING (business_id IN (SELECT b.id FROM public.businesses b WHERE b.owner_id = auth.uid()));

DO $$ BEGIN
  REVOKE ALL ON public.cloud_plans FROM anon;
  REVOKE ALL ON public.cloud_payments FROM anon;
  REVOKE ALL ON public.cloud_plan_reminders FROM anon, authenticated;
  GRANT SELECT ON public.cloud_plans TO authenticated;
  GRANT SELECT ON public.cloud_payments TO authenticated;
  GRANT ALL ON public.cloud_plans TO service_role;
  GRANT ALL ON public.cloud_payments TO service_role;
  GRANT ALL ON public.cloud_plan_reminders TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('170_cloud_plans', 'A581: cloud_plans (period and amount per business; paid-until stays businesses.web_access_expires_at), cloud_payments (each payment recorded: amount, method, M-Pesa code once only, paid-until before and after, invoice, who), cloud_plan_reminders (one per business, paid-until and milestone).')
ON CONFLICT (version) DO NOTHING;
