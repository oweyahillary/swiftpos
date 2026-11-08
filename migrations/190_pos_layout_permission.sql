-- 190_pos_layout_permission.sql — 8n: the "POS layout" right (settings.pos_layout)
--
-- Owner, 2026-11-05: categories in the side panel or across the top, "toggled per branch by the manager" — and, on who may
-- change it: "lets go with your recommendations since in future we might get more items under POS layout". So the branch's
-- POS layout has its own right, a Manager's by default (docs/SHARED-COMPONENTS-PLAN.md 8n; packages/core/src/permissions.ts
-- — the words below follow it word for word). settings.branches still allows it (the cloud accepts either:
-- @zaptill/core/categoryLayout CATEGORY_LAYOUT_PERMISSIONS), so nobody who could change it before loses it.
--
-- Registered (idempotent: re-running updates the words only). Granted ONCE (guarded by its own schema_migrations row, so a
-- role the owner later un-ticks stays un-ticked):
--   1. the owner roles (owner / admin) — every new key, as every new key always has;
--   2. the BUILT-IN Manager and General Manager roles (roles.is_default, still so named — case, spaces and underscores
--      aside), every business's own. A role the owner made themselves under the same name is left alone (as 177).
-- Nothing is taken away. The role_permissions triggers bump permissions_version (tokens renew) and log a staff change for
-- the desktop POS. A new business's Manager gets it from the catalogue (manager: true) once this key is registered.
--
-- To see beforehand which roles get it (read-only):
--   SELECT b.name AS business, r.name AS role
--     FROM public.roles r JOIN public.businesses b ON b.id = r.business_id
--    WHERE lower(trim(r.name)) IN ('owner', 'admin')
--       OR (r.is_default AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('manager', 'general manager'))
--    ORDER BY 1, 2;

INSERT INTO public.permissions (key, label, module, description) VALUES
  ('settings.pos_layout', 'POS layout', 'settings', 'How the POS screen is laid out at a branch (the categories in a side panel or across the top, for now)')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

DO $n8$
DECLARE
  v_owner integer := 0;
  v_mgr integer := 0;
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '190_pos_layout_permission') THEN
  -- 1. the owner roles
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'settings.pos_layout'
     WHERE lower(trim(r.name)) IN ('owner', 'admin')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_owner FROM added;
  -- 2. the BUILT-IN Manager and General Manager
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'settings.pos_layout'
     WHERE r.is_default = true
       AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('manager', 'general manager')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_mgr FROM added;
  RAISE NOTICE '8n: settings.pos_layout to % owner-role grant(s) and % built-in manager grant(s)', v_owner, v_mgr;
END IF;
END $n8$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('190_pos_layout_permission', '8n: settings.pos_layout (POS layout) registered; granted once to the owner roles and the built-in Manager and General Manager')
ON CONFLICT (version) DO NOTHING;
