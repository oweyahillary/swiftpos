-- Migration 200 — per-person EMAIL alert preferences (A627 W3)
--
-- Owner, 2026-11-26: "people who receive daily mails … not every general manager and owner loves to see emails daily" +
-- "disable for a specific person, I can't find the UI." Email alerts (the daily summary, low-stock, operations alerts) go
-- out automatically to the owner and to every staff member who holds reports.overview and has an e-mail on file, with no
-- per-person off switch. This table is that switch: a row with email_enabled=false opts one person out of one alert,
-- overriding the automatic include. An ABSENT row means ON, so nothing changes for anyone until they opt out.
--
-- Service role only (the email jobs and the staff route read/write it; the browser never does). packages/core/
-- notificationPrefs.ts is the single source of truth for the alert keys and which right each one needs.
--
-- Additive, idempotent, reversible: DROP the table.

CREATE TABLE IF NOT EXISTS public.user_notification_prefs (
  business_id   uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL,
  alert_type    text        NOT NULL,
  email_enabled boolean     NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NULL,
  PRIMARY KEY (user_id, alert_type)
);
COMMENT ON TABLE public.user_notification_prefs IS
  'A627 W3: per-person email-alert opt-outs (email_enabled=false silences one alert for one person). Absent row = on. Service role only.';
CREATE INDEX IF NOT EXISTS user_notification_prefs_business ON public.user_notification_prefs (business_id, alert_type);

ALTER TABLE public.user_notification_prefs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.user_notification_prefs FROM anon, authenticated;
EXCEPTION WHEN others THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('200_user_notification_prefs', 'A627 W3: per-person email-alert preferences (user_notification_prefs) — opt a person out of the daily summary, low-stock or operations alerts')
ON CONFLICT (version) DO NOTHING;
