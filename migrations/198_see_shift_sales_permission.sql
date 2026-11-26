-- 198_see_shift_sales_permission.sql — A627: "See own shift sales at close" (shifts.see_shift_sales)
--
-- Owner, 2026-11-26: "can we make it a user right that the owner or the partner can give their team? 1. if locked a cashier
-- should never see their sales difference they only key in the amount they have." Seeing a shift's SALES total at close is
-- now a per-person RIGHT, not only the business-wide 'cashier_sees_shift_sales' switch (business_settings/branch_settings,
-- which still works as the default for cashiers). The count stays BLIND either way — never the expected cash or the
-- difference; that needs shifts.confirm. So a locked cashier (switch off, no right) only keys in the cash they counted,
-- while the owner grants the right to a trusted person. packages/core/src/permissions.ts — the words below follow it.
--
-- Registered (idempotent: re-running updates the words only). Granted ONCE (guarded by its own schema_migrations row, so a
-- role the owner later un-ticks stays un-ticked) to the roles that hold it by the new catalogue defaults — the SENIORS who
-- see the branch's sales, never the built-in Cashier or Waiter (whose shift-close stays governed by the switch):
--   1. the owner roles (owner / admin) — every new key, as every new key always has;
--   2. the BUILT-IN Manager, General Manager, Supervisor, Operations Manager and Auditor roles (roles.is_default; matched
--      case-, space- and underscore-insensitively). A role the owner made themselves under the same name is left alone.
-- Nothing is taken away. The role_permissions triggers bump permissions_version (tokens renew) and log a staff change for
-- the desktop POS. A new business's seniors get it from the catalogue (manager:true / its built-in role list) once registered.
--
-- To see beforehand which roles get it (read-only):
--   SELECT b.name AS business, r.name AS role
--     FROM public.roles r JOIN public.businesses b ON b.id = r.business_id
--    WHERE lower(trim(r.name)) IN ('owner', 'admin')
--       OR (r.is_default AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g')
--             IN ('manager', 'general manager', 'supervisor', 'operations manager', 'auditor'))
--    ORDER BY 1, 2;

INSERT INTO public.permissions (key, label, module, description) VALUES
  ('shifts.see_shift_sales', 'See own shift sales at close', 'drawer',
   'When closing a shift, see the shift''s sales total and number of orders. The count stays blind — never the expected cash or the difference (a drawer confirmation shows those).')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

DO $a627$
DECLARE
  v_owner integer := 0;
  v_senior integer := 0;
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '198_see_shift_sales_permission') THEN
  -- 1. the owner roles
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'shifts.see_shift_sales'
     WHERE lower(trim(r.name)) IN ('owner', 'admin')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_owner FROM added;
  -- 2. the BUILT-IN senior roles (never the Cashier or Waiter)
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'shifts.see_shift_sales'
     WHERE r.is_default = true
       AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g')
             IN ('manager', 'general manager', 'supervisor', 'operations manager', 'auditor')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_senior FROM added;
  RAISE NOTICE 'A627: shifts.see_shift_sales to % owner-role grant(s) and % built-in senior grant(s)', v_owner, v_senior;
END IF;
END $a627$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('198_see_shift_sales_permission', 'A627: shifts.see_shift_sales (See own shift sales at close) registered; granted once to the owner roles and the built-in Manager, General Manager, Supervisor, Operations Manager and Auditor')
ON CONFLICT (version) DO NOTHING;
