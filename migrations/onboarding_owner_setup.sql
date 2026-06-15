-- ─────────────────────────────────────────────────────────────────────────────
-- SwiftPOS — Onboarding: owner credentials & force-password-change
-- Safe to run on existing data — all changes are additive.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Track whether the owner must change their password on next login.
--    Set to TRUE by the agent during onboarding, cleared after owner changes it.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- 2. Store the owner's address (optional, collected in onboarding step 1)
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS owner_name character varying;

-- 3. Extend onboarding_progress to track the new step 3 (owner PIN set)
ALTER TABLE public.onboarding_progress
  ADD COLUMN IF NOT EXISTS owner_pin_set boolean NOT NULL DEFAULT false;

-- 4. Add branch address & phone columns if not already present (collected step 2)
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS city character varying,
  ADD COLUMN IF NOT EXISTS country character varying NOT NULL DEFAULT 'Kenya';

-- ─────────────────────────────────────────────────────────────────────────────
-- Done.
-- New columns: users.must_change_password, businesses.owner_name,
--              onboarding_progress.owner_pin_set,
--              branches.city, branches.country
-- ─────────────────────────────────────────────────────────────────────────────
