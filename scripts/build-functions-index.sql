-- ─────────────────────────────────────────────────────────────────────────────
-- build-functions-index.sql — regenerate scripts/functions-index.json from the
-- live database. This is the AUTHORITATIVE source for that file.
--
-- Run it in the Supabase SQL editor, copy the single JSON value it returns, and
-- save it as scripts/functions-index.json.
--
-- WHY FUNCTIONS AND NOT JUST TABLES
-- PostgREST resolves an RPC by its NAMED ARGUMENT SET, so a parameter name is
-- part of the call signature, not documentation. increment_loyalty_points was
-- (p_customer_id, p_delta) in this database and (p_customer_id, p_points) in
-- migrations/53 for months. PostgreSQL refuses to rename a parameter through
-- CREATE OR REPLACE, so every re-run of that migration failed and the two
-- definitions drifted apart with nothing to flag it.
--
-- Run this whenever a migration creates or changes a function.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT json_object_agg(proname, args ORDER BY proname)::text AS functions_index
FROM (
  SELECT p.proname,
         pg_get_function_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'          -- plain functions; not aggregates or procedures
  ORDER BY p.proname
) s;
