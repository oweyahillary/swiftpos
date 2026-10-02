-- Migration 108 — per-business approval of desktop updates (A348, 2026-09-28)
--
-- Owner, 2026-09-28: "since i am rolling the update to a client is it possible to prevent auto update untill i confirm
-- that thats the right thing to avoid breaking a working system?" … "can i find a way of picking only one client to run
-- the update not all the clients?" — then: "hold by default, per business, build 0.6.16".
--
-- Until now every till polled the public GitHub release feed, so publishing a release updated every till of every
-- client at once. From desktop 0.6.16 a till asks the CLOUD which version its business is approved for and downloads
-- only that one, through the cloud (GET /api/desktop-update/…), which also lets the source repository go private later.
--
--   NULL          → HOLD (the default, owner's choice): the business's tills stay on the version they run.
--   '0.6.16' etc. → tills older than this update to exactly this version; tills already on it (or newer) do nothing.
--
-- Set from the admin portal (PATCH /api/admin/clients/:id/desktop-version, audited). Plain x.y.z only; the route
-- validates, and the CHECK keeps a hand-edit honest. Additive: no existing row changes (all start held).

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS desktop_approved_version text;

ALTER TABLE public.businesses
  DROP CONSTRAINT IF EXISTS businesses_desktop_approved_version_format;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_desktop_approved_version_format
  CHECK (desktop_approved_version IS NULL OR desktop_approved_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$');

COMMENT ON COLUMN public.businesses.desktop_approved_version IS
  'A348: the desktop version this business''s tills may update to (x.y.z). NULL = hold — tills stay where they are. '
  'Set in the admin portal; read by GET /api/desktop-update/status and enforced by the cloud''s update feed.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('108_desktop_approved_version', 'A348: businesses.desktop_approved_version — per-business approval of desktop updates (NULL = hold)')
ON CONFLICT (version) DO NOTHING;
