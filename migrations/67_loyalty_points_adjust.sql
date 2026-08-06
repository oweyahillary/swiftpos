-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 67 — adjust_loyalty_points: move a balance WITHOUT counting a visit
--
-- ── WHY A SECOND FUNCTION ────────────────────────────────────────────────────
-- increment_loyalty_points (migration 53) does:
--
--     loyalty_points = loyalty_points + p_points,
--     visit_count    = visit_count + 1        <-- unconditional
--
-- That is right for EARNING on a completed order: one order, one visit. It is
-- wrong for REDEEMING. Calling it with a negative number to spend points would
-- also add a visit, and an order that both redeems and earns would count the
-- customer as visiting twice.
--
-- So redemption gets its own function. Same atomic single-UPDATE shape, no
-- visit_count.
--
-- ── WHAT IT REPLACES ─────────────────────────────────────────────────────────
-- The dine-in path in orders.ts POST /:id/pay did this:
--
--     .update({ loyalty_points: supabase.rpc('decrement', { x: points }) })
--
-- supabase.rpc() returns a lazy query BUILDER, not a value. It was never
-- awaited, so no request was sent — the builder object was serialised into the
-- update body as JSON. The result was not destructured, so the failure was
-- silent. And no 'decrement' function has ever existed in any migration.
--
-- Net effect: dine-in customers redeemed their points and kept them.
--
-- ── CLAMPING ─────────────────────────────────────────────────────────────────
-- GREATEST(..., 0) so a balance can never go negative even if two redemptions
-- race, or a caller skips its own balance check. Silent clamping is the right
-- trade here: refusing at this point would be AFTER the order is already
-- committed and the customer has walked away.
--
-- Safe to run on a live database, and safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.adjust_loyalty_points(
  p_customer_id uuid,
  p_points      int
)
RETURNS int
LANGUAGE sql
AS $$
  UPDATE customers
  SET loyalty_points = GREATEST(COALESCE(loyalty_points, 0) + p_points, 0)
  WHERE id = p_customer_id
  RETURNING loyalty_points;
$$;

COMMENT ON FUNCTION public.adjust_loyalty_points IS
  'Atomically moves a customer loyalty balance by p_points (negative to redeem) '
  'and returns the new balance. Does NOT touch visit_count — use '
  'increment_loyalty_points for earning on a completed order, which counts the visit.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('67_loyalty_points_adjust',
        'adjust_loyalty_points for redemption. Dine-in redeemed points were never deducted.')
ON CONFLICT (version) DO NOTHING;
