-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 14: Device registration for cashier access control
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Allows a business owner to require that cashier logins from unknown devices
-- be approved before access is granted. Prevents cashiers logging into the
-- web POS from home or personal devices without authorisation.
--
-- How it works:
--   1. Owner enables "require_device_registration" in business_settings
--   2. Cashier logs in from any device → fingerprint computed server-side
--      from User-Agent + a stable client-provided canvas/screen hash
--   3. If fingerprint not in user_devices (or pending/rejected) → 403
--      with code: DEVICE_NOT_REGISTERED
--   4. Client shows "Waiting for approval" screen
--   5. Owner sees badge on dashboard, goes to Settings → Devices, approves
--   6. A notification is created so the owner sees it in the bell icon
--   7. Cashier retries login → now approved → token issued normally
--
-- Safe on live data: all additive (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. user_devices table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_devices (
  id            uuid        NOT NULL DEFAULT uuid_generate_v4(),
  user_id       uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  business_id   uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  fingerprint   text        NOT NULL,       -- sha256(ua + client_hint) — stable device identity
  device_label  text,                       -- human-readable: 'Chrome on Windows', 'Safari on iPhone'
  ip_address    text,                       -- IP at registration time
  status        text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz,               -- when owner approved/rejected
  reviewed_by   uuid,                       -- FK → users.id (the owner/manager who acted)
  last_seen_at  timestamptz,               -- updated on each successful login
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_devices_pkey           PRIMARY KEY (id),
  CONSTRAINT user_devices_user_fp_uq     UNIQUE (user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS user_devices_user_id_idx     ON public.user_devices (user_id);
CREATE INDEX IF NOT EXISTS user_devices_business_id_idx ON public.user_devices (business_id);
CREATE INDEX IF NOT EXISTS user_devices_fingerprint_idx ON public.user_devices (fingerprint);
CREATE INDEX IF NOT EXISTS user_devices_status_idx      ON public.user_devices (business_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Done. New objects:
--   public.user_devices (table + 4 indexes)
--
-- The "require_device_registration" toggle is stored in business_settings
-- (key: 'require_device_registration', value: 'true'/'false').
-- No schema change needed — business_settings is already a generic kv store.
-- ─────────────────────────────────────────────────────────────────────────────
