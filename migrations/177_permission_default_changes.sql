-- 177_permission_default_changes.sql — A595, the owner's decisions on the default rights (2026-10-27)
--
-- Migration 176 split the broad rights into parts and changed nobody. The owner then decided (docs/PERMISSIONS-AUDIT.md,
-- "Decisions needed from you"; the questions left open stay in docs/PERMISSIONS-DEFAULTS-177-DRAFT.sql):
--   D1  NO  — cashiers and waiters KEEP customers' contacts and history; and they must be able to ADD a customer and take
--             their details, the KRA PIN included → the built-in Cashier and Waiter roles hold customers.edit ("Add and edit
--             customers"); customers get a KRA PIN (customers.kra_pin: a letter, 9 digits, a letter — A123456789Z — or none).
--   D2  YES — "Change cost prices" (menu.costs_edit) off the built-in Auditor and Storekeeper roles.
--   D3  Webhooks: the owner's alone → settings.webhooks off every role but the owner's. Report e-mails: the owner and the
--             partners choose who receives them (the cloud's rule, routes/business.ts mayReportEmails), never a manager by
--             their role → settings.report_emails off every role but the owner's.
--   D5  YES — recording fuel deliveries and setting up pumps and tanks off the built-in Cashier and Fuel attendant roles
--             (pumps on / off stays: fuel.manage).
--   D6  YES — typed discounts (sales.discount) off the built-in Cashier roles; set-up discounts and promo codes stay
--             (sales.discount_preset).
--   D8  YES — Overview is today's page (routes/reports.ts answers today's range for Overview alone); a role that held
--             Overview without the Sales or Item report gets them, so what it used to open stays open.
--   D7 (customers stay business-wide), D9 (new businesses' Manager only: shared/permissions.ts), D10 (as is): nothing here.
-- "Built-in" = the role ZapTill made (roles.is_default), still so named (case, spaces and underscores aside) — every
-- business's own. A role the owner made themselves under the same name is left alone. Only ROLE grants change: a person's own
-- right (Staff › This person's permissions) that GIVES a removed key is the owner's choice for that person and is kept.
-- Each decision runs once, under its own schema_migrations row. The role_permissions triggers bump permissions_version.
--
-- To see beforehand what each block takes off (read-only):
--   SELECT b.name AS business, r.name AS role, p.key
--     FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
--     JOIN public.businesses b ON b.id = r.business_id JOIN public.permissions p ON p.id = rp.permission_id
--    WHERE (r.is_default AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('auditor', 'storekeeper') AND p.key = 'menu.costs_edit')
--       OR (lower(trim(r.name)) NOT IN ('owner', 'admin') AND p.key IN ('settings.webhooks', 'settings.report_emails'))
--       OR (r.is_default AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('cashier', 'fuel attendant') AND p.key IN ('fuel.deliveries', 'fuel.setup'))
--       OR (r.is_default AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') = 'cashier' AND p.key = 'sales.discount')
--    ORDER BY 1, 2, 3;
-- And which built-in Cashier / Waiter roles gain "Add and edit customers" (D1):
--   SELECT b.name, r.name FROM public.roles r JOIN public.businesses b ON b.id = r.business_id
--    WHERE r.is_default AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('cashier', 'waiter')
--      AND NOT EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions k ON k.id = x.permission_id
--                       WHERE x.role_id = r.id AND k.key = 'customers.edit');

-- ── D1: the customer's KRA PIN (idempotent) ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS kra_pin text;
DO $kra$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_kra_pin_format') THEN
    UPDATE public.customers SET kra_pin = NULL WHERE kra_pin IS NOT NULL AND btrim(kra_pin) = '';
    UPDATE public.customers SET kra_pin = upper(btrim(kra_pin)) WHERE kra_pin IS NOT NULL;
    UPDATE public.customers SET kra_pin = NULL WHERE kra_pin IS NOT NULL AND kra_pin !~ '^[A-Z][0-9]{9}[A-Z]$';
    ALTER TABLE public.customers ADD CONSTRAINT customers_kra_pin_format CHECK (kra_pin IS NULL OR kra_pin ~ '^[A-Z][0-9]{9}[A-Z]$');
  END IF;
END $kra$;
COMMENT ON COLUMN public.customers.kra_pin IS 'A595: the customer''s KRA PIN (A123456789Z), personal and tax data - shown to holders of customers.contacts.';

-- ── D1: built-in Cashier and Waiter roles add customers ──────────────────────────────────────────────────────────────
DO $d1$ BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '177_d1_customers_add') THEN
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'customers.edit'
   WHERE r.is_default AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('cashier', 'waiter')
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  INSERT INTO public.schema_migrations (version, notes) VALUES ('177_d1_customers_add', 'A595 D1: built-in Cashier and Waiter add customers (contacts and history kept)');
END IF;
END $d1$;

-- ── D2: "Change cost prices" off built-in Auditor and Storekeeper ────────────────────────────────────────────────────
DO $d2$ BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '177_d2_costs_edit') THEN
  DELETE FROM public.role_permissions rp USING public.permissions p, public.roles r
   WHERE rp.permission_id = p.id AND r.id = rp.role_id AND r.is_default
     AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('auditor', 'storekeeper')
     AND p.key = 'menu.costs_edit';
  INSERT INTO public.schema_migrations (version, notes) VALUES ('177_d2_costs_edit', 'A595 D2: Change cost prices off built-in Auditor and Storekeeper');
END IF;
END $d2$;

-- ── D3: webhooks and report e-mails off every role but the owner's ───────────────────────────────────────────────────
DO $d3$ BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '177_d3_data_out') THEN
  DELETE FROM public.role_permissions rp USING public.permissions p, public.roles r
   WHERE rp.permission_id = p.id AND r.id = rp.role_id AND lower(trim(r.name)) NOT IN ('owner', 'admin')
     AND p.key IN ('settings.webhooks', 'settings.report_emails');
  INSERT INTO public.schema_migrations (version, notes) VALUES ('177_d3_data_out', 'A595 D3: webhooks the owner''s; report e-mails the owner''s and partners''');
