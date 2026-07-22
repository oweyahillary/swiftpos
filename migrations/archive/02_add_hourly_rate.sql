-- SwiftPOS: Add hourly_rate to users for SPLH labour cost calculation
-- Run this in your Supabase SQL editor

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10, 2) DEFAULT NULL;

COMMENT ON COLUMN public.users.hourly_rate IS
  'Hourly wage rate in local currency. Used for SPLH labour cost % report.';
