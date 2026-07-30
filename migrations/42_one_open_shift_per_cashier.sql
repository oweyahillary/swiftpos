-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 42 — One open shift per cashier, business-wide
--
-- Split out of migration 41 deliberately. 41 is purely additive; this file adds
-- a UNIQUE INDEX, which can reject a write, and that difference decides when it
-- is safe to apply.
--
-- ⚠ DO NOT APPLY UNTIL /api/sync/push UPSERTS SHIFTS PER ROW.
--
--   The endpoint batch-upserts: supabase.from('shifts').upsert(rows). One row
--   violating this index fails the WHOLE call — shifts, floats and expenses
--   together — and syncEngine retries it forever. A till in that state cannot
--   sync anything at all.
--
--   Worse, push deliberately forces status='open' on every row and lets
--   reconcileClosedShifts() close it afterwards (shifts push before their
--   orders). So a shift the pre-flight below demotes to 'closed_unreconciled'
--   gets RE-UPSERTED AS OPEN on the next sync — and if that cashier already
--   holds another open shift, the push dies. The fix is per-row upsert plus
--   translating 23505 into a shift flagged for manager attention.
--
-- WHY THE RULE EXISTS
--   A person can hold custody of one drawer at a time. Holding an unreconciled
--   shift on one terminal must therefore stop them opening another anywhere.
--   routes/shifts.ts already intended this, but its guard is application-level
--   and sync/push bypassed it entirely — an offline till pushed a second open
--   shift for the same cashier and nothing objected.
--
-- WHY IT BELONGS IN THE DATABASE
--   Three tills each hold their own SQLite database and cannot see each other's
--   drawers, so no client can enforce this. Only the shared database can. It is
--   the canonical statement of the rule; the clients enforce a local mirror for
--   responsiveness and must treat rejection here as authoritative.
--
-- Scoped to status='open'. A force-closed drawer is 'closed_unreconciled',
-- which is NOT in this index, so a manager clearing a forgotten shift releases
-- the cashier immediately.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-flight, then the index ───────────────────────────────────────────────
--
-- A person can only have custody of one drawer at a time, so holding an
-- unreconciled shift on one terminal must stop them opening another anywhere.
-- routes/shifts.ts already intended this, but its guard is application-level and
-- /api/sync/push bypasses it entirely — an offline till pushes a second open
-- shift for the same cashier and nothing objects. This puts the rule where it
-- cannot be bypassed.
--
-- Deliberately scoped to status='open'. A force-closed drawer is
-- 'closed_unreconciled', which is NOT in this index, so a manager clearing a
-- forgotten shift releases the cashier immediately.
--
-- PRE-FLIGHT: existing data may already violate this — that is precisely the
-- defect being closed, so assume it does. CREATE UNIQUE INDEX would abort the
-- whole migration on a cryptic constraint violation, so resolve it first and say
-- so out loud. Older duplicates are demoted to 'closed_unreconciled' because
-- that is the honest description of what they are: drawers nobody ever counted.
-- The alternative — inventing a closing_float — would fabricate a reconciliation
-- that never happened.

DO $$
DECLARE
  demoted integer;
BEGIN
  WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY business_id, cashier_id ORDER BY opened_at DESC) AS rn
      FROM public.shifts
     WHERE status = 'open'
  )
  UPDATE public.shifts s
     SET status       = 'closed_unreconciled',
         close_method = 'forced',
         closed_at    = COALESCE(s.closed_at, now()),
         notes        = concat_ws(E'\n', s.notes,
                        'Auto-closed by migration 41: this cashier held more than one open shift. '
                        || 'Never counted — closing_float and cash_variance are intentionally NULL.')
    FROM ranked r
   WHERE s.id = r.id AND r.rn > 1;

  GET DIAGNOSTICS demoted = ROW_COUNT;
  IF demoted > 0 THEN
    RAISE NOTICE 'migration 41: demoted % duplicate open shift(s) to closed_unreconciled. Review them — each is a drawer that was never counted.', demoted;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_cashier
  ON public.shifts (business_id, cashier_id)
  WHERE status = 'open';


INSERT INTO public.schema_migrations (version, notes)
VALUES ('42_one_open_shift_per_cashier',
        'partial unique index shifts(business_id, cashier_id) WHERE status=open; pre-flight demotes older duplicate open shifts to closed_unreconciled. Requires per-row upsert in /api/sync/push.')
ON CONFLICT (version) DO NOTHING;
