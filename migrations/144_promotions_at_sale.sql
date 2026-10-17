-- 144_promotions_at_sale.sql — A518
--
-- Promotions (Menu › Promotions, menu.promotions) were stored but never charged anywhere: not at the till, not on the web
-- POS, not by the cloud. From A518 a promotion is charged at the sale as an offer (apps/server/src/lib/promotionOffers.ts)
-- — but only one saved since then: the rows from before were never charged, and turning them all on with a release
-- would change prices nobody chose. applies_at_sale marks a promotion saved from the A518 page (the cloud sets it on
-- every create and on a save from the page). Existing rows stay false: the owner opens one and saves it to start it.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). No data is changed.

ALTER TABLE public.promotions ADD COLUMN IF NOT EXISTS applies_at_sale boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.promotions.applies_at_sale IS
  'A518: charged at the sale (as an offer, with pos/init and the cloud recheck). False for promotions saved before A518.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('144_promotions_at_sale', 'A518: promotions.applies_at_sale - a promotion saved since A518 is charged at the sale as an offer.')
ON CONFLICT (version) DO NOTHING;
