-- 157_credit_confirmations.sql — A545: every sale on account (credit) gets a manager confirmation.
--
-- Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that it
-- was done." A511 (migration 140) made a sale on account by someone without customers.credit need a manager PIN on the
-- cloud and the web POS, and wrote the approver on the customer ledger line (its notes). A till that already took a
-- credit sale (its own sign-in, the sync push) could not send that PIN and was refused (the A534 audit) - the sale is now
-- RECORDED and waits here for a manager instead.
--
-- public.credit_confirmations - one row per sale with an on-account payment, keyed by the order:
--   state     awaiting (nobody has confirmed it yet), confirmed (a manager confirmed it was done), disputed (a manager
--             says it was not right, with a reason). A disputed sale stays on the customer balance - money is owed until
--             someone reverses the sale through the normal void / refund.
--   approved_at_sale_by  who approved it at the moment of sale (a manager PIN, or the seller holding customers.credit /
--             the owner). Such a sale is BORN confirmed by that person (decided_by = them, decided_at = the sale).
--   source    web (a live sale at the cloud or the web POS) or till (a sale a till already took, sent later).
--   over_limit  a till sale recorded although it went past the customer credit limit (the till took it already).
--   decided_by / decided_by_name / decided_at  who confirmed or disputed it, and when (the name kept for an owner whose
--             sign-in has no users row, and for someone who left).
--   dispute_reason  required when disputed (at most 300 characters).
--
-- Not synced to the tills (no sync_versions / sync_changes): the till manager screen reads it from the cloud with the
-- manager sign-in and keeps the last list for when it is offline; a decision made offline is queued on the till and
-- sent later (POST /api/credit/sales/:id/confirm|dispute).
--
-- RLS: a member of the business may read its rows; writes go through the server (the service role bypasses RLS).
-- Idempotent: safe to run twice. No backfill - sales on account before 157 were approved under A511 and are not listed.

CREATE TABLE IF NOT EXISTS public.credit_confirmations (
  order_id             uuid          PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  business_id          uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id            uuid          NULL REFERENCES public.branches(id) ON DELETE SET NULL,
  customer_id          uuid          NULL REFERENCES public.customers(id) ON DELETE SET NULL,
  amount               numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  state                text          NOT NULL DEFAULT 'awaiting' CHECK (state IN ('awaiting', 'confirmed', 'disputed')),
  source               text          NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'till')),
  over_limit           boolean       NOT NULL DEFAULT false,
  cashier_id           uuid          NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at_sale_by  uuid          NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decided_by           uuid          NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decided_by_name      text          NULL CHECK (decided_by_name IS NULL OR char_length(decided_by_name) <= 120),
  decided_at           timestamptz   NULL,
  dispute_reason       text          NULL CHECK (dispute_reason IS NULL OR char_length(dispute_reason) <= 300),
  sold_at              timestamptz   NOT NULL DEFAULT now(),
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT credit_confirmations_decided CHECK (state = 'awaiting' OR decided_at IS NOT NULL),
  CONSTRAINT credit_confirmations_reason CHECK (state <> 'disputed' OR char_length(btrim(coalesce(dispute_reason, ''))) > 0)
);
COMMENT ON TABLE public.credit_confirmations IS
  'A545: a manager confirmation of every sale on account - awaiting, confirmed (by whom, when) or disputed (by whom, when, why). A disputed sale stays owed until it is voided or refunded.';

CREATE INDEX IF NOT EXISTS credit_confirmations_business_state ON public.credit_confirmations (business_id, state, sold_at DESC);
CREATE INDEX IF NOT EXISTS credit_confirmations_branch_state ON public.credit_confirmations (branch_id, state);

DROP TRIGGER IF EXISTS credit_confirmations_set_updated_at ON public.credit_confirmations;
CREATE TRIGGER credit_confirmations_set_updated_at BEFORE UPDATE ON public.credit_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.credit_confirmations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_confirmations_business_member ON public.credit_confirmations;
CREATE POLICY credit_confirmations_business_member ON public.credit_confirmations
  USING (business_id IN (SELECT u.business_id FROM public.users u WHERE u.id = auth.uid()));
DO $$ BEGIN
  REVOKE ALL ON public.credit_confirmations FROM anon;
  GRANT SELECT ON public.credit_confirmations TO authenticated;
  GRANT ALL ON public.credit_confirmations TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('157_credit_confirmations', 'A545: credit_confirmations - every sale on account awaiting a manager confirmation (confirmed or disputed, by whom, when, why); a sale approved at the moment of sale is born confirmed.')
ON CONFLICT (version) DO NOTHING;
