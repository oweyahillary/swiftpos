-- Migration 109 — who RECORDED an expense (A361, 2026-09-28)
--
-- Owner, 2026-09-28: "expense should also capture who recorded it".
--
-- `paid_by` is who the money went out through. On the web it is an optional pick-list, often left blank, and it can be
-- changed later, so it never told you who entered the expense. `recorded_by` is stamped by the cloud from the signed-in
-- account (web) or from the till's signed-in staff (sync), and no route ever changes it afterwards.
--
-- Backfill: every till expense so far carried the till's signed-in staff as paid_by (the till never offered a pick),
-- and only the till's sync writes shift_id — so for rows WITH a shift_id, paid_by IS the recorder. Web rows (no
-- shift_id) stay NULL: nobody knows who typed them. Additive; nothing else changes.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS recorded_by uuid;

ALTER TABLE public.expenses
  DROP CONSTRAINT IF EXISTS expenses_recorded_by_fkey;
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;

UPDATE public.expenses
   SET recorded_by = paid_by
 WHERE recorded_by IS NULL AND shift_id IS NOT NULL AND paid_by IS NOT NULL;

COMMENT ON COLUMN public.expenses.recorded_by IS
  'A361: the staff member (users.id) who entered this expense — stamped by the cloud (web: the signed-in account; '
  'till sync: the till''s signed-in staff). Never set from a form, never edited. NULL = recorded before migration 109 on the web.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('109_expense_recorded_by', 'A361: expenses.recorded_by — who entered the expense, stamped by the cloud, never edited')
ON CONFLICT (version) DO NOTHING;
