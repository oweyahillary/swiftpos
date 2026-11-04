-- Migration 184 — Attendance shifts (A616)
--
-- Owner, 2026-10-31: "on the attendance section add shifts section" — staff work set shifts (e.g. 09:00-17:00,
-- 13:00-21:00, 17:00-00:00) and a punch in the small hours is the night's punch-out, never the next day's punch-in.
-- Owner's choices: shifts per branch (copyable); each day the shift nearest a person's first punch, or one shift pinned to
-- the person; the report shows late arrivals.
--
-- What this adds (idempotent):
--   attendance_shifts            a branch's shifts: name, start and end as minutes after midnight (an end at or before the
--                                start runs past midnight; 00:00 is 0), and the grace minutes before an arrival is late.
--                                Ended shifts are kept (active false) so old reports keep their names.
--   attendance_people.shift_id   the shift pinned to a person (NULL: the nearest shift each day). A shift removed: SET NULL.
-- Service role only (as every attendance table, migration 180). Reversible: DROP COLUMN attendance_people.shift_id;
-- DROP TABLE attendance_shifts.

CREATE TABLE IF NOT EXISTS public.attendance_shifts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id       uuid        NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  start_min       integer     NOT NULL,
  end_min         integer     NOT NULL,
  grace_min       integer     NOT NULL DEFAULT 10,
  active          boolean     NOT NULL DEFAULT true,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_shifts_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT attendance_shifts_start_check CHECK (start_min BETWEEN 0 AND 1439),
  CONSTRAINT attendance_shifts_end_check CHECK (end_min BETWEEN 0 AND 1439),
  CONSTRAINT attendance_shifts_grace_check CHECK (grace_min BETWEEN 0 AND 120)
);
CREATE INDEX IF NOT EXISTS attendance_shifts_branch ON public.attendance_shifts (business_id, branch_id);
-- one active shift of a name per branch
CREATE UNIQUE INDEX IF NOT EXISTS attendance_shifts_name ON public.attendance_shifts (branch_id, lower(btrim(name))) WHERE active;
ALTER TABLE public.attendance_shifts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.attendance_shifts FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
COMMENT ON TABLE public.attendance_shifts IS
  '184 (A616): a branch''s work shifts for attendance - start/end in minutes after midnight (end <= start: past midnight), grace minutes before late. Service role only.';

ALTER TABLE public.attendance_people ADD COLUMN IF NOT EXISTS shift_id uuid NULL REFERENCES public.attendance_shifts(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.attendance_people.shift_id IS
  '184 (A616): the shift pinned to this person (their work day starts 6 h before it); NULL: the nearest shift to their first punch each day.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('184_attendance_shifts', 'A616: attendance shifts per branch, a pinned shift per person')
ON CONFLICT (version) DO NOTHING;
