-- 145_support_logs.sql — A519: a till's log sent to ZapTill support ("Send logs to support" on the Tech page).
--
-- The till sends the last 24 hours of its log (every secret-looking value removed on the till, and again by the cloud
-- before it is stored — lib/logRedact.ts), gzip + base64, under its own session. The admin portal lists a client's logs
-- and downloads one (GET /api/admin/support-logs). The reference is what the client reads out on the phone.
--
-- No Supabase Storage bucket exists in this project, so the log is a text column (gzip + base64, at most ~900 kB per
-- row — the cloud refuses more). Only the cloud's service role reads or writes it: RLS on, no policy for anyone else.
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS public.support_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id     uuid NULL,
  device_id     text NOT NULL,
  terminal_code text NULL,
  app_version   text NULL,
  reference     text NOT NULL,
  sent_by       text NULL,
  bytes         integer NOT NULL DEFAULT 0,
  trimmed       boolean NOT NULL DEFAULT false,
  log_gz_b64    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS support_logs_reference_unique ON public.support_logs (reference);
CREATE INDEX IF NOT EXISTS support_logs_business_created ON public.support_logs (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_logs_device_created ON public.support_logs (device_id, created_at DESC);

ALTER TABLE public.support_logs ENABLE ROW LEVEL SECURITY;
-- No policy: anon and authenticated read and write nothing; the cloud's service role bypasses RLS.
DO $$ BEGIN
  REVOKE ALL ON public.support_logs FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('145_support_logs', 'A519: support_logs — a till''s redacted 24-hour log sent to support, listed and downloaded in the admin portal.')
ON CONFLICT (version) DO NOTHING;
