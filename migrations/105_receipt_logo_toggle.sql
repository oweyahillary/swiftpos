-- 105_receipt_logo_toggle.sql — A311 (SCOPE-A295 §10 item 4, second slice of A310–A313)
--
-- The client's receipt-logo switch. Owner decision 2026-09-22: printing the logo on
-- receipts is a per-business TOGGLE, opt-in. Default FALSE so an existing branded
-- business prints exactly what it printed yesterday until someone turns it on after
-- seeing the receipt preview (SCOPE addendum §C — the gradient-logo case).
--
-- Purely additive (rule 13): one nullable-default column on a table no till PUSHES
-- (branding is pulled, remote-wins), so no push payload can be rejected by this.
-- logo_receipt itself already exists (migration 104, "later slice" — this is that
-- slice's data half); it holds the mono1: raster string from shared/printing raster.ts.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the ledger insert is ON CONFLICT DO NOTHING.

ALTER TABLE public.business_branding
  ADD COLUMN IF NOT EXISTS receipt_logo_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.business_branding.receipt_logo_enabled IS
  'A311: print logo_receipt on customer receipts. Opt-in; default false.';
COMMENT ON COLUMN public.business_branding.logo_receipt IS
  'A310/A311: pre-thresholded 1-bit raster as mono1:<w>:<h>:<base64> (shared/printing raster.ts). Generated where a canvas exists; never decoded on a till.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('105_receipt_logo_toggle', 'A311: business_branding.receipt_logo_enabled (opt-in receipt logo)')
ON CONFLICT (version) DO NOTHING;
