-- ═════════════════════════════════════════════════════════════════════════════
-- SwiftPOS — eTIMS (KRA fiscalisation) — Phase 1 schema
-- Additive + idempotent. Fold into the consolidated migration once verified.
--
-- eTIMS is per-taxpayer: each business fiscalises under its own KRA PIN
-- (businesses.tax_pin) and a control unit (OSCU/VSCU) registered per branch.
-- Column names ending in KRA terms (bhf_id, cmc_key, sdc_id) map to the OSCU/
-- VSCU v2.0 spec so the provider adapter lines up 1:1 when implemented.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Products: KRA per-line tax classification (required on every invoice line) ─
-- tax_type: KRA tax category code (e.g. A=Exempt, B=16%, C=Zero-rated, D=Non-VAT,
--   E=8%). Stored as a code; the rate mapping lives in the eTIMS provider/config
--   so we never hard-code a rate that KRA later changes.
-- kra_item_class_code: KRA item classification code for the product.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS tax_type            text DEFAULT 'B',
  ADD COLUMN IF NOT EXISTS kra_item_class_code text;

-- ── Businesses: onboarding status flag ───────────────────────────────────────
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS etims_onboarded boolean NOT NULL DEFAULT false;

-- ── Per-branch control unit registration ─────────────────────────────────────
-- One row per branch once its control unit is registered with KRA.
CREATE TABLE IF NOT EXISTS public.etims_branch_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL UNIQUE REFERENCES public.branches(id) ON DELETE CASCADE,
  environment     text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','production')),
  mode            text NOT NULL DEFAULT 'vscu'    CHECK (mode IN ('vscu','oscu')),
  bhf_id          text,                 -- KRA branch (headquarter) id, e.g. '00'
  device_serial   text,                 -- dvcSrlNo registered with KRA
  cmc_key         text,                 -- communication key — STORE ENCRYPTED AT REST
  sdc_id          text,                 -- assigned SDC id (returned after init)
  last_invoice_no integer NOT NULL DEFAULT 0,  -- our per-branch invoice counter
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','registered','disabled')),
  registered_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_etims_branch_config_business ON public.etims_branch_config (business_id);

-- ── Fiscal invoice ledger (audit trail KRA expects you to retain) ────────────
-- One row per fiscalisation attempt for an order. A void produces a separate
-- 'credit' row referencing the original 'sale' row (KRA same-solution rule).
CREATE TABLE IF NOT EXISTS public.etims_invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id         uuid NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  order_id          uuid NOT NULL REFERENCES public.orders(id)     ON DELETE CASCADE,
  invoice_type      text NOT NULL DEFAULT 'sale' CHECK (invoice_type IN ('sale','credit')),
  original_invoice_id uuid REFERENCES public.etims_invoices(id),  -- set on credit notes
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','signed','failed','skipped')),
  invoice_no        integer,            -- our per-branch sequential number
  kra_receipt_no    text,               -- curRcptNo / rcptNo from KRA
  kra_internal_data text,               -- intrlData
  kra_signature     text,               -- rcptSign
  qr_payload        text,               -- QR content to render on the receipt
  request_payload   jsonb,              -- exactly what we sent (audit)
  response_payload  jsonb,              -- exactly what KRA returned (audit)
  error             text,
  retry_count       integer NOT NULL DEFAULT 0,
  sent_at           timestamptz,
  signed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_etims_invoices_order    ON public.etims_invoices (order_id);
CREATE INDEX IF NOT EXISTS idx_etims_invoices_status   ON public.etims_invoices (business_id, status);
CREATE INDEX IF NOT EXISTS idx_etims_invoices_branch   ON public.etims_invoices (branch_id, created_at DESC);

-- Per-business eTIMS on/off lives in the existing feature_flags table as data:
--   INSERT INTO feature_flags (business_id, key, enabled) VALUES (<biz>, 'etims_enabled', true);

COMMIT;
