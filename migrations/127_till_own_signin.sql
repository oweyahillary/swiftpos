-- Migration 127 — A415: a till signs in as itself, never as the owner (2026-10-06)
--
-- Owner, 2026-10-06: "remove any linkage with the desktop app using owners credetials, we find a way to use some key or
-- something that links the till to the business id and branch id never the owners session at all remove it totally".
--
-- A till's session names the till (its device id), the business and the branch — no person (lib/deviceGrant.ts). So:
-- public.refresh_tokens.user_id        — null for a till's own session (it names no person).
-- public.user_devices.user_id          — null for a till (fingerprint 'desktop:…'): the till is not a person's device.
--                                         Browser rows (a cashier's approved browser) keep theirs.
-- public.device_enrolment_codes.created_by — no owner on an enrolment code: ZapTill's admin issues it (the admin is in
--                                         the admin audit log).
-- and the owner is cleared from every existing till row, till session and code.
--
-- Idempotent.

ALTER TABLE public.refresh_tokens         ALTER COLUMN user_id    DROP NOT NULL;
ALTER TABLE public.user_devices           ALTER COLUMN user_id    DROP NOT NULL;
ALTER TABLE public.device_enrolment_codes ALTER COLUMN created_by DROP NOT NULL;

UPDATE public.user_devices           SET user_id    = NULL WHERE fingerprint LIKE 'desktop:%' AND user_id IS NOT NULL;
UPDATE public.refresh_tokens         SET user_id    = NULL WHERE session_kind = 'device'      AND user_id IS NOT NULL;
UPDATE public.device_enrolment_codes SET created_by = NULL WHERE created_by IS NOT NULL;
