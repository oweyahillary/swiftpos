-- fix-sync.sql — run ONCE against the database your Render server uses:
--   psql "<server DATABASE_URL>" -f scripts/fix-sync.sql
--
-- Two safe, idempotent, non-destructive fixes for Till 1 (Beryl):
--   1. Ensure migration 89's payment-method constraint is present (so custom
--      methods like kcb/bonga sync). No-op if already there.
--   2. Close any STALE OPEN trading day + open shift left on the server for this
--      till's device, which is what makes the server reject the new (18th) day
--      with "This till already has an open trading day."
--
-- Deletes nothing. Touches only rows for this one device. Safe to re-run.
-- device_id / business_id taken from the till's own device_config + session.

\set device_id  'f77f63d7-e052-48b0-bf6b-9a73dce64a8f'
\set business_id '8604033e-024b-4722-9f2f-6bdb8eb69e7a'

BEGIN;

-- 1. payment-method domain (idempotent — same as migration 89) -----------------
ALTER TABLE public.payments ALTER COLUMN method TYPE varchar(40);
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_method_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_method_format_check') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_method_format_check CHECK (method ~ '^[a-z0-9_]{1,40}$');
  END IF;
END $$;

-- 2. clear the stale open day + shift for this till ----------------------------
-- Show what we're about to close (for your log), then close it.
\echo 'Open trading days on the server for this till BEFORE fix:'
SELECT id, business_date, status, opened_at, closed_at
FROM public.business_days
WHERE device_id = :'device_id' AND status = 'open';

UPDATE public.business_days
SET status = 'closed', closed_at = COALESCE(closed_at, now())
WHERE device_id = :'device_id' AND status = 'open';

UPDATE public.shifts
SET status = 'closed', closed_at = COALESCE(closed_at, now())
WHERE device_id = :'device_id' AND status = 'open';

\echo 'Open days remaining (should be zero):'
SELECT count(*) AS open_days_left
FROM public.business_days
WHERE device_id = :'device_id' AND status = 'open';

COMMIT;
