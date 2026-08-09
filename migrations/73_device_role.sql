-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 73 — Record what a terminal IS, not just that it exists
--
-- NUMBERED 73, NOT 72. Migrations 68 and 72 are absent from this repository and
-- 68 is known to exist in production (register A4). Reusing 72 would collide
-- with whatever is already applied there. Numbers are cheap; a collision on the
-- migration ledger is not.
--
-- ── THE GAP ─────────────────────────────────────────────────────────────────
-- `user_devices` records that a terminal exists, which branch it is bound to and
-- what build it runs. It does not record WHAT IT IS. The desktop has had three
-- roles since Phase 3 — deviceConfig.ts:26:
--
--     export type DeviceRole = 'till' | 'node' | 'office';
--
-- 'till'   sells, may also serve
-- 'node'   a till that also serves the branch
-- 'office' serves the branch and CANNOT sell — no drawer, no shift, no cash,
--          safe unattended, and not meant to consume an activation seat
--
-- None of that reaches the server. The till reports X-Schema-Version,
-- X-Device-Id and its app version, and nothing else. So the server cannot tell
-- a back-office box from the machine on the counter.
--
-- ── WHY IT MATTERS NOW ──────────────────────────────────────────────────────
-- 1. PHASE5 §4b hands a machine the branch's PIN hashes so tills can
--    authenticate staff with no internet. Nothing may cross that boundary until
--    the server can verify the caller is the branch's server (register A25).
--    Today the only available gate is "is a desktop", which every till passes.
--
-- 2. deviceConfig.ts states the server "counts only role='till'" for activation
--    seats. It cannot: there is no role to count. An office machine explicitly
--    should not consume a seat, and today nothing could tell.
--
-- 3. The fleet view shows every registered machine as a till, because that is
--    all a row can say.
--
-- ── isNodeRole, NOT role = 'node' ───────────────────────────────────────────
-- deviceConfig.ts warns: "Comparing against the literal 'node' anywhere else is
-- how office machines fall through cracks." Both 'node' and 'office' serve the
-- branch. Server-side checks must ask "does this machine serve?" (node OR
-- office), never "is this machine a node". The view below exists so that
-- question has one answer rather than being re-derived per query.
--
-- ── FAILS OPEN ──────────────────────────────────────────────────────────────
-- Existing rows get NULL, meaning "has not reported one yet", and are treated as
-- an ordinary till until they do. Defaulting them to 'till' would be a guess
-- that reads as a fact, and a branch server would then look like a counter
-- terminal until somebody noticed. NULL is honest and self-correcting: the next
-- sign-in fills it in.
--
-- A role is a CLAIM by the device, exactly as branch_id was before migration 52.
-- It is recorded here so it can be seen and, later, verified. Recording it is
-- not trusting it — see the comment on the column.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS device_role      text
    CHECK (device_role IS NULL OR device_role IN ('till', 'node', 'office')),
  ADD COLUMN IF NOT EXISTS role_reported_at timestamptz;

COMMENT ON COLUMN public.user_devices.device_role IS
  'What this terminal is: till (sells), node (sells and serves the branch), office (serves and CANNOT sell). NULL means it has not reported yet. This is a CLAIM by the device, recorded so it can be seen and audited — it is not on its own sufficient to authorise anything. Any check for "does this machine serve the branch" must accept node OR office; comparing against the literal node is how office machines fall through cracks.';

COMMENT ON COLUMN public.user_devices.role_reported_at IS
  'When device_role was last reported. A role that stops being refreshed is a machine that has been repurposed or retired.';

-- One index answering the question every caller actually asks: which machines
-- serve this branch? Partial, because serving machines are a handful per
-- business while tills are the bulk.
CREATE INDEX IF NOT EXISTS user_devices_serving_idx
  ON public.user_devices (business_id, branch_id)
  WHERE device_role IN ('node', 'office') AND status = 'approved';

-- The isNodeRole() helper, in SQL, so the node-or-office rule is written once.
-- A view rather than a function: it composes into other queries and needs no
-- privileges of its own.
--
-- DROP first, and NOT `CREATE OR REPLACE`. Replace may only APPEND columns to an
-- existing view — it can neither insert, reorder nor drop them. Migration 74
-- extends this view, so once 74 has run, re-running 73 with replace fails with
-- "cannot drop columns from view", and 74 itself failed with:
--
--   42P16: cannot change name of view column "is_view_only" to "role_confirmed_at"
--
-- Every migration in this repository is written to be safely re-runnable,
-- because only 20 of 66 record themselves in schema_migrations (register A4) and
-- re-running to be sure is therefore normal practice. A view that can only be
-- created once breaks that.
--
-- Deliberately NOT `DROP ... CASCADE`: if something ever comes to depend on this
-- view, that must fail loudly rather than quietly delete whatever it was.
--
-- CONSEQUENCE, stated because it is real: this file owns the SMALLER definition,
-- so running 73 on its own after 74 has applied reverts the view and loses the
-- confirmation columns. Recoverable — re-run 74 — and covered by a test, but if
-- you are re-running migrations by hand, run them in order.
DROP VIEW IF EXISTS public.branch_serving_devices;

CREATE VIEW public.branch_serving_devices AS
  SELECT id, business_id, branch_id, device_id, terminal_code, device_label,
         device_role, app_version, schema_version, last_seen_at, last_sync_at,
         role_reported_at, status,
         (device_role = 'office') AS is_view_only
    FROM public.user_devices
   WHERE device_role IN ('node', 'office')
     AND status = 'approved';

COMMENT ON VIEW public.branch_serving_devices IS
  'Terminals that serve their branch — node OR office. The SQL form of deviceConfig.isNodeRole(). is_view_only marks an office machine, which serves but cannot sell. Use this rather than testing device_role = ''node'' anywhere.';

-- ─── Report, do not fail ────────────────────────────────────────────────────
-- Matches migration 52's convention: describe what is already there rather than
-- refusing to apply because reality is untidy.
DO $$
DECLARE unreported integer; serving integer;
BEGIN
  SELECT count(*) INTO unreported
    FROM public.user_devices WHERE device_role IS NULL;
  SELECT count(*) INTO serving
    FROM public.user_devices WHERE device_role IN ('node', 'office');

  RAISE NOTICE 'migration 73: % device(s) have not reported a role yet (treated as ordinary tills until they do); % already serve their branch.',
    unreported, serving;
END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('73_device_role',
        'Records what a terminal IS (till / node / office) plus when it last said so, with a branch_serving_devices view as the SQL form of isNodeRole(). Prerequisite for PHASE5 credential distribution (A25) and for activation-seat counting, which cannot exclude office machines while no role exists. Existing rows are NULL — has not reported — rather than guessed as till. Numbered 73 because 72 is absent from the repo and may exist in production.')
ON CONFLICT (version) DO NOTHING;
