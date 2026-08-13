-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 80 — drop the dead `public.sync_queue` decoy (register D15)
--
-- `public.sync_queue` (columns: retry_count, table_name, status, …) has NO reader
-- and NO writer anywhere in the tree — not apps/server, apps/dashboard,
-- apps/desktop, no migration, no RPC. The LIVE queue with the same name is the
-- till's SQLite table (attempts, last_error) — a completely different schema.
-- Same name, different columns, one of them a decoy the next reader mistakes for
-- the real thing.
--
-- Nothing FK-references it (checked against 00_baseline: only its own PK, two
-- CHECK constraints, and two indexes), so the drop needs no special ordering and
-- CASCADE only removes the table's own dependent objects.
--
-- Idempotent (IF EXISTS). Fully public.-qualified (register A62).
-- schema-index.json updated in the same change so `verify-db-schema` does not
-- then report the table as "missing".
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.sync_queue CASCADE;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('80_drop_dead_sync_queue',
        'D15. Drops the dead public.sync_queue decoy — no reader/writer anywhere in the repo; the live queue is the till SQLite table of the same name, different schema. Nothing FK-references it. Idempotent.')
ON CONFLICT (version) DO NOTHING;
