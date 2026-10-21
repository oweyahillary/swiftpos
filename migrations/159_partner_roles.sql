-- 159_partner_roles.sql — A550
--
-- Owner, 2026-10-21, with partner login (a staff member let into the full web dashboard with a password): "add general
-- manager, ops manager, accountant and any user you feel will be needed". Accountant has been a built-in role since A514
-- (migration 142) and is left as it is.
--
-- Once (guarded by its own schema_migrations row), every business gets each of these roles it does not have yet — by
-- name, case and spaces aside (a business that already has a "General Manager" keeps its own, untouched) — marked
-- is_default like the roles seeded at sign-up, with the role's default keys and NOBODY assigned. A role the owner deletes
-- afterwards is not brought back (the guard).
--
-- The names, descriptions and keys are shared/permissions.ts BUILT_IN_ROLES exactly (new businesses are seeded from it,
-- lib/defaultRolePermissions.ts); scripts/test-migration-159.mjs compares this file with it.
--   General Manager    — every permission in the catalogue (the usual partner role); what is the owner's by design is
--                        not a permission (the owner's password and role, partner access, M-Pesa credentials, sign-in
--                        codes, the kitchen display key) and stays the owner's
--   Operations Manager — menu and prices, stock (counts reviewed, adjustments), kitchen and printers, tables, shifts and
--                        closing the day and the branch, the staff list and staff, the operational reports; no finance
--   Finance Manager    — the Accountant's reports and books, plus paying suppliers, recording expenses, customer credit
--                        and confirming drawers; no selling, menu, stock or staff
--   Auditor            — every view and report a non-owner can be given, nothing that changes anything
--   Kitchen Manager    — the menu, recipes and ingredients, receiving, counting and writing off stock, the stock report and
--                        the kitchen's print stations; no money, selling or staff

