-- =============================================================================
-- SwiftPOS — payment_exceptions table (audit H8)
-- =============================================================================
-- M-Pesa callback amount mismatches (underpayment, tampered/forged callback)
-- were only ever a console.error — invisible unless someone was watching
-- server logs at the exact moment. This gives it a home a dashboard view can
-- read from. RLS follows the same owner_all convention migration 29 (C1)
-- established for every other tenant-scoped table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS payment_exceptions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  payment_id       UUID REFERENCES payments(id) ON DELETE SET NULL,
  order_id         UUID REFERENCES orders(id) ON DELETE SET NULL,
  checkout_id      TEXT,
  expected_amount  NUMERIC(12,2),
  received_amount  NUMERIC(12,2),
  reason           TEXT NOT NULL,
  resolved_at      TIMESTAMPTZ,
  resolved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_notes TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_exceptions_business  ON payment_exceptions(business_id);
CREATE INDEX IF NOT EXISTS idx_payment_exceptions_unresolved ON payment_exceptions(business_id) WHERE resolved_at IS NULL;

ALTER TABLE public.payment_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.payment_exceptions;
CREATE POLICY owner_all ON public.payment_exceptions FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
);
