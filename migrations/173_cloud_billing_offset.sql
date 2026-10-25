-- 173_cloud_billing_offset.sql — A587: the owner's billing decisions of 2026-10-24 on top of A584 (migration 172).
--
-- Owner, 2026-10-24: "What happens to the old unpaid invoice of a locked client who pays? — we offset it; if they fail to
-- pay for 3 months we assume they are not interested", corrected the same day: "it's pay as you go, not pay for missed
-- months, since they won't be using the system at that time" · "Should already-locked clients get the 7 days? — no".
-- Rules: apps/server/src/lib/cloudPlan.ts (cloudStanding, invoiceStarts, paymentCovers) and lib/billingClock.ts; the job:
-- apps/server/src/jobs/cloudPlanReminders.ts; Record payment: routes/cloudPlanAdmin.ts.
--
-- public.invoices.status — adds 'written_off': a cloud invoice closed, not charged — when a LOCKED client pays (pay as
--   you go: the payment starts a fresh period; the locked time's invoice is "not used while paused"; audited in
--   'cloud_plan.payment' not_charged), and when the client is taken as "Not interested" (unpaid 3 months after its first
--   unpaid due date; audited 'cloud_plan.not_interested' with the numbers). Nothing existing changes. A cloud before this
--   migration writes 'failed' instead (A584's word).
-- public.cloud_plan_reminders.milestone — adds 'not_interested' (ZapTill's one notice). Every earlier milestone stays.
-- public.cloud_plans.billing_from — NULL for every plan (the due moment is paid-until, or created_at when later — A584).
--   Set only by the A584 bridge for a licence that was ALREADY locked under the old ladder (28+ days past its date): the
--   licence's own date, so it stays locked at once (no fresh 7 days, no arrears invoice); when it pays, a fresh period
--   starts from the payment day.
--
-- No data is moved. Idempotent: safe to run twice. Additive.

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_status_check
  CHECK (((status)::text = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'refunded'::text, 'written_off'::text])));

ALTER TABLE public.cloud_plan_reminders DROP CONSTRAINT IF EXISTS cloud_plan_reminders_milestone_check;
ALTER TABLE public.cloud_plan_reminders ADD CONSTRAINT cloud_plan_reminders_milestone_check
  CHECK (milestone ~ '^(before_(14|7|3|1)|lapse_day|lapsed_w[1-9]|invoice|unpaid_5|locked|trial_end|not_interested)$');

ALTER TABLE public.cloud_plans ADD COLUMN IF NOT EXISTS billing_from timestamptz NULL;
COMMENT ON COLUMN public.cloud_plans.billing_from IS
  'A587: set by the bridge for a licence already locked under the old ladder - its own date, so it stays locked (no arrears invoice; a payment starts afresh). NULL = A584 (due = paid-until, or created_at when later).';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('173_cloud_billing_offset', 'A587: invoices.status written_off; cloud_plan_reminders milestone not_interested; cloud_plans.billing_from (a bridged licence kept locked).')
ON CONFLICT (version) DO NOTHING;
