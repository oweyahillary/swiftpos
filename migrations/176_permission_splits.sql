-- 176_permission_splits.sql — A595
--
-- Owner, 2026-10-26: "implement the changes and break down any right that you feel is too big and exposes data — some can
-- be broken down to view and edit etc. I leave you working on user rights fully." The design is docs/PERMISSIONS-AUDIT.md;
-- this is its SAFE part: nobody gains or loses anything on the day it runs.
--
-- Registered (idempotent: re-running updates the words only, which follow shared/permissions.ts word for word — the
-- 36 new keys below). 35 of them are PARTS of a key that exists (shared/permissions.ts SPLITS): the parent keeps its name
-- and what a 1.0.21 desktop POS checks by it; the cloud checks the part. The 36th, customers.credit_limit, replaces a rule
-- by role NAME (lib/creditApprovers.ts, A585 / A587: the built-in Manager and General Manager roles set credit limits).
--
-- Carried over ONCE (guarded by its own schema_migrations row), so what a person may do the day after equals the day before:
--   1. every role holding a parent gets all of its parts (inventory.reorder: a part of receiving AND of adjusting stock;
--      staff.contacts: of seeing AND of editing staff — a role holding either gets it);
--   2. every person with an override (Staff › This person's permissions) of a parent gets the same override of each part —
--      a given parent becomes given parts, a taken-away parent taken-away parts. A part with two parents takes what the
--      person effectively had through either (their override of a parent, else their role's grant of it);
--   3. customers.credit_limit to exactly the roles that set limits today: the BUILT-IN Manager and General Manager roles
--      (is_default, still so named — case, spaces and underscores aside). A custom role merely named Manager does not
--      count, as before. Partners keep setting limits at one of their branches by the A587 rule in the code (owner
--      decision D4, docs/PERMISSIONS-DEFAULTS-177-DRAFT.sql) — they are not given the key here;
--   4. the owner roles (owner / admin) every new key, as every new key always has.
-- Nothing is taken away. No default of an existing role changes — those wait for the owner's decisions D1–D10
-- (docs/PERMISSIONS-DEFAULTS-177-DRAFT.sql). The role_permissions / user_permissions triggers bump permissions_version
-- (tokens renew) and log a staff change for the desktop POS. Until this is recorded the cloud treats every parent as
-- bringing its parts (lib/permissionsState.ts splitsPending), so deploying the code first changes nothing either.
--
-- To see beforehand what each role gets (read-only):
--   WITH pairs(parent, part) AS (VALUES ('customers.view', 'customers.contacts'), ('customers.view', 'customers.history'),
--          ('customers.edit', 'customers.delete'), ('customers.credit', 'customers.credit_payment'),
--          ('customers.credit', 'customers.credit_adjust'), ('staff.view', 'staff.contacts'), ('staff.edit', 'staff.contacts'),
--          ('staff.edit', 'staff.pins'), ('staff.edit', 'staff.access'), ('staff.edit', 'staff.pay'),
--          ('menu.costs', 'menu.costs_edit'), ('menu.edit', 'menu.delete'), ('menu.edit', 'menu.bulk'),
--          ('settings.integrations', 'settings.webhooks'), ('settings.integrations', 'settings.report_emails'),
--          ('fuel.manage', 'fuel.deliveries'), ('fuel.manage', 'fuel.setup'), ('sales.discount', 'sales.discount_preset'),
--          ('shifts.confirm', 'shifts.approve_payout'), ('shifts.confirm', 'sales.approve_kitchen_void'))
--   SELECT b.name AS business, r.name AS role, string_agg(DISTINCT x.part, ', ' ORDER BY x.part) AS gets
--     FROM public.roles r JOIN public.businesses b ON b.id = r.business_id
--     JOIN public.role_permissions rp ON rp.role_id = r.id JOIN public.permissions p ON p.id = rp.permission_id
--     JOIN pairs x ON x.parent = p.key
--    WHERE lower(trim(r.name)) NOT IN ('owner', 'admin')
--    GROUP BY 1, 2 ORDER BY 1, 2;
-- (the list above is the personal-data and money parts; the full list is the VALUES of step 1 below.)
-- And who gets customers.credit_limit:
--   SELECT b.name AS business, r.name AS role FROM public.roles r JOIN public.businesses b ON b.id = r.business_id
--    WHERE r.is_default AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('manager', 'general manager')
--    ORDER BY 1, 2;
-- After it has run, every parent holder holds its parts (expect 0 rows):
--   SELECT r.name, p.key FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
--     JOIN public.permissions p ON p.id = rp.permission_id
--    WHERE p.key IN ('customers.view', 'staff.edit', 'menu.costs', 'fuel.manage', 'shifts.confirm')
--      AND NOT EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions c ON c.id = x.permission_id
--                       WHERE x.role_id = rp.role_id AND c.key = CASE p.key WHEN 'customers.view' THEN 'customers.contacts'
--                         WHEN 'staff.edit' THEN 'staff.pins' WHEN 'menu.costs' THEN 'menu.costs_edit'
--                         WHEN 'fuel.manage' THEN 'fuel.deliveries' ELSE 'shifts.approve_payout' END);

INSERT INTO public.permissions (key, label, module, description) VALUES
  ('sales.discount_preset', 'Apply set-up discounts and promo codes', 'selling', 'Apply a discount or a promo code the business has set up (typing an amount needs Give discounts)'),
  ('sales.approve_kitchen_void', 'Approve removing items sent to the kitchen', 'selling', 'Approve with their PIN taking an item off an order after it was sent to the kitchen or bar'),
  ('shifts.approve_payout', 'Approve cash out and drawer expenses with their PIN', 'drawer', 'Approve with their PIN a cash out, a pay-out or an expense paid from a drawer, and a cash in by someone without Record cash in'),
  ('reports.analytics', 'Analytics', 'reports', 'The Analytics pages: trends, menu engineering, branch comparisons and recommendations (money leaks also need Voids, refunds and exceptions)'),
  ('reports.audit', 'Audit trail', 'reports', 'Download the audit trail of voids, refunds, discounts and other changes, with who made them'),
  ('menu.delete', 'Delete products, categories and menus', 'menu', 'Delete products, categories, menus, variants, choices, extras and combos'),
  ('menu.bulk', 'Bulk changes to the menu', 'menu', 'Import products from a spreadsheet, change the tax or stock tracking of many items at once and generate barcodes'),
  ('menu.costs_edit', 'Change cost prices', 'menu', 'Change the cost price of products, one at a time or many at once'),
  ('suppliers.manage', 'Add, change and remove suppliers', 'stock', 'Supplier records: names, contacts and payment details (seeing the suppliers comes with Receive deliveries)'),
  ('inventory.order', 'Purchase orders', 'stock', 'Raise, change and cancel purchase orders to suppliers'),
  ('inventory.reorder', 'Reorder levels', 'stock', 'Set the low-stock level of products and ingredients'),
  ('inventory.count_review', 'Review and post stock counts', 'stock', 'See the expected figures of a stock count, ask for a recount and post the count to stock'),
  ('payables.pay', 'Pay suppliers', 'stock', 'Record a payment to a supplier and void one'),
  ('customers.contacts', 'See customer phone numbers and e-mails', 'customers', 'Full phone numbers and e-mail addresses wherever customers appear: lists, credit, orders, M-Pesa payers and Analytics (without it they are masked - finding a customer by typing their number still works)'),
  ('customers.history', 'See what a customer bought', 'customers', 'A customer purchases, visits and insights'),
  ('customers.delete', 'Remove customers', 'customers', 'Remove a customer record (also how a request to erase the data of a customer is honoured)'),
  ('customers.credit_payment', 'Record credit repayments', 'customers', 'Record a payment a customer makes towards what they owe on account'),
  ('customers.credit_adjust', 'Adjust or write off credit balances', 'customers', 'Correct the balance of a customer on account or write it off, with a reason'),
  ('customers.credit_limit', 'Set credit limits', 'customers', 'Give, change or remove the credit limit of a customer on account'),
  ('expenses.edit', 'Change or remove recorded expenses', 'expenses', 'Change or remove an expense that was already recorded'),
  ('expenses.types', 'Expense types', 'expenses', 'Add, rename and remove expense types'),
  ('expenses.monthly', 'Monthly pack entries', 'expenses', 'Record and remove entries in the cash and M-Pesa books of the monthly pack'),
  ('staff.contacts', 'See staff phone numbers and e-mails', 'staff', 'Phone numbers and e-mail addresses on the staff list (without it they are hidden)'),
  ('staff.pins', 'Set and reset PINs and sign-in codes', 'staff', 'Set the PIN and the approval PIN of staff and reset their sign-in codes'),
  ('staff.access', 'Give a person their own rights', 'staff', 'Give or take away rights for one person beyond their role - never more than they hold themselves'),
  ('staff.pay', 'Set staff pay rates', 'staff', 'The hourly pay rate of each person'),
  ('parking.void', 'Void parking tickets', 'front', 'Void a parking ticket, with a reason'),
  ('fuel.deliveries', 'Record fuel deliveries', 'front', 'Record a delivery of fuel into a tank'),
  ('fuel.setup', 'Set up pumps and tanks', 'front', 'Add, change and remove pumps and tanks'),
  ('settings.tax', 'Tax rates', 'settings', 'The VAT and levy rates'),
  ('settings.sales_rules', 'Discount limit and selling rules', 'settings', 'The discount limit, continuous operation and how the sales history is shown to cashiers'),
  ('settings.webhooks', 'Webhooks (send sales to another system)', 'settings', 'Send every sale, with customer details, to another system at an address they choose'),
  ('settings.report_emails', 'Scheduled report e-mails', 'settings', 'E-mail reports on a schedule to any address'),
  ('devices.view', 'See the POS devices', 'settings', 'The list of POS devices, their state and the fleet'),
  ('devices.retire', 'Retire, remove or hand over POS devices', 'settings', 'Retire a POS device, bring one back, remove one or authorise a hand-over to new hardware'),
  ('changes.approve_staff', 'Approve staff changes made on a POS', 'settings', 'Approve or refuse new staff and PIN changes made on a POS')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

DO $a595$
DECLARE
  v_roles integer := 0;
  v_people integer := 0;
  v_limits integer := 0;
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '176_permission_splits') THEN
  -- a working list for this block only (dropped at commit; not part of the schema)
  CREATE TEMPORARY TABLE a595_parts (parent text NOT NULL, part text NOT NULL) ON COMMIT DROP;
  INSERT INTO a595_parts (parent, part) VALUES
      ('sales.discount', 'sales.discount_preset'),
      ('shifts.confirm', 'shifts.approve_payout'),
      ('shifts.confirm', 'sales.approve_kitchen_void'),
      ('reports.sales', 'reports.analytics'),
      ('reports.voids', 'reports.audit'),
      ('menu.edit', 'menu.delete'),
      ('menu.edit', 'menu.bulk'),
      ('menu.costs', 'menu.costs_edit'),
      ('inventory.receive', 'suppliers.manage'),
      ('inventory.receive', 'inventory.order'),
      ('inventory.receive', 'inventory.reorder'),
      ('inventory.adjust', 'inventory.count_review'),
      ('inventory.adjust', 'inventory.reorder'),
      ('payables.manage', 'payables.pay'),
      ('customers.view', 'customers.contacts'),
      ('customers.view', 'customers.history'),
      ('customers.edit', 'customers.delete'),
      ('customers.credit', 'customers.credit_payment'),
      ('customers.credit', 'customers.credit_adjust'),
      ('expenses.manage', 'expenses.edit'),
      ('expenses.manage', 'expenses.types'),
      ('expenses.manage', 'expenses.monthly'),
      ('staff.view', 'staff.contacts'),
      ('staff.edit', 'staff.contacts'),
      ('staff.edit', 'staff.pins'),
      ('staff.edit', 'staff.access'),
      ('staff.edit', 'staff.pay'),
      ('parking.manage', 'parking.void'),
      ('fuel.manage', 'fuel.deliveries'),
      ('fuel.manage', 'fuel.setup'),
      ('settings.business', 'settings.tax'),
      ('settings.business', 'settings.sales_rules'),
      ('settings.integrations', 'settings.webhooks'),
      ('settings.integrations', 'settings.report_emails'),
      ('devices.approve', 'devices.view'),
      ('devices.approve', 'devices.retire'),
      ('changes.approve', 'changes.approve_staff');

  -- 1. Every role holding a parent gets its parts (the owner roles too — step 4 gives them everything anyway).
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT DISTINCT rp.role_id, c.id
      FROM public.role_permissions rp
      JOIN public.permissions p ON p.id = rp.permission_id
      JOIN a595_parts x ON x.parent = p.key
      JOIN public.permissions c ON c.key = x.part
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  )
  SELECT count(*) INTO v_roles FROM added;

  -- 2. Every person's own override of a parent, carried to its parts: what they effectively held through each parent
  --    (their override of it, else their role's grant of it) — given or taken alike.
  WITH eff AS (
    SELECT u.id AS user_id, x.part,
           bool_or(COALESCE(up.granted, EXISTS (
             SELECT 1 FROM public.role_permissions rr JOIN public.permissions rk ON rk.id = rr.permission_id
              WHERE rr.role_id = u.role_id AND rk.key = x.parent))) AS held,
           bool_or(up.user_id IS NOT NULL) AS overridden
      FROM public.users u
      JOIN a595_parts x ON true
      JOIN public.permissions pp ON pp.key = x.parent
      LEFT JOIN public.user_permissions up ON up.user_id = u.id AND up.permission_id = pp.id
     WHERE EXISTS (SELECT 1 FROM public.user_permissions o WHERE o.user_id = u.id)
     GROUP BY u.id, x.part
  ), added AS (
    INSERT INTO public.user_permissions (user_id, permission_id, granted)
    SELECT e.user_id, c.id, e.held
      FROM eff e JOIN public.permissions c ON c.key = e.part
     WHERE e.overridden
    ON CONFLICT (user_id, permission_id) DO NOTHING
    RETURNING user_id
  )
  SELECT count(*) INTO v_people FROM added;

  -- 3. Credit limits: exactly the roles the A585 / A587 rule named — the built-in Manager and General Manager.
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, n.id
      FROM public.roles r
      JOIN public.permissions n ON n.key = 'customers.credit_limit'
     WHERE r.is_default = true
       AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g') IN ('manager', 'general manager')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  )
  SELECT count(*) INTO v_limits FROM added;

  -- 4. The owner roles: every new key.
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, n.id
    FROM public.roles r
    JOIN public.permissions n ON n.key IN (SELECT part FROM a595_parts UNION SELECT 'customers.credit_limit')
   WHERE lower(trim(r.name)) IN ('owner', 'admin')
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  RAISE NOTICE 'A595: % role grants and % personal overrides carried to the parts; credit limits to % built-in manager role(s)', v_roles, v_people, v_limits;
END IF;
END $a595$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('176_permission_splits', 'A595: 36 narrower rights (parts of the broad ones, and customers.credit_limit for the role-name rule) - every holder of a parent carried to its parts; no default changed.')
ON CONFLICT (version) DO NOTHING;
