-- ============================================================================
-- A256 — Backfill POST-ONBOARDING default permissions to existing roles.
--
-- Root cause (A141): permission defaults seed AT ONBOARDING. A permission added
-- to the catalogue LATER (e.g. ingredients.manage) never reaches roles created
-- before it existed — an owner silently loses a feature area with no error.
--
-- SAFE BY CONSTRUCTION:
--   1. Only permissions CREATED AFTER a role's business onboarded
--      (permissions.created_at > businesses.created_at) — the owner could not
--      have intentionally removed a permission that did not exist at seed time,
--      so this never undoes a deliberate removal (why migration 59 touched only
--      EMPTY roles; this can safely top up PARTIAL roles because of the date gate).
--   2. Granted per the SAME tiers as apps/server/src/lib/defaultRolePermissions.ts
--      (full / manager-except-deny / cashier-subset) — never beyond a role's
--      defaults (a cashier can never gain a manager permission).
--   3. Idempotent (NOT EXISTS) — re-running is a no-op.
--
-- REVIEW-FIRST: this is a permission change. Run STEP 1 (preview) and read what
-- it WOULD grant. Only if it looks right, run STEP 2 (apply). On dump-seeded DBs,
-- confirm permissions.created_at actually reflects when each key was added — if
-- every key shares one dump timestamp, the date gate is meaningless and you
-- should NOT apply this (use the manual path below instead).
--
-- Manual path for a single business (fastest for B Fastfoods right now):
--   Settings -> Roles -> owner role -> enable "manage ingredients".
-- ============================================================================

-- ── STEP 1 — PREVIEW (no writes). What would be granted, per business/role/key.
SELECT b.name AS business, r.name AS role, p.key AS permission, p.created_at
FROM public.roles r
JOIN public.businesses b   ON b.id = r.business_id
JOIN public.permissions p  ON p.created_at > b.created_at            -- post-onboarding only
WHERE (
       lower(r.name) IN ('admin', 'owner')
    OR (lower(r.name) IN ('manager', 'supervisor', 'branch_manager')
        AND p.key NOT IN ('settings.manage','inventory.adjust','ingredients.manage','reports.financial'))
    OR (lower(r.name) = 'cashier'
        AND p.key IN ('orders.create','products.view','inventory.view',
                      'customers.view','customers.manage','invoice.create'))
     )
  AND NOT EXISTS (
        SELECT 1 FROM public.role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id)
ORDER BY b.name, r.name, p.key;

-- ── STEP 2 — APPLY (writes). Only after the preview looks correct.
-- INSERT INTO public.role_permissions (role_id, permission_id)
-- SELECT r.id, p.id
-- FROM public.roles r
-- JOIN public.businesses b   ON b.id = r.business_id
-- JOIN public.permissions p  ON p.created_at > b.created_at
-- WHERE (
--        lower(r.name) IN ('admin', 'owner')
--     OR (lower(r.name) IN ('manager', 'supervisor', 'branch_manager')
--         AND p.key NOT IN ('settings.manage','inventory.adjust','ingredients.manage','reports.financial'))
--     OR (lower(r.name) = 'cashier'
--         AND p.key IN ('orders.create','products.view','inventory.view',
--                       'customers.view','customers.manage','invoice.create'))
--      )
--   AND NOT EXISTS (
--         SELECT 1 FROM public.role_permissions rp
--         WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- ── VERIFY (after apply) — permission counts per business/role.
-- SELECT b.name AS business, r.name AS role, count(rp.*) AS perms
-- FROM public.roles r
-- JOIN public.businesses b ON b.id = r.business_id
-- LEFT JOIN public.role_permissions rp ON rp.role_id = r.id
-- GROUP BY b.name, r.name ORDER BY b.name, r.name;
