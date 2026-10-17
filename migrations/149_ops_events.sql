-- 149_ops_events.sql — A525: what the production server runs, whether a deploy reached it, what the dependencies carry.
--
-- Production silently failed EVERY deploy from 1.0.16 to 1.0.18: a startup guard refused MPESA_ENVIRONMENT=sandbox with
-- NODE_ENV=production, Render kept the old 1.0.15 instance running, and nobody noticed for two releases. npm audit showed
-- 7 vulnerabilities nobody was told about. Owner, 2026-10-17: "maybe can we have a UI for all that in the app, these
-- results are written to the db and I can read through".
--
-- public.ops_events — one row per thing that happened:
--   boot          the server started (it writes this itself, after it listens - index.ts / lib/opsEvents.ts)
--   deploy_check  GitHub (.github/workflows/verify-prod-deploy.yml) asked /health whether the newest server change runs
--   vuln_scan     GitHub (.github/workflows/security-scan.yml) ran npm audit on every app
-- posted by GitHub through POST /api/ops/events (a token, not a user session), read by super admins only in the admin
-- portal (System page, GET /api/admin/ops/events and /summary).
--
-- Only the cloud's service role reads or writes it: RLS on, no policy for anyone else (as 145 support_logs).
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS public.ops_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('boot', 'deploy_check', 'vuln_scan')),
  status      text NOT NULL CHECK (status IN ('ok', 'warn', 'fail')),
  commit      text NULL,
  title       text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  source      text NOT NULL DEFAULT 'server',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_events_kind_created ON public.ops_events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS ops_events_created ON public.ops_events (created_at DESC);

ALTER TABLE public.ops_events ENABLE ROW LEVEL SECURITY;
-- No policy: anon and authenticated read and write nothing; the cloud's service role bypasses RLS.
DO $$ BEGIN
  REVOKE ALL ON public.ops_events FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('149_ops_events', 'A525: ops_events - the server starts, the GitHub deploy check and dependency scan, read by super admins in the admin portal System page.')
ON CONFLICT (version) DO NOTHING;
