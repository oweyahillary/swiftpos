-- Migration 116 — A383: the watchdog's memory — what it has already told the admin (2026-10-03)
--
-- Owner, 2026-10-03: "as an admin is there a way i can be getting this errors critical one first hand before the client
-- calls like an email notification or something proactive not reactive" — then: "telegram and email combo is fine".
--
-- public.watchdog_alerts — one row per problem the cloud's watchdog (apps/server/src/jobs/watchdog.ts) has found, keyed
-- by what the problem is (e.g. 'till_not_syncing:<device id>'). It is how the watchdog tells a NEW problem (alert now)
-- from one it already reported (remind every few hours, not every ten minutes), and when to say "resolved".
-- Only the cloud's service role reads or writes it: RLS on, no policy (the dashboard never sees it).
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.watchdog_alerts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key        text        NOT NULL,
  severity         text        NOT NULL,
  business_id      uuid        REFERENCES public.businesses(id) ON DELETE CASCADE,
  title            text        NOT NULL,
  detail           text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  notify_count     integer     NOT NULL DEFAULT 0,
  resolved_at      timestamptz,
  CONSTRAINT watchdog_alerts_severity_check CHECK (severity IN ('critical', 'warning'))
);

-- One OPEN alert per problem; a resolved one may come back as a new row.
CREATE UNIQUE INDEX IF NOT EXISTS watchdog_alerts_open_key
  ON public.watchdog_alerts (alert_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS watchdog_alerts_business
  ON public.watchdog_alerts (business_id, first_seen_at DESC);

ALTER TABLE public.watchdog_alerts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.watchdog_alerts IS
  '116: problems the cloud watchdog found and told the admin about (Telegram + email) — one open row per problem.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('116_watchdog_alerts', 'A383: watchdog_alerts — what the cloud watchdog has already told the admin')
ON CONFLICT (version) DO NOTHING;
