-- Migration 185 — A branch's own prices; current clients keep Themes, free (A617)
--
-- Owner, 2026-11-01: current clients keep Themes, free · a client may have its own price for an add-on or the package ·
-- ZapTill's default look and the Ocean, Teal and Sky themes are free to everyone, the rest stays premium.
-- (docs/A617-themes-basic-and-own-prices.md)
--
-- What this adds (additive, idempotent; nothing existing changes meaning):
--
--   branch_cloud_plans.own_prices   optional per-branch monthly prices (KES) for 'analytics', 'attendance', 'themes' and
--                                   'package', each a non-negative number. A missing key (or NULL) = ZapTill's global
--                                   price (admin_settings 'billing_details'). lib/branchBilling.ts branchBill uses it.
--
--   The grandfathering (once): migration 182's fill gave every branch of a business on the plan premium = '{}', so on its
--   own every current client would lose Themes on deploy. Every branch row whose business has the 'themes' flag on gets
--   'themes' in premium (never twice) and own_prices.themes = 0 (only when the row has no own Themes price yet) — current
--   clients keep Themes, free. It runs once (its schema_migrations row guards it), so a later run never puts back a Themes
--   a super admin took off; each row's own guards make it safe even without that.
--
-- Safe before or after the server deploy: the server reads branch_cloud_plans with '*' (no column named) and a save that
-- names own_prices on a database without it is retried without it (routes/cloudPlanAdmin.ts). Run after 182.
-- Reversible: ALTER TABLE public.branch_cloud_plans DROP COLUMN own_prices (the premium added stays).

ALTER TABLE public.branch_cloud_plans ADD COLUMN IF NOT EXISTS own_prices jsonb NULL;
COMMENT ON COLUMN public.branch_cloud_plans.own_prices IS
  'A617: this branch''s own monthly prices (KES) for analytics, attendance, themes and the package - {"themes": 0}; a missing key (or NULL) = ZapTill''s global price.';

-- An object of the four keys, each a non-negative number.
DO $a617$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_cloud_plans_own_prices_check') THEN
    ALTER TABLE public.branch_cloud_plans ADD CONSTRAINT branch_cloud_plans_own_prices_check CHECK (
      own_prices IS NULL OR (
        jsonb_typeof(own_prices) = 'object'
        AND own_prices - ARRAY['analytics', 'attendance', 'themes', 'package'] = '{}'::jsonb
        AND NOT jsonb_path_exists(own_prices, '$.* ? (@.type() != "number" || @ < 0)')
      ));
  END IF;
END $a617$;

-- The grandfathering: current clients keep Themes, free (once; see above).
DO $a617b$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '185_branch_own_prices') THEN
  UPDATE public.branch_cloud_plans p
     SET premium    = CASE WHEN 'themes' = ANY (p.premium) THEN p.premium ELSE array_append(p.premium, 'themes') END,
         own_prices = CASE WHEN COALESCE(p.own_prices, '{}'::jsonb) ? 'themes' THEN p.own_prices
                           ELSE COALESCE(p.own_prices, '{}'::jsonb) || '{"themes": 0}'::jsonb END,
         updated_by = 'migration 185'
   WHERE EXISTS (SELECT 1 FROM public.feature_flags f
                  WHERE f.business_id = p.business_id AND f.key = 'themes' AND f.enabled = true)
     AND (NOT ('themes' = ANY (p.premium)) OR NOT (COALESCE(p.own_prices, '{}'::jsonb) ? 'themes'));
END IF;
END $a617b$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('185_branch_own_prices', 'A617: branch_cloud_plans.own_prices (a branch''s own add-on and package prices); current clients keep Themes, free')
ON CONFLICT (version) DO NOTHING;
