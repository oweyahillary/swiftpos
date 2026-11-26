-- 199_sales_history_total_permission.sql — A627: "See a running total in History" (sales.history_total), and retire the
-- two "cashiers see sales" switches in favour of rights.
--
-- Owner, 2026-11-26: "remove all sales toggle and add them as user rights for easy management". W1 made the close-shift
-- sales a right (shifts.see_shift_sales, migration 198); this makes the History total a right too (sales.history_total) and
-- retires BOTH business-wide switches (cashier_sees_shift_sales A416, cashier_history_totals A418) as the control — the
-- enforcement now reads the rights only. The count stays blind either way. packages/core/src/permissions.ts — words follow it.
--
-- Registered (idempotent). Granted ONCE (guarded by its own schema_migrations row, so a role an owner later un-ticks stays
-- un-ticked):
--   1. sales.history_total to the owner roles (owner / admin) — every new key.
--   2. sales.history_total to the BUILT-IN Manager, General Manager, Supervisor, Operations Manager and Auditor (is_default).
--   3. PRESERVE: shifts.see_shift_sales to EVERY role of any business where the close-shift switch was effectively on
--      (business_settings OR any branch_settings = 'true'), so nobody who saw sales at close loses it when the switch goes.
--   4. PRESERVE: sales.history_total to EVERY role of any business where the History-total switch AND the close-shift switch
--      were both effectively on (A418 required A416), so nobody who saw a History total loses it.
-- Nothing is taken away. The owner now un-ticks per role/person to lock a cashier. role_permissions triggers renew tokens
-- and log a staff change for the desktop POS.

-- NOTE: the VALUES tuple is on ONE line and the description carries no apostrophe, identical to the catalogue's — so
-- test-migration-134's `registeredLater` regex detects this key as later-registered and excludes it from 134/142/159.
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('sales.history_total', 'See a running total in History', 'selling', 'In History, see the number of orders and the sales of whatever the filters show (not only the page on screen).')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

DO $a627b$
DECLARE
  v_owner integer := 0;
  v_senior integer := 0;
  v_see integer := 0;
  v_total integer := 0;
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '199_sales_history_total_permission') THEN
  -- 1. the owner roles
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'sales.history_total'
     WHERE lower(trim(r.name)) IN ('owner', 'admin')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_owner FROM added;
  -- 2. the BUILT-IN senior roles
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'sales.history_total'
     WHERE r.is_default = true
       AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g')
             IN ('manager', 'general manager', 'supervisor', 'operations manager', 'auditor')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_senior FROM added;
  -- 3. PRESERVE shifts.see_shift_sales where the close-shift switch was effectively on
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'shifts.see_shift_sales'
     WHERE r.business_id IN (
       SELECT business_id FROM public.business_settings WHERE key = 'cashier_sees_shift_sales' AND value = 'true'
       UNION SELECT business_id FROM public.branch_settings WHERE key = 'cashier_sees_shift_sales' AND value = 'true')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_see FROM added;
  -- 4. PRESERVE sales.history_total where BOTH switches were effectively on
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'sales.history_total'
     WHERE r.business_id IN (
         SELECT business_id FROM public.business_settings WHERE key = 'cashier_history_totals' AND value = 'true'
         UNION SELECT business_id FROM public.branch_settings WHERE key = 'cashier_history_totals' AND value = 'true')
       AND r.business_id IN (
         SELECT business_id FROM public.business_settings WHERE key = 'cashier_sees_shift_sales' AND value = 'true'
         UNION SELECT business_id FROM public.branch_settings WHERE key = 'cashier_sees_shift_sales' AND value = 'true')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_total FROM added;
  RAISE NOTICE 'A627: sales.history_total to % owner + % senior; preserve % see_shift_sales + % history_total', v_owner, v_senior, v_see, v_total;
END IF;
END $a627b$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('199_sales_history_total_permission', 'A627: sales.history_total registered + granted to owner/senior roles; preserve-grants of shifts.see_shift_sales / sales.history_total wherever the retired switches were on')
ON CONFLICT (version) DO NOTHING;
