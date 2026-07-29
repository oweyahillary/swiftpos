-- SwiftPOS: refunds (audit finding M3)
--
-- Until now there was no way to give money back. Voids exist, but only within 30
-- minutes and only as "this sale should not have happened". A customer returning
-- an hour later had no path through the software at all, which in practice means
-- cash leaves the drawer with no record — the worst possible outcome, because it
-- is indistinguishable from theft at close.
--
-- MODELLED AS A PAYMENT EVENT, NOT AN ORDER STATE CHANGE
--
-- The sale did happen. The food was made, the stock moved, the levy and VAT were
-- charged and are owed. What changed is that money went back out. So the order
-- stays 'completed' and the refund is recorded as reversing payment rows, with
-- the columns below carrying the audit trail.
--
-- This also avoids altering orders_status_check, which currently permits only
-- ('open','completed','voided'). Adding a status would mean auditing every query
-- in the codebase that filters on 'completed' — reports, shift reconciliation,
-- Z-reports, the sync engine — and any one of them missed would silently drop
-- refunded orders out of a total. A nullable timestamp is inert to every one of
-- those queries by default.
--
-- FULL REFUNDS ONLY, for now. refunded_amount exists so partial refunds can be
-- added without another migration, and so the endpoint can refuse to refund more
-- than was actually taken, but the first version reverses the whole order. A
-- partial refund needs line-level selection to restore the right stock and to
-- recompute the tax position, and getting that wrong is worse than not offering
-- it — staff can refund in full and re-ring the difference.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS refunded_at      timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_amount  numeric(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_reason    text,
  ADD COLUMN IF NOT EXISTS refunded_by      uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS refund_authorized_by uuid REFERENCES public.users(id);

COMMENT ON COLUMN public.orders.refunded_at IS
  'When money was returned. Null = never refunded. The order stays completed — the sale happened.';
COMMENT ON COLUMN public.orders.refunded_amount IS
  'Cumulative amount returned. Equals total for a full refund. Guards against refunding twice.';
COMMENT ON COLUMN public.orders.refund_authorized_by IS
  'The supervisor whose override PIN approved this refund. Distinct from refunded_by, who operated the till.';

-- Partial index: refunds are rare, and every report that wants them wants only
-- them.
CREATE INDEX IF NOT EXISTS idx_orders_refunded_at
  ON public.orders (business_id, refunded_at)
  WHERE refunded_at IS NOT NULL;
