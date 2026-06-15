-- ═════════════════════════════════════════════════════════════════════════════
-- SwiftPOS — Customer Credit Accounts (item 15)
-- Additive + idempotent. Fold into the consolidated migration once verified.
--
-- A customer can buy "on account" using the existing 'credit' payment method.
-- credit_limit caps how much they may owe; credit_balance is the running amount
-- owed (debits from credit sales, credits from repayments). Every movement is an
-- immutable row in customer_credit_transactions for audit + statements.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Customers: credit limit + running balance ────────────────────────────────
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS credit_limit   numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_balance numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.customers.credit_limit   IS 'Max amount the customer may owe. 0 = no credit allowed.';
COMMENT ON COLUMN public.customers.credit_balance IS 'Current amount owed. Increases on credit sale, decreases on repayment.';

-- ── Credit ledger (immutable audit trail) ────────────────────────────────────
-- type: 'charge'   -> credit sale, increases balance (debit to customer)
--       'payment'  -> repayment, decreases balance
--       'adjustment'-> manual correction (+/-), set by staff with a reason
CREATE TABLE IF NOT EXISTS public.customer_credit_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES public.customers(id)  ON DELETE CASCADE,
  branch_id      uuid REFERENCES public.branches(id)            ON DELETE SET NULL,
  order_id       uuid REFERENCES public.orders(id)              ON DELETE SET NULL,
  type           text NOT NULL CHECK (type IN ('charge','payment','adjustment')),
  amount         numeric(12,2) NOT NULL,        -- signed: + increases balance, - decreases
  balance_after  numeric(12,2) NOT NULL,        -- running balance snapshot after this row
  method         text,                          -- repayment method: cash/mpesa/card
  reference      text,                          -- M-Pesa code / cheque no / note
  notes          text,
  created_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_txn_customer ON public.customer_credit_transactions (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_txn_business ON public.customer_credit_transactions (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_txn_order    ON public.customer_credit_transactions (order_id);

-- ── Atomic balance change + ledger insert ────────────────────────────────────
-- Applies a signed delta to credit_balance and writes the ledger row in one
-- statement so concurrent charges/payments can't race. Enforces the credit
-- limit for positive deltas (charges) unless p_enforce_limit is false.
-- Returns the new balance, or raises 'CREDIT_LIMIT_EXCEEDED'.
CREATE OR REPLACE FUNCTION public.apply_credit_transaction(
  p_business_id   uuid,
  p_customer_id   uuid,
  p_branch_id     uuid,
  p_order_id      uuid,
  p_type          text,
  p_amount        numeric,   -- signed delta
  p_method        text,
  p_reference     text,
  p_notes         text,
  p_created_by    uuid,
  p_enforce_limit boolean DEFAULT true
)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_balance numeric;
  v_limit       numeric;
BEGIN
  SELECT credit_balance + p_amount, credit_limit
    INTO v_new_balance, v_limit
    FROM public.customers
   WHERE id = p_customer_id AND business_id = p_business_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
  END IF;

  IF p_enforce_limit AND p_amount > 0 AND v_new_balance > v_limit THEN
    RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED';
  END IF;

  IF v_new_balance < 0 THEN
    v_new_balance := 0;  -- never let an account go into credit (overpayment clamps)
  END IF;

  UPDATE public.customers
     SET credit_balance = v_new_balance, updated_at = now()
   WHERE id = p_customer_id;

  INSERT INTO public.customer_credit_transactions
    (business_id, customer_id, branch_id, order_id, type, amount, balance_after,
     method, reference, notes, created_by)
  VALUES
    (p_business_id, p_customer_id, p_branch_id, p_order_id, p_type, p_amount, v_new_balance,
     p_method, p_reference, p_notes, p_created_by);

  RETURN v_new_balance;
END;
$$;

-- ── Permission seeds for credit management ───────────────────────────────────
INSERT INTO public.permissions (key, label, module) VALUES
  ('customers.view',   'View customers & credit',   'Customers'),
  ('customers.manage', 'Manage customers & credit', 'Customers')
ON CONFLICT (key) DO NOTHING;

-- Grant both to manager-level roles (idempotent; no unique constraint on the
-- join table, so guard with NOT EXISTS).
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN ('customers.view','customers.manage')
WHERE lower(r.name) IN ('manager','supervisor','branch_manager','admin')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

COMMIT;
