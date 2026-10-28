-- Migration 180 — Attendance (A599, premium): ZKTeco devices, the people on them, their punches, corrections
--
-- Owner, 2026-10-27/28: attendance is premium — the per-business feature flag 'attendance' (feature_flags, set by ZapTill
-- in the admin portal only; +KES 2,000 on the cloud price). Punches come ONLY from a ZKTeco device on the shop network
-- (first model: K90 Pro), for EVERYONE — cashiers, managers and attendance-only people (cooks, cleaners, guards). The
-- branch server pulls them from the device and sends them here (routes/attendance.ts /node/*); fingerprints never leave
-- the device: the cloud keeps who, when and which device. The web POS's PIN clock-in (POST /api/staff/clock) stays for a
-- business without the flag and is refused while it is on.
--
-- What this adds (additive, idempotent; nothing existing changes meaning):
--   attendance_devices         the devices of each branch (name, address, serial, model, firmware, last pull, last error,
--                              clock drift). Written from the web (attendance.devices) and by the branch server's report.
--   attendance_people          WHO is on the devices: one row per person with their device number (attendance_no, unique
--                              per business — a person may punch at another branch's device and stays the same person).
--                              user_id set = a member of staff (users); user_id NULL = an ATTENDANCE-ONLY person (name,
--                              branch, number — no sign-in, no PIN, no rights, never a POS user: they are not in users at
--                              all, so no sign-in or PIN path can ever find them, no staff list or picker shows them and
--                              nothing counts them as a user).
--   attendance_device_users    the device's own user list as the branch server last reported it (number, name, admin or
--                              not) — "New on the device: 12 · John" is a number here that nobody has.
--   attendance_device_actions  what the branch server is to do on a device (write a user, delete a user), picked up and
--                              acknowledged by it. Queued when a person is added / renamed / moved / deactivated.
--   clock_events (extended)    source 'pin' (the web POS, as before — every existing row) / 'device' / 'correction';
--                              the device, its serial, the device user id, the person, the device's raw status and punch;
--                              a correction's reason and author; a voided row keeps its place (voided_at, by, reason) so
--                              the original is never lost. staff_id becomes NULLABLE: a device punch of an attendance-only
--                              person, or of a number nobody has yet ("Not matched"), has no users row. Unmatched punches
--                              are kept with their number and assigned retroactively when the number is linked.
--   permissions                attendance.view / attendance.edit / attendance.devices (shared/permissions.ts words) —
--                              once: the owner roles all three; the built-in Manager and General Manager view + edit.
--                              Partners (web dashboard access, A550) hold all three by the rule in the cloud
--                              (routes/attendance.ts), whatever their role. Cashiers, waiters and the rest: none.
--
-- Dedupe of device punches: UNIQUE (business_id, device_serial, device_user_id, recorded_at) — a full index (NULLs are
-- distinct, so PIN rows and corrections never collide), so the ingest is an upsert that ignores what it already has.
--
-- Only the cloud's service role reads or writes the new tables (RLS on, no policy — attendance is personal data).
-- Reversible: DROP the four tables; ALTER TABLE clock_events DROP the new columns (after deleting the non-pin rows).

-- ── Devices ──────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_devices (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id       uuid        NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  ip              text        NOT NULL,
  port            integer     NOT NULL DEFAULT 4370,
  comm_key        integer     NOT NULL DEFAULT 0,
  serial          text,
  model           text,
  firmware        text,
  last_pull_at    timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  clock_drift_s   integer,
  users_on_device integer,
  punches_on_device integer,
  removed_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_devices_port_check CHECK (port BETWEEN 1 AND 65535),
  CONSTRAINT attendance_devices_comm_key_check CHECK (comm_key BETWEEN 0 AND 999999),
  CONSTRAINT attendance_devices_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  CONSTRAINT attendance_devices_ip_check CHECK (ip ~ '^[0-9A-Za-z.:-]{1,64}$')
);
CREATE INDEX IF NOT EXISTS attendance_devices_branch ON public.attendance_devices (business_id, branch_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_devices_serial ON public.attendance_devices (business_id, serial) WHERE serial IS NOT NULL AND removed_at IS NULL;
ALTER TABLE public.attendance_devices ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.attendance_devices FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
COMMENT ON TABLE public.attendance_devices IS
  '180 (A599): ZKTeco attendance devices per branch - address, identity and health as the branch server last reported it. Service role only.';
COMMENT ON COLUMN public.attendance_devices.comm_key IS
  'A599: the device''s communication key (0 = none). Sent to the branch server only; never shown on the web.';

-- ── People on the devices ────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_people (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id       uuid        REFERENCES public.branches(id) ON DELETE SET NULL,
  user_id         uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  name            text        NOT NULL,
  attendance_no   integer     NOT NULL,
  active          boolean     NOT NULL DEFAULT true,
  deactivated_at  timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_people_no_check CHECK (attendance_no BETWEEN 1 AND 999999999),
  CONSTRAINT attendance_people_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_people_no ON public.attendance_people (business_id, attendance_no);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_people_user ON public.attendance_people (business_id, user_id);
CREATE INDEX IF NOT EXISTS attendance_people_branch ON public.attendance_people (business_id, branch_id);
ALTER TABLE public.attendance_people ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.attendance_people FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
COMMENT ON TABLE public.attendance_people IS
  '180 (A599): who is on the attendance devices. user_id = a member of staff; NULL = an attendance-only person (no sign-in, no PIN, no rights, not a POS user - never in users). attendance_no unique per business. Service role only.';

-- ── The device's own user list (last report) ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_device_users (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  device_id       uuid        NOT NULL REFERENCES public.attendance_devices(id) ON DELETE CASCADE,
  device_user_id  text        NOT NULL,
  device_uid      integer,
  name            text,
  privilege       integer     NOT NULL DEFAULT 0,
  seen_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_device_users_key ON public.attendance_device_users (device_id, device_user_id);
CREATE INDEX IF NOT EXISTS attendance_device_users_business ON public.attendance_device_users (business_id);
ALTER TABLE public.attendance_device_users ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.attendance_device_users FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
COMMENT ON TABLE public.attendance_device_users IS
  '180 (A599): each device''s user list (number, name, privilege) as its branch server last reported it - never fingerprints. Service role only.';

-- ── What the branch server is to do on a device ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_device_actions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id       uuid        NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  device_id       uuid        NOT NULL REFERENCES public.attendance_devices(id) ON DELETE CASCADE,
  action          text        NOT NULL,
  person_id       uuid        REFERENCES public.attendance_people(id) ON DELETE SET NULL,
  attendance_no   integer     NOT NULL,
  name            text,
  -- write_user may replace a DIFFERENT name already in that slot only when true: the manager chose this number for the
  -- person (a link, a number typed), or the slot is already theirs (a rename). False: only onto an empty slot or the
  -- same name. A device bought before ZapTill keeps its own people under its own numbers (a real K40: 138 from 1) — an
  -- automatic write never lands on one of them (the branch server refuses it too).
  overwrite       boolean     NOT NULL DEFAULT false,
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz,
  CONSTRAINT attendance_device_actions_action_check CHECK (action IN ('write_user', 'delete_user')),
  CONSTRAINT attendance_device_actions_status_check CHECK (status IN ('pending', 'done', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS attendance_device_actions_pending ON public.attendance_device_actions (business_id, branch_id, created_at) WHERE status = 'pending';
ALTER TABLE public.attendance_device_actions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.attendance_device_actions FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
COMMENT ON TABLE public.attendance_device_actions IS
  '180 (A599): write / delete a user on a device - queued by the cloud, done and acknowledged by the branch server. Service role only.';

-- ── clock_events: device punches and corrections beside the PIN clock events ─────────────────────────────────────
ALTER TABLE public.clock_events ALTER COLUMN staff_id DROP NOT NULL;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pin';
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.attendance_people(id) ON DELETE SET NULL;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES public.attendance_devices(id) ON DELETE SET NULL;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS device_serial text;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS device_user_id text;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS attendance_no integer;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS raw_status integer;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS raw_punch integer;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS corrects_id uuid REFERENCES public.clock_events(id) ON DELETE SET NULL;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS voided_by uuid;
ALTER TABLE public.clock_events ADD COLUMN IF NOT EXISTS void_reason text;

-- The device's in / out is not trusted (routes pair punches in time order): a device punch and a correction are 'punch'.
ALTER TABLE public.clock_events DROP CONSTRAINT IF EXISTS clock_events_event_type_check;
ALTER TABLE public.clock_events ADD CONSTRAINT clock_events_event_type_check CHECK (event_type IN ('in', 'out', 'punch'));
ALTER TABLE public.clock_events DROP CONSTRAINT IF EXISTS clock_events_source_check;
ALTER TABLE public.clock_events ADD CONSTRAINT clock_events_source_check CHECK (
  (source = 'pin' AND staff_id IS NOT NULL)
  OR (source = 'device' AND device_serial IS NOT NULL AND device_user_id IS NOT NULL)
  OR (source = 'correction' AND reason IS NOT NULL AND length(btrim(reason)) > 0 AND (person_id IS NOT NULL OR staff_id IS NOT NULL)));
ALTER TABLE public.clock_events DROP CONSTRAINT IF EXISTS clock_events_void_reason_check;
ALTER TABLE public.clock_events ADD CONSTRAINT clock_events_void_reason_check CHECK (
  voided_at IS NULL OR (void_reason IS NOT NULL AND length(btrim(void_reason)) > 0));

CREATE UNIQUE INDEX IF NOT EXISTS clock_events_device_punch ON public.clock_events (business_id, device_serial, device_user_id, recorded_at);
CREATE INDEX IF NOT EXISTS clock_events_person_date ON public.clock_events (business_id, person_id, recorded_at);
CREATE INDEX IF NOT EXISTS clock_events_unmatched ON public.clock_events (business_id, attendance_no, recorded_at) WHERE person_id IS NULL AND source = 'device';

COMMENT ON COLUMN public.clock_events.source IS
  'A599: pin (the web POS clock-in, every row before 180) / device (pulled from a ZKTeco device by the branch server) / correction (a manager''s, with reason).';
COMMENT ON COLUMN public.clock_events.person_id IS
  'A599: the attendance person (attendance_people). NULL on a device punch = "Not matched" (a number nobody has yet); assigned when the number is linked.';
COMMENT ON COLUMN public.clock_events.voided_at IS
  'A599: a punch a manager removed or moved - kept (never deleted) with who, when and why; the move''s new punch names it in corrects_id.';

-- ── Permissions ──────────────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('attendance.view', 'See attendance', 'staff', 'The Attendance report: who came in and when, hours worked, missed punch-outs and corrections (pay figures also need Set staff pay rates)'),
  ('attendance.edit', 'Correct attendance', 'staff', 'Add or fix a punch with a reason (the original is kept) and link punches nobody was matched to'),
  ('attendance.devices', 'Attendance devices', 'staff', 'Add and remove attendance devices, give people their device numbers and match the users found on a device')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

DO $a599$
DECLARE
  v_owner integer := 0;
  v_mgr integer := 0;
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '180_attendance') THEN
  -- the owner roles: all three
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
      JOIN public.permissions p ON p.key IN ('attendance.view', 'attendance.edit', 'attendance.devices')
     WHERE lower(trim(r.name)) IN ('owner', 'admin')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_owner FROM added;
  -- the BUILT-IN Manager and General Manager (is_default, still so named): see and correct, not the devices
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
      JOIN public.permissions p ON p.key IN ('attendance.view', 'attendance.edit')
     WHERE r.is_default = true
       AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('manager', 'general manager')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_mgr FROM added;
  RAISE NOTICE 'A599: attendance rights to % owner-role grant(s) and % built-in manager grant(s)', v_owner, v_mgr;
END IF;
END $a599$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('180_attendance', 'A599: attendance (premium flag attendance) - devices, people with device numbers (attendance-only people never in users), the device user list, device actions, clock_events device punches / corrections (staff_id nullable, deduped), attendance.view / edit / devices')
ON CONFLICT (version) DO NOTHING;
