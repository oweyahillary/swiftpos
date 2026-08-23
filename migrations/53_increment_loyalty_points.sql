-- NOTE (migration 68): this file says p_points. Some databases were created
-- with p_delta instead, and PostgreSQL will NOT rename a parameter through
-- CREATE OR REPLACE — re-running this file against such a database fails with
--
--     ERROR: cannot change name of input parameter "p_delta"
--
-- which is how the repo and production drifted apart unnoticed. PostgREST
-- resolves an RPC by its NAMED ARGUMENT SET, so the name IS the call signature.
-- migrations/68_loyalty_rpc_parameter_name.sql does the DROP + CREATE that
-- settles every database on p_points. Run 68 if this file errors.
--
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
