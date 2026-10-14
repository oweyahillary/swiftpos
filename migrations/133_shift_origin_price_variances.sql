-- Migration 133 — cloud audit 2026-10-14: where a shift was opened (P0-1), and offline sales priced differently (P0-2)
--
-- 1. public.shifts.opened_via — 'web' (POST /api/shifts/open: the web POS, standing in for a till or on the branch's web
--    till) or 'till' (pushed by a till through /api/sync/push). A till's close folds in only a WEB stand-in drawer on the
--    same till (A342); before this, every other open shift on that till's key was folded — including the till's own NEXT
--    shift, pushed before the old shift's close reached the cloud: the live drawer was closed with variance 0 and its cash
--    counted into the old one. Backfill (best-effort): a till's shift always names its trading day (business_day_id,
--    migration 41); a web shift never does.
--
-- 2. public.order_price_variances — owner, 2026-10-14: "let the sale go through but count it as a loss". A till's offline
--    sale whose catalogue price changed (or whose option / product was renamed or removed) before it synced is stored at
--    the till's prices — the money actually taken — and the difference is recorded here, one row per sale:
--      catalogue_total  what the cloud's catalogue prices the sale at now
--      till_total       what the till charged (the stored order total)
--      difference       catalogue_total - till_total: positive = a loss
--      reason           'price changed before sync', 'variant renamed or removed: …', 'product not on the cloud: …'
--      suspicious       the difference is more than half the catalogue total (accepted, highlighted for the owner)
--    Read by Reports › Voids & Exceptions and the owner's daily email.
-- Additive and idempotent.

ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS opened_via text;
DO $$ BEGIN
  ALTER TABLE public.shifts ADD CONSTRAINT shifts_opened_via_check CHECK (opened_via IS NULL OR opened_via IN ('web', 'till'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
UPDATE public.shifts
   SET opened_via = CASE WHEN business_day_id IS NOT NULL THEN 'till' ELSE 'web' END
 WHERE opened_via IS NULL;
COMMENT ON COLUMN public.shifts.opened_via IS
  '133: web = opened by POST /api/shifts/open (the web POS); till = pushed by a till (/api/sync/push). Only a web stand-in on a till is closed with that till''s count (A342).';

CREATE TABLE IF NOT EXISTS public.order_price_variances (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id        uuid          REFERENCES public.branches(id) ON DELETE SET NULL,
  order_id         uuid          NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_number     text,
  catalogue_total  numeric(12,2) NOT NULL,
  till_total       numeric(12,2) NOT NULL,
  difference       numeric(12,2) NOT NULL,
  reason           text          NOT NULL,
  suspicious       boolean       NOT NULL DEFAULT false,
  sold_at          timestamptz,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT order_price_variances_difference_check CHECK (difference = catalogue_total - till_total)
);
-- One row per sale: a retried sync never counts the same loss twice.
CREATE UNIQUE INDEX IF NOT EXISTS order_price_variances_order_uniq ON public.order_price_variances (order_id);
CREATE INDEX IF NOT EXISTS order_price_variances_business_created ON public.order_price_variances (business_id, created_at);
ALTER TABLE public.order_price_variances ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.order_price_variances IS
  '133: an offline till sale stored at the till''s prices because the catalogue priced it differently on sync — the difference (catalogue - till, positive = a loss) for Reports and the owner''s daily email.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('133_shift_origin_price_variances', 'Cloud audit 2026-10-14: shifts.opened_via (a till close folds only a web stand-in, P0-1); order_price_variances (offline sales priced differently, counted as a loss, P0-2)')
ON CONFLICT (version) DO NOTHING;
