-- ─────────────────────────────────────────────────────────────────────────────
-- build-schema-index.sql — regenerate scripts/schema-index.json from the live
-- database. This is the AUTHORITATIVE source for that file.
--
-- Run it in the Supabase SQL editor (or psql), copy the single JSON value it
-- returns into a file, then:
--
--     node scripts/build-schema-index.mjs --from-db result.json
--
-- json_object_agg, not jsonb_object_agg: jsonb sorts its keys, which would
-- reorder every column alphabetically and turn a two-line change into a
-- whole-file diff nobody reads. json preserves insertion order, so columns stay
-- in ordinal_position and tables stay alphabetical.
--
-- BASE TABLE only — views would otherwise appear as tables the audit believes
-- are writable.
--
-- Run this whenever a migration adds or removes a table or column. The index is
-- what scripts/schema-audit.py checks all 470-odd selects against; when it is
-- stale that job either fails on tables that do exist, or passes on columns that
-- do not.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT json_object_agg(table_name, cols ORDER BY table_name)::text AS schema_index
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
