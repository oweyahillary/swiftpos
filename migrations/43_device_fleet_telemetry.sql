-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 43 — Fleet telemetry on user_devices
--
-- Tills are updated by hand, one installer at a time, so the fleet drifts. There
-- is no auto-update, which means at any moment some terminal is behind and
-- nothing anywhere says which. Migration 36 started this by recording
-- app_version; this completes it with the two facts that actually tell you
-- whether a till is healthy.
--
--   schema_version   The local SQLite generation the build carries. Already sent
--                    on every sync as X-Schema-Version and, until now, thrown
--                    away. app_version alone cannot answer "can this till send
--                    covers", because the app version moves for reasons that have
--                    nothing to do with the schema.
--
--   last_sync_at     When this device last successfully pushed. The single most
--                    useful number here: a till that has not synced since morning
--                    is either off, unplugged from the network, or wedged on a
--                    rejected row — and until now that was invisible until
--                    somebody noticed the day's takings were short.
--
--                    Distinct from last_seen_at, which is written at SIGN-IN. A
--                    till signed in at 07:00 and silently failing to sync since
--                    07:05 looks perfectly healthy by last_seen_at alone.
--
-- WHY ON user_devices AND NOT A NEW TABLE
--   Same reasoning as migration 36: the row already exists per device, is already
--   touched on sign-in, and is already surfaced in the devices list. A new table
--   would need its own registration path, its own sync, and its own ways to go
--   wrong.
--
-- Both nullable, and both written best-effort. A till that has never reported
-- shows blank rather than blocking anything, and recording telemetry must never
-- be able to fail a sync push — the sale matters, the statistic does not.
--
-- Purely additive. Nothing here can reject a write.
--
-- NOTE ON NUMBERING: LOCAL_SCHEMA_VERSION moved to 43 for orders.covers, which
-- needed no Postgres change because the column has existed since the baseline.
-- This file shares the number because it is the Postgres half of the same
-- generation, not because it carries the covers change.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS schema_version integer,
  ADD COLUMN IF NOT EXISTS last_sync_at   timestamptz,
  -- The till's OWN stable identity, minted at install and already sent on every
  -- verify-pin (and discarded until now). The existing `fingerprint` is a hash of
  -- the User-Agent, which is a browser mechanism: every Electron till on the same
  -- build produces a similar UA, so it is a poor key for telling three terminals
  -- apart. device_id is what orders are already stamped with, so using it here
  -- makes the fleet view join to real sales rather than to a guess.
  ADD COLUMN IF NOT EXISTS device_id      text;

COMMENT ON COLUMN public.user_devices.schema_version IS
  'Local SQLite schema generation last reported by this device (X-Schema-Version). Null = never reported.';
COMMENT ON COLUMN public.user_devices.last_sync_at IS
  'Last successful sync push from this device. Null = never synced. Distinct from last_seen_at, which is sign-in.';

-- Finding the stale tills is the whole point, so make that query cheap.
CREATE INDEX IF NOT EXISTS user_devices_last_sync_idx
  ON public.user_devices (last_sync_at DESC NULLS LAST);

-- Sync telemetry looks the row up by device_id on every push.
CREATE INDEX IF NOT EXISTS user_devices_device_id_idx
  ON public.user_devices (device_id) WHERE device_id IS NOT NULL;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('43_device_fleet_telemetry',
        'user_devices gains schema_version, last_sync_at and device_id, all nullable and best-effort, for the fleet view')
ON CONFLICT (version) DO NOTHING;
