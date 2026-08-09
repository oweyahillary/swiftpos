-- ─────────────────────────────────────────────────────────────────────────────
-- Shifts become DRAWER SESSIONS bound to a terminal, not to a cashier.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────────
-- The system keyed shifts on cashier_id everywhere: /shifts/current, /shifts/open,
-- the sale's shift resolution, and the constraint shifts_one_open_per_cashier
-- (migration 42). A shift carried a device_id and terminal_code (migration 41
-- added them, clearly intending the terminal model) but nothing enforced them.
--
-- Consequence, with cashier A opened on T1 and B on T2, A walks to T2 and sells:
--   * /shifts/current on T2 finds A's shift BY CASHIER — returns the T1 shift.
--   * the sale is stamped with A's T1 shift_id.
--   * the money is physically in the T2 drawer.
-- So T1 reads short and T2 reads over, by the same amount, in different rooms.
-- Migration 41 built for the terminal model; migration 42 then contradicted it
-- with a per-cashier constraint. This migration realigns everything to the model
-- 41 intended, which is also the POS industry standard.
--
-- ── THE STANDARD MODEL (Microsoft Commerce "fixed till", and every major POS) ─
-- A shift/drawer session is associated with a specific REGISTER. It is not moved
-- between registers. Whoever is logged into a terminal sells into THAT terminal's
-- open session. The rules:
--   * one open session per terminal (not per cashier);
--   * a cashier logged into two terminals is in two sessions;
--   * multiple cashiers on one terminal share its one session — a login does not
--     open a new session, and a new session opens only by an explicit close;
--   * the money and the sales reconcile against the DRAWER, which is what a human
--     physically counts at night.
-- The cashier is still recorded on every sale (orders.cashier_id) and on the
-- session (opened_by / closed_by) for per-person reporting and accountability —
-- attribution to a person is a tag, reconciliation is against the drawer.
--
-- ── WHAT THIS CHANGES ────────────────────────────────────────────────────────
--   1. Replace the per-cashier open-shift constraint with a per-terminal one.
--   2. Backfill terminal identity on any legacy open shift so the new constraint
--      can be created without tripping over historical rows.
-- The application changes (resolve the sale's shift by terminal, open/close by
-- terminal, authorise close) ship alongside in shifts.ts and orders.ts.
-- ─────────────────────────────────────────────────────────────────────────────

-- A session's terminal key. device_id is minted on the desktop at install; the
-- web POS has none, so it falls back to a synthetic per-branch web terminal so
-- that web sales still reconcile to a single logical drawer rather than scatter.
-- COALESCE keeps the key non-null for the unique index.
CREATE OR REPLACE FUNCTION public.shift_terminal_key(
  p_device_id text, p_terminal_code text, p_branch_id uuid
)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(
    NULLIF(p_device_id, ''),
    NULLIF(p_terminal_code, ''),
    'web:' || p_branch_id::text
  );
$$;

-- ── 1. Backfill: give every OPEN shift a stable terminal key ─────────────────
-- Legacy open shifts may have null device_id/terminal_code. Without a key they
-- cannot participate in the per-terminal constraint. Assign the web fallback so
-- they remain valid and reconcile per branch.
UPDATE public.shifts
   SET terminal_code = COALESCE(NULLIF(terminal_code, ''), 'web:' || branch_id::text)
 WHERE status = 'open'
   AND COALESCE(NULLIF(device_id, ''), NULLIF(terminal_code, '')) IS NULL;

-- ── 2. Pre-flight: demote duplicate open sessions on the SAME terminal ───────
-- If two open shifts already share a terminal key (possible under the old
-- per-cashier model — A and B both open on T1), the newest is kept as the live
-- session and older ones are demoted to closed_unreconciled for a manager to
-- count. Same treatment migration 42 used for its own duplicates.
DO $$
DECLARE demoted integer;
BEGIN
  WITH keyed AS (
    SELECT id,
           public.shift_terminal_key(device_id, terminal_code, branch_id) AS tkey,
           row_number() OVER (
             PARTITION BY business_id, public.shift_terminal_key(device_id, terminal_code, branch_id)
             ORDER BY opened_at DESC
           ) AS rn
      FROM public.shifts
     WHERE status = 'open'
  )
  UPDATE public.shifts s
     SET status = 'closed_unreconciled'
    FROM keyed
   WHERE s.id = keyed.id
     AND keyed.rn > 1;
  GET DIAGNOSTICS demoted = ROW_COUNT;
  IF demoted > 0 THEN
    RAISE NOTICE 'shift-session migration: demoted % duplicate open session(s) sharing a terminal to closed_unreconciled. Each is a drawer to count.', demoted;
  END IF;
END $$;

-- ── 3. Swap the constraint: per-terminal, not per-cashier ────────────────────
DROP INDEX IF EXISTS public.shifts_one_open_per_cashier;

-- One open session per terminal per business. The terminal key is computed the
-- same way everywhere (function above), so the index and the app agree.
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_terminal
  ON public.shifts (
    business_id,
    public.shift_terminal_key(device_id, terminal_code, branch_id)
  )
  WHERE status = 'open';

COMMENT ON INDEX public.shifts_one_open_per_terminal IS
  'One open drawer session per terminal (fixed-till model). Replaces '
  'shifts_one_open_per_cashier — a cashier no longer carries a shift between '
  'terminals; whoever is on a terminal sells into that terminal''s session.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('63_shift_drawer_sessions',
        'Shifts become drawer sessions bound to a terminal (fixed-till model). '
        'Replaces per-cashier open-shift constraint with per-terminal. Backfills '
        'and demotes duplicate open sessions. Requires shifts.ts/orders.ts changes.')
ON CONFLICT (version) DO NOTHING;
