-- Migration 125 — A407: a till's sign-in is never lost by accident, and ZapTill hears when one is (2026-10-05)
--
-- Owner, 2026-10-05 (Pollo Fried Chicken, a till on the PIN screen with "Please sign in again."): "how do we prevent
-- this from ever happening" — "if a till is rejected when it comes online after a long offline period i should get an
-- email".
--
-- public.refresh_tokens.session_kind — whose session it is: 'device' (the till itself), 'pin' (a person on a till), 'web'. A till
--   signs in AS the owner (its sessions carry the owner's user id), so owner actions ("sign out everywhere", a password
--   change) must tell a till's session from the owner's browsers by this, not by the user id. NULL on rows from before.
-- public.user_devices.session_lost_at / session_lost_reason — a till whose session the cloud refused and which could
--   not sign itself back in with its device secret (A164). The watchdog emails it as critical; cleared when the till
--   signs back in (device secret or a new enrolment code).
--
-- Additive and idempotent.

ALTER TABLE public.refresh_tokens
  ADD COLUMN IF NOT EXISTS session_kind text;

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS session_lost_at     timestamptz,
  ADD COLUMN IF NOT EXISTS session_lost_reason text;

COMMENT ON COLUMN public.refresh_tokens.session_kind IS
  '125 (A407): device = the till''s own session (owner-scoped); pin = a person signed in on a till; web = a browser. Owner actions never revoke device sessions; only blocking the till does.';
COMMENT ON COLUMN public.user_devices.session_lost_at IS
  '125 (A407): the till''s session was refused and it could not sign itself back in — emailed as a critical alert.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('125_till_sessions', 'A407: refresh_tokens.session_kind; user_devices.session_lost_at / session_lost_reason')
ON CONFLICT (version) DO NOTHING;
