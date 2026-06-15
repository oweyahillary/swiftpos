-- SwiftPOS: Add hourly_rate to users for SPLH labour cost calculation

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS hourly_rate numeric(10, 2) DEFAULT NULL;
