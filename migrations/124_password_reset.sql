-- Migration 124 — A402: an owner resets their own password (2026-10-05)
--
-- Owner, 2026-10-05: "add, reset password feature". Before: a forgotten owner password could only be reset by ZapTill
-- staff in the admin portal (reset-owner-password), and a signed-in owner could not change their own.
--
-- public.password_reset_codes — a 6-digit code emailed to the owner's sign-in address ("Forgot password?" on the
--   dashboard sign-in page). Hashed (never the code itself), 15 minutes, 5 tries, used once. subject_id is the owner's
--   sign-in account (auth.users id). Only the cloud's service role reads or writes it (RLS on, no policies).
--   Kept apart from login_otp_codes on purpose: a sign-in code can never be used to change a password, nor the reverse.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.password_reset_codes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id   uuid        NOT NULL,
  email        text        NOT NULL,
  code_hash    text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_codes_subject ON public.password_reset_codes (subject_id, created_at DESC);
ALTER TABLE public.password_reset_codes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.password_reset_codes IS
  '124 (A402): emailed codes for an owner resetting their own password — hashed, 15 minutes, 5 tries, used once.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('124_password_reset', 'A402: password_reset_codes (owner "Forgot password?")')
ON CONFLICT (version) DO NOTHING;
