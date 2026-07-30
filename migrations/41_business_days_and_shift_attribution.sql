-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 41 — Trading days, per-till shift attribution, forced-close status
--
-- Adds the two-level cash model the desktop tills enforce:
--
--   business_days   one row per TILL per trading date. Opens implicitly when the
--                   first cashier opens a drawer on that till that day; closes
--                   only when a MANAGER counts the cash and signs it off.
--   shifts          a cashier's own drawer session INSIDE a day. Several per
--                   till per day as staff hand over. Cashier opens and closes
--                   their own; no manager needed.
--
-- CASH IS TRACKED BY CUSTODY, NOT BY LOCATION
--   Sites move physical drawers between terminals and we have no control over
--   that. So no cash figure is ever inferred from where a drawer sits or from
--   the previous shift on the same till: opening_float is counted at open,
--   closing_float is counted at close, and each shift stands alone. A drawer
--   that moves mid-day, or is swapped out of the safe, changes nothing — the
--   episode is closed by a count and the next is opened by one.
--
-- The gate that matters: a till whose previous day is still open cannot open a
-- new shift and cannot sell. Only a manager clears it. Enforcement lives on the
-- device (each till holds its own SQLite copy and works offline); this schema is
-- where the record lands once it syncs.
--
-- WHY business_days IS KEYED ON THE TILL, NOT THE BRANCH
--   Each terminal runs a standalone SQLite database and only ORDERS traverse the
--   branch LAN (POST /node/orders). Shift and drawer state never leaves the
--   machine that owns it, so one till cannot observe another's drawer. A
--   branch-wide day would therefore have to be read from the aggregation node —
--   which is itself just a till PC. If it were switched off, all three tills
--   would block. That is an outage, not a control. The drawer is also the thing
--   actually being reconciled, so the till is the correct grain.
--
-- THREE EXISTING DEFECTS THIS ALSO CLOSES
--   1. shifts carried no device_id. With three tills per branch, three drawers
--      arrived here distinguishable only by cashier — so one person covering two
--      tills in a day produced an unattributable reconciliation.
--   2. shifts_status_check admitted only 'open' and 'closed', but the desktop
--      writes 'closed_unreconciled' when a manager force-closes a drawer nobody
--      counted. It has not blown up only because /api/sync/push hard-codes
--      status 'open' on every row it upserts.
--   3. closed_by / close_method existed in the local SQLite schema and nowhere
--      here, so who force-closed a drawer, and whether anyone counted it, was
--      lost on sync.
--
-- PURELY ADDITIVE. Creates a table, adds columns, widens a CHECK, backfills
-- NULLs. Nothing here can reject a write, so it cannot break an existing client.
--
-- The one-open-shift-per-cashier rule was originally part of this file and has
-- been SPLIT OUT into migration 42, because it is a unique index and therefore
-- can reject a write — and /api/sync/push batch-upserts shifts, so a single
-- rejected row fails the whole push and the sync queue retries it forever. 42
-- must not be applied until that endpoint upserts per row and treats a rejection
-- as a reconcilable outcome rather than a transport error.
--
-- Idempotent. Safe to run on any environment.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. business_days ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.business_days (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL,
  branch_id      uuid NOT NULL,

  -- The physical terminal this trading day belongs to. TEXT, not a FK, to match
  -- orders.device_id: the id is minted on the device at install and a till may
  -- be reinstalled. NULL means a non-desktop surface (web POS).
  device_id      text,
  terminal_code  text,

  -- The LOCAL calendar date at the till. Deliberately computed on the device
  -- rather than derived from a timestamp here: businesses has no timezone
  -- column, and the terminal is physically in the shop, so its own clock is the
  -- authority on which trading day a sale belongs to.
  business_date  date NOT NULL,

  opened_at      timestamptz NOT NULL DEFAULT now(),
  opened_by      uuid,                       -- cashier whose first drawer opened it
  closed_at      timestamptz,
  closed_by      uuid,                       -- MUST be a manager; enforced on device

  status         text NOT NULL DEFAULT 'open',

  -- The manager's independent count at day close. This is the SECOND count of
  -- the day: each cashier already counted their own drawer blind at their close.
  -- Two counts by two people is the whole point — a single counter who can see
  -- the expected figure can quietly close a shortage to zero.
  counted_cash   numeric(12,2),
  expected_cash  numeric(12,2),
  cash_variance  numeric(12,2),

  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_days_status_check
    CHECK (status = ANY (ARRAY['open'::text, 'closed'::text]))
);

