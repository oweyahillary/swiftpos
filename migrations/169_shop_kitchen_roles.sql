-- 169_shop_kitchen_roles.sql — A580
--
-- Owner, 2026-10-23: "how can shops have waiter and kitchen roles unless requested keep them off we only have cashier
-- and other roles". Migration 142 (A514) gave EVERY business the built-in Waiter and Kitchen roles and migration 159 (A550)
-- the Kitchen Manager; from A580 they are a restaurant's or a café's only (shared/permissions.ts BUILT_IN_ROLES,
-- FOOD_BUSINESS_TYPES — new shops are no longer seeded with them).
--
-- Once (guarded by its own schema_migrations row), at every business that is NOT a restaurant or a café (retail, minimart,
-- parking, petrol_station, other), this deletes the built-in roles named
-- Waiter, Kitchen or Kitchen Manager (case and spaces / underscores aside, as 142 and 159 matched them) that:
--   * are built-in (is_default = true — a role the owner made by hand, even one called "Waiter", is never touched), and
--   * have NOBODY on them — no staff member at all, active OR inactive (users.role_id).
-- A role with people on it stays exactly as it is (they keep working; the owner may move them and delete it). Its keys go
-- with it (role_permissions ON DELETE CASCADE); the staff sync version and sync_changes triggers (150 / 151) tell the tills.
-- A shop that wants a Waiter role can still add one: Settings › Roles and permissions › New role (name it, tick its keys,
-- or copy another role) — the guard means this never runs again to take it away.
--
-- To see beforehand what it will delete and keep (read-only):
--   SELECT b.name AS business, b.type, r.name AS role,
--          (SELECT count(*) FROM public.users u WHERE u.role_id = r.id) AS staff_on_it
--     FROM public.roles r JOIN public.businesses b ON b.id = r.business_id
--    WHERE r.is_default AND COALESCE(trim(b.type), '') <> ''
--      AND lower(regexp_replace(trim(b.type), '[[:space:]]+', '_', 'g')) NOT IN ('restaurant', 'cafe')
--      AND lower(regexp_replace(trim(r.name), '[[:space:]_]+', ' ', 'g')) IN ('waiter', 'kitchen', 'kitchen manager')
--    ORDER BY 1, 3;      -- staff_on_it = 0 → deleted; more → kept
-- It reports the two counts as a NOTICE when it runs.

DO $a580r$
DECLARE
  v_deleted integer := 0;
  v_kept    integer := 0;
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '169_shop_kitchen_roles') THEN
  SELECT count(*) INTO v_kept
    FROM public.roles r JOIN public.businesses b ON b.id = r.business_id
   WHERE r.is_default = true
     AND COALESCE(trim(b.type), '') <> ''
     AND lower(regexp_replace(trim(b.type), '[[:space:]]+', '_', 'g')) NOT IN ('restaurant', 'cafe')
     AND lower(regexp_replace(trim(r.name), '[[:space:]_]+', ' ', 'g')) IN ('waiter', 'kitchen', 'kitchen manager')
     AND EXISTS (SELECT 1 FROM public.users u WHERE u.role_id = r.id);

  WITH gone AS (
    DELETE FROM public.roles r
     USING public.businesses b
     WHERE b.id = r.business_id
       AND r.is_default = true
       AND COALESCE(trim(b.type), '') <> ''
       AND lower(regexp_replace(trim(b.type), '[[:space:]]+', '_', 'g')) NOT IN ('restaurant', 'cafe')
       AND lower(regexp_replace(trim(r.name), '[[:space:]_]+', ' ', 'g')) IN ('waiter', 'kitchen', 'kitchen manager')
       AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.role_id = r.id)
    RETURNING r.id
  )
  SELECT count(*) INTO v_deleted FROM gone;

  RAISE NOTICE '169_shop_kitchen_roles: % unused Waiter / Kitchen / Kitchen Manager role(s) removed from shops; % kept (staff on them)', v_deleted, v_kept;
END IF;
END $a580r$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('169_shop_kitchen_roles', 'A580: the unused built-in Waiter, Kitchen and Kitchen Manager roles taken off businesses that are not a restaurant or a cafe (roles with staff kept).')
ON CONFLICT (version) DO NOTHING;
