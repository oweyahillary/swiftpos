-- Migration 104 — business_branding (A303, client branding cloud store)
--
-- The cloud source of truth for A295 client branding: one row per business, pulled
-- down to each till's local `branding` mirror (remote-wins) via /api/pos/init. The
-- desktop write path (A301) and the tech-gated feed (A302) already write the LOCAL
-- row; this is the cloud table the web portal writes and the till reads.
--
-- Logo storage: base64 in the row, NOT a separate asset bucket. SCOPE-A295 §3
-- proposed logo_asset_id + Supabase Storage, but A301 settled on a <=250 KB base64
-- PNG produced client-side (prepareRasterLogo), and SCOPE §4 explicitly permits
-- "base64 for small logos". A 250 KB cap does not justify a whole asset subsystem,
-- and it keeps the cloud row shape identical to the local mirror. logo_receipt (the
-- monochrome thermal raster) is reserved for a later slice; null for now.
--
-- updated_at is maintained by the set_updated_at BEFORE UPDATE trigger so branding
-- participates in the A291 /api/pos/catalogue-version freshness signal (pos.ts adds
-- business_branding to its latest() list), i.e. a branding edit propagates to tills
-- on the normal pull without new plumbing.
--
-- RLS + grants mirror branch_settings (migration 91): a business member may read
-- their row; all writes go through the server (service_role, which bypasses RLS).
-- DROP ... IF EXISTS before CREATE keeps the migration idempotent (migration 102
-- lesson: no CREATE POLICY/TRIGGER IF NOT EXISTS in this Postgres).

CREATE TABLE IF NOT EXISTS public.business_branding (
  business_id   uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  accent_hex    text,
  logo_png      text,          -- base64 data-URI, <=250 KB (A301 cap)
  logo_receipt  text,          -- monochrome thermal raster (later slice); null for now
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A291 freshness signal: bump updated_at on every UPDATE.
DROP TRIGGER IF EXISTS business_branding_set_updated_at ON public.business_branding;
CREATE TRIGGER business_branding_set_updated_at
  BEFORE UPDATE ON public.business_branding
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.business_branding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_branding_business_member ON public.business_branding;
CREATE POLICY business_branding_business_member ON public.business_branding
  USING (business_id IN ( SELECT users.business_id FROM public.users WHERE users.id = auth.uid() ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_branding TO authenticated;
GRANT ALL ON public.business_branding TO service_role;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('104_business_branding',
        'A303 — cloud store for A295 client branding (accent + base64 logo), one row per business, pulled to the local branding mirror via /api/pos/init (remote-wins). set_updated_at trigger feeds the A291 catalogue-version signal. RLS + grants mirror branch_settings (91). Additive/idempotent/reversible.')
ON CONFLICT (version) DO NOTHING;
