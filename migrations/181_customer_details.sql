-- Migration 181 — Customer details at the counter (A607): the sale's buyer KRA PIN, and the desktop POS's M-Pesa prompts
--
-- Owner, 2026-10-28: "a feature where clients details can be captured by the cashier both on the main screen and the second
-- screen also, and if mpesa integration is available the client can key in their mpesa, if KRA is integrated they can key
-- in KRA pin etc".
--
-- What this adds (additive, idempotent; nothing existing changes meaning):
--
--   orders.buyer_kra_pin   the buyer's KRA PIN for THIS sale (a walk-in may give a PIN for one invoice without being saved
--                          as a customer — Kenya Data Protection Act: used for the invoice only unless the customer agrees
--                          to be saved). NULL = none. The format only: A or P, 9 digits, a letter (A123456789Z), upper
--                          case — shared/customerDetails.ts KRA_PIN_RE is the same rule; POST /api/orders refuses
--                          anything else (BAD_BUYER_PIN). eTIMS sends it to KRA as the buyer's TIN (custTin): the sale's
--                          PIN, else the attached customer's kra_pin, else none (lib/etims/index.ts buildInvoiceDTO).
--
--   mpesa_stk_requests     the M-Pesa prompts a DESKTOP POS asks the cloud to send (POST /api/mpesa/stk-push-pos). A
--                          desktop sale is made on the POS first and reaches the cloud later, so at payment there is no
--                          cloud order and no pending payments row for the web's /stk-push to use; the prompt is kept
--                          here instead, keyed by Safaricom's CheckoutRequestID like payments.mpesa_checkout_id. The
--                          callback and GET /api/mpesa/status read it when no payments row has the checkout id — the
--                          web's flow (payments rows) is untouched. The amount is the POS's (whole shillings, 1–250,000:
--                          Daraja's limits); the customer approves exactly that on their phone, and the callback still
--                          refuses a shortfall. client_ref is the POS's own reference for the payment (its bill), so a
--                          synced order's M-Pesa leg (reference = the M-Pesa receipt) can be matched to its prompt.
--
-- Only the cloud's service role reads or writes mpesa_stk_requests (RLS on, no policy — a payer's phone is personal data;
-- routes/mpesa.ts masks it for anyone without customers.contacts, lib/personalData.ts).
-- Reversible: DROP TABLE mpesa_stk_requests; ALTER TABLE orders DROP COLUMN buyer_kra_pin.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS buyer_kra_pin text;

DO $fmt$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_buyer_kra_pin_format') THEN
    -- None can exist (the column is new), but a re-run after a hand edit must not fail.
    UPDATE public.orders SET buyer_kra_pin = upper(btrim(buyer_kra_pin)) WHERE buyer_kra_pin IS NOT NULL;
    UPDATE public.orders SET buyer_kra_pin = NULL WHERE buyer_kra_pin IS NOT NULL AND buyer_kra_pin !~ '^[AP][0-9]{9}[A-Z]$';
    ALTER TABLE public.orders ADD CONSTRAINT orders_buyer_kra_pin_format
      CHECK (buyer_kra_pin IS NULL OR buyer_kra_pin ~ '^[AP][0-9]{9}[A-Z]$');
  END IF;
END $fmt$;

COMMENT ON COLUMN public.orders.buyer_kra_pin IS
  'A607: the buyer''s KRA PIN for this sale (A/P + 9 digits + a letter), printed on the receipt and sent to KRA eTIMS as custTin. NULL = none (eTIMS then uses the attached customer''s kra_pin, if any).';

CREATE TABLE IF NOT EXISTS public.mpesa_stk_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id           uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  device_id           text,
  requested_by        uuid,
  client_ref          text NOT NULL CHECK (char_length(client_ref) BETWEEN 1 AND 40),
  amount              numeric(12,2) NOT NULL CHECK (amount >= 1 AND amount <= 250000),
  mpesa_phone         text NOT NULL CHECK (mpesa_phone ~ '^254[17][0-9]{8}$'),
  mpesa_checkout_id   text,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  reference           text,
  paid_amount         numeric(12,2),
  mpesa_result_desc   text,
  mpesa_requested_at  timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mpesa_stk_requests_checkout_key ON public.mpesa_stk_requests (mpesa_checkout_id) WHERE mpesa_checkout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mpesa_stk_requests_business_idx ON public.mpesa_stk_requests (business_id, created_at DESC);
ALTER TABLE public.mpesa_stk_requests ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.mpesa_stk_requests IS
  'A607: M-Pesa prompts sent for a DESKTOP POS (POST /api/mpesa/stk-push-pos) - no cloud order exists yet at payment. Matched by the Daraja callback on mpesa_checkout_id when no payments row has it. Service role only.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('181_customer_details', 'A607: orders.buyer_kra_pin (the sale''s buyer KRA PIN, to eTIMS) and mpesa_stk_requests (the desktop POS''s M-Pesa prompts)')
ON CONFLICT (version) DO NOTHING;
