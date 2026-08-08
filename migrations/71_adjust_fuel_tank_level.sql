-- ─────────────────────────────────────────────────────────────────────────────
-- 71_adjust_fuel_tank_level.sql
--
-- adjust_fuel_tank_level — atomic wet-stock change on one tank.
--
-- WHY THIS EXISTS
-- Every other stock path in SwiftPOS reached this conclusion already:
--
--     ingredients      migration 23   adjust_ingredient_stock
--     products         migration 61   adjust_product_stock
--     fuel tanks       —              still read-modify-write in JavaScript
--
-- The fuel path was the last one doing this:
--
--     const newLevel = Math.max(0, Number(tank.current_level) - litres);
--     await supabase.from('fuel_tanks').update({ current_level: newLevel })...
--
-- Two problems, the same two migration 61 documents for products.
--
-- 1. LOST UPDATE. A station's whole point is several pumps drawing one tank at
--    once. Two sales read 8,000 L, one takes 40 and the other 60, both write
--    their own answer, and the tank ends at 7,960 or 7,940 instead of 7,900.
--    Forty litres of fuel leave the ground and no record says so. The error is
--    always in the same direction — the tank always reads HIGHER than it is —
--    so it presents as unexplained shrinkage at the next dip, which is the one
--    number a station manager is certain to notice and least able to explain.
--
-- 2. THE CLAMP HID OVERSELL. Math.max(0, ...) meant a tank that had gone
--    negative read as exactly empty. A tank reading 0 when the true figure is
--    -300 L is not an inventory rounding error; it means either the dispenser
--    is metering wrong or fuel is leaving without a sale, and the clamp is what
--    stopped anyone finding out. Negative is allowed here for the same reason
--    it is allowed on products: it is a real fact about the site.
--
-- Deliberately narrow: takes a tank id, not a product id. Which tank to draw
-- from is a decision the caller makes with the pump binding, and folding that
-- lookup in here would hide it. One tank, one delta, under the row lock the
-- UPDATE takes.
--
-- Negative delta = sale. Positive = delivery or a correction.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.adjust_fuel_tank_level(
  p_tank_id UUID,
  p_delta   NUMERIC
)
RETURNS TABLE (current_level NUMERIC)
LANGUAGE plpgsql
AS $$
DECLARE
  v_level NUMERIC;
BEGIN
  UPDATE public.fuel_tanks
     SET current_level = public.fuel_tanks.current_level + p_delta,
         updated_at    = NOW()
   WHERE id = p_tank_id
  RETURNING public.fuel_tanks.current_level INTO v_level;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'adjust_fuel_tank_level: no tank with id %', p_tank_id
      USING ERRCODE = 'no_data_found';
  END IF;

  current_level := v_level;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.adjust_fuel_tank_level IS
  'Atomic wet-stock delta on one tank. Replaces JS read-modify-write, which lost '
  'updates when two pumps drew the same tank concurrently and clamped at zero, '
  'hiding oversell. Negative delta = sale, positive = delivery.';

-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.schema_migrations (version, notes)
VALUES ('71', 'adjust_fuel_tank_level: atomic tank deduction; closes the last read-modify-write stock path')
ON CONFLICT (version) DO NOTHING;
