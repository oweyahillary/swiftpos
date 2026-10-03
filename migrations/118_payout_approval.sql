-- Migration 118 — 0.6.37 (A388): who approved a cash-out or an expense (2026-10-03)
--
-- Owner, 2026-10-03: "Manager approve cashout and expense" — "Manager PIN on the spot": a cashier's pay-out (cash out of
-- the drawer) and every expense need a manager — signed in, or their PIN typed at the till / web POS at that moment
-- (the till checks it offline too). Who approved is kept with the record and shown on the Z-report.
--
-- public.float_transactions.approved_by / approved_by_name — the manager who approved a pay-out (float_out). NULL = a
--   pay-in, a rider's delivery fee (paid for the sale, not asked), or recorded before 0.6.37.
-- public.expenses.approved_by / approved_by_name — the manager who approved the expense. NULL = before 0.6.37, or
--   entered in the back office (Expenses), where the person entering it holds expenses.manage.
--
-- No foreign key on purpose: a till pushes what it approved offline, and an approver since removed must never get the
-- drawer's record refused (a refused pay-out is cash the cloud never sees). The name is kept for the same reason.
--
-- Additive and idempotent.

ALTER TABLE public.float_transactions
  ADD COLUMN IF NOT EXISTS approved_by      uuid,
  ADD COLUMN IF NOT EXISTS approved_by_name text;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS approved_by      uuid,
  ADD COLUMN IF NOT EXISTS approved_by_name text;

COMMENT ON COLUMN public.float_transactions.approved_by IS
  '118: the manager who approved this pay-out (PIN or signed in). NULL = a pay-in, a rider''s fee, or before 0.6.37.';
COMMENT ON COLUMN public.expenses.approved_by IS
  '118: the manager who approved this expense (PIN or signed in). NULL = before 0.6.37 or entered in the back office.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('118_payout_approval', '0.6.37: float_transactions/expenses.approved_by(+_name) — the manager who approved a cash-out or an expense')
ON CONFLICT (version) DO NOTHING;
