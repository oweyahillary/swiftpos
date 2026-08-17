-- =============================================================================
-- 85_complete_manual_mpesa.sql
--
-- Backfills manual M-Pesa tenders that got stuck 'pending' (register A93 / #3).
--
-- The desktop till is a manual-tender POS: the cashier confirms the M-Pesa
-- payment on their own phone, there is no STK push and no Daraja callback. But
-- /api/orders wrote every M-Pesa leg 'pending' regardless, so those rows never
-- reached 'completed', and the dashboard payment-method breakdown (which counts
-- only 'completed') showed the amount as "unaccounted". A93 makes NEW manual
-- legs 'completed'; this one-shot backfill fixes the historical rows.
--
-- Guarded so it can NEVER complete a genuine in-flight STK payment:
--   • mpesa_checkout_id IS NULL   → the leg never went through STK (manual only;
--                                   STK always stamps a checkout id).
--   • created_at older than 1 hour → well past the STK timeout (minutes), so no
--                                   payment still awaiting a callback is touched.
-- Idempotent: a second run matches nothing.
--
-- public.-qualified for search_path safety (A62).
-- =============================================================================

UPDATE public.payments
   SET status = 'completed'
 WHERE method = 'mpesa'
   AND status = 'pending'
   AND mpesa_checkout_id IS NULL
   AND created_at < (now() - interval '1 hour');

INSERT INTO public.schema_migrations (version, notes)
VALUES ('85_complete_manual_mpesa',
        'A93 / #3. Backfills manual M-Pesa tenders stuck pending (desktop till confirms on the phone; no STK, no callback) to completed so they stop reporting as unaccounted. Guarded: only mpesa_checkout_id IS NULL (never STK) and created_at older than 1 hour. Idempotent.')
ON CONFLICT (version) DO NOTHING;
