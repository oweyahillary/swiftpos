-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 51 — Parking tariffs, and parking that works offline
--
-- The parking module already exists and is closer to right than it looks:
-- parking_sessions, bays modelled as tables with slot_type='parking_bay', an
-- order_type of 'parking_session', and a nullable order_id on the session. That
-- last one matters — whoever wrote it understood that the SESSION is an accrual
-- and the ORDER is the sale, which is the correct separation and the thing this
-- migration builds on rather than replaces.
--
-- Three gaps stop it being sellable.
--
-- 1. IT CANNOT WORK OFFLINE. parking_sessions is absent from SYNC_DIRECTION and
--    has no local SQLite table, and POST /:id/close computes `new Date()` on the
--    SERVER. A gate booth in a basement — the worst connectivity in the whole
--    product — currently cannot bill anybody when the line drops. For a module
--    whose entire job is to take money at a barrier, that is disqualifying.
--
-- 2. THE PRICING MODEL IS ONE NUMBER. `rate_per_hour` with ceil() and a minimum
--    of one hour cannot express a grace period, a different first hour, a daily
--    maximum, a per-vehicle-class rate, or a lost-ticket fee. Every one of those
--    is standard at a Kenyan mall or county lot. Worst is the missing cap: a car
--    left for three days currently bills 72 hours, which no operator would issue
--    and no driver would pay. `vehicle_type` exists but changes nothing.
--
-- 3. NOTHING TIES IT TO CASH CONTROL. A session has no shift, no business day,
--    no device, no staff attribution. The day gate, blind cash count and
--    expected-cash work validated on the restaurant module simply does not
--    reach parking revenue.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
-- Adds a real tariff table, and the columns a session needs to be priced by the
-- TILL, offline, and audited afterwards. The arithmetic itself lives in
-- shared/parkingTariff.ts, in one implementation both sides run, because audit
-- H2 was caused by exactly two code paths pricing the same thing differently.
--
-- Additive. Existing sessions keep working on rate_per_hour until a tariff is
-- assigned; the pricing engine falls back to it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Tariffs ─────────────────────────────────────────────────────────────
-- Money in CENTS as integers, deliberately. The restaurant module stores money
-- as REAL in the till's SQLite and accumulates float dust that surfaces as an
-- unexplainable 0.01 drawer variance. Parking multiplies a rate by an increment
-- count, which is precisely where that compounds. Do not "simplify" these to
-- numeric later.

CREATE TABLE IF NOT EXISTS public.parking_tariffs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id               uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id                 uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  name                      text NOT NULL,

  -- Which vehicles this tariff prices. A session picks the tariff matching its
  -- vehicle_type; 'any' is the fallback so a lot can run a single tariff.
  vehicle_class             text NOT NULL DEFAULT 'any',

  -- Free-exit WINDOW, not a deduction. Leave inside it and pay nothing; stay one
  -- minute longer and you pay from entry. That is how every mall behaves, and
  -- the alternative gives a bill that jumps oddly at the boundary in a way no
  -- attendant can defend. It must be printed on the ticket.
  grace_minutes             integer NOT NULL DEFAULT 0,

  first_period_minutes      integer NOT NULL DEFAULT 60,
  first_period_price_cents  integer NOT NULL DEFAULT 0,
  increment_minutes         integer NOT NULL DEFAULT 60,
  increment_price_cents     integer NOT NULL DEFAULT 0,

  -- Ceiling per rolling 24h from entry, not per calendar day. A car in from
  -- 22:00 to 02:00 crossed midnight but was there four hours; charging it two
  -- days would be indefensible at the barrier.
  daily_cap_cents           integer,

  -- Overrides the ladder entirely. County street parking works this way.
  flat_daily_rate_cents     integer,

  lost_ticket_fee_cents     integer,

  active                    boolean NOT NULL DEFAULT true,
  sort_order                integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT parking_tariffs_vehicle_class_check
    CHECK (vehicle_class IN ('any','motorbike','car','van','lorry','bus')),
  -- Non-negative money and time. A negative increment price would make waiting
  -- profitable, which is the kind of thing that is only discovered in a queue.
  CONSTRAINT parking_tariffs_non_negative CHECK (
    grace_minutes >= 0 AND first_period_minutes >= 0 AND first_period_price_cents >= 0
    AND increment_minutes >= 1 AND increment_price_cents >= 0
    AND (daily_cap_cents       IS NULL OR daily_cap_cents       >= 0)
    AND (flat_daily_rate_cents IS NULL OR flat_daily_rate_cents >= 0)
    AND (lost_ticket_fee_cents IS NULL OR lost_ticket_fee_cents >= 0)
  )
);

CREATE INDEX IF NOT EXISTS parking_tariffs_lookup_idx
  ON public.parking_tariffs (business_id, branch_id, vehicle_class, active);

ALTER TABLE public.parking_tariffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.parking_tariffs;
CREATE POLICY owner_all ON public.parking_tariffs FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
);

-- ─── 2. Sessions ────────────────────────────────────────────────────────────

