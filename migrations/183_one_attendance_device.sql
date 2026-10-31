-- Migration 183 — One attendance device per branch (A614)
--
-- Owner, 2026-10-30: "we bind an attendance device to a branch and a branch can never have two attendance device if added
-- online or through the desktop app".
--
-- What this adds (idempotent): a UNIQUE index on attendance_devices (branch_id) over the devices not removed — a branch has
-- at most one active device, whoever adds it (the web's POST /api/attendance/devices refuses a second with 409
-- BRANCH_HAS_DEVICE first; this holds it when two adds race, and for any path added later). A removed device (removed_at
-- set) does not count, so a device can be replaced.
--
-- If a branch ALREADY has two active devices the index cannot be built: this migration then STOPS with the branches named
-- (nothing changed) — remove the extra device on Attendance → Devices, then run it again. Read-only check first:
--   SELECT branch_id, count(*) FROM public.attendance_devices WHERE removed_at IS NULL GROUP BY branch_id HAVING count(*) > 1;
-- Reversible: DROP INDEX public.attendance_devices_one_per_branch.

DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(branch_id::text || ' (' || n || ' devices)', ', ') INTO dup
  FROM (SELECT branch_id, count(*) AS n FROM public.attendance_devices WHERE removed_at IS NULL GROUP BY branch_id HAVING count(*) > 1) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'A614: these branches have more than one attendance device: %. Remove the extra ones on Attendance > Devices, then run migration 183 again.', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_devices_one_per_branch
  ON public.attendance_devices (branch_id) WHERE removed_at IS NULL;
COMMENT ON INDEX public.attendance_devices_one_per_branch IS
  'A614: a branch has one attendance device (the removed ones do not count).';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('183_one_attendance_device', 'A614: one attendance device per branch (unique index over the devices not removed)')
ON CONFLICT (version) DO NOTHING;
