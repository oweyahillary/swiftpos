-- =============================================================================
-- 77_increment_customer_spend.sql
--
-- Register A55 — the last racy read-modify-write on the customer row.
--
-- `orders.ts` updates `customers.total_spent` in three places by SELECTing the
-- current value and writing back `current + amount`:
--
--     orders.ts:800    order paid
--     orders.ts:1323   order voided (subtract)
--     orders.ts:1869   payment recorded
--
-- Two tills serving the same customer at the same moment both read the old
-- value and both write their own total. One sale silently vanishes from it.
--
-- ── WHY THIS IS THE ODD ONE OUT ─────────────────────────────────────────────
-- Everything else on this row is ALREADY atomic. Migration 53 built
-- `increment_loyalty_points(p_customer_id, p_points)`, which does
-- `loyalty_points = loyalty_points + p_points, visit_count = visit_count + 1`
-- in a single statement, and `awardLoyaltyPoints` (orders.ts:308) calls it.
-- `adjust_loyalty_points` (67), `adjust_product_stock`, `apply_credit_transaction`
-- and `increment_discount_usage` are all RPCs for the same reason — the 08-08
-- session converted three racy stock writes deliberately.
--
-- `total_spent` was simply left outside that path, and is written racily by the
-- SAME request, to the SAME row, about twenty lines after the atomic call. The
-- comment at orders.ts:794 says "inline — no RPC dependency", which is true and
-- is the problem.
--
-- ── WHY A SEPARATE FUNCTION, NOT AN ARGUMENT TO MIGRATION 53's ──────────────
-- Migration 67 set the precedent: `adjust_loyalty_points` deliberately does NOT
-- touch `visit_count`, because an adjustment is not a visit. Same reasoning
-- here — a void must decrement spend WITHOUT decrementing visit_count, and a
-- payment recorded against an existing order must add spend without counting a
-- second visit. Folding this into increment_loyalty_points would force those
-- concerns together and break the void path.
--
-- ── SIGNED, AND WHY total_spent IS FLOORED BUT visit_count IS NOT TOUCHED ───
-- p_amount is signed so the void path passes a negative. total_spent is floored
-- at 0: a void of an order placed before the customer record existed, or a
-- double-void, would otherwise drive lifetime spend negative and every RFM
-- segment reading it would silently mis-bucket that customer. Clamping is the
-- conservative choice — it loses the ability to detect that anomaly here, which
-- is why the function reports nothing and the caller keeps its own audit trail.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.increment_customer_spend(
  p_customer_id uuid,
  p_amount      numeric
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.customers
  SET    total_spent = GREATEST(0, COALESCE(total_spent, 0) + p_amount),
         updated_at  = now()
  WHERE  id = p_customer_id;
$$;

COMMENT ON FUNCTION public.increment_customer_spend(uuid, numeric) IS
  'Register A55. Atomically add (or subtract, for a void) to customers.total_spent. Replaces a read-modify-write in orders.ts that lost an increment whenever two tills served the same customer at once. Floors at 0. Deliberately does NOT touch visit_count — see migration 67''s split of adjust_loyalty_points from increment_loyalty_points.';

-- The void path updates THREE columns in one read-modify-write:
-- loyalty_points, total_spent and visit_count (orders.ts:1317-1324). The first
-- already has an atomic form (adjust_loyalty_points, migration 67) and the
-- second is above. This is the third, so the whole block can become RPC calls
-- rather than one racy statement — a partial fix would leave a racy write in
-- the same place and read as if it had been handled.
--
-- Separate from increment_customer_spend for migration 67's stated reason: a
-- payment recorded against an existing order adds spend WITHOUT counting a
-- second visit, so the two must be callable independently.
CREATE OR REPLACE FUNCTION public.adjust_customer_visits(
  p_customer_id uuid,
  p_delta       int
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.customers
  SET    visit_count = GREATEST(0, COALESCE(visit_count, 0) + p_delta),
         updated_at  = now()
  WHERE  id = p_customer_id;
$$;

COMMENT ON FUNCTION public.adjust_customer_visits(uuid, int) IS
  'Register A55. Atomically move customers.visit_count (negative to reverse a void). Floors at 0. Pairs with increment_customer_spend; kept separate because spend and visits move independently.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('77_increment_customer_spend',
        'A55. increment_customer_spend(uuid, numeric) makes the last racy read-modify-write on the customer row atomic. total_spent was written as current+amount in three places in orders.ts (paid, voided, payment recorded) while loyalty_points and visit_count on the SAME row had been atomic since migration 53. Signed amount so the void path subtracts; floored at 0; does not touch visit_count.')
ON CONFLICT (version) DO NOTHING;
