-- ═════════════════════════════════════════════════════════════════════════════
-- SwiftPOS — Restaurant dine-in features (items 11–13)
-- Additive + idempotent. Fold into the consolidated migration once verified.
--
--   11. Split bill   — sub-bill grouping on order_items (by-item) + even-split is
--                      computed at pay time (no schema needed for even split).
--   12. Course firing— per-item course tag + fire state, set by the cashier.
--   13. Turnover     — orders.seated_at to measure dwell time; threshold in
--                      business_settings ('turnover_alert_minutes').
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 12. Course firing — per order_item ───────────────────────────────────────
-- course: cashier-assigned course name (free text, e.g. 'Starters','Mains').
-- fire_status: 'held' (sent to order but not yet to kitchen) or 'fired' (sent).
-- fired_at: when the course was fired to the kitchen.
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS course      text,
  ADD COLUMN IF NOT EXISTS fire_status text NOT NULL DEFAULT 'fired'
                            CHECK (fire_status IN ('held','fired')),
  ADD COLUMN IF NOT EXISTS fired_at    timestamptz;

-- ── 11. Split bill — sub-bill grouping per order_item ────────────────────────
-- sub_bill: integer group id (1,2,3…) for by-item splits. NULL = unassigned /
-- single bill. Even splits don't need persistence (computed at pay time), so
-- this column only supports the by-item mode.
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS sub_bill integer;

-- ── 13. Table turnover — seated time on the order ────────────────────────────
-- seated_at marks when the party was seated (defaults to order creation). Dwell
-- time = now() - seated_at for an open dine-in order; closed orders measure
-- seated_at → updated_at.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS seated_at timestamptz;

-- Backfill seated_at for existing open dine-in orders so turnover works immediately.
UPDATE public.orders
   SET seated_at = created_at
 WHERE seated_at IS NULL AND order_type = 'dine_in';

CREATE INDEX IF NOT EXISTS idx_orders_open_dinein
  ON public.orders (branch_id, seated_at)
  WHERE status = 'open' AND order_type = 'dine_in';

-- Default turnover alert threshold (minutes) for existing businesses.
INSERT INTO public.business_settings (business_id, key, value)
SELECT b.id, 'turnover_alert_minutes', '90'::jsonb
FROM public.businesses b
WHERE NOT EXISTS (
  SELECT 1 FROM public.business_settings s
  WHERE s.business_id = b.id AND s.key = 'turnover_alert_minutes'
);

COMMIT;
