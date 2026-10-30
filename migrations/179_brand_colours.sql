-- Migration 179 — business_branding.primary_hex / secondary_hex (A597, brand colours across the web portal and both POS apps)
--
-- Owner, 2026-10-27: the business OWNER chooses a primary and a secondary colour on Settings › Branding — any colour. The
-- web portal (buttons, the active menu item, links, the sidebar's logo band, chart accents), the web POS and the desktop
-- POS (buttons, selections, the brand strip and the lock screen) wear them. Never refused for legibility: the apps derive
-- every readable shade (black or white text, lighter and darker shades) from whatever colour is stored
-- (shared/themes.ts brandTokens), so the only rule kept here is the FORMAT — lower-case #rrggbb, or NULL (not chosen).
--
-- Premium: used only while the business's feature flag 'themes' is on (A325, set by ZapTill in the admin portal). Off,
-- /api/pos/init serves no colours and the dashboard sets nothing — today's look, pixel for pixel. A stored colour is kept
-- for when it is turned on again. Precedence (shared/branchBranding.ts): a branch's own theme (A544) → these colours →
-- the business's curated theme (theme_id) → the ZapTill default.
--
-- Who writes them: the owner alone, signed in as themselves (routes/business.ts PUT /api/business/branding — a partner, a
-- manager with the Branding tab's rights or a POS session gets 403). Printed documents are unchanged (the logo stays).
--
-- Additive, idempotent, reversible (ALTER TABLE business_branding DROP COLUMN primary_hex, DROP COLUMN secondary_hex).

ALTER TABLE public.business_branding ADD COLUMN IF NOT EXISTS primary_hex text;
ALTER TABLE public.business_branding ADD COLUMN IF NOT EXISTS secondary_hex text;

-- The format only (a typo can never reach a POS). Added once; a value that does not fit is cleared first (none can exist —
-- the columns are new — but a re-run after a hand edit must not fail).
DO $fmt$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_branding_primary_hex_format') THEN
    UPDATE public.business_branding SET primary_hex = lower(btrim(primary_hex)) WHERE primary_hex IS NOT NULL;
    UPDATE public.business_branding SET primary_hex = NULL WHERE primary_hex IS NOT NULL AND primary_hex !~ '^#[0-9a-f]{6}$';
    ALTER TABLE public.business_branding ADD CONSTRAINT business_branding_primary_hex_format
      CHECK (primary_hex IS NULL OR primary_hex ~ '^#[0-9a-f]{6}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_branding_secondary_hex_format') THEN
    UPDATE public.business_branding SET secondary_hex = lower(btrim(secondary_hex)) WHERE secondary_hex IS NOT NULL;
    UPDATE public.business_branding SET secondary_hex = NULL WHERE secondary_hex IS NOT NULL AND secondary_hex !~ '^#[0-9a-f]{6}$';
    ALTER TABLE public.business_branding ADD CONSTRAINT business_branding_secondary_hex_format
      CHECK (secondary_hex IS NULL OR secondary_hex ~ '^#[0-9a-f]{6}$');
  END IF;
END $fmt$;

COMMENT ON COLUMN public.business_branding.primary_hex IS
  'A597: the owner''s primary brand colour (#rrggbb) - buttons, selections, links on the web portal and both POS apps. NULL = not chosen. Used only while feature_flags ''themes'' is on; wins over theme_id.';
COMMENT ON COLUMN public.business_branding.secondary_hex IS
  'A597: the owner''s secondary brand colour (#rrggbb) - accents, chips, chart series and the brand strip''s second half. NULL = not chosen (the primary is used). Used only while feature_flags ''themes'' is on.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('179_brand_colours', 'A597: business_branding.primary_hex / secondary_hex (owner''s brand colours; flag-gated by feature_flags themes)')
ON CONFLICT (version) DO NOTHING;
