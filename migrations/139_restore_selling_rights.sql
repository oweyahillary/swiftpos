-- 139_restore_selling_rights.sql — A510
--
-- Owner, 2026-10-16: "rights are still off cashiers cant sale but they can still see staff". Production: KRUNCH & CO
-- and L MASTER's cashier roles hold staff.view, reservations, parking, fuel and the customers keys — and NOT
-- orders.create.
--
-- Why: before A490 (1.0.15) selling had no permission at all — every role could ring a sale. A490 made it orders.create,
-- and migration 134 promised "nothing gained, nothing lost" — but it gave the keys every seller had (sales.discount,
-- sales.history_all, shifts.cash_movements) only to roles that ALREADY held orders.create, and never gave orders.create
-- to a role that could sell without it. A business whose cashier role was set up without that key lost selling.
--
-- The repair, once (guarded by its own schema_migrations row): every role that existed when 134 ran (created before 134
-- was applied), other than the owner's, and that does not hold orders.create gets back what it had before 134:
--   * orders.create (sell) and sales.discount (give discounts, within the business's discount limit) — always;
--   * sales.history_all (every cashier's sales) and shifts.cash_movements (cash in / out) — only where the business never
--     had the switch that limited cashiers (cashier_own_history / cashier_no_money_out); where it had one, they stay off
--     (134 turned the switches off; the owner ticks them per role in Settings › Roles if wanted).
-- A role made after 134 (the owner chose its keys in the Roles screen) is never touched, nor is any other key.
-- Tokens pick it up at the next renewal: the baseline's role_permissions trigger bumps permissions_version for the people
-- in those roles.

DO $a510$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '139_restore_selling_rights') THEN

  -- The roles to repair, as one condition (no temp table: check-schema-drift reads every CREATE TABLE as schema).
  -- Cash in / out and every cashier's sales first: both statements must see the roles BEFORE orders.create is given.
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM public.roles r
    JOIN (VALUES ('sales.history_all', 'cashier_own_history'), ('shifts.cash_movements', 'cashier_no_money_out')) AS s(perm, flag) ON true
    JOIN public.permissions p ON p.key = s.perm
   WHERE lower(trim(r.name)) NOT IN ('owner', 'admin')
     AND r.created_at < COALESCE((SELECT applied_at FROM public.schema_migrations WHERE version = '134_permission_catalogue'), now())
     AND NOT EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions k ON k.id = x.permission_id
                      WHERE x.role_id = r.id AND k.key = 'orders.create')
     AND NOT EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.business_id = r.business_id AND f.key = s.flag)
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM public.roles r
    JOIN public.permissions p ON p.key IN ('orders.create', 'sales.discount')
   WHERE lower(trim(r.name)) NOT IN ('owner', 'admin')
     AND r.created_at < COALESCE((SELECT applied_at FROM public.schema_migrations WHERE version = '134_permission_catalogue'), now())
     AND NOT EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions k ON k.id = x.permission_id
                      WHERE x.role_id = r.id AND k.key = 'orders.create')
  ON CONFLICT (role_id, permission_id) DO NOTHING;

END IF;
END $a510$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('139_restore_selling_rights', 'A510: roles that could sell before A490 get orders.create (and what sellers had) back - 134 left them without it.')
ON CONFLICT (version) DO NOTHING;
