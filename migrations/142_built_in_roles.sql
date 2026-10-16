-- 142_built_in_roles.sql — A514
--
-- Owner, 2026-10-16, on the roles a business starts with (owner, manager, cashier): "Supervisor, Waiter, Kitchen,
-- Storekeeper and any other that a good system should have" — with Accountant (reads the books) and, at a fuel business,
-- Fuel attendant.
--
-- Once (guarded by its own schema_migrations row), every business gets each built-in role it does not have yet — by
-- name, case and spaces aside (a business that already has a "Supervisor" keeps its own, untouched) — marked is_default
-- like the roles seeded at sign-up, with the role's default keys and NOBODY assigned. Fuel attendant only where the
-- business type sells fuel (petrol_station). A role the owner deletes afterwards is not brought back (the guard).
--
-- The names, descriptions and keys are shared/permissions.ts BUILT_IN_ROLES exactly (new businesses are seeded from it,
-- lib/defaultRolePermissions.ts); scripts/test-migration-142.mjs compares this file with it.
--   Manager / Cashier — the catalogue's manager / cashier defaults (only where a business has none of that name)
--   Supervisor — sells, approves voids / refunds / sales on account and drawers with their PIN, sales and shift reports
--   Waiter — sells and sends to the kitchen, discounts within the limit; no staff list, credit, refunds or reports
--   Kitchen — reads the menu (the kitchen display signs in with its own display token)
--   Storekeeper — stock levels, deliveries, transfers, counts, wastage, the stock report and cost prices
--   Accountant — every report read-only, the orders and shifts pages, the expenses list
--   Fuel attendant — pump sales and the pumps (fuel businesses only)

