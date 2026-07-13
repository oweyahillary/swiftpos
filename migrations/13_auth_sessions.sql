-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 13: Auth hardening — refresh token storage + permissions versioning
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Fixes 5 concurrent-session problems:
--   1. Refresh tokens stored server-side → real logout + revocation
--   2. jti (JWT ID) on every token → rotation tracking
--   3. permissions_version on users → stale-permission detection in 1 DB read
--   4. session_id groups tokens per login → device-level revocation
--   5. (Client-side) cashier storage key scoped to userId — separate migration
--
-- Safe to run on live data: all changes are additive (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. refresh_tokens table ───────────────────────────────────────────────────
-- Each issued refresh token gets one row. On use it is rotated (old row revoked,
-- new row inserted). On logout the row is revoked. On expiry the row is ignored.
--
-- jti = sha256(refreshToken) — we store the hash, never the raw token.
-- session_id groups all tokens from one login event (PIN entry / email login).
--   Used for "log out this device" (revoke by session_id).

CREATE TABLE IF NOT EXISTS public.refresh_tokens (
  id          uuid        NOT NULL DEFAULT uuid_generate_v4(),
  jti         text        NOT NULL,               -- sha256 of the refresh token (index)
  user_id     uuid        NOT NULL,               -- FK → users.id
  business_id uuid        NOT NULL,               -- for fast tenant-scoped queries
  session_id  text        NOT NULL,               -- groups tokens per login event
  device_hint text,                               -- UA or device fingerprint (optional)
  ip_address  text,                               -- client IP at issuance
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,                        -- NULL = active
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT refresh_tokens_pkey    PRIMARY KEY (id),
  CONSTRAINT refresh_tokens_jti_uq  UNIQUE (jti),
  CONSTRAINT refresh_tokens_user_fk FOREIGN KEY (user_id)
    REFERENCES public.users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS refresh_tokens_jti_idx         ON public.refresh_tokens (jti);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx     ON public.refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_session_id_idx  ON public.refresh_tokens (session_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_business_id_idx ON public.refresh_tokens (business_id);

-- ── 2. permissions_version on users ──────────────────────────────────────────
-- Incremented whenever a user's role or permissions change.
-- Embedded in the JWT (claim: pv). requireAuth compares token.pv to DB value.
-- Mismatch → 401 PERMISSIONS_CHANGED → client refreshes → new token has current perms.
-- Cost: one integer read per authenticated request (hits the PK index).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS permissions_version integer NOT NULL DEFAULT 1;

-- ── 3. Auto-bump permissions_version on role or permission change ─────────────
-- Trigger fires whenever role_permissions or user_permissions rows are inserted,
-- updated, or deleted. Bumps the affected user's permissions_version atomically.

-- Trigger function for role_permissions changes
-- (affects all users who have that role)
CREATE OR REPLACE FUNCTION public.bump_permissions_version_for_role()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_role_id uuid;
BEGIN
  -- Get the role_id from whichever row is available (NEW for INSERT/UPDATE, OLD for DELETE)
  v_role_id := COALESCE(NEW.role_id, OLD.role_id);
  UPDATE public.users
     SET permissions_version = permissions_version + 1
   WHERE role_id = v_role_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_pv_role_permissions ON public.role_permissions;
CREATE TRIGGER trg_bump_pv_role_permissions
  AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.bump_permissions_version_for_role();

-- Trigger function for user_permissions overrides
-- (affects only the specific user)
CREATE OR REPLACE FUNCTION public.bump_permissions_version_for_user()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := COALESCE(NEW.user_id, OLD.user_id);
  UPDATE public.users
     SET permissions_version = permissions_version + 1
   WHERE id = v_user_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_pv_user_permissions ON public.user_permissions;
CREATE TRIGGER trg_bump_pv_user_permissions
  AFTER INSERT OR UPDATE OR DELETE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.bump_permissions_version_for_user();

-- Also bump when a user's role_id is reassigned directly
CREATE OR REPLACE FUNCTION public.bump_permissions_version_on_role_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role_id IS DISTINCT FROM OLD.role_id THEN
    NEW.permissions_version := COALESCE(NEW.permissions_version, 1) + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_pv_on_role_change ON public.users;
CREATE TRIGGER trg_bump_pv_on_role_change
  BEFORE UPDATE OF role_id ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.bump_permissions_version_on_role_change();

-- ── 4. Cleanup job hint ───────────────────────────────────────────────────────
-- Expired / revoked tokens accumulate. Run this periodically (daily cron, or
-- pg_cron if available) to keep the table lean:
--
--   DELETE FROM public.refresh_tokens
--    WHERE expires_at < now() - interval '7 days'
--       OR revoked_at < now() - interval '7 days';
--
-- 7-day grace lets you audit recent revocations. Adjust to taste.

-- ─────────────────────────────────────────────────────────────────────────────
-- Done. New objects:
--   public.refresh_tokens (table + 4 indexes)
--   public.users.permissions_version (column)
--   public.bump_permissions_version_for_role (function + trigger)
--   public.bump_permissions_version_for_user (function + trigger)
--   public.bump_permissions_version_on_role_change (function + trigger)
-- ─────────────────────────────────────────────────────────────────────────────
