-- 172_cloud_billing.sql — A584: the cloud plan's invoice on the first day of each billing period, once per period, and
-- ZapTill's (admin-only) billing notices.
--
-- Owner, 2026-10-23: "build a robust structure — some clients I had already set the licence, but build it: if it expires
-- they will call" · "an invoice is sent to the client on the first day of their billing" · "after 7 days the access gets
-- revoked immediately, no warning for web". Rules: apps/server/src/lib/cloudPlan.ts and lib/billingClock.ts; the job:
-- apps/server/src/jobs/cloudPlanReminders.ts.
--
-- public.invoices.kind — 'cloud' for the cloud plan's invoices (raised pending on the due day, or paid by Record payment).
--   NULL for every other invoice (a licence fee, an invoice the admin raises by hand) — nothing existing changes.
--   invoices_one_cloud_period: one cloud invoice per business and period start — the job and a payment can never raise two.
-- public.cloud_plan_reminders.milestone — A581's client reminders (before_14 … lapsed_w8) stay readable as history; A584 adds
--   ZapTill's notices: invoice (raised and emailed on the due day), unpaid_5 ("locks in 2 days"), locked, trial_end.
--
-- No data is moved: the bridge of licence expiries set before the plan (a plan row per dated business) is made by the
-- billing job, audited, so it also covers a date set after this runs.
-- Idempotent: safe to run twice. Additive.

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS kind text NULL;
DO $$ BEGIN
  ALTER TABLE public.invoices ADD CONSTRAINT invoices_kind_check CHECK (kind IS NULL OR kind IN ('cloud'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.invoices.kind IS
  'A584: ''cloud'' = a cloud plan invoice (one per business and period start, raised on the due day or by Record payment); NULL = any other invoice.';

CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_cloud_period ON public.invoices (business_id, period_start)
  WHERE kind = 'cloud';

ALTER TABLE public.cloud_plan_reminders DROP CONSTRAINT IF EXISTS cloud_plan_reminders_milestone_check;
ALTER TABLE public.cloud_plan_reminders ADD CONSTRAINT cloud_plan_reminders_milestone_check
  CHECK (milestone ~ '^(before_(14|7|3|1)|lapse_day|lapsed_w[1-9]|invoice|unpaid_5|locked|trial_end)$');
COMMENT ON TABLE public.cloud_plan_reminders IS
  'A581/A584: the cloud billing notices sent - one per business, due date and milestone. A584: invoice (to the client and ZapTill), unpaid_5, locked, trial_end (ZapTill only). before_*/lapse_day/lapsed_w* are A581''s, kept as history.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('172_cloud_billing', 'A584: invoices.kind (''cloud'') with one cloud invoice per business and period start; cloud_plan_reminders milestones invoice / unpaid_5 / locked / trial_end.')
ON CONFLICT (version) DO NOTHING;
