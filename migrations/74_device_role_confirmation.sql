-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 74 — Make a claimed role checkable (register A25 / D4)
--
-- Migration 73 let a terminal SAY what it is. This lets the server decide
-- whether to believe it, which is the difference between a diagnostic and a
-- security control.
--
-- ── WHY A CLAIM IS NOT ENOUGH ───────────────────────────────────────────────
-- `device_role` arrives in a header the till sets about itself. PHASE5 §4b wants
-- to hand the branch's PIN hashes to the machine that serves the branch, so
-- tills can authenticate staff with no internet. Gating that on an unverified
-- header would mean any till — and anyone who lifted an owner token off one —
-- could ask for the roster by claiming to be the node.
--
-- This is the same problem migration 52 solved for branch_id, and it is solved
-- the same way ON PURPOSE. A new trust mechanism would be a third thing to learn
-- and a third thing to get wrong.
--
-- ── TRUST ON FIRST USE, THEN CLOSED ─────────────────────────────────────────
-- The first device to claim 'node' or 'office' for a branch becomes that
-- branch's confirmed server. A DIFFERENT device claiming it afterwards is
-- refused and the conflict recorded — it is either a mistake or a machine
-- pretending, and both are worth seeing.
--
-- Confirmation is automatic rather than an owner clicking a button, and that is
-- deliberate: this product is aimed at remote sites with thin internet, where
-- "wait for the owner to open the dashboard" means the shop does not open. The
-- window below is how a legitimate change happens.
--
-- ── HANDOVER, INCLUDING FAILOVER ────────────────────────────────────────────
-- `role_change_allowed_until` mirrors `rebind_allowed_until` from migration 52:
-- a manager grants one window, the next claim inside it takes effect, and the
-- window is cleared. Without it a promoted till could never become the confirmed
-- server after the old node died, and failover would restore the branch's data
-- but not its ability to obtain credentials.
--
-- ── FAILS CLOSED, NOT OPEN ──────────────────────────────────────────────────
-- Note the direction, opposite to migration 52's branch binding. There, an
-- unbound device was allowed through, because refusing would have stopped a shop
-- trading over a diagnostic. Here, an unconfirmed device is refused CREDENTIALS,
-- because the cost of a wrong answer is the branch's PIN hashes rather than a
-- misattributed sale. Refusing costs a device offline authentication until
-- somebody confirms it; granting wrongly cannot be undone.
--
-- Nothing here affects selling. A refused device still trades, still syncs,
-- still serves its own tills over the LAN with the branch secret.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_devices
  -- When this device's SERVING role was confirmed for its branch. NULL means
  -- claimed but not confirmed — visible in the fleet view, trusted for nothing.
  ADD COLUMN IF NOT EXISTS role_confirmed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS role_confirmed_by         uuid,

  -- Manager-granted window permitting ONE handover. Cleared when taken up.
  ADD COLUMN IF NOT EXISTS role_change_allowed_until timestamptz,
  ADD COLUMN IF NOT EXISTS role_change_authorised_by uuid,

  -- Refused claims. Kept rather than counted: "which machine tried, and when"
  -- is the question asked when two boxes are fighting over one branch, and a
  -- counter cannot answer it.
  ADD COLUMN IF NOT EXISTS role_conflict_at          timestamptz,
  ADD COLUMN IF NOT EXISTS role_conflict_with        uuid;

COMMENT ON COLUMN public.user_devices.role_confirmed_at IS
  'When this device was confirmed as its branch''s server. NULL = claimed but unconfirmed: shown in the fleet view, trusted for nothing. Only a confirmed device may receive branch credentials (PHASE5 §4b).';
COMMENT ON COLUMN public.user_devices.role_change_allowed_until IS
  'A manager-granted window during which a DIFFERENT device may take over as this branch''s server. Mirrors rebind_allowed_until from migration 52. Required for failover: without it a promoted till could never become the confirmed server after the original died.';
COMMENT ON COLUMN public.user_devices.role_conflict_at IS
  'When this device last claimed a serving role that another confirmed device already held. A second machine claiming to be the branch server is either a mistake or an impersonation, and both are worth seeing.';

