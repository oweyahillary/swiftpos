-- ═════════════════════════════════════════════════════════════════════════════
-- SwiftPOS — Cash Denomination Counter (item 18)
-- Additive + idempotent. Fold into the consolidated migration once verified.
--
-- Stores the note×count breakdown captured at shift close for audit. The list
-- of denominations a business counts is configurable and lives in
-- business_settings under key 'cash_denominations' (a JSON array of numbers);
-- when absent the server falls back to a Kenyan default.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS denomination_breakdown jsonb;

COMMENT ON COLUMN public.shifts.denomination_breakdown IS
  'Cash count at close as { "1000": 3, "500": 5, ... }. Sums to closing_float.';

-- Optional: seed a default denomination list per existing business so the
-- counter has something to show before anyone configures it. Idempotent.
INSERT INTO public.business_settings (business_id, key, value)
SELECT b.id, 'cash_denominations', '[1000,500,200,100,50,40,20,10,5,1]'::jsonb
FROM public.businesses b
WHERE NOT EXISTS (
  SELECT 1 FROM public.business_settings s
  WHERE s.business_id = b.id AND s.key = 'cash_denominations'
);

COMMIT;
