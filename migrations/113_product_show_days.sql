-- Migration 113 — 0.6.31: a product shown only on chosen days (2026-10-02)
--
-- Owner, 2026-10-02 (a pizza client's Tuesday and Thursday offer): "show products only on chosen days, but the product
-- should be able to sell anyday not just the selected day". public.products.show_days — the days the product is on the
-- POS grid (till, web POS) and the customer QR menu: 0 = Sunday … 6 = Saturday (JavaScript's Date.getDay()). NULL =
-- every day (every product before this). On any other day the product is off the grid but still found by search and by
-- barcode / PLU and rings at its normal price — selling is unchanged. The rule lives in shared/productDays.ts.
--
-- Additive and idempotent; no backfill (NULL = every day = today's behaviour).

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS show_days smallint[];

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_show_days_range;
ALTER TABLE public.products ADD CONSTRAINT products_show_days_range
  CHECK (show_days IS NULL OR (show_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[] AND cardinality(show_days) BETWEEN 1 AND 6));

COMMENT ON COLUMN public.products.show_days IS
  '0.6.31: days the product is on the POS grid and QR menu (0 = Sunday … 6 = Saturday); NULL = every day. Off the grid '
  'on other days but still found by search / barcode and sold at its normal price (shared/productDays.ts).';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('113_product_show_days', '0.6.31: products.show_days — shown on the POS grid / QR menu only on chosen days (still sold any day)')
ON CONFLICT (version) DO NOTHING;
