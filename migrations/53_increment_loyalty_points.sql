-- Migration: atomic loyalty points increment
-- Run this in Supabase SQL editor before deploying the updated orders.ts
--
-- Replaces the read-modify-write pattern in awardLoyaltyPoints() with a
-- single atomic UPDATE, eliminating the race condition when two orders for
-- the same customer complete concurrently.

CREATE OR REPLACE FUNCTION increment_loyalty_points(
  p_customer_id uuid,
  p_points      int
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE customers
  SET
    loyalty_points = loyalty_points + p_points,
    visit_count    = visit_count + 1
  WHERE id = p_customer_id;
$$;
