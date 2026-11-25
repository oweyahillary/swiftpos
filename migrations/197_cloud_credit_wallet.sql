-- Migration 197 — the cloud credit wallet: over/underpayments and prepaid held per client (A626 Phase 2b)
--
-- Owner, 2026-11-25: when a client pays less, the admin allocates; when more, the system keeps the balance for future
-- allocations. (docs/tasks/A626-paybill-cloud-billing.md). A matched payment settles the client's open cloud invoices
-- oldest-first through the existing branch-payment engine; the remainder (an overpayment, or an underpayment that cannot
-- yet cover an invoice) is held here and auto-applies once it covers one, or the admin allocates it.
--
-- balance never goes negative (a settlement only spends what the wallet holds). The ledger explains every change.
--
-- Additive, idempotent, reversible: DROP the two tables.

CREATE TABLE IF NOT EXISTS public.business_cloud_credit (
  business_id uuid          PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  balance     numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency    text          NOT NULL DEFAULT 'KES',
  updated_at  timestamptz   NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.business_cloud_credit IS
  'A626: a prepaid cloud-billing balance per client (overpayment surplus, or an underpayment held for allocation). Service role only.';

CREATE TABLE IF NOT EXISTS public.cloud_credit_entries (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  delta       numeric(12,2) NOT NULL,
  reason      text          NULL,
  receipt_id  uuid          NULL REFERENCES public.cloud_billing_receipts(id) ON DELETE SET NULL,
  created_by  text          NULL,
  created_at  timestamptz   NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.cloud_credit_entries IS
  'A626: the cloud credit ledger — a payment in (+), an invoice settled from credit (-), an admin adjustment. Service role only.';
CREATE INDEX IF NOT EXISTS cloud_credit_entries_business ON public.cloud_credit_entries (business_id, created_at DESC);

ALTER TABLE public.business_cloud_credit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_credit_entries  ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.business_cloud_credit FROM anon, authenticated;
  REVOKE ALL ON public.cloud_credit_entries  FROM anon, authenticated;
EXCEPTION WHEN others THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('197_cloud_credit_wallet', 'A626 Phase 2b: cloud credit wallet (business_cloud_credit + cloud_credit_entries ledger) — over/underpayments and prepaid held per client')
ON CONFLICT (version) DO NOTHING;
