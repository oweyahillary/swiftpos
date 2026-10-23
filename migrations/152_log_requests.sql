-- 152_log_requests.sql — A533: ZapTill support pulls a till's (or a branch server's) log from the admin portal.
--
-- Owner, 2026-10-19: "add a feature where we can pull local logs of a server or a till to cloud so that we can be
-- investigating such issues" - and, on the admin portal's Desktop updates tab: "how do I pull logs". Until now (A519) a
-- log reached support only when someone at the shop pressed Send logs to support on the Tech page.
--
-- public.log_requests - one row per pull asked for in the admin portal (POST /api/admin/clients/:id/log-requests, any
-- active admin, audited in admin_audit_log): which device, why, how far back (24, 72 or 168 hours), what else to send
-- (include: auth = the sign-in history). The cloud rings the business over the push channel (A531) and the till also
-- asks GET /api/support/log-requests/mine on its 90 s beat; it answers with POST /api/support/logs carrying request_id -
-- the same redacted upload as A519 - and the cloud links the stored log (support_log_id) and marks it delivered.
-- status: waiting -> delivered | cancelled (an admin) | expired (still waiting 7 days after it was asked: expires_at).
--
-- Only the cloud's service role reads or writes it: RLS on, no policy for anyone else (as 145 support_logs).
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS public.log_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  device_id           text NOT NULL,
  requested_by_admin  uuid NULL,
  requested_by_email  text NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  reason              text NOT NULL,
  range_hours         integer NOT NULL DEFAULT 24 CHECK (range_hours IN (24, 72, 168)),
  include             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'delivered', 'expired', 'cancelled')),
  delivered_at        timestamptz NULL,
  support_log_id      uuid NULL REFERENCES public.support_logs(id) ON DELETE SET NULL,
  cancelled_at        timestamptz NULL,
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS log_requests_business_requested ON public.log_requests (business_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS log_requests_device_waiting ON public.log_requests (business_id, device_id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS log_requests_admin_requested ON public.log_requests (requested_by_admin, requested_at DESC);

ALTER TABLE public.log_requests ENABLE ROW LEVEL SECURITY;
-- No policy: anon and authenticated read and write nothing; the cloud's service role bypasses RLS.
DO $$ BEGIN
  REVOKE ALL ON public.log_requests FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('152_log_requests', 'A533: log_requests - support asks a till or branch server for its log from the admin portal, the till answers through the A519 upload.')
ON CONFLICT (version) DO NOTHING;
