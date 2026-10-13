-- Migration 130 — A455: the money books (cash, M-Pesa …) have the movements the tills do not record (2026-10-12)
--
-- Owner, 2026-10-12, sending the clients' own monthly workbooks (their "Cash Usage" and "Mpesa Usage" sheets): "I want to
-- be able to generate such reports from the system"; managers record them ("3 manager can record").
--
-- The monthly pack's money book for a method (cash, M-Pesa, bank …) takes that method's sales and the expenses paid with it
-- from what the tills and the web already record. What no till records is kept here, one row per movement:
--   kind  opening       the book's balance carried in at the start of a month (set once per month and method)
--         other_income  money in that is not a sale (e.g. used cooking oil sold)
--         drawing       the owner's personal use ("Personal")
--         bank_deposit  money banked out of this method
--         charges       charges taken by the method (M-Pesa charges, bank charges)
--   method       a payment-method code (cash, mpesa, card, bank …)
--   amount       always positive; the kind gives the direction
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.money_movements (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id        uuid          NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  movement_date    date          NOT NULL,
  method           text          NOT NULL,
  kind             text          NOT NULL,
  amount           numeric(12,2) NOT NULL,
  note             text,
  recorded_by      uuid,
  recorded_by_name text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT money_movements_kind_check   CHECK (kind IN ('opening', 'other_income', 'drawing', 'bank_deposit', 'charges')),
  CONSTRAINT money_movements_amount_check CHECK (amount > 0 OR (kind = 'opening' AND amount >= 0)),
  CONSTRAINT money_movements_method_check CHECK (method ~ '^[a-z0-9_]{1,40}$')
);
CREATE INDEX IF NOT EXISTS money_movements_branch_date ON public.money_movements (business_id, branch_id, movement_date);
ALTER TABLE public.money_movements ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.money_movements IS
  'A455: money in or out of a payment method that no till records (opening balance, other income, drawings, bank deposits, charges) — the monthly pack''s money books.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('130_money_movements', 'A455: money movements for the monthly pack''s cash / M-Pesa books (opening, other income, drawings, bank deposits, charges)')
ON CONFLICT (version) DO NOTHING;