DO $a514r$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '142_built_in_roles') THEN
  WITH built (name, description, fuel_only) AS (VALUES
    ('Manager', 'Runs a branch', false),
    ('Cashier', 'Sells at the till', false),
    ('Supervisor', 'Sells, and approves voids, refunds, sales on account and drawers with their PIN', false),
    ('Waiter', 'Takes orders, sends them to the kitchen and takes payment', false),
    ('Kitchen', 'Kitchen staff - reads the menu (the kitchen display has its own sign-in)', false),
    ('Storekeeper', 'Receives deliveries, transfers, counts and writes off stock', false),
    ('Accountant', 'Reads the books - every report, the orders and the expenses, changes nothing', false),
    ('Fuel attendant', 'Sells fuel at the pumps', true)
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
    ('Manager', 'orders.create'),
    ('Manager', 'sales.discount'),
    ('Manager', 'sales.void'),
    ('Manager', 'sales.refund'),
    ('Manager', 'sales.reprint'),
    ('Manager', 'sales.history_all'),
    ('Manager', 'invoice.create'),
    ('Manager', 'shifts.cash_movements'),
    ('Manager', 'shifts.confirm'),
    ('Manager', 'shifts.force_close'),
    ('Manager', 'shifts.close_day'),
    ('Manager', 'reports.overview'),
    ('Manager', 'reports.sales'),
    ('Manager', 'reports.items'),
    ('Manager', 'reports.staff'),
    ('Manager', 'reports.shifts'),
    ('Manager', 'reports.voids'),
    ('Manager', 'reports.inventory'),
    ('Manager', 'reports.fuel'),
    ('Manager', 'orders.view_all'),
    ('Manager', 'products.view'),
    ('Manager', 'menu.offers'),
    ('Manager', 'inventory.view'),
    ('Manager', 'inventory.receive'),
    ('Manager', 'inventory.transfer'),
    ('Manager', 'inventory.count'),
    ('Manager', 'inventory.waste'),
    ('Manager', 'customers.view'),
    ('Manager', 'customers.edit'),
    ('Manager', 'customers.credit'),
    ('Manager', 'expenses.view'),
    ('Manager', 'expenses.manage'),
    ('Manager', 'staff.view'),
    ('Manager', 'staff.edit'),
    ('Manager', 'reservations.manage'),
    ('Manager', 'parking.manage'),
    ('Manager', 'fuel.manage'),
    ('Manager', 'settings.mpesa'),
    ('Manager', 'receipt.manage'),
    ('Manager', 'stations.manage'),
    ('Manager', 'tables.manage'),
    ('Manager', 'devices.approve'),
    ('Cashier', 'orders.create'),
    ('Cashier', 'sales.discount'),
    ('Cashier', 'invoice.create'),
    ('Cashier', 'shifts.cash_movements'),
    ('Cashier', 'products.view'),
    ('Cashier', 'inventory.view'),
    ('Cashier', 'customers.view'),
    ('Cashier', 'customers.edit'),
    ('Cashier', 'reservations.manage'),
    ('Cashier', 'parking.manage'),
    ('Cashier', 'fuel.manage'),
    ('Supervisor', 'orders.create'),
    ('Supervisor', 'sales.discount'),
    ('Supervisor', 'invoice.create'),
    ('Supervisor', 'shifts.cash_movements'),
    ('Supervisor', 'products.view'),
    ('Supervisor', 'inventory.view'),
    ('Supervisor', 'customers.view'),
    ('Supervisor', 'customers.edit'),
    ('Supervisor', 'reservations.manage'),
    ('Supervisor', 'parking.manage'),
    ('Supervisor', 'fuel.manage'),
    ('Supervisor', 'sales.void'),
    ('Supervisor', 'sales.refund'),
    ('Supervisor', 'sales.reprint'),
    ('Supervisor', 'sales.history_all'),
    ('Supervisor', 'customers.credit'),
    ('Supervisor', 'shifts.confirm'),
    ('Supervisor', 'reports.sales'),
    ('Supervisor', 'reports.shifts'),
    ('Waiter', 'orders.create'),
    ('Waiter', 'sales.discount'),
    ('Waiter', 'products.view'),
    ('Waiter', 'inventory.view'),
    ('Waiter', 'customers.view'),
    ('Waiter', 'customers.edit'),
    ('Waiter', 'reservations.manage'),
    ('Kitchen', 'products.view'),
    ('Storekeeper', 'products.view'),
    ('Storekeeper', 'inventory.view'),
    ('Storekeeper', 'inventory.receive'),
    ('Storekeeper', 'inventory.transfer'),
    ('Storekeeper', 'inventory.count'),
    ('Storekeeper', 'inventory.waste'),
    ('Storekeeper', 'reports.inventory'),
    ('Storekeeper', 'menu.costs'),
    ('Accountant', 'reports.overview'),
    ('Accountant', 'reports.sales'),
    ('Accountant', 'reports.items'),
    ('Accountant', 'reports.staff'),
    ('Accountant', 'reports.shifts'),
    ('Accountant', 'reports.voids'),
    ('Accountant', 'reports.inventory'),
    ('Accountant', 'reports.fuel'),
    ('Accountant', 'reports.tax'),
    ('Accountant', 'reports.costs'),
    ('Accountant', 'reports.labour'),
    ('Accountant', 'reports.monthly_pack'),
    ('Accountant', 'reports.payments'),
    ('Accountant', 'reports.export'),
    ('Accountant', 'orders.view_all'),
    ('Accountant', 'expenses.view'),
    ('Fuel attendant', 'orders.create'),
    ('Fuel attendant', 'products.view'),
    ('Fuel attendant', 'fuel.manage')
    ) AS k (role_name, key) ON k.role_name = a.name
    JOIN public.permissions p ON p.key = k.key
  ON CONFLICT (role_id, permission_id) DO NOTHING;
END IF;
END $a514r$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('142_built_in_roles', 'A514: every business gets the built-in roles it lacks - Supervisor, Waiter, Kitchen, Storekeeper, Accountant, Fuel attendant at fuel businesses.')
ON CONFLICT (version) DO NOTHING;
