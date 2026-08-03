-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 52 — Bind a terminal to its branch, and make terminal codes unique
--
-- Two related integrity gaps, both invisible until they cost somebody money.
--
-- ── 1. A DEVICE IS BOUND TO A BUSINESS, NOT A BRANCH ────────────────────────
-- user_devices records business_id and nothing finer. The branch a sale belongs
-- to comes from the TILL's own device_config — a local SQLite row the machine
-- carries with it. So a terminal physically moved from Branch A to Branch B goes
-- on reporting its takings as Branch A's until somebody notices and reconfigures
-- it, and the server has no basis on which to disagree.
--
-- That is a reconciliation problem by accident and a laundering route on
-- purpose: move a till for an evening, ring the sales, and Branch A's books
-- carry revenue that never happened there while Branch B's stock walks out
-- unrecorded. Neither branch's cash count reveals it, because each is internally
-- consistent. It only shows up in a stock take weeks later.
--
-- Binding the device to a branch server-side means the claim can be checked
-- against something the till does not control.
--
-- ── 2. TERMINAL CODES ARE NOT UNIQUE ────────────────────────────────────────
-- terminal_code is free text on the setup screen, defaulting to 'T1', with no
-- uniqueness check anywhere — client or server. Configure two tills at the same
-- time, as happens on an install day, and both are 'T1'. Shift attribution, the
-- fleet view and the dead-terminal drawer then cannot tell them apart, and the
-- per-till reporting that migration 41 was written to provide silently reports
-- two machines as one.
--
-- ── FAILS OPEN UNTIL BOUND, THEN CLOSED ─────────────────────────────────────
-- Existing devices have no branch recorded and cannot be retro-assigned safely —
-- guessing would attribute history to the wrong branch. So enforcement starts
-- the first time a device reports a branch, and applies from then on. A till in
-- the field keeps working; a till that moves after this lands gets caught.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_devices
  -- The branch this terminal is registered at. NULL means never reported one,
  -- which is every existing row until its next sync.
  ADD COLUMN IF NOT EXISTS branch_id           uuid REFERENCES public.branches(id),
  ADD COLUMN IF NOT EXISTS terminal_code       text,
  ADD COLUMN IF NOT EXISTS bound_at            timestamptz,

  -- Rebinding history. Kept rather than overwritten: "this till was at Westlands
  -- until the 14th" is the question being asked when the numbers do not add up,
  -- and an overwritten field cannot answer it.
  ADD COLUMN IF NOT EXISTS previous_branch_id  uuid REFERENCES public.branches(id),
  ADD COLUMN IF NOT EXISTS branch_changed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS branch_change_count integer NOT NULL DEFAULT 0,

  -- Set by a manager to permit ONE move. Cleared when the move is taken up.
  -- A relocation is a legitimate, occasional act; it should be possible without
  -- a developer, and impossible without somebody accountable.
  ADD COLUMN IF NOT EXISTS rebind_allowed_until timestamptz,
  ADD COLUMN IF NOT EXISTS rebind_authorised_by uuid;

COMMENT ON COLUMN public.user_devices.branch_id IS
  'The branch this terminal is bound to, held server-side. The till also carries a branch_id in its own config, but that travels with the machine; this does not. A mismatch is what identifies a terminal that has been moved.';
COMMENT ON COLUMN public.user_devices.rebind_allowed_until IS
  'A manager-granted window during which this device may bind to a different branch. Outside it, a branch change is refused. Relocation is legitimate; silent relocation is not.';

-- ─── Terminal codes unique per branch ───────────────────────────────────────
-- Scoped to the BRANCH, not the business: 'T1' at Westlands and 'T1' at Karen
-- are two sensible names for two machines, and forcing globally unique codes
-- across a chain would push staff toward codes nobody can read off a screen.
--
-- Partial on approved + non-null so pending and rejected registrations, and the
-- existing rows with no code, do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS user_devices_terminal_code_unique
  ON public.user_devices (business_id, branch_id, upper(terminal_code))
  WHERE status = 'approved' AND terminal_code IS NOT NULL AND branch_id IS NOT NULL;

-- One registration per physical device per business. device_id is the UUID the
-- till generates once at setup; a second row for the same one means a duplicate
-- registration, and the fleet view would then show a terminal twice.
CREATE UNIQUE INDEX IF NOT EXISTS user_devices_device_id_unique
  ON public.user_devices (business_id, device_id)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_devices_branch_idx
  ON public.user_devices (business_id, branch_id, status);

-- ─── Report on what is already ambiguous ────────────────────────────────────
-- Does not fail the migration. Duplicates that already exist are history, and
-- refusing to apply the fix because the problem exists would be perverse.
DO $$
DECLARE dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT business_id, device_id FROM public.user_devices
     WHERE device_id IS NOT NULL
     GROUP BY business_id, device_id HAVING count(*) > 1
  ) d;

  IF dupes > 0 THEN
    RAISE WARNING 'migration 52: % duplicate device registration(s) already present. The unique index above will not have been created — resolve them and re-run.', dupes;
  ELSE
    RAISE NOTICE 'migration 52: device-branch binding in place; no duplicate registrations.';
  END IF;
END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('52_device_branch_binding',
        'Binds a terminal to a branch server-side so a physically relocated till cannot keep reporting to its old branch, with a manager-granted rebind window and retained relocation history. Makes terminal_code unique per branch and device_id unique per business. Enforcement fails open until a device first reports a branch, then closed.')
ON CONFLICT (version) DO NOTHING;
