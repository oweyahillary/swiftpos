-- 166_loss_alerts.sql — A576: loss-prevention alerts (the owner's watch list).
--
-- Owner, 2026-10-23: unusual patterns per branch and per staff member — voids after payment, many voids or refunds by one
-- person against the others, big or frequent discounts typed in, cash short or over at the confirm or the day close,
-- sales priced below the list, items taken back from the kitchen (restaurants), vehicles let out with no charge (car
-- parks). A WARNING ONLY, for investigation: plain words, never an accusation, never "to recover"; at most 10 shown; to
-- the owner and managers, never on the cashier's screen.
--
-- public.loss_alerts — one row per alert, written by the cloud's hourly job (apps/server/src/jobs/lossAlerts.ts, rules in
-- lib/lossAlertRules.ts) and read by the dashboard's Watch list (GET /api/loss-alerts):
--   alert_key       what makes it one alert: kind, period, day, branch, person (and the shift or day for a cash
--                   difference) — UNIQUE per business, so the job writes the same alert again as an update (idempotent);
--                   the count grows during the day, the notification goes once
--   kind            paid_voids / many_voids / many_refunds / big_discounts / frequent_discounts / free_sales / cash_short /
--                   price_below_list / kitchen_removed / parking_no_charge
--   period          'day' (business_date is that day) or 'week' (the 7 business days ending business_date)
--   branch_id       the branch (null only when the event had none); staff_id the person it is about (null: a branch's day
--                   close, a car park's sessions)
--   count, amount   how many, and an amount where one applies (the cash difference, the largest discount, how far below
--                   the list); peer_low / peer_high the others' range ("others: 0-1")
--   score           the order on the list (most worth a look first)
--   message, link   the plain words and the list behind them (reports filtered to the day, branch and person)
--   notified_at     when the owner / managers were told (once); dismissed_at / dismissed_by / dismiss_note — "looked
--                   into", off the list
-- The owner's switches, thresholds and who is told live in business_settings 'loss_alerts' (no table).
--
-- Indexes for the job's reads that had none: voided orders by voided_at, confirmed shifts by confirmed_at, voided parking
-- sessions by ended_at.
--
-- RLS: only the business's owner may read its rows directly (the alerts are about staff — never a staff sign-in's to read);
-- the managers' watch list is served by the cloud, which holds the branch and permission rules. Writes go through the
-- server (the service role bypasses RLS).
-- Idempotent: safe to run twice. Additive - nothing existing changes.

CREATE TABLE IF NOT EXISTS public.loss_alerts (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id      uuid          NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  staff_id       uuid          NULL REFERENCES public.users(id) ON DELETE SET NULL,
  alert_key      text          NOT NULL CHECK (char_length(alert_key) BETWEEN 1 AND 300),
  kind           text          NOT NULL CHECK (kind IN ('paid_voids', 'many_voids', 'many_refunds', 'big_discounts',
                                 'frequent_discounts', 'free_sales', 'cash_short', 'price_below_list', 'kitchen_removed',
                                 'parking_no_charge')),
  period         text          NOT NULL CHECK (period IN ('day', 'week')),
  business_date  date          NOT NULL,
  count          integer       NOT NULL DEFAULT 1 CHECK (count >= 0),
  amount         numeric(14,2) NULL,
  peer_low       integer       NULL CHECK (peer_low IS NULL OR peer_low >= 0),
  peer_high      integer       NULL CHECK (peer_high IS NULL OR peer_high >= 0),
  score          numeric(8,2)  NOT NULL DEFAULT 0,
  message        text          NOT NULL CHECK (char_length(message) BETWEEN 1 AND 600),
  link           text          NULL CHECK (link IS NULL OR char_length(link) <= 600),
  notified_at    timestamptz   NULL,
  dismissed_at   timestamptz   NULL,
  dismissed_by   uuid          NULL REFERENCES public.users(id) ON DELETE SET NULL,
  dismiss_note   text          NULL CHECK (dismiss_note IS NULL OR char_length(dismiss_note) <= 300),
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT loss_alerts_one_per_key UNIQUE (business_id, alert_key)
);
COMMENT ON TABLE public.loss_alerts IS
  'A576: loss-prevention alerts for the owner''s watch list - one row per alert (kind, period, day, branch, person), written by the cloud''s job (idempotent on alert_key), told once (notified_at), dismissed when looked into. A warning for investigation, never an accusation.';

CREATE INDEX IF NOT EXISTS loss_alerts_business_date ON public.loss_alerts (business_id, business_date DESC);
CREATE INDEX IF NOT EXISTS loss_alerts_branch_date ON public.loss_alerts (business_id, branch_id, business_date DESC);

CREATE INDEX IF NOT EXISTS idx_orders_voided_at ON public.orders (business_id, voided_at) WHERE status = 'voided';
CREATE INDEX IF NOT EXISTS idx_shifts_confirmed_at ON public.shifts (business_id, confirmed_at) WHERE confirmed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS parking_sessions_voided_ended ON public.parking_sessions (business_id, ended_at) WHERE status = 'voided';

DROP TRIGGER IF EXISTS loss_alerts_set_updated_at ON public.loss_alerts;
CREATE TRIGGER loss_alerts_set_updated_at BEFORE UPDATE ON public.loss_alerts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.loss_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS loss_alerts_owner_reads ON public.loss_alerts;
CREATE POLICY loss_alerts_owner_reads ON public.loss_alerts FOR SELECT
  USING (business_id IN (SELECT b.id FROM public.businesses b WHERE b.owner_id = auth.uid()));
DO $$ BEGIN
  REVOKE ALL ON public.loss_alerts FROM anon;
  GRANT SELECT ON public.loss_alerts TO authenticated;
  GRANT ALL ON public.loss_alerts TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('166_loss_alerts', 'A576: loss_alerts - the owner''s watch list of loss-prevention alerts (one per kind, period, day, branch and person; idempotent on alert_key; told once; dismissed when looked into), and indexes for voided orders, confirmed shifts and voided parking sessions.')
ON CONFLICT (version) DO NOTHING;
