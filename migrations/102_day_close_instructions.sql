-- =============================================================================
-- 102_day_close_instructions.sql
--
-- A275 — remote day close (Option i). Cloud relay of the branch-LAN central
-- close (branchClose.ts / node_instructions), so a manager who is NOT in the
-- store can close a till's trading day.
--
-- WHY
-- ---
-- The on-prem central close queues a close_day instruction on the branch node;
-- the till collects it, closes ITSELF (computing its own expected cash +
-- variance), and acks. business_days sync to the cloud PUSH-ONLY, so a day
-- cannot be closed by writing the cloud copy — closes flow up, never down, and
-- the till would keep selling. The faithful remote form is the SAME instruction,
-- relayed through the cloud: the off-site manager queues it here, the till pulls
-- it on its normal cloud sync and runs executeCloseDay() LOCALLY, then acks.
-- The till stays the cash authority; the manager's counted_cash is entered
-- remotely (relayed from the cashier at the till), exactly as the manager enters
-- it at the node screen today. No count is fabricated (dayService.ts invariant).
--
-- WHAT (additive, idempotent, reversible)
-- ---------------------------------------
--   • public.day_close_instructions — one row per queued close, mirroring the
--     local node_instructions shape (pending | acked | failed, payload, ack).
--   • one-pending-per-(business, till, date) partial unique index, mirroring
--     createCloseInstruction's "replace any still-pending close" rule so a till
--     never sees two counts for one day.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.day_close_instructions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL,
  branch_id      uuid,
  device_id      text NOT NULL,                    -- target till
  business_date  date NOT NULL,                    -- the day being closed
  payload        jsonb NOT NULL,                   -- CloseDayPayload (branchClose.ts)
  status         text NOT NULL DEFAULT 'pending',  -- pending | acked | failed
  created_by     uuid,                             -- manager user id
  created_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz,                      -- when the till first collected it
  ack            jsonb,                            -- the till's verdict + summary
  acked_at       timestamptz
);

CREATE INDEX IF NOT EXISTS day_close_instructions_pending_idx
  ON public.day_close_instructions (device_id, status);

CREATE INDEX IF NOT EXISTS day_close_instructions_business_idx
  ON public.day_close_instructions (business_id, branch_id, business_date);

-- One LIVE instruction per till per day: two pending counts is a question with
-- two answers, and the till would execute whichever it saw first (branchClose.ts).
CREATE UNIQUE INDEX IF NOT EXISTS day_close_instructions_one_pending
  ON public.day_close_instructions (business_id, device_id, business_date)
  WHERE status = 'pending';

-- RLS — same shape as payment_methods (migration 86). All real access is the
-- server on the service_role (which bypasses RLS): the manager queues via
-- /api/day-close and the till polls/acks with its device session, both server-side.
-- This owner_all policy is defense-in-depth for any direct PostgREST access.
ALTER TABLE public.day_close_instructions ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_all ON public.day_close_instructions FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
);

INSERT INTO public.schema_migrations (version, notes)
VALUES ('102_day_close_instructions',
        'A275 — cloud relay for remote day close (Option i). day_close_instructions mirrors the local node_instructions: a manager queues a close_day the till pulls on cloud sync and executes locally (executeCloseDay), then acks. One-pending-per-(business,till,date). Additive/idempotent/reversible.')
ON CONFLICT (version) DO NOTHING;
