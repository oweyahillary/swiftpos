-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 68 — settle the increment_loyalty_points parameter name on p_points
--
-- ── THE DRIFT ────────────────────────────────────────────────────────────────
-- The repo and the live database disagree, and have for a long time:
--
--     live database            increment_loyalty_points(p_customer_id, p_delta)
--     migrations/53_...sql     increment_loyalty_points(p_customer_id, p_points)
--
-- PostgreSQL will NOT rename a parameter through CREATE OR REPLACE:
--
--     ERROR: cannot change name of input parameter "p_delta"
--
-- So migration 53 has been failing on every re-run against this database, and
-- the two definitions drifted apart with nothing to flag it. PostgREST resolves
-- an RPC by its NAMED ARGUMENT SET, so the name is not cosmetic — it is the
-- call signature.
--
-- ── WHY IT MATTERS RIGHT NOW ─────────────────────────────────────────────────
-- orders.ts previously sent p_delta, which MATCHED this database. The atomic
-- increment has been working here. A database provisioned fresh from the repo
-- migrations got p_points, did NOT match, and fell back to the racy
-- read-modify-write on every award — silently, because the fallback triggers on
-- the word "function" appearing in the error.
--
-- One name, everywhere. p_points, because that is what migration 53 says, what
-- adjust_loyalty_points (migration 67) uses, and what orders.ts now sends.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────────
-- DROP + CREATE, not CREATE OR REPLACE, because a rename needs it. Wrapped in a
-- transaction so the function is never absent to a concurrent caller: the DROP
-- takes an exclusive lock and the CREATE lands before anything else can see the
-- gap.
--
-- RUN THIS BEFORE DEPLOYING THE SERVER. Between the two there is a window where
-- the code sends p_points and the database still wants p_delta; awards would
-- fall back to read-modify-write. Not data loss, but the race comes back.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP FUNCTION IF EXISTS public.increment_loyalty_points(uuid, int);
DROP FUNCTION IF EXISTS public.increment_loyalty_points(uuid, integer);

CREATE FUNCTION public.increment_loyalty_points(
  p_customer_id uuid,
  p_points      int
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE customers
  SET
    loyalty_points = COALESCE(loyalty_points, 0) + p_points,
    visit_count    = COALESCE(visit_count, 0) + 1
  WHERE id = p_customer_id;
$$;

COMMENT ON FUNCTION public.increment_loyalty_points IS
  'Atomically awards p_points to a customer AND counts one visit. For earning on '
  'a completed order. To move a balance without counting a visit (redemption), '
  'use adjust_loyalty_points — migration 67.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('68_loyalty_rpc_parameter_name',
        'Renames p_delta -> p_points. The live DB and migrations/53 had drifted; '
        'CREATE OR REPLACE cannot rename a parameter, so a DROP was required.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
