-- verify_rls_coverage.sql — audit C1's "CI check that fails the build if any
-- public table has relrowsecurity = false".
--
-- This repo's CI (.github/workflows/ci.yml) has no database connection today,
-- so this isn't wired into a GitHub Actions job yet — it's a standalone check
-- to run manually (Supabase SQL editor, or `psql "$DATABASE_URL" -f scripts/
-- verify_rls_coverage.sql`) after any migration that adds a table. Once a CI
-- secret for a service-role connection exists, wire this in as a job that
-- fails if the query below returns any rows.
--
-- Run this after migrations/29_enable_rls_all_tables.sql (and after any
-- future migration that adds a table) to confirm nothing was missed.

SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'                 -- ordinary tables only, not views
  AND c.relrowsecurity = false        -- <-- the failure condition: RLS not enabled
ORDER BY c.relname;

-- Expect ZERO rows. Any row returned here is a table added since this check
-- was last run that nobody remembered to cover — same class of bug as C1
-- itself. A table can legitimately have relrowsecurity = true and ZERO
-- policies (that's an intentional default-deny for anon/authenticated, e.g.
-- the platform/sensitive tables in migration 29's group 3) — that's fine and
-- expected, only relrowsecurity = false is the actual failure condition.
