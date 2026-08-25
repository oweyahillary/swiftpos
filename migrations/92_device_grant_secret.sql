-- 92_device_grant_secret.sql
-- A164 — SCOPE-node-authority Phase 1 (cloud device-grant).
--
-- A per-device grant secret so a till can recover its OWN session (get a fresh
-- token) without an owner re-login when its refresh lapses — the "re-login wart"
-- on online tills, and the foundation the node-broker (Phase 2) and node-mint
-- (Phase 3) build on.
--
-- Additive + nullable + idempotent: an existing device simply has NULL and keeps
-- using the refresh/enrol paths unchanged until it next enrols. We store the
-- HASH only — the raw secret is returned to the device exactly once, at issue,
-- and never touches the DB again (same discipline as refresh-token jti and
-- enrolment codes). Schema-qualified per A62.

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS device_secret_hash   text,
  ADD COLUMN IF NOT EXISTS device_secret_set_at timestamptz;

COMMENT ON COLUMN public.user_devices.device_secret_hash IS
  'sha256 of the per-device grant secret (A164). Raw secret returned to the device once at issue; never stored. NULL = device predates the grant or has not re-enrolled.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('92_device_grant_secret',
        'A164 / SCOPE-node-authority Phase 1. Adds user_devices.device_secret_hash + device_secret_set_at (both nullable) so a till can recover its own session via POST /api/auth/device-token without an owner re-login. Additive, idempotent (ADD COLUMN IF NOT EXISTS), no backfill; store hash only.')
ON CONFLICT (version) DO NOTHING;