DO $a550r$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '159_partner_roles') THEN
  WITH built (name, description, fuel_only) AS (VALUES
    ('General Manager', 'Runs the whole business day to day - every permission, never the owner', false),
    ('Operations Manager', 'Runs operations - menu, stock, kitchen, shifts and the day, staff and the operational reports', false),
    ('Finance Manager', 'The accountant who acts - pays suppliers, records expenses, customer credit and drawer checks', false),
    ('Auditor', 'Sees every report, list and figure a non-owner can be shown, changes nothing', false),
    ('Kitchen Manager', 'Runs the kitchen - the menu and recipes, receiving, counting and writing off stock', false)
  ),
  added AS (
    INSERT INTO public.roles (business_id, name, description, is_default)
    SELECT b.id, bi.name, bi.description, true
      FROM public.businesses b
      JOIN built bi ON (NOT bi.fuel_only OR lower(b.type) = 'petrol_station')
     WHERE NOT EXISTS (SELECT 1 FROM public.roles r
                        WHERE r.business_id = b.id
                          AND lower(regexp_replace(trim(r.name), '[[:space:]_]+', ' ', 'g')) = lower(bi.name))
    ON CONFLICT (business_id, name) DO NOTHING
    RETURNING id, name
  )
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT a.id, p.id
    FROM added a
    JOIN (VALUES
    ('General Manager', 'orders.create'),
    ('General Manager', 'sales.discount'),
    ('General Manager', 'sales.void'),
    ('General Manager', 'sales.refund'),
    ('General Manager', 'sales.reprint'),
    ('General Manager', 'sales.history_all'),
    ('General Manager', 'invoice.create'),
    ('General Manager', 'shifts.cash_movements'),
    ('General Manager', 'shifts.confirm'),
    ('General Manager', 'shifts.force_close'),
    ('General Manager', 'shifts.close_day'),
    ('General Manager', 'shifts.close_branch'),
    ('General Manager', 'reports.overview'),
    ('General Manager', 'reports.sales'),
    ('General Manager', 'reports.items'),
    ('General Manager', 'reports.staff'),
    ('General Manager', 'reports.shifts'),
    ('General Manager', 'reports.voids'),
    ('General Manager', 'reports.inventory'),
    ('General Manager', 'reports.fuel'),
    ('General Manager', 'reports.tax'),
    ('General Manager', 'reports.costs'),
    ('General Manager', 'reports.labour'),
    ('General Manager', 'reports.monthly_pack'),
    ('General Manager', 'reports.payments'),
    ('General Manager', 'reports.export'),
    ('General Manager', 'orders.view_all'),
    ('General Manager', 'products.view'),
    ('General Manager', 'menu.edit'),
    ('General Manager', 'menu.prices'),
    ('General Manager', 'menu.offers'),
    ('General Manager', 'menu.promotions'),
    ('General Manager', 'menu.recipes'),
    ('General Manager', 'menu.costs'),
    ('General Manager', 'inventory.view'),
    ('General Manager', 'inventory.receive'),
    ('General Manager', 'inventory.transfer'),
    ('General Manager', 'inventory.count'),
    ('General Manager', 'inventory.waste'),
    ('General Manager', 'inventory.count_freeze'),
    ('General Manager', 'inventory.adjust'),
    ('General Manager', 'ingredients.manage'),
    ('General Manager', 'payables.manage'),
    ('General Manager', 'payables.view'),
    ('General Manager', 'customers.view'),
    ('General Manager', 'customers.edit'),
    ('General Manager', 'customers.credit'),
    ('General Manager', 'expenses.view'),
    ('General Manager', 'expenses.manage'),
    ('General Manager', 'staff.view'),
    ('General Manager', 'staff.edit'),
    ('General Manager', 'staff.roles'),
    ('General Manager', 'reservations.manage'),
    ('General Manager', 'parking.manage'),
    ('General Manager', 'fuel.manage'),
    ('General Manager', 'settings.business'),
    ('General Manager', 'settings.branches'),
    ('General Manager', 'settings.payments'),
    ('General Manager', 'settings.mpesa'),
    ('General Manager', 'settings.reversals'),
    ('General Manager', 'settings.integrations'),
    ('General Manager', 'settings.pos'),
    ('General Manager', 'receipt.manage'),
    ('General Manager', 'stations.manage'),
    ('General Manager', 'tables.manage'),
    ('General Manager', 'devices.approve'),
    ('General Manager', 'etims.manage'),
    ('General Manager', 'changes.approve'),
    ('Operations Manager', 'products.view'),
    ('Operations Manager', 'menu.edit'),
    ('Operations Manager', 'menu.prices'),
    ('Operations Manager', 'menu.offers'),
    ('Operations Manager', 'menu.recipes'),
    ('Operations Manager', 'menu.costs'),
    ('Operations Manager', 'inventory.view'),
    ('Operations Manager', 'inventory.receive'),
    ('Operations Manager', 'inventory.transfer'),
    ('Operations Manager', 'inventory.count'),
    ('Operations Manager', 'inventory.waste'),
    ('Operations Manager', 'inventory.adjust'),
    ('Operations Manager', 'ingredients.manage'),
    ('Operations Manager', 'stations.manage'),
    ('Operations Manager', 'tables.manage'),
    ('Operations Manager', 'changes.approve'),
    ('Operations Manager', 'shifts.close_day'),
    ('Operations Manager', 'shifts.close_branch'),
    ('Operations Manager', 'shifts.force_close'),
    ('Operations Manager', 'staff.view'),
    ('Operations Manager', 'staff.edit'),
    ('Operations Manager', 'reservations.manage'),
    ('Operations Manager', 'parking.manage'),
    ('Operations Manager', 'fuel.manage'),
    ('Operations Manager', 'reports.overview'),
    ('Operations Manager', 'reports.sales'),
    ('Operations Manager', 'reports.items'),
    ('Operations Manager', 'reports.inventory'),
    ('Operations Manager', 'reports.shifts'),
    ('Operations Manager', 'reports.voids'),
    ('Operations Manager', 'reports.fuel'),
    ('Operations Manager', 'orders.view_all'),
    ('Operations Manager', 'sales.history_all'),
    ('Finance Manager', 'reports.overview'),
    ('Finance Manager', 'reports.sales'),
    ('Finance Manager', 'reports.items'),
    ('Finance Manager', 'reports.staff'),
    ('Finance Manager', 'reports.shifts'),
    ('Finance Manager', 'reports.voids'),
    ('Finance Manager', 'reports.inventory'),
    ('Finance Manager', 'reports.fuel'),
    ('Finance Manager', 'reports.tax'),
    ('Finance Manager', 'reports.costs'),
    ('Finance Manager', 'reports.labour'),
    ('Finance Manager', 'reports.monthly_pack'),
    ('Finance Manager', 'reports.payments'),
    ('Finance Manager', 'reports.export'),
    ('Finance Manager', 'orders.view_all'),
    ('Finance Manager', 'expenses.view'),
    ('Finance Manager', 'payables.view'),
    ('Finance Manager', 'payables.manage'),
    ('Finance Manager', 'expenses.manage'),
    ('Finance Manager', 'customers.view'),
    ('Finance Manager', 'customers.credit'),
    ('Finance Manager', 'shifts.confirm'),
    ('Auditor', 'sales.history_all'),
    ('Auditor', 'reports.overview'),
    ('Auditor', 'reports.sales'),
    ('Auditor', 'reports.items'),
    ('Auditor', 'reports.staff'),
    ('Auditor', 'reports.shifts'),
    ('Auditor', 'reports.voids'),
    ('Auditor', 'reports.inventory'),
    ('Auditor', 'reports.fuel'),
    ('Auditor', 'reports.tax'),
    ('Auditor', 'reports.costs'),
    ('Auditor', 'reports.labour'),
    ('Auditor', 'reports.monthly_pack'),
    ('Auditor', 'reports.payments'),
    ('Auditor', 'reports.export'),
    ('Auditor', 'orders.view_all'),
    ('Auditor', 'products.view'),
    ('Auditor', 'menu.costs'),
    ('Auditor', 'inventory.view'),
    ('Auditor', 'payables.view'),
    ('Auditor', 'customers.view'),
    ('Auditor', 'expenses.view'),
    ('Auditor', 'staff.view'),
    ('Kitchen Manager', 'products.view'),
    ('Kitchen Manager', 'menu.edit'),
    ('Kitchen Manager', 'menu.recipes'),
    ('Kitchen Manager', 'menu.costs'),
    ('Kitchen Manager', 'ingredients.manage'),
    ('Kitchen Manager', 'inventory.view'),
    ('Kitchen Manager', 'inventory.receive'),
    ('Kitchen Manager', 'inventory.count'),
    ('Kitchen Manager', 'inventory.waste'),
    ('Kitchen Manager', 'reports.inventory'),
    ('Kitchen Manager', 'stations.manage')
    ) AS k (role_name, key) ON k.role_name = a.name
    JOIN public.permissions p ON p.key = k.key
  ON CONFLICT (role_id, permission_id) DO NOTHING;
END IF;
END $a550r$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('159_partner_roles', 'A550: every business gets the built-in roles it lacks - General Manager, Operations Manager, Finance Manager, Auditor, Kitchen Manager.')
ON CONFLICT (version) DO NOTHING;