COMMENT ON TABLE public.business_days IS
  'One trading day per till. Opens with the first cashier drawer of the date; closes only on a manager cash count.';
COMMENT ON COLUMN public.business_days.business_date IS
  'Local calendar date at the terminal. Set by the device, not derived from opened_at.';
COMMENT ON COLUMN public.business_days.counted_cash IS
  'Manager''s verification count at day close — independent of the cashiers'' own drawer counts.';

-- One day row per till per date. COALESCE because device_id is nullable and
-- NULLs compare distinct in a unique index, which would let a web-POS branch
-- accumulate duplicate days for the same date.
CREATE UNIQUE INDEX IF NOT EXISTS business_days_till_date_uniq
  ON public.business_days (branch_id, COALESCE(device_id, ''), business_date);

-- The rule itself, in the database: a till may have only ONE open day at a time.
-- With this in place, "you cannot start a new day until yesterday's is closed"
-- cannot be defeated by a client that skips the check.
CREATE UNIQUE INDEX IF NOT EXISTS business_days_one_open_per_till
  ON public.business_days (branch_id, COALESCE(device_id, ''))
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS business_days_business_idx ON public.business_days (business_id);
CREATE INDEX IF NOT EXISTS business_days_branch_date_idx ON public.business_days (branch_id, business_date DESC);
CREATE INDEX IF NOT EXISTS business_days_status_idx ON public.business_days (status);

-- ── 2. shifts — day linkage, till attribution, close provenance ──────────────

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS business_day_id uuid,
  ADD COLUMN IF NOT EXISTS business_date   date,
  ADD COLUMN IF NOT EXISTS device_id       text,
  ADD COLUMN IF NOT EXISTS terminal_code   text,
  ADD COLUMN IF NOT EXISTS drawer_label    text,
  ADD COLUMN IF NOT EXISTS opened_by       uuid,
  ADD COLUMN IF NOT EXISTS closed_by       uuid,
  ADD COLUMN IF NOT EXISTS close_method    text;

COMMENT ON COLUMN public.shifts.device_id IS
  'Physical till that owns this drawer. NULL for web-POS shifts.';
COMMENT ON COLUMN public.shifts.close_method IS
  'counted = a human counted the drawer. forced = a manager ended it without a count; closing_float and cash_variance are NULL, never 0.';

-- WHY A DRAWER LABEL, AND WHY IT IS ONLY A LABEL
--   Sites move physical drawers between terminals — swapped at handover, taken
--   to the office to be counted, replaced from the safe — and we get no say in
--   that. So cash state is never inferred from where a drawer sits: a shift's
--   opening_float is COUNTED at open and its closing_float is COUNTED at close,
--   and no figure is ever carried over from the previous shift on the same till.
--   Each shift is therefore a self-contained custody episode and stays correct
--   under any drawer arrangement.
--
--   This column records which physical drawer the cashier had, as free text the
--   site labels itself. It is deliberately NOT a managed table with ids: that
--   would need setup we cannot rely on, and a wrong id is worse than a hand-typed
--   name. It buys nothing operationally and everything forensically — when a
--   variance shows up, whether the same drawer was involved each time is usually
--   the first question, and without this there is no way to answer it.
COMMENT ON COLUMN public.shifts.drawer_label IS
  'Site''s own name for the physical drawer used (e.g. "Drawer 2"). Free text: drawers move between tills and are not modelled as entities.';

