-- 167_weighed_quantities.sql — A577: items sold by weight keep their weight to the gram.
--
-- Owner, 2026-10-23 (approved): goods sold by the kilo — scanned from a weighing scale's label (0.452 kg) or weighed and
-- typed at the till — are sold with the weight as the line's quantity.
--
-- The products already say how an item is sold (products.sold_by 'weight', since the baseline), its scale code
-- (products.plu_code) and its unit (products.unit_label 'kg' or 'g'); the business's scale label layout is a
-- business_settings row ('scale_barcodes'). No new column is needed for them.
--
-- What is needed: the quantity columns a sale passes through held TWO decimals (numeric(12,2)), so 0.452 kg was stored
-- as 0.45 — the line, the stock taken off the shelf and the movement log each lost the last gram digit, and a day of
-- weighed sales drifted the stock by up to 5 g a sale. Widened to THREE decimals (the gram):
--   order_items.quantity                              the sale's line
--   stock_levels.quantity                             the branch's stock
--   stock_movements.quantity_change / quantity_after  the movement log (migration 39 made them numeric(12,2))
--   stock_adjustments.quantity                        a manager's adjustment
--   stock_take_lines.counted_qty / expected_qty       a stock count (migration 120)
--   grn_items.quantity_received                       goods received
-- (kitchen_voids, wastage, stock batches, transfer lines and transfer requests already hold 3 decimals.)
--
-- Safe: numeric(12,2) -> numeric(12,3) keeps every stored value exactly (the largest still fits: 999 999 999.999).
-- Idempotent: an ALTER to the type a column already has changes nothing. No view depends on these columns.

ALTER TABLE public.order_items
  ALTER COLUMN quantity TYPE numeric(12, 3);

ALTER TABLE public.stock_levels
  ALTER COLUMN quantity TYPE numeric(12, 3);

ALTER TABLE public.stock_movements
  ALTER COLUMN quantity_change TYPE numeric(12, 3),
  ALTER COLUMN quantity_after  TYPE numeric(12, 3);

ALTER TABLE public.stock_adjustments
  ALTER COLUMN quantity TYPE numeric(12, 3);

ALTER TABLE public.stock_take_lines
  ALTER COLUMN counted_qty  TYPE numeric(12, 3),
  ALTER COLUMN expected_qty TYPE numeric(12, 3);

ALTER TABLE public.grn_items
  ALTER COLUMN quantity_received TYPE numeric(12, 3);

COMMENT ON COLUMN public.order_items.quantity IS
  'How many — or, for an item sold by weight (products.sold_by = ''weight''), the weight in kg to the gram (migration 167).';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('167_weighed_quantities', 'A577: items sold by weight - order_items, stock_levels, stock_movements, stock_adjustments, stock_take_lines and grn_items quantities numeric(12,2) -> numeric(12,3), so a weighed sale keeps its gram.')
ON CONFLICT (version) DO NOTHING;
