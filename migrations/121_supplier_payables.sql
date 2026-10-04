-- Migration 121 — A395: what the business owes its suppliers (2026-10-04)
--
-- Owner, 2026-10-04 (after the stock take): "Yes proceed" — supplier bills and payables, with returns to supplier.
-- Before: suppliers, purchase orders and goods received notes existed, but nothing recorded what was owed, what was
-- paid, or goods sent back.
--
-- public.supplier_bills — a supplier's invoice: amount, date, due date; optionally the delivery (GRN) it is for (at most
--   one bill per GRN). Voided, never deleted (and only while nothing is paid against it).
-- public.supplier_payments — money paid to a supplier: against one bill, or "on account" (bill_id NULL). Voided, never
--   deleted. Recording a payment here does NOT add an expense or touch a till drawer.
-- public.supplier_returns / supplier_return_items — goods sent back: the stock leaves the branch (a movement naming the
--   return) and the supplier owes a credit (credit_amount), which lowers the balance.
-- permission payables.manage — bills, payments and balances. Not granted by this migration: the owner's by default
--   (lib/defaultRolePermissions MANAGER_DENY); the owner can give it to a role.
--
-- A supplier's balance = open bills − payments − return credits (lib/payables.ts).
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.supplier_bills (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  supplier_id      uuid          NOT NULL REFERENCES public.suppliers(id),
  branch_id        uuid          REFERENCES public.branches(id),
  ref              text          NOT NULL,
  invoice_number   text,
  bill_date        date          NOT NULL DEFAULT CURRENT_DATE,
  due_date         date,
  amount           numeric(14,2) NOT NULL,
  grn_id           uuid          REFERENCES public.goods_received_notes(id),
  note             text,
  status           text          NOT NULL DEFAULT 'open',
  voided_at        timestamptz,
  voided_by_name   text,
  void_reason      text,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT supplier_bills_amount_check CHECK (amount > 0),
  CONSTRAINT supplier_bills_status_check CHECK (status IN ('open', 'void')),
  CONSTRAINT supplier_bills_due_check CHECK (due_date IS NULL OR due_date >= bill_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_bills_one_per_grn
  ON public.supplier_bills (grn_id) WHERE grn_id IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS supplier_bills_supplier ON public.supplier_bills (business_id, supplier_id, bill_date);
ALTER TABLE public.supplier_bills ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.supplier_payments (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  supplier_id      uuid          NOT NULL REFERENCES public.suppliers(id),
  bill_id          uuid          REFERENCES public.supplier_bills(id),
  amount           numeric(14,2) NOT NULL,
  method           text          NOT NULL,
  reference        text,
  paid_on          date          NOT NULL DEFAULT CURRENT_DATE,
  note             text,
  voided_at        timestamptz,
  voided_by_name   text,
  void_reason      text,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT supplier_payments_amount_check CHECK (amount > 0),
  CONSTRAINT supplier_payments_method_check CHECK (method IN ('cash', 'mpesa', 'bank', 'cheque', 'other'))
);
CREATE INDEX IF NOT EXISTS supplier_payments_supplier ON public.supplier_payments (business_id, supplier_id, paid_on);
CREATE INDEX IF NOT EXISTS supplier_payments_bill ON public.supplier_payments (bill_id) WHERE bill_id IS NOT NULL;
ALTER TABLE public.supplier_payments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.supplier_returns (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  supplier_id      uuid          NOT NULL REFERENCES public.suppliers(id),
  branch_id        uuid          NOT NULL REFERENCES public.branches(id),
  ref              text          NOT NULL,
  grn_id           uuid          REFERENCES public.goods_received_notes(id),
  return_date      date          NOT NULL DEFAULT CURRENT_DATE,
  reason           text,
  credit_amount    numeric(14,2) NOT NULL DEFAULT 0,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT supplier_returns_credit_check CHECK (credit_amount >= 0)
);
CREATE INDEX IF NOT EXISTS supplier_returns_supplier ON public.supplier_returns (business_id, supplier_id, return_date);
ALTER TABLE public.supplier_returns ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.supplier_return_items (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id      uuid          NOT NULL REFERENCES public.supplier_returns(id) ON DELETE CASCADE,
  item_kind      text          NOT NULL,
  product_id     uuid          REFERENCES public.products(id),
  ingredient_id  uuid          REFERENCES public.ingredients(id),
  name           text          NOT NULL,
  quantity       numeric(12,2) NOT NULL,
  unit_cost      numeric(12,2),
  CONSTRAINT supplier_return_items_kind_check CHECK (
    (item_kind = 'product'    AND product_id    IS NOT NULL AND ingredient_id IS NULL) OR
    (item_kind = 'ingredient' AND ingredient_id IS NOT NULL AND product_id    IS NULL)),
  CONSTRAINT supplier_return_items_qty_check CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS supplier_return_items_return ON public.supplier_return_items (return_id);
ALTER TABLE public.supplier_return_items ENABLE ROW LEVEL SECURITY;

INSERT INTO public.permissions (key, label, module, description)
VALUES ('payables.manage', 'Supplier bills & payments', 'inventory', 'Record supplier bills and payments; see what is owed (owner-only by default)')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.supplier_bills IS '121 (A395): a supplier''s invoice — what the business owes; optionally for one GRN.';
COMMENT ON TABLE public.supplier_payments IS '121 (A395): money paid to a supplier, against a bill or on account. Not an expense; not from a drawer.';
COMMENT ON TABLE public.supplier_returns IS '121 (A395): goods sent back to a supplier — stock out, and a credit against the balance.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('121_supplier_payables', 'A395: supplier_bills, supplier_payments, supplier_returns(+items), permission payables.manage')
ON CONFLICT (version) DO NOTHING;
