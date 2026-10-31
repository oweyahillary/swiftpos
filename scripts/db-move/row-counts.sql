-- row-counts.sql — READ-ONLY. Every table's row count in the app's schema (public) and the sign-ins (auth.users,
-- auth.identities), plus the last migration applied. Run it on the OLD and the NEW database and compare the two outputs:
-- every line must match. (docs/SUPABASE-ORG-MOVE.md, section B2)
SELECT t.table_schema, t.table_name,
       (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::bigint AS row_count
FROM information_schema.tables t
WHERE t.table_type = 'BASE TABLE'
  AND (t.table_schema = 'public' OR (t.table_schema = 'auth' AND t.table_name IN ('users', 'identities')))
ORDER BY 1, 2;

SELECT max(version) AS last_migration, count(*) AS migrations_recorded FROM public.schema_migrations;