-- Separates who took custody of the cash from who recorded the count. Where a
-- manager issues the float in dual presence, opened_by is the manager and
-- cashier_id is the person accountable for the drawer. NULL where one person did
-- both, which is the honest record for a site that cannot staff two.
COMMENT ON COLUMN public.shifts.opened_by IS
  'Who authorised/recorded the opening count, if not the cashier themselves.';

-- FK added separately so re-running on a database that already has it is a
-- no-op rather than an error (ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shifts_business_day_id_fkey'
  ) THEN
    ALTER TABLE public.shifts
      ADD CONSTRAINT shifts_business_day_id_fkey
      FOREIGN KEY (business_day_id) REFERENCES public.business_days(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shifts_close_method_check'
  ) THEN
    ALTER TABLE public.shifts
      ADD CONSTRAINT shifts_close_method_check
      CHECK (close_method IS NULL OR close_method = ANY (ARRAY['counted'::text, 'forced'::text]));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS shifts_business_day_idx ON public.shifts (business_day_id);
CREATE INDEX IF NOT EXISTS shifts_device_idx ON public.shifts (device_id);
CREATE INDEX IF NOT EXISTS shifts_business_date_idx ON public.shifts (business_date DESC);

-- ── 3. Admit the forced-close status ─────────────────────────────────────────
--
-- 'closed_unreconciled' is a THIRD state, not a flavour of 'closed', and it must
-- stay distinct forever: it means nobody counted the drawer. Anything that
-- averages variance, or reports a till as balanced, has to be able to exclude it.
-- Its closing_float and cash_variance are NULL rather than 0, because a zero
-- variance is a claim that somebody checked.

ALTER TABLE public.shifts DROP CONSTRAINT IF EXISTS shifts_status_check;
ALTER TABLE public.shifts
  ADD CONSTRAINT shifts_status_check
  CHECK (status = ANY (ARRAY['open'::text, 'closed'::text, 'closed_unreconciled'::text]));

-- ── 4. Backfill business_date on existing shifts ─────────────────────────────
--
-- Africa/Nairobi is hard-coded here and ONLY here: it is a one-off repair of
-- rows written before the device started stamping the column. Every new row
-- gets its date from the till's own clock. Existing deployments are Kenyan; if
-- that ever stops being true, this backfill is historical and inert rather than
-- a rule that keeps applying.

UPDATE public.shifts
   SET business_date = (opened_at AT TIME ZONE 'Africa/Nairobi')::date
 WHERE business_date IS NULL;

-- Existing shifts predate per-till attribution. Recover device_id where the
-- shift's orders agree on one terminal; leave it NULL where they don't rather
-- than guessing, since a wrong attribution is worse than an absent one.
UPDATE public.shifts s
   SET device_id = d.device_id
  FROM (
    SELECT shift_id, MIN(device_id) AS device_id
      FROM public.orders
     WHERE shift_id IS NOT NULL AND device_id IS NOT NULL
     GROUP BY shift_id
    HAVING COUNT(DISTINCT device_id) = 1
  ) d
 WHERE s.id = d.shift_id
   AND s.device_id IS NULL;

-- ── 5. RLS ───────────────────────────────────────────────────────────────────
-- Matches the owner_all pattern established in migration 29. The Express API
-- uses the service_role key and bypasses this entirely; the policy exists to
-- keep the anon key (which ships in every JS bundle) from reading the table.

ALTER TABLE public.business_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.business_days;
CREATE POLICY owner_all ON public.business_days FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
);

INSERT INTO public.schema_migrations (version, notes)
VALUES ('41_business_days_and_shift_attribution',
        'business_days (per till per date); shifts gains business_day_id/business_date/device_id/terminal_code/drawer_label/opened_by/closed_by/close_method; status admits closed_unreconciled. Additive only — one-open-per-cashier moved to 42.')
ON CONFLICT (version) DO NOTHING;