END IF;
END $d3$;

-- ── D5: fuel deliveries and pump / tank set-up off built-in Cashier and Fuel attendant ───────────────────────────────
DO $d5$ BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '177_d5_fuel') THEN
  DELETE FROM public.role_permissions rp USING public.permissions p, public.roles r
   WHERE rp.permission_id = p.id AND r.id = rp.role_id AND r.is_default
     AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('cashier', 'fuel attendant')
     AND p.key IN ('fuel.deliveries', 'fuel.setup');
  INSERT INTO public.schema_migrations (version, notes) VALUES ('177_d5_fuel', 'A595 D5: fuel deliveries and set-up off built-in Cashier and Fuel attendant');
END IF;
END $d5$;

-- ── D6: typed discounts off built-in Cashier (set-up discounts and promo codes stay) ─────────────────────────────────
DO $d6$ BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '177_d6_typed_discount') THEN
  DELETE FROM public.role_permissions rp USING public.permissions p, public.roles r
   WHERE rp.permission_id = p.id AND r.id = rp.role_id AND r.is_default
     AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') = 'cashier'
     AND p.key = 'sales.discount';
  INSERT INTO public.schema_migrations (version, notes) VALUES ('177_d6_typed_discount', 'A595 D6: typed discounts off built-in Cashier');
END IF;
END $d6$;

-- ── D8: roles that relied on Overview for the sales and item reports keep them ───────────────────────────────────────
DO $d8$ BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '177_d8_overview') THEN
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, n.id
    FROM public.role_permissions rp
    JOIN public.permissions o ON o.id = rp.permission_id AND o.key = 'reports.overview'
    JOIN public.roles r ON r.id = rp.role_id
    JOIN public.permissions n ON n.key IN ('reports.sales', 'reports.items')
   WHERE lower(trim(r.name)) NOT IN ('owner', 'admin')
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  INSERT INTO public.schema_migrations (version, notes) VALUES ('177_d8_overview', 'A595 D8: Overview is today''s page; roles that had only Overview keep the sales and item reports');
END IF;
END $d8$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('177_permission_default_changes', 'A595: the owner''s decisions D1 (customers kept, KRA PIN), D2, D3, D5, D6 on the default rights.')
ON CONFLICT (version) DO NOTHING;
