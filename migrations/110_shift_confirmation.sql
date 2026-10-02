-- Migration 110 — a manager confirms every cashier's shift, on every payment method (A365, 2026-09-29)
--
-- Owner, 2026-09-29: "a manager should be able to confirm end shift count when a cashier closes their shift and also
-- close day … the managers should confirm shift before closing the day … it should block they have to confirm shifts.
-- They should recount incase the cashier submitted less than the amount … applies to both [till and web] … on all
-- payment method not just mpesa".
--
-- The cashier now DECLARES every method at End Shift (cash counted, M-Pesa, card and the others from their slips);
-- a manager later RECOUNTS every method blind. Both figures are kept; the manager's are the confirmed ones.
--
--   declared_methods   {"cash": 5500, "mpesa": 3250, …}  the cashier's declaration at close (NULL = closed before 110)
--   expected_methods   what the system recorded for each method when the manager confirmed (cash = expected cash)
--   confirmed_methods  the manager's blind recount
--   confirmed_by / confirmed_at   who confirmed and when (the till's replay carries the till's own time)
--   confirm_self       the manager confirmed a shift they worked themselves — allowed, but flagged (owner's call)
--
-- A shift with declared_methods set and confirmed_at NULL is "awaiting manager check"; a till refuses to close its
-- trading day while one is. Shifts closed before this migration (declared_methods NULL) are never awaited.
-- Additive and idempotent; nothing existing changes.

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS declared_methods  jsonb,
  ADD COLUMN IF NOT EXISTS expected_methods  jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_methods jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_by      uuid,
  ADD COLUMN IF NOT EXISTS confirmed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS confirm_self      boolean NOT NULL DEFAULT false;

ALTER TABLE public.shifts
  DROP CONSTRAINT IF EXISTS shifts_confirmed_by_fkey;
ALTER TABLE public.shifts
  ADD CONSTRAINT shifts_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- A confirmation is whole: who, when and the recount, or none of them.
ALTER TABLE public.shifts
  DROP CONSTRAINT IF EXISTS shifts_confirmation_whole;
ALTER TABLE public.shifts
  ADD CONSTRAINT shifts_confirmation_whole CHECK (
    (confirmed_at IS NULL AND confirmed_methods IS NULL)
    OR (confirmed_at IS NOT NULL AND confirmed_methods IS NOT NULL)
  );

-- The dashboard's "awaiting manager check" list.
CREATE INDEX IF NOT EXISTS shifts_awaiting_confirmation
  ON public.shifts (business_id, closed_at DESC)
  WHERE declared_methods IS NOT NULL AND confirmed_at IS NULL;

COMMENT ON COLUMN public.shifts.declared_methods IS
  'A365: the cashier''s declaration at End Shift, per payment method code ({"cash": n, "mpesa": n, …}). NULL = closed before migration 110.';
COMMENT ON COLUMN public.shifts.confirmed_methods IS
  'A365: the manager''s blind recount per payment method. Set with confirmed_at/confirmed_by; the confirmed figures.';
COMMENT ON COLUMN public.shifts.expected_methods IS
  'A365: what the system recorded per payment method when the manager confirmed (cash = expected cash in the drawer).';
COMMENT ON COLUMN public.shifts.confirm_self IS
  'A365: the manager confirmed a shift they worked themselves — allowed, shown as self-confirmed.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('110_shift_confirmation', 'A365: a manager confirms every shift (blind recount per payment method); the cashier declares every method')
ON CONFLICT (version) DO NOTHING;
