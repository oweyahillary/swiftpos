-- 154_device_update_state.sql — A534: where each till is with its update, for the admin portal.
--
-- Owner, 2026-10-20 ("add all of them since effort is small"): the admin portal Desktop updates card showed each till
-- version and nothing else. An old till stuck (TJS PIZZA T1 on 1.0.5 while 1.0.19 was approved) could not be explained
-- from there. From 1.0.20 a till reports what its updater knows (POST /api/desktop-update/state, its own session):
--   update_state     jsonb  the cleaned report (lib/updateState.ts): running, state (idle / checking / available /
--                           downloading / downloaded / error), version, percent, since, checked_at, approved, error,
--                           idle_note, task
--   update_state_at  timestamptz  when the cloud last took a report
-- Read only by the admin portal (GET /api/admin/clients/:id/devices, super admin and agent) — no client route selects it.
-- Not a staff change: the A528 trigger on user_devices fires only on status, retired_at, branch_id, business_id and
-- device_role (migration 150), so a report never moves the staff version. Idempotent: safe to run twice.

ALTER TABLE public.user_devices ADD COLUMN IF NOT EXISTS update_state jsonb NULL;
ALTER TABLE public.user_devices ADD COLUMN IF NOT EXISTS update_state_at timestamptz NULL;

COMMENT ON COLUMN public.user_devices.update_state IS 'A534: the till updater state as it last reported it (admin portal only).';
COMMENT ON COLUMN public.user_devices.update_state_at IS 'A534: when the cloud last took the till update state.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('154_device_update_state', 'A534: user_devices.update_state and update_state_at - each till reports its update state (downloading, downloaded and waiting, failed and why) for the admin portal Desktop updates card.')
ON CONFLICT (version) DO NOTHING;
