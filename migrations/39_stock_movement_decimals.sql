-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 39 — Fractional quantities on stock_movements
--
-- quantity_change and quantity_after were integer. Fuel sells in fractional
-- litres: fuel_tanks.current_level is numeric(10,2) and order_items.quantity is
-- numeric(12,2). A 20.5 L sale was silently truncated to 20 on the way into the
-- movement log — the tank level stayed correct, but the audit trail that is
-- supposed to reconcile against it did not.
--
-- Loss is silent and one-directional: every fractional sale under-reports.
--
-- Weight- and volume-priced retail (products.sold_by = 'weight') has the same
-- exposure, so this is not petrol-only.
--
-- Safe: integer -> numeric widens. No rounding, no data loss, no rewrite of
-- existing values.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.stock_movements
  ALTER COLUMN quantity_change TYPE numeric(12, 2) USING quantity_change::numeric(12, 2),
  ALTER COLUMN quantity_after  TYPE numeric(12, 2) USING quantity_after::numeric(12, 2);

COMMENT ON COLUMN public.stock_movements.quantity_change IS
  'Signed change. numeric to carry fractional litres/kg (migration 39).';
COMMENT ON COLUMN public.stock_movements.quantity_after IS
  'Resulting on-hand level after this movement. numeric — see quantity_change.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('39_stock_movement_decimals', 'quantity_change/quantity_after integer -> numeric(12,2)')
ON CONFLICT (version) DO NOTHING;
