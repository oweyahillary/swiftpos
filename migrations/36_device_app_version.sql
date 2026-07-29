-- SwiftPOS: record which app build a till is running
--
-- Three tills update independently — the app folder is replaced by hand, and
-- there is no auto-update. So they drift, and nothing anywhere records which
-- build each one is on. A report of "till 2 is doing X" cannot be tied to a
-- version, which means a fixed bug and an un-updated till look identical from
-- the outside.
--
-- Nullable on purpose. A till that has not reported yet, or is running a build
-- older than this change, simply shows blank rather than blocking anything.
-- The write is best-effort server-side for the same reason: recording a version
-- must never be able to fail a sign-in.
--
-- Lives on user_devices rather than a new table because that row already exists
-- per device, is already touched on every sign-in (last_seen_at), and is already
-- surfaced in the devices list. A new table would need its own registration
-- path, its own sync, and its own reasons to go wrong.

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS app_version text;

COMMENT ON COLUMN public.user_devices.app_version IS
  'Desktop app version last reported by this device (e.g. "0.1.0"). Null = never reported.';
