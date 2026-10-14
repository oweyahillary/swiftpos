-- Migration 131 — A477: a till's renewal is a handshake, its key is bound to its machine (2026-10-14)
--
-- Owner, 2026-10-14 (a branch server signed out on 2026-10-12: every renewal answered TOKEN_REPLAYED, its device secret
-- was missing, a technician had to rejoin it, its shifts waited two days): renewal like SYN / SYN-ACK / ACK so an honest
-- till can never be locked out by a crash, an update restart, a lost reply or a slow line; the key bound to the machine
-- "to confirm that this till is in the system".
--
-- public.refresh_tokens.acked_at          — when the client confirmed it holds this token (POST /api/auth/refresh/ack,
--                                            or by presenting it). NULL = not confirmed: the token it replaced stays alive
--                                            until then, so a lost reply is re-asked instead of locking the till out
--                                            (apps/server/src/lib/refreshHandshake.ts).
--   Backfill: every existing row is confirmed (acked_at = created_at) — except a live successor whose parent the old
--   rotation already revoked: it stays unconfirmed, so a reply lost just before this deploy is still re-asked (A88) and
--   its first use confirms it. Sessions mid-flight rotate exactly as before.
-- public.user_devices.machine_guid_hash   — SHA-256 of the till's Windows MachineGuid (hashed on the till), first seen.
-- public.user_devices.serial_hash         — SHA-256 of the till's BIOS serial (hashed on the till), first seen.
-- public.user_devices.identity_seen_at    — when the machine was recorded / last matched (a technician's rejoin resets it).
-- public.user_devices.security_alert_at / security_alert_reason
--                                          — another computer seems to hold the till's data (an outdated key presented,
--                                            or the key from a machine not on record). The owner is emailed
--                                            (jobs/ownerAlerts.ts). Not cleared by the till's healthy renewals.
--
-- (The brief named a "terminals" table: a till's terminal row is public.user_devices — device_id, mac_address (93),
-- device_secret_hash (A164) live there.)
--
-- Additive and idempotent.
--
-- REVERT:
--   ALTER TABLE public.refresh_tokens DROP COLUMN IF EXISTS acked_at;
--   ALTER TABLE public.user_devices DROP COLUMN IF EXISTS machine_guid_hash, DROP COLUMN IF EXISTS serial_hash,
--     DROP COLUMN IF EXISTS identity_seen_at, DROP COLUMN IF EXISTS security_alert_at, DROP COLUMN IF EXISTS security_alert_reason;

ALTER TABLE public.refresh_tokens
  ADD COLUMN IF NOT EXISTS acked_at timestamptz;

UPDATE public.refresh_tokens t
   SET acked_at = t.created_at
 WHERE t.acked_at IS NULL
   AND NOT (
     t.revoked_at IS NULL
     AND EXISTS (SELECT 1 FROM public.refresh_tokens p WHERE p.replaced_by = t.id AND p.revoked_at IS NOT NULL)
   );

-- The handshake looks a token's parent up by its successor (the ack retires the parent).
CREATE INDEX IF NOT EXISTS refresh_tokens_replaced_by_idx
  ON public.refresh_tokens (replaced_by)
  WHERE replaced_by IS NOT NULL;

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS machine_guid_hash     text,
  ADD COLUMN IF NOT EXISTS serial_hash           text,
  ADD COLUMN IF NOT EXISTS identity_seen_at      timestamptz,
  ADD COLUMN IF NOT EXISTS security_alert_at     timestamptz,
  ADD COLUMN IF NOT EXISTS security_alert_reason text;

COMMENT ON COLUMN public.refresh_tokens.acked_at IS
  '131 (A477): when the client confirmed it holds this token (/api/auth/refresh/ack or by presenting it). NULL = not confirmed — the token it replaced stays alive until then.';
COMMENT ON COLUMN public.user_devices.machine_guid_hash IS
  '131 (A477): SHA-256 of the till''s Windows MachineGuid (hashed on the till). Trust on first use; a renewal passes when this or serial_hash matches.';
COMMENT ON COLUMN public.user_devices.serial_hash IS
  '131 (A477): SHA-256 of the till''s BIOS serial (hashed on the till). Trust on first use; a renewal passes when this or machine_guid_hash matches.';
COMMENT ON COLUMN public.user_devices.security_alert_at IS
  '131 (A477): another computer seems to hold this till''s data (an outdated key, or a key from a machine not on record) — the owner is emailed.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('131_refresh_ack', 'A477: refresh_tokens.acked_at (renewal handshake, backfilled); user_devices.machine_guid_hash / serial_hash / identity_seen_at (machine binding) / security_alert_at / security_alert_reason')
ON CONFLICT (version) DO NOTHING;
