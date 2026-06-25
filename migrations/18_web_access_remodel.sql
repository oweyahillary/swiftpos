-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 18 — Web access remodel
--
-- Aligns the schema with the two-products model (see DESKTOP_DESIGN.md):
--   • Web access = recurring, per BUSINESS (10k/yr). Gains a renewal CLOCK.
--   • Offline desktop = one-off, per branch, never licence-gated.
--   • Per-branch flag now means "this branch's data syncs to / is visible in the
--     cloud" — NOT "the desktop app is allowed to run."
--
-- Backwards-compatible: existing businesses keep working. The server treats a
-- NULL expiry as "use the legacy feature_flags.web_hosting boolean", so nothing
-- changes for current accounts until an expiry date is actually set.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Business level: the recurring web-access clock ──────────────────────────
-- NULL  → no dated subscription yet; fall back to legacy feature_flags.web_hosting.
-- date  → renewal date. The server derives the access STATE from now() vs this:
--           now < expiry            → active
--           expiry .. +21d          → grace        (full access)
--           +21d .. +28d            → reports_only  (read-only portal)
--           > +28d                  → locked        (login blocked, renew banner)
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS web_access_expires_at timestamptz;

COMMENT ON COLUMN public.businesses.web_access_expires_at IS
  'Renewal date for the recurring web portal (10k/yr). NULL = use legacy feature_flags.web_hosting boolean. Access state is derived from now() vs this date.';

-- ── Branch level: repurpose desktop_licensed → web_sync_enabled ─────────────
-- New column carries the cloud-sync meaning; backfilled from the old flag so
-- behaviour is identical on deploy. desktop_licensed is LEFT IN PLACE for the
-- transition (the per-branch 30k install becomes a billing record only and no
-- longer gates anything technically); a later migration can drop it.
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS web_sync_enabled boolean NOT NULL DEFAULT false;

UPDATE public.branches
  SET web_sync_enabled = COALESCE(desktop_licensed, false)
  WHERE web_sync_enabled IS DISTINCT FROM COALESCE(desktop_licensed, false);

COMMENT ON COLUMN public.branches.web_sync_enabled IS
  'Whether this branch''s data syncs to / is visible in the cloud web portal. Replaces the old desktop_licensed gating meaning.';
