-- Migration 187 — Delivery platform prices (A619)
--
-- Owner, 2026-11-01: Glovo, Uber Eats and Bolt Food charge fees, so prices on those platforms are higher — "assume 3 piece
-- chicken is 1000 normal price ordering with glovo it is 1150 a 15% bump so the receipt shows 1150 not the percentage
-- increase but the price in glovo". The sale is rung at normal prices; picking the platform as the payment method
-- re-prices it (shared/platformPrices.ts).
--
-- The rules need no table: each platform's uplift is a setting (business default, branch override — the A387 pattern),
-- key delivery_platform_prices, and the rounding a business setting, delivery_platform_rounding. Both start with
-- 'delivery_', so the change log already counts them as money (sync_setting_topic, migration 151): a POS applies them at
-- once.
--
-- What this adds (idempotent, additive — safe before or after the deploy; the cloud and the POS read normal prices
-- without it):
--   products.platform_prices   an item's own price per platform ({"glovo": 1200}); NULL = the platform's uplift.
--                              Rides with the product to every POS (the change log logs products).
--   orders.price_list          the platform whose prices the sale was charged at (NULL = normal prices).
--   orders.platform_rule       the rule that applied ({"kind": "percent", "value": 15, "rounding": "up10"}), so a later
--                              change of the rate never rewrites history.
--   orders.platform_uplift     what the platform prices added (the sale's subtotal − the same lines at normal prices) —
--                              the reports' "of which uplift".
-- No new table, so nothing new to secure: products and orders keep their row level security.
-- Reversible: ALTER TABLE products DROP COLUMN platform_prices; ALTER TABLE orders DROP COLUMN price_list, DROP COLUMN
-- platform_rule, DROP COLUMN platform_uplift.

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS platform_prices jsonb NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_platform_prices_object') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_platform_prices_object
      CHECK (platform_prices IS NULL OR jsonb_typeof(platform_prices) = 'object');
  END IF;
END $$;
COMMENT ON COLUMN public.products.platform_prices IS
  '187 (A619): the item''s own price per delivery platform ({"glovo": 1200}) - wins over the platform''s uplift; NULL = the uplift.';

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS price_list text NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS platform_rule jsonb NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS platform_uplift numeric(12,2) NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_price_list_code') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_price_list_code
      CHECK (price_list IS NULL OR price_list ~ '^[a-z0-9_]{1,40}$');
  END IF;
END $$;
-- The reports read a period's platform sales: only those rows are indexed.
CREATE INDEX IF NOT EXISTS orders_price_list_period ON public.orders (business_id, created_at) WHERE price_list IS NOT NULL;
COMMENT ON COLUMN public.orders.price_list IS
  '187 (A619): the delivery platform whose prices the sale was charged at (a payment method code); NULL = normal prices.';
COMMENT ON COLUMN public.orders.platform_rule IS
  '187 (A619): the platform rule that applied - {"kind": "percent"|"amount"|null, "value", "rounding"} - kept as it was.';
COMMENT ON COLUMN public.orders.platform_uplift IS
  '187 (A619): what the platform prices added - the subtotal minus the same lines at normal prices.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('187_platform_prices', 'A619: delivery platform prices - products.platform_prices, orders.price_list / platform_rule / platform_uplift')
ON CONFLICT (version) DO NOTHING;
