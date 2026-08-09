-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 70 — schema_snapshot() and functions_snapshot()
--
-- Lets scripts/refresh-schema-index.mjs pull both drift snapshots over the
-- existing Supabase connection, so nobody has to paste SQL into the dashboard
-- and copy a JSON blob back out by hand.
--
-- That manual step is not a small inconvenience — it is the reason
-- schema-index.json went stale in the first place, and a gate that depends on
-- somebody remembering to run two SQL files starts passing against an old
-- picture the moment they forget. The whole point of check-schema-drift.mjs is
-- to catch what humans miss; it should not itself depend on a human chore.
--
-- ── SECURITY ────────────────────────────────────────────────────────────────
-- SECURITY DEFINER so it can read the catalogs, then EXECUTE is REVOKED from
-- PUBLIC, anon and authenticated, and granted ONLY to service_role. These
-- expose table, column and function names — not row data — but that is still a
-- map of the schema and there is no reason for a browser client to hold it.
--
-- search_path is pinned: a SECURITY DEFINER function without it can be hijacked
-- by a caller-controlled search_path.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.schema_snapshot()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT json_object_agg(table_name, cols ORDER BY table_name)::text
  FROM (
    SELECT
      c.table_name,
      json_object_agg(
        c.column_name,
        '"' || c.data_type || '"' ||
          CASE WHEN c.is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
        ORDER BY c.ordinal_position
      ) AS cols
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name   = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type   = 'BASE TABLE'
    GROUP BY c.table_name
  ) s;
$$;

CREATE OR REPLACE FUNCTION public.functions_snapshot()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT json_object_agg(proname, args ORDER BY proname)::text
  FROM (
    SELECT p.proname,
           pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
  ) s;
$$;

REVOKE ALL ON FUNCTION public.schema_snapshot()    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.functions_snapshot() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.schema_snapshot()    FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.functions_snapshot() FROM anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.schema_snapshot()    TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.functions_snapshot() TO service_role';
  END IF;
END $$;

COMMENT ON FUNCTION public.schema_snapshot() IS
  'Returns the public schema as JSON for scripts/refresh-schema-index.mjs. service_role only.';
COMMENT ON FUNCTION public.functions_snapshot() IS
  'Returns public function signatures as JSON for scripts/refresh-schema-index.mjs. service_role only.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('70_schema_snapshot_rpcs',
        'schema_snapshot() and functions_snapshot() so the drift gate refreshes itself.')
ON CONFLICT (version) DO NOTHING;
