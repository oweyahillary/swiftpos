-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 79 — grant `stations.manage` to the manager roles
--
-- WHY (register A59, docs/permission-model.md)
--   `stations.manage` was registered by migration 75 but granted to NO role and
--   enforced on NO route — a dead key. That is why the till's Printers tab still
--   fell back to a role test: there was no manager-held key to gate on, and
--   `settings.manage` is owner/admin-only (migration 59), so keying Printers on
--   it would have hidden the tab from every manager.
--
--   This is the first batch of the permission-model decision: stop letting
--   "manage settings" imply "manage printers". It wires `stations.manage`
--   through the GRANT surface so the till can gate the Printers tab on it and
--   the cloud can enforce it on the station routes (both additive, so no role
--   loses access).
--
-- ADDITIVE. It only grants; it revokes nothing. The Printers tab re-point in
-- ManagerPage.tsx and the additive `requireAnyPermission('stations.manage',
-- 'products.manage')` on stations.ts ship in the SAME batch, so managers hold
-- the key before anything starts to require it.
--
-- Every table reference is public.-qualified: migration 76 failed in production
-- on one unqualified name under a search_path that excluded public (A62).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Registered (defensive; 75 already did this, ON CONFLICT makes it a no-op).
--    Self-contained so the grant below is never a silent no-op on a DB that
--    somehow lacks the row.
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('stations.manage', 'Manage print stations', 'settings',
     'Create, edit and delete print stations and their per-station exclusions (PHASE6 8c)')
ON CONFLICT (key) DO NOTHING;

-- 2. Grant to the manager roles. Same normalised-name set as migrations 75/76
--    (space -> underscore, NOT widened to ILIKE '%manager%' — register A61), and
--    the same NOT EXISTS guard so re-running grants nothing twice.
DO $$
DECLARE granted_count integer;
BEGIN
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM   public.roles r
  CROSS JOIN public.permissions p
  WHERE  p.key = 'stations.manage'
    AND  lower(replace(r.name, ' ', '_'))
           IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
    AND  NOT EXISTS (
           SELECT 1 FROM public.role_permissions rp
           WHERE rp.role_id = r.id AND rp.permission_id = p.id
         );
  GET DIAGNOSTICS granted_count = ROW_COUNT;
  RAISE NOTICE 'migration 79: granted stations.manage to % role(s).', granted_count;
END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('79_stations_manage_grant',
        'A59 / permission-model. Grants stations.manage (registered by 75, granted to no role, enforced on no route) to manager/supervisor/branch_manager/admin/owner. Additive; pairs with the ManagerPage Printers re-point and the requireAnyPermission on stations.ts so no manager loses the tab. Fully public.-qualified (A62).')
ON CONFLICT (version) DO NOTHING;

-- ── Who this affects. Safe to run on its own, before or after committing. ─────
-- SELECT b.name AS business, r.name AS role
-- FROM   public.role_permissions rp
-- JOIN   public.permissions p ON p.id = rp.permission_id AND p.key = 'stations.manage'
-- JOIN   public.roles r       ON r.id = rp.role_id
-- JOIN   public.businesses b  ON b.id = r.business_id
-- ORDER  BY b.name, r.name;
