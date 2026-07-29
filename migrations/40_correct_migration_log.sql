-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 40 — Correct the schema_migrations backfill
--
-- 01_schema_migrations.sql recorded migration 19 as NOT applied. That was wrong.
-- The check looked for branches.reveal_code; the column migration 19 actually
-- adds is branches.tech_reveal_code, which has been present all along.
--
-- Only migration 20 (branch_prices) was genuinely outstanding.
--
-- This is exactly the failure the tracking table exists to prevent — inferring
-- applied-state from a guessed artefact name rather than asking the database.
-- Recording it rather than editing 01 in place, so the mistake stays visible.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.schema_migrations (version, notes) VALUES
  ('19_branch_reveal_code', 'verified: branches.tech_reveal_code — was wrongly recorded as unapplied in 01')
ON CONFLICT (version) DO NOTHING;

INSERT INTO public.schema_migrations (version, notes) VALUES
  ('40_correct_migration_log', 'corrects the 19 record')
ON CONFLICT (version) DO NOTHING;
