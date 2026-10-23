-- 163_stock_transfer_requests.sql — A564: a branch asks another branch for an item it has in stock.
--
-- Owner, 2026-10-22: "add a feature where employees can search if items are in an inventory of another branch and the
-- manager can request for them".
--
-- Seeing another branch's stock needs no table (GET /api/stock/other-branches reads stock_levels). Asking for it does:
-- public.stock_transfer_requests — one row per request, one product each:
--   from_branch_id   the branch ASKED to send (it holds the stock)
--   to_branch_id     the branch asking (the requester's own branch)
--   quantity         how much is asked for (> 0); sent_quantity what the sender sent (> 0) - the sending manager may
--                    change it, fewer or more than asked (owner, 2026-10-22); both are kept and shown ("asked 30 - sent 20")
--   status           requested (waiting for the other branch) -> accepted (a stock transfer was created and despatched:
--                    transfer_id) / declined (with a reason) / cancelled (by the asking branch, while still requested)
--   requested_by / _name / requested_at   who asked, and when
--   decided_by / _name / decided_at       who accepted, declined or cancelled it, and when (the name kept for an owner
--                                         whose sign-in has no users row, and for someone who left)
--   decline_reason   required when declined (at most 300 characters)
--
-- Accepting never moves stock itself: it creates an ordinary stock transfer (stock_transfers, routes/stock.ts) and
-- despatches it through the same step a transfer always takes - stock leaves the sender then, and arrives when the asking
-- branch receives the transfer. A transfer removed leaves the request (transfer_id emptied).
--
-- Not synced to the tills: the till reads it from the cloud with the manager's own sign-in (Manager > Stock > Other
-- branches), through the branch server on a till that has one (A410).
--
-- RLS: a member of the business may read its rows; writes go through the server (the service role bypasses RLS).
-- Idempotent: safe to run twice. Additive - nothing existing changes.

CREATE TABLE IF NOT EXISTS public.stock_transfer_requests (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  from_branch_id     uuid          NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  to_branch_id       uuid          NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  product_id         uuid          NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity           numeric(12,3) NOT NULL CHECK (quantity > 0),
  sent_quantity      numeric(12,3) NULL CHECK (sent_quantity IS NULL OR sent_quantity > 0),
  note               text          NULL CHECK (note IS NULL OR char_length(note) <= 300),
  status             text          NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'cancelled')),
  requested_by       uuid          NULL REFERENCES public.users(id) ON DELETE SET NULL,
  requested_by_name  text          NULL CHECK (requested_by_name IS NULL OR char_length(requested_by_name) <= 120),
  requested_at       timestamptz   NOT NULL DEFAULT now(),
  decided_by         uuid          NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decided_by_name    text          NULL CHECK (decided_by_name IS NULL OR char_length(decided_by_name) <= 120),
  decided_at         timestamptz   NULL,
  decline_reason     text          NULL CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 300),
  transfer_id        uuid          NULL REFERENCES public.stock_transfers(id) ON DELETE SET NULL,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfer_requests_two_branches CHECK (from_branch_id <> to_branch_id),
  CONSTRAINT stock_transfer_requests_decided CHECK (status = 'requested' OR decided_at IS NOT NULL),
  CONSTRAINT stock_transfer_requests_reason CHECK (status <> 'declined' OR char_length(btrim(coalesce(decline_reason, ''))) > 0)
);
COMMENT ON TABLE public.stock_transfer_requests IS
  'A564: a branch asks another branch for an item - requested, accepted (a stock transfer created and despatched: transfer_id), declined (why) or cancelled by the asking branch; who and when for each.';

CREATE INDEX IF NOT EXISTS stock_transfer_requests_from_status ON public.stock_transfer_requests (business_id, from_branch_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS stock_transfer_requests_to_status ON public.stock_transfer_requests (business_id, to_branch_id, status, requested_at DESC);

DROP TRIGGER IF EXISTS stock_transfer_requests_set_updated_at ON public.stock_transfer_requests;
CREATE TRIGGER stock_transfer_requests_set_updated_at BEFORE UPDATE ON public.stock_transfer_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.stock_transfer_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_transfer_requests_business_member ON public.stock_transfer_requests;
CREATE POLICY stock_transfer_requests_business_member ON public.stock_transfer_requests
  USING (business_id IN (SELECT u.business_id FROM public.users u WHERE u.id = auth.uid()));
DO $$ BEGIN
  REVOKE ALL ON public.stock_transfer_requests FROM anon;
  GRANT SELECT ON public.stock_transfer_requests TO authenticated;
  GRANT ALL ON public.stock_transfer_requests TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('163_stock_transfer_requests', 'A564: stock_transfer_requests - a branch asks another for an item (requested / accepted with the stock transfer it became / declined with a reason / cancelled), who and when for each.')
ON CONFLICT (version) DO NOTHING;
