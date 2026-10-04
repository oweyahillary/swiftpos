-- Migration 119 — A391: a one-time code at sign-in (OTP) for admins, owners and managers; A392: mute an alert (2026-10-04)
--
-- Owner, 2026-10-04: "OTP enabling both admin portal and dashboard" — the code by email or an authenticator app, "Both,
-- user picks" — "Portal admin is mandatory, owner should be mandatory also managers".
--
-- admin_users / users:
--   otp_method       'email' (a 6-digit code is emailed at sign-in — the default, nothing to set up) or 'totp' (an
--                    authenticator app: Google / Microsoft Authenticator).
--   otp_totp_secret  the authenticator's secret, encrypted (lib/crypto.ts, APP_ENCRYPTION_KEY); NULL on email.
--   otp_version      raised on every change or reset of the method: a browser "remembered for 30 days" under an
--                    older version must enter a code again.
-- login_otp_codes — the emailed codes, hashed; 10 minutes, 5 tries, used once. Only the cloud's service role reads or
-- writes it: RLS on, no policy.
-- watchdog_alerts.acknowledged_at / _by — an admin saw the alert in the portal and muted its reminders (A392).
--
-- Additive and idempotent.

ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS otp_method      text    NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS otp_totp_secret text,
  ADD COLUMN IF NOT EXISTS otp_version     integer NOT NULL DEFAULT 1;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS otp_method      text    NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS otp_totp_secret text,
  ADD COLUMN IF NOT EXISTS otp_version     integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_otp_method_check') THEN
    ALTER TABLE public.admin_users ADD CONSTRAINT admin_users_otp_method_check CHECK (otp_method IN ('email', 'totp'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_otp_method_check') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_otp_method_check CHECK (otp_method IN ('email', 'totp'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.login_otp_codes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text        NOT NULL,
  subject_id   uuid        NOT NULL,
  code_hash    text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT login_otp_codes_kind_check CHECK (subject_kind IN ('admin', 'user'))
);
CREATE INDEX IF NOT EXISTS login_otp_codes_subject
  ON public.login_otp_codes (subject_kind, subject_id, created_at DESC);
ALTER TABLE public.login_otp_codes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.watchdog_alerts
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by text;

COMMENT ON TABLE public.login_otp_codes IS
  '119: sign-in codes emailed to admins, owners and managers — hashed, 10 minutes, 5 tries, used once.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('119_login_otp', 'A391: sign-in code (email or authenticator) for admins, owners, managers; A392: mute an alert')
ON CONFLICT (version) DO NOTHING;
