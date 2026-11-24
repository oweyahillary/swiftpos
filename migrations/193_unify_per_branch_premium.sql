-- Migration 193 — Unify cloud billing on per-branch: premium per branch is the sole entitlement (A624)
--
-- Owner, 2026-11-23: every premium add-on (Analytics, Attendance, Themes) is priced per branch; retire the per-business
-- master switches (feature_flags 'analytics' / 'attendance' / 'themes'). This migration moves entitlement entirely onto
-- branch_cloud_plans.premium so the server can stop reading those switches. (docs/tasks/A624-unify-per-branch-billing.md)
--
-- WHY A BACKFILL, not just "read premium": today a feature is ON for a branch only when BOTH the business master switch
-- is on AND (the branch pays for it, OR the business is "billed as one" — no branch rows — in which case the switch alone
-- grants it to every branch). Migration 182 filled branch rows with EMPTY premium, so for per-branch clients the premium
-- column does NOT yet reflect who has access. This migration computes each branch's CURRENT effective entitlement and
-- writes it into premium, so NO client's access changes when the code stops reading the switches.
--
-- Additive and idempotent. The feature_flags rows are NOT deleted here (a later cleanup migration drops them once no code
-- reads them, so a code rollback still finds them). Forward-only (it overwrites premium with the preserved effective set).
--
-- ORDER: apply this BEFORE deploying the code that stops reading the switches, or per-branch clients (empty premium) lose
-- Analytics for the gap.

-- 0. Safety notice: a branch on the Premium package keeps the package (which grants all three). If its business had a
--    premium switch OFF, that branch currently has NO access to that feature, yet after the switches are retired the
--    package will grant it. We assume the package implies ZapTill had the switches on; surface any exception to review.
DO $chk$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM public.branch_cloud_plans bp
  WHERE bp.package
    AND EXISTS (
      SELECT 1 FROM unnest(ARRAY['analytics','attendance','themes']) AS f
      WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags ff
                        WHERE ff.business_id = bp.business_id AND ff.key = f AND ff.enabled = true));
  IF n > 0 THEN
    RAISE NOTICE 'A624: % package branch(es) whose business has a premium switch OFF — they keep the package (review).', n;
  END IF;
END $chk$;

-- 1. Capture each branch's CURRENT effective premium (the two-layer rule) BEFORE creating any rows.
--    A branch has F when the master switch is on AND (the business is billed as one, OR this branch pays for F).
CREATE TEMP TABLE _a624_eff ON COMMIT DROP AS
SELECT br.id AS branch_id, br.business_id,
  ARRAY(
    SELECT f FROM unnest(ARRAY['analytics','attendance','themes']) AS f
    WHERE EXISTS (SELECT 1 FROM public.feature_flags ff
                  WHERE ff.business_id = br.business_id AND ff.key = f AND ff.enabled = true)        -- master switch on
      AND (
        NOT EXISTS (SELECT 1 FROM public.branch_cloud_plans bp0 WHERE bp0.business_id = br.business_id)  -- billed as one
        OR EXISTS (SELECT 1 FROM public.branch_cloud_plans bp                                            -- or this branch pays
                   WHERE bp.branch_id = br.id AND (bp.package OR f = ANY(bp.premium)))
      )
  ) AS premium
FROM public.branches br
WHERE EXISTS (SELECT 1 FROM public.cloud_plans p WHERE p.business_id = br.business_id)                 -- on the cloud,
   OR EXISTS (SELECT 1 FROM public.feature_flags ff WHERE ff.business_id = br.business_id               -- or has a premium
              AND ff.key IN ('analytics','attendance','themes') AND ff.enabled = true);                -- switch on

-- 2. Create missing branch rows for businesses WITH a plan, inheriting it exactly as migration 182 did.
INSERT INTO public.branch_cloud_plans
  (branch_id, business_id, period, amount, currency, custom_until, paid_until, billing_from, created_at, updated_by)
SELECT e.branch_id, e.business_id, p.period, p.amount, p.currency, p.custom_until, b.web_access_expires_at, p.billing_from,
       p.created_at, 'migration 193'
FROM _a624_eff e
JOIN public.businesses b ON b.id = e.business_id
JOIN public.cloud_plans p ON p.business_id = e.business_id
ON CONFLICT (branch_id) DO NOTHING;

-- 2b. Businesses with NO plan but a premium switch on (trial / complimentary): a default row to carry the premium.
INSERT INTO public.branch_cloud_plans
  (branch_id, business_id, period, amount, currency, paid_until, created_at, updated_by)
SELECT e.branch_id, e.business_id, 'monthly', 0, 'KES', b.web_access_expires_at, now(), 'migration 193'
FROM _a624_eff e
JOIN public.businesses b ON b.id = e.business_id
WHERE NOT EXISTS (SELECT 1 FROM public.cloud_plans p WHERE p.business_id = e.business_id)
ON CONFLICT (branch_id) DO NOTHING;

-- 3. Write the preserved effective premium onto every (non-package) branch row. Package rows keep the package.
UPDATE public.branch_cloud_plans bp
SET premium = e.premium, updated_at = now()
FROM _a624_eff e
WHERE bp.branch_id = e.branch_id AND NOT bp.package;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('193_unify_per_branch_premium', 'A624: unify cloud billing on per-branch — backfill branch premium from the master switches (access-preserving); switches retired in code, dropped by a later migration')
ON CONFLICT (version) DO NOTHING;
