-- =============================================================================
-- 86_payment_methods.sql
--
-- CORRECTION (A128, 2026-08-18): the notes below say `payments.method` is "a free
-- string on the order, never an FK, so nothing breaks either way." That is only
-- half true and it cost us the "custom-method sales don't sync" bug. method is not
-- an FK, but it WAS value-CHECK-constrained (`payments_method_check`: cash | mpesa |
-- card | credit | glovo) and only varchar(20), so a custom code failed the cloud
-- INSERT (23514 / 22001) and the till parked the order forever. Migration 89 makes
-- this claim true — free-text `code`, format-checked, varchar(40). This SQL is
-- unchanged (it is applied); the note stands only so the next reader is not misled.
--
-- Custom payment methods, per business (register A95 / #4).
--
-- The built-in tenders (cash, M-Pesa, card) stay in code; this table holds the
-- EXTRA ones a business defines — "Coop Card", "Airtel Money", a house account —
-- so they can be offered at the POS and show up by name in the payment-method
-- breakdown (which already groups /sales by the leg's `method` string).
--
-- `code` is the value written to payments.method for a sale on this method, so it
-- is stable and unique per business; `name` is the display label and can change.
-- All custom methods are NON-CASH for reconciliation — only method='cash' affects
-- expected drawer cash — so no flag is needed here (owner decision, A95).
--
-- is_active lets a method be retired without deleting it, so historical orders
-- that used it keep reporting correctly (method is a free string on the order,
-- never an FK, so nothing breaks either way).
--
-- REVERT:  DROP TABLE IF EXISTS public.payment_methods;
--
-- public.-qualified for search_path safety (A62).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.payment_methods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name        varchar(60)  NOT NULL,
  code        varchar(40)  NOT NULL,
  is_active   boolean      NOT NULL DEFAULT true,
  sort_order  integer      NOT NULL DEFAULT 0,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT payment_methods_business_code_key UNIQUE (business_id, code)
);

CREATE INDEX IF NOT EXISTS payment_methods_business_idx
  ON public.payment_methods (business_id) WHERE is_active;

-- RLS, same owner_all shape as every other business-scoped table (migration 47).
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.payment_methods;
CREATE POLICY owner_all ON public.payment_methods FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
);

INSERT INTO public.schema_migrations (version, notes)
VALUES ('86_payment_methods',
        'A95 / #4. Custom payment methods per business: id, business_id (FK businesses ON DELETE CASCADE), name, code (UNIQUE per business, written to payments.method), is_active, sort_order. Built-ins (cash/mpesa/card) stay in code; this holds the extras. All non-cash for reconciliation. Additive, idempotent (IF NOT EXISTS).')
ON CONFLICT (version) DO NOTHING;
