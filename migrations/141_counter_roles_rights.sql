-- 141_counter_roles_rights.sql — A514
--
-- Owner, 2026-10-16: apply migration 140's rule to every counter role — "Cashier, Waiter or Teller". 140 did the roles
-- named cashier; this does the roles named waiter or teller.
--
-- Once (guarded by its own schema_migrations row), from every role that exists when 141 runs and is NAMED waiter or teller
-- (case and spaces aside):
--   * staff.view — the staff list (134 gave it to every role, as everyone had it before A490);
--   * customers.credit — credit limits, repayments, adjustments and approving sales on account (A511): their sale on
--     account is approved with a manager's PIN instead. It also keeps such a role off the manager screens on 1.0.15 tills
--     (A499's cause).
-- The owner can tick either back per role (Settings › Roles) and a later run never takes it away again. Other roles and
-- keys untouched. The built-in Waiter role of migration 142 never had either key. People renew into it (the
-- role_permissions trigger bumps permissions_version).

DO $a514c$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '141_counter_roles_rights') THEN
  DELETE FROM public.role_permissions rp
   USING public.roles r, public.permissions p
   WHERE rp.role_id = r.id AND rp.permission_id = p.id
     AND lower(trim(r.name)) IN ('waiter', 'teller')
     AND p.key IN ('staff.view', 'customers.credit');
END IF;
END $a514c$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('141_counter_roles_rights', 'A514: waiter and teller roles lose staff.view and customers.credit - as 140 did for cashier roles.')
ON CONFLICT (version) DO NOTHING;
