-- Backfill default role_permissions for businesses created before the seeding
-- fix (their seeded roles have zero permissions — empty roles screen, no staff
-- access). Mirrors apps/server/src/lib/defaultRolePermissions.ts.
--
-- IDEMPOTENT & SAFE: only roles that currently have NO permissions are touched,
-- so re-running is a no-op and businesses you've already configured by hand are
-- left untouched.
--
-- Tiers by role name (case-insensitive):
--   admin / owner            -> every permission
--   manager / supervisor / branch_manager -> everything except settings.manage
--   cashier                  -> POS-floor subset

WITH empty_roles AS (
  SELECT r.id, lower(r.name) AS nm
  FROM public.roles r
  WHERE NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id
  )
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT er.id, p.id
FROM empty_roles er
JOIN public.permissions p ON (
      er.nm IN ('admin', 'owner')
   OR (er.nm IN ('manager', 'supervisor', 'branch_manager') AND p.key <> 'settings.manage')
   OR (er.nm = 'cashier' AND p.key IN (
         'orders.create', 'products.view', 'inventory.view',
         'customers.view', 'customers.manage', 'invoice.create'
       ))
);

-- Verify (optional): roles with their granted permission counts
-- SELECT b.name AS business, r.name AS role, count(rp.*) AS perms
-- FROM public.roles r
-- JOIN public.businesses b ON b.id = r.business_id
-- LEFT JOIN public.role_permissions rp ON rp.role_id = r.id
-- GROUP BY b.name, r.name ORDER BY b.name, r.name;
