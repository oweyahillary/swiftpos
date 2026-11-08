-- Migration 189 — per-business approval of the ZapTill Android app, per surface (Android Stage 0, 2026-11-04)
--
-- docs/ANDROID-APP-DESIGN.md §1.4 (Q3, decided 2026-10-11): the Android app is a direct APK, "updated through the A348
-- per-client approval". The desktop's rule (migration 108), for the app's two surfaces:
--   android_till_approved_version   the "Shop POS" mode (a shop tablet that sells — the cloud's surface 'android-till')
--   mobile_approved_version         the "Owner / manager phone" mode (the surface 'mobile')
--
--   NULL          → HOLD (the default, as the desktop): the app stays on the version it runs.
--   '0.1.0' etc.  → devices older than this update to exactly this version; devices on it (or newer) do nothing.
--
-- Two columns, so a client's shop tablets can stay on a version that works while the owner's phone takes a newer one.
-- Set from the admin portal (PATCH /api/admin/android/clients/:id/version, super admin, audited); read by
-- GET /api/app-update/android/status. Plain x.y.z only; the route validates, and the CHECKs keep a hand-edit honest.
-- Additive: no existing row changes (every client starts held). Safe before or after the server deploy: until this runs
-- the cloud answers "held" with a warning naming this migration.
-- Reversible: ALTER TABLE public.businesses DROP COLUMN android_till_approved_version, DROP COLUMN mobile_approved_version;
-- DELETE FROM public.schema_migrations WHERE version = '189_android_approved_versions'.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS android_till_approved_version text,
  ADD COLUMN IF NOT EXISTS mobile_approved_version text;

ALTER TABLE public.businesses
  DROP CONSTRAINT IF EXISTS businesses_android_till_approved_version_format;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_android_till_approved_version_format
  CHECK (android_till_approved_version IS NULL OR android_till_approved_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$');

ALTER TABLE public.businesses
  DROP CONSTRAINT IF EXISTS businesses_mobile_approved_version_format;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_mobile_approved_version_format
  CHECK (mobile_approved_version IS NULL OR mobile_approved_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$');

COMMENT ON COLUMN public.businesses.android_till_approved_version IS
  'Android Stage 0: the ZapTill for Android version this business''s Shop POS tablets may update to (x.y.z). NULL = hold. '
  'Set in the admin portal; read by GET /api/app-update/android/status.';
COMMENT ON COLUMN public.businesses.mobile_approved_version IS
  'Android Stage 0: the ZapTill for Android version this business''s owner / manager phones may update to (x.y.z). '
  'NULL = hold. Set in the admin portal; read by GET /api/app-update/android/status.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('189_android_approved_versions', 'Android Stage 0: businesses.android_till_approved_version and mobile_approved_version — per-business approval of the Android app (NULL = hold)')
ON CONFLICT (version) DO NOTHING;
