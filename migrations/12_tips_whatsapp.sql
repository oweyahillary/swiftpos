-- ═════════════════════════════════════════════════════════════════════════════
-- SwiftPOS — Tips/Gratuity (17) + WhatsApp receipts (16)
-- Additive + idempotent. Fold into the consolidated migration once verified.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 17. Tips / gratuity ──────────────────────────────────────────────────────
-- tip_amount is collected at payment, on top of the order total. It is NOT part
-- of taxable subtotal/VAT — it's a gratuity to staff — so it lives in its own
-- column and is added to the cash actually collected.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tip_amount numeric(12,2) NOT NULL DEFAULT 0;

-- Default tip preset config per business (percentages offered at checkout, and
-- whether tipping is shown at all). Stored as JSON in business_settings.
INSERT INTO public.business_settings (business_id, key, value)
SELECT b.id, 'tip_settings', '{"enabled":false,"presets":[5,10,15],"allow_custom":true}'::jsonb
FROM public.businesses b
WHERE NOT EXISTS (
  SELECT 1 FROM public.business_settings s
  WHERE s.business_id = b.id AND s.key = 'tip_settings'
);

-- ── 16. WhatsApp receipt delivery ────────────────────────────────────────────
-- Per-business WhatsApp config (provider keys are NOT stored here in clear text;
-- the access token belongs in env/secret store — this only holds non-secret
-- routing config + the enabled flag).
INSERT INTO public.business_settings (business_id, key, value)
SELECT b.id, 'whatsapp_settings', '{"enabled":false,"template_name":"receipt","auto_send":false}'::jsonb
FROM public.businesses b
WHERE NOT EXISTS (
  SELECT 1 FROM public.business_settings s
  WHERE s.business_id = b.id AND s.key = 'whatsapp_settings'
);

-- Delivery log so we have an audit trail of receipt sends + their status.
CREATE TABLE IF NOT EXISTS public.whatsapp_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  order_id     uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  to_phone     text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','sent','failed','skipped')),
  provider_id  text,                 -- message id returned by the provider
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_deliveries_business ON public.whatsapp_deliveries (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_deliveries_order    ON public.whatsapp_deliveries (order_id);

COMMIT;
