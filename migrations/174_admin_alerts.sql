-- 174_admin_alerts.sql — A589: the admin's alerts go to the admin portal first, grouped emails, nightly backups recorded.
--
-- Owner, 2026-10-25: "till not closed should not come as an email for each client; let it be a notification on the admin
-- portal — right now I am getting like 7 emails for different clients — or if they must come as an email let it be a
-- table containing the clients list, not each client an email; also invoices let it be the same; [emails] maybe when the
-- server is down or overloaded; and how can I be doing backups to protect my client data each night at 12am".
-- Rules: apps/server/src/lib/adminAlertPolicy.ts (pure); the job: apps/server/src/jobs/watchdog.ts; the billing job:
-- apps/server/src/jobs/cloudPlanReminders.ts; the routes: apps/server/src/routes/admin.ts; the backup:
-- .github/workflows/nightly-backup.yml (docs/BACKUPS.md).
--
-- public.admin_settings — ZapTill's own settings (not a client's): one row per key, a JSON value. First key
--   'alert_settings' { instant: [categories emailed at once], digest_email, digest_time 'HH:MM' Nairobi,
--   billing_summary_email }, and 'digest_state' { last_date } (the morning digest sent once a day, across restarts).
--   No row = the defaults in lib/adminAlertPolicy.ts.
-- public.admin_notifications — the admin portal's bell: one row per thing the admin should see — a client problem the
--   watchdog opened (a day not closed, a POS not syncing …), a billing notice (an invoice issued, unpaid day 5, locked,
--   trial ended, not interested). read_at set when an admin marks it read. digest_sent_at: in a daily summary email.
-- public.ops_events.kind — adds 'backup' (the nightly backup's result) and 'uptime' (the external down check's recovery).
--
-- Only the cloud's service role reads or writes the two new tables: RLS on, no policy. Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.admin_settings (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.admin_settings FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
COMMENT ON TABLE public.admin_settings IS
  '174 (A589): ZapTill admin settings, one JSON value per key (alert_settings, digest_state). Service role only.';

CREATE TABLE IF NOT EXISTS public.admin_notifications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  category        text        NOT NULL,
  business_id     uuid        REFERENCES public.businesses(id) ON DELETE CASCADE,
  alert_key       text,
  title           text        NOT NULL,
  detail          text,
  data            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,
  read_by         text,
  digest_sent_at  timestamptz,
  CONSTRAINT admin_notifications_category_check CHECK (category ~ '^[a-z_]{2,40}$')
);
CREATE INDEX IF NOT EXISTS admin_notifications_created ON public.admin_notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_notifications_unread ON public.admin_notifications (created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS admin_notifications_undigested ON public.admin_notifications (category, created_at) WHERE digest_sent_at IS NULL;
ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.admin_notifications FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
COMMENT ON TABLE public.admin_notifications IS
  '174 (A589): the admin portal bell - client problems and billing notices, instead of one email each. Service role only.';

ALTER TABLE public.ops_events DROP CONSTRAINT IF EXISTS ops_events_kind_check;
ALTER TABLE public.ops_events ADD CONSTRAINT ops_events_kind_check
  CHECK (kind IN ('boot', 'deploy_check', 'vuln_scan', 'backup', 'uptime'));

INSERT INTO public.schema_migrations (version, notes)
VALUES ('174_admin_alerts', 'A589: admin_settings, admin_notifications (the admin portal bell); ops_events kinds backup and uptime.')
ON CONFLICT (version) DO NOTHING;
