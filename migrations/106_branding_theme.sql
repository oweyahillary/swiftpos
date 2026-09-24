-- Migration 106 — business_branding.theme_id (A325, client branding Phase 2 slice 2)
--
-- The ACTION theme a business chose (one of the curated ids in shared/themes.ts — ocean, violet, lagoon,
-- orchid, sky, teal, blossom). NULL = never chosen. The BRAND colour needs no column: it is the existing
-- accent_hex (Phase 1), per the approved two-layer design (A323).
--
-- Deliberately NO CHECK constraint on the value: the list of themes lives in code (themes.ts, one registry,
-- tested). A CHECK here would be a second copy of that list, and a retired or renamed id would then fail the
-- write instead of resolving to the default (resolveTheme). The cloud validates on write (routes/business.ts).
--
-- Whether a business may USE themes is a per-business feature flag (feature_flags key 'themes', off by
-- default), not a column: until it is on, /api/pos/init serves no theme and the till keeps today's look.
--
-- Additive, idempotent, reversible (ALTER TABLE business_branding DROP COLUMN theme_id).

ALTER TABLE public.business_branding
  ADD COLUMN IF NOT EXISTS theme_id text;
COMMENT ON COLUMN public.business_branding.theme_id IS
  'A325: the curated action theme id (shared/themes.ts). NULL = not chosen. Validated by the cloud on write; used only when feature_flags ''themes'' is on.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('106_branding_theme', 'A325: business_branding.theme_id (Phase 2 action theme; flag-gated by feature_flags themes)')
ON CONFLICT (version) DO NOTHING;