-- ─── One confirmed server per branch ────────────────────────────────────────
-- The guarantee, not merely the intention: two rows cannot both be confirmed for
-- one branch even if two requests race. Handover therefore clears the outgoing
-- device BEFORE setting the incoming one, so an interrupted handover leaves the
-- branch with NO confirmed server — credentials refused — rather than two.
-- Failing closed is the whole point of this migration.
CREATE UNIQUE INDEX IF NOT EXISTS user_devices_one_server_per_branch
  ON public.user_devices (business_id, branch_id)
  WHERE role_confirmed_at IS NOT NULL
    AND device_role IN ('node', 'office')
    AND status = 'approved';

CREATE INDEX IF NOT EXISTS user_devices_role_conflict_idx
  ON public.user_devices (business_id, role_conflict_at)
  WHERE role_conflict_at IS NOT NULL;

-- Extend migration 73's view so a caller can see confirmation without joining.
--
-- DROP first, and NOT `CREATE OR REPLACE`. Replace can only APPEND columns to a
-- view: the existing ones must keep their names, types and positions. Migration
-- 73's view ends with `is_view_only`, and the columns below are inserted before
-- it, so replace fails with:
--
--   42P16: cannot change name of view column "is_view_only" to "role_confirmed_at"
--
-- Grouping the confirmation columns with the other data columns, and keeping the
-- two derived booleans together at the end, is worth a drop — the alternative is
-- an ordering dictated by which migration happened to add what.
--
-- Safe here: nothing depends on this view. It was created by migration 73 and
-- nothing reads it yet. Deliberately NOT `DROP ... CASCADE` — if something does
-- come to depend on it later, this must fail loudly rather than quietly delete
-- whatever that was.
DROP VIEW IF EXISTS public.branch_serving_devices;

CREATE VIEW public.branch_serving_devices AS
  SELECT id, business_id, branch_id, device_id, terminal_code, device_label,
         device_role, app_version, schema_version, last_seen_at, last_sync_at,
         role_reported_at, status,
         role_confirmed_at, role_confirmed_by,
         role_change_allowed_until, role_conflict_at,
         (device_role = 'office')        AS is_view_only,
         (role_confirmed_at IS NOT NULL) AS is_confirmed
    FROM public.user_devices
   WHERE device_role IN ('node', 'office')
     AND status = 'approved';

COMMENT ON VIEW public.branch_serving_devices IS
  'Terminals that serve their branch — node OR office. The SQL form of deviceConfig.isNodeRole(). is_view_only marks an office machine, which serves but cannot sell. is_confirmed marks one the server has accepted as its branch''s server; only those may receive branch credentials. Use this rather than testing device_role = ''node'' anywhere.';

-- ─── Report, do not fail ────────────────────────────────────────────────────
DO $$
DECLARE serving integer; confirmed integer; contested integer;
BEGIN
  SELECT count(*) INTO serving
    FROM public.user_devices WHERE device_role IN ('node','office');
  SELECT count(*) INTO confirmed
    FROM public.user_devices WHERE role_confirmed_at IS NOT NULL;
  SELECT count(*) INTO contested FROM (
    SELECT business_id, branch_id FROM public.user_devices
     WHERE device_role IN ('node','office') AND status = 'approved'
     GROUP BY business_id, branch_id HAVING count(*) > 1
  ) c;

  RAISE NOTICE 'migration 74: % serving device(s), % confirmed. % branch(es) have more than one machine claiming to serve — the first to sync will be confirmed and the rest recorded as conflicts.',
    serving, confirmed, contested;
END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('74_device_role_confirmation',
        'Makes a claimed device role checkable: trust-on-first-use per branch, a manager-granted handover window mirroring migration 52 rebind (required for failover), recorded conflicts, and a unique index guaranteeing one confirmed server per branch. Fails CLOSED — unlike 52 branch binding — because the cost of a wrong answer here is the branch PIN hashes rather than a misattributed sale. Does not affect selling or syncing.')
ON CONFLICT (version) DO NOTHING;