ALTER TABLE public.parking_sessions
  -- Which tariff, and THE RULES THEMSELVES frozen at entry.
  --
  -- The snapshot is the important one. A manager who raises the rate at 14:00
  -- must not retroactively reprice a car that entered at 09:00, and the till
  -- must be able to close a session with no network and no tariff table. It is
  -- also what makes a disputed bill answerable: the rules that produced the
  -- number are stored beside the number, so "why is it 500?" has an answer in
  -- the row rather than in whatever the tariff happens to say today.
  ADD COLUMN IF NOT EXISTS tariff_id           uuid REFERENCES public.parking_tariffs(id),
  ADD COLUMN IF NOT EXISTS tariff_snapshot     jsonb,

  -- The computed breakdown, so the receipt and any later dispute read the same
  -- lines the engine produced rather than re-deriving them.
  ADD COLUMN IF NOT EXISTS price_lines         jsonb,
  ADD COLUMN IF NOT EXISTS total_cents         integer,

  ADD COLUMN IF NOT EXISTS lost_ticket         boolean NOT NULL DEFAULT false,

  -- Cash-control attribution, matching shifts and business_days.
  ADD COLUMN IF NOT EXISTS device_id           uuid,
  ADD COLUMN IF NOT EXISTS opened_by           uuid,
  ADD COLUMN IF NOT EXISTS closed_by           uuid,

  -- ── CLOCK TRUST ──────────────────────────────────────────────────────────
  -- Offline pricing means the DEVICE clock decides the bill, and a device clock
  -- can be wound back. That cannot be prevented at a disconnected barrier, so it
  -- is made VISIBLE instead: the till stamps its own clock, the server records
  -- when the row actually arrived, and the difference is computed on sync.
  -- A till reporting a consistent negative skew is a report, not an alarm — but
  -- it is a report that currently could not exist at all.
  ADD COLUMN IF NOT EXISTS synced_at           timestamptz,
  ADD COLUMN IF NOT EXISTS clock_skew_seconds  integer;

COMMENT ON COLUMN public.parking_sessions.tariff_snapshot IS
  'The tariff rules frozen at entry. Pricing reads this, never the live tariff row, so a mid-session rate change cannot reprice a car already parked and a disputed bill can be reconstructed exactly.';
COMMENT ON COLUMN public.parking_sessions.clock_skew_seconds IS
  'Device clock minus server clock at sync. Offline pricing trusts the device clock; this makes tampering and drift visible after the fact, since neither can be prevented at a disconnected barrier.';
COMMENT ON COLUMN public.parking_sessions.total_cents IS
  'Authoritative integer-cent total. total_amount is kept in step for existing reports but is the derived figure, not the source.';

CREATE INDEX IF NOT EXISTS parking_sessions_open_idx
  ON public.parking_sessions (business_id, branch_id, status)
  WHERE status = 'open';

-- ─── 3. Seed a sensible default tariff per parking business ─────────────────
-- A module that requires configuration before it can take a single shilling
-- gets configured wrong at 6am on opening day. This is a working mall-style
-- tariff (15 min grace, 100 first hour, 50/hr after, 500 daily cap, 1000 lost
-- ticket) that an operator can trade on immediately and adjust later.

INSERT INTO public.parking_tariffs
  (business_id, name, vehicle_class, grace_minutes,
   first_period_minutes, first_period_price_cents,
   increment_minutes, increment_price_cents,
   daily_cap_cents, lost_ticket_fee_cents)
SELECT b.id, 'Standard', 'any', 15, 60, 10000, 60, 5000, 50000, 100000
FROM public.businesses b
WHERE b.type = 'parking'
  AND NOT EXISTS (
    SELECT 1 FROM public.parking_tariffs t WHERE t.business_id = b.id
  );

-- ─── 4. Backfill existing sessions ──────────────────────────────────────────
-- Give closed sessions a snapshot describing what they were ACTUALLY priced
-- under — the old flat rate_per_hour with ceil and a one-hour minimum — rather
-- than the new default, which would misrepresent history.
UPDATE public.parking_sessions s
   SET tariff_snapshot = jsonb_build_object(
         'legacy',                   true,
         'grace_minutes',            0,
         'first_period_minutes',     60,
         'first_period_price_cents', (s.rate_per_hour * 100)::integer,
         'increment_minutes',        60,
         'increment_price_cents',    (s.rate_per_hour * 100)::integer,
         'daily_cap_cents',          NULL,
         'flat_daily_rate_cents',    NULL,
         'lost_ticket_fee_cents',    NULL
       ),
       total_cents = COALESCE((s.total_amount * 100)::integer, 0)
 WHERE tariff_snapshot IS NULL;

DO $$
DECLARE tariffs integer; sessions integer;
BEGIN
  SELECT count(*) INTO tariffs  FROM public.parking_tariffs;
  SELECT count(*) INTO sessions FROM public.parking_sessions WHERE tariff_snapshot IS NULL;
  RAISE NOTICE 'migration 51: % tariff(s); % session(s) without a snapshot (expect 0).', tariffs, sessions;
  IF sessions > 0 THEN
    RAISE EXCEPTION 'migration 51: % session(s) left without a tariff snapshot.', sessions;
  END IF;
END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('51_parking_tariffs',
        'Parking tariff table (integer cents, grace window, first-period ladder, rolling-24h daily cap, flat-daily mode, lost-ticket fee) plus session columns for offline pricing: frozen tariff snapshot, computed price lines, device/staff attribution and clock-skew recording. Arithmetic lives in shared/parkingTariff.ts, one implementation run by both the server and the till.')
ON CONFLICT (version) DO NOTHING;
