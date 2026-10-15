-- =============================================================================
-- 134_permission_catalogue.sql — A490: one catalogue of fine permissions, set in one place
--
-- Owner, 2026-10-14/15: "turn most of this features into permissions which can be set in one place … each report …
-- a permission … dont just focus on reports break even other views and how to limit what users see".
--
-- The catalogue is shared/permissions.ts (GENERATED FROM IT — scripts/test-migration-134.mjs fails if they drift).
-- What this does, all idempotent:
--   1. Registers every FINE key (label / group / description), refreshing the words of keys that already exist; the
--      broad keys it replaces are relabelled "(replaced)" and moved to module 'legacy'.
--   2. Rewrites every role's grants: each broad key (reports.view, reports.financial, orders.void, shifts.manage,
--      products.manage, customers.manage, staff.manage, settings.manage) becomes the fine keys it stood for — measured
--      from what each allowed anywhere in the code, so nobody gains or loses anything — and the broad rows go.
--   3. Per-person overrides likewise (a broad key taken away becomes those fine keys taken away).
--   4. What had NO check before A490 goes to the roles that had it in practice:
--        - sales.discount                     → every role that can sell (orders.create)
--        - sales.history_all                  → every role that can sell — but where the business had the POS switch
--                                               "cashiers see only their own sales" on, only roles that confirm drawers
--        - shifts.cash_movements              → the same, with the switch "only managers record expenses and cash"
--        - staff.view, reservations.manage, parking.manage, fuel.manage → every role
--      and those two switches are switched off: the role decides now (the owner sets it per role).
--   5. Owners' own database sessions (Supabase, RLS) may READ feature_flags and businesses but no longer write them —
--      the cloud writes them, after checking permissions and what only the admin may set (themes, web hosting, the
--      approved till version, licences). Nothing in the apps writes these tables directly (checked 2026-10-15).
--   6. Records 134_permission_catalogue: from then on the cloud stops giving everyone the formerly-unchecked keys.
--
-- Note: role_permissions / user_permissions triggers bump users.permissions_version — every person's token is renewed
-- once (PERMISSIONS_CHANGED → refresh), and comes back with the fine keys.
-- =============================================================================

-- ─── 1. The fine keys ────────────────────────────────────────────────────────
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('orders.create', 'Sell', 'selling', 'Ring up sales, hold and recall bills, send orders to the kitchen and take payment'),
  ('sales.discount', 'Give discounts', 'selling', 'Give a discount on a sale, up to the business''s discount limit'),
  ('sales.void', 'Void sales', 'selling', 'Void a sale within the void window (with a reason)'),
  ('sales.refund', 'Refund sales', 'selling', 'Refund a completed sale (with a reason)'),
  ('sales.reprint', 'Reprint receipts', 'selling', 'Reprint a receipt from the sales history'),
  ('sales.history_all', 'See every cashier''s sales', 'selling', 'The sales history shows every cashier''s sales, not only their own'),
  ('invoice.create', 'Raise invoices', 'selling', 'Raise an invoice for an order or a customer'),
  ('shifts.cash_movements', 'Cash in, cash out and drawer expenses', 'drawer', 'Record money into or out of their drawer and expenses paid from it (cash out and expenses still need an approver)'),
  ('shifts.confirm', 'Approve with their PIN', 'drawer', 'Approve cash out, expenses and removing items sent to the kitchen, confirm cashiers'' drawers and see the expected cash'),
  ('shifts.force_close', 'Force-close a drawer', 'drawer', 'Close another person''s drawer without a cash count (it shows as unreconciled)'),
  ('shifts.close_day', 'Close the day and the branch', 'drawer', 'Close the trading day on a till, and Close Branch on the branch server'),
  ('reports.overview', 'Overview', 'reports', 'The Overview page: today''s sales, orders and open drawers'),
  ('reports.sales', 'Sales reports', 'reports', 'Master / DSR, daily and hourly sales, payment methods and order channels'),
  ('reports.items', 'Item mix and menu matrix', 'reports', 'What sold, by product and category'),
  ('reports.staff', 'Staff performance', 'reports', 'Sales, voids and refunds by cashier'),
  ('reports.shifts', 'Shift reports and Z-reports', 'reports', 'Each drawer''s report: expected cash, counted cash and the difference'),
  ('reports.voids', 'Voids, refunds and exceptions', 'reports', 'Voids and refunds, price differences on offline sales and other exceptions'),
  ('reports.inventory', 'Inventory report', 'reports', 'Stock movement and value over a period'),
  ('reports.fuel', 'Fuel reports', 'reports', 'Fuel sales, wet stock and the pump monitor'),
  ('reports.tax', 'Tax report', 'reports', 'VAT and levy by branch and category, and eTIMS invoices'),
  ('reports.costs', 'Costs, margins and profit', 'reports', 'Food cost, cost prices, margins, net profit and profit and loss'),
  ('reports.labour', 'Labour cost', 'reports', 'Sales per labour hour and labour cost'),
  ('reports.monthly_pack', 'Monthly pack', 'reports', 'The monthly books: daily sales, expenses, cash and M-Pesa books'),
  ('reports.payments', 'Payment exceptions', 'reports', 'M-Pesa payments that did not match a sale'),
  ('reports.export', 'Download reports', 'reports', 'Download Excel and the exports (sales, items, shifts, profit and loss, expenses, audit)'),
  ('orders.view_all', 'Orders, shifts and turnover pages', 'orders', 'See every order of the branch, its shifts and table turnover'),
  ('products.view', 'See the menu', 'menu', 'Read the menu and its prices'),
  ('menu.edit', 'Edit the menu', 'menu', 'Add and change products, categories, variants, choices, extras and combos'),
  ('menu.prices', 'Change prices', 'menu', 'Change selling prices, branch prices and bulk prices'),
  ('menu.offers', 'Discounts and offers', 'menu', 'Set up discounts, promotions and offers'),
  ('menu.recipes', 'Recipes and packaging', 'menu', 'What each product uses from stock'),
  ('menu.costs', 'See cost prices', 'menu', 'Cost prices and margins wherever they appear (menu, deliveries, stock)'),
  ('inventory.view', 'See stock levels', 'stock', 'Stock levels of the branch'),
  ('inventory.receive', 'Receive deliveries', 'stock', 'Suppliers, purchase orders and receiving deliveries'),
  ('inventory.transfer', 'Transfer stock', 'stock', 'Send stock to another branch and receive transfers'),
  ('inventory.count', 'Count stock', 'stock', 'Take part in a stock count (they never see the expected figure)'),
  ('inventory.waste', 'Record wastage', 'stock', 'Write off spoiled, expired or damaged stock, with a reason'),
  ('inventory.adjust', 'Adjust stock', 'stock', 'Change a stock figure by hand, review counts and close batches'),
  ('ingredients.manage', 'Ingredient list', 'stock', 'Add and change ingredients'),
  ('payables.manage', 'Supplier bills and payments', 'stock', 'What is owed to suppliers, their bills and paying them'),
  ('customers.view', 'See customers', 'customers', 'Customer records, points and credit balances'),
  ('customers.edit', 'Add and edit customers', 'customers', 'Add customers and change their details'),
  ('customers.credit', 'Customer credit', 'customers', 'Set credit limits, record repayments and adjust balances'),
  ('expenses.view', 'See expenses', 'expenses', 'The expenses list and its totals'),
  ('expenses.manage', 'Record expenses', 'expenses', 'Record, change and remove expenses and expense types, and record entries in the monthly pack'),
  ('staff.view', 'See staff', 'staff', 'The staff list of their branch'),
  ('staff.edit', 'Add and edit staff', 'staff', 'Add staff, set PINs and branches, and deactivate staff — never with more rights than they hold themselves'),
  ('staff.roles', 'Roles and permissions', 'staff', 'Change what each role may see and do — never beyond what they hold themselves'),
  ('reservations.manage', 'Reservations and waitlist', 'front', 'Take and change reservations and the waitlist'),
  ('parking.manage', 'Parking', 'front', 'Open, close and void parking tickets'),
  ('fuel.manage', 'Fuel pumps and tanks', 'front', 'Set pumps active or idle, record tank deliveries and set up pumps and tanks'),
  ('settings.business', 'Business settings', 'settings', 'Business profile, receipt and history rules, opening hours and tax rates'),
  ('settings.branches', 'Branches', 'settings', 'Branch details and each branch''s own settings'),
  ('settings.payments', 'Payment methods', 'settings', 'Which payment methods each branch takes, and the business''s own methods'),
  ('settings.integrations', 'Integrations', 'settings', 'Webhooks, QR ordering and scheduled report emails'),
  ('settings.pos', 'POS options', 'settings', 'How the tills work: delivery fee and rider, pay later, pay before kitchen, sign-in codes and loyalty'),
  ('settings.updates', 'Till updates', 'settings', 'Approve or hold the version of ZapTill the tills install'),
  ('receipt.manage', 'Receipt text', 'settings', 'The receipt''s header and footer lines'),
  ('stations.manage', 'Printers and print stations', 'settings', 'Printers, kitchen and bar stations and what prints where'),
  ('tables.manage', 'Tables and zones', 'settings', 'The dining tables and floor zones'),
  ('devices.approve', 'Tills and devices', 'settings', 'Approve, rename, retire and remove tills'),
  ('etims.manage', 'eTIMS / KRA', 'settings', 'eTIMS set-up and KRA device registration'),
  ('changes.approve', 'Approve till changes', 'settings', 'Approve or refuse menu and staff changes made on a till')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

UPDATE public.permissions
   SET module = 'legacy',
       label  = CASE WHEN label LIKE '%(replaced)' THEN label ELSE label || ' (replaced)' END
 WHERE key IN ('reports.view', 'reports.financial', 'orders.void', 'shifts.manage', 'products.manage', 'customers.manage', 'staff.manage', 'settings.manage');

-- ─── 2–3. Broad keys → the fine keys they stood for ─────────────────────────
-- The broad key → fine key pairs (shared/permissions.ts LEGACY) are inline in each statement below.

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, pf.id
  FROM public.role_permissions rp
  JOIN public.permissions pl ON pl.id = rp.permission_id
  JOIN (VALUES
  ('reports.view', 'reports.overview'),
  ('reports.view', 'reports.sales'),
  ('reports.view', 'reports.items'),
  ('reports.view', 'reports.staff'),
  ('reports.view', 'reports.shifts'),
  ('reports.view', 'reports.voids'),
  ('reports.view', 'reports.inventory'),
  ('reports.view', 'reports.fuel'),
  ('reports.financial', 'reports.tax'),
  ('reports.financial', 'reports.costs'),
  ('reports.financial', 'reports.labour'),
  ('reports.financial', 'reports.monthly_pack'),
  ('reports.financial', 'reports.payments'),
  ('reports.financial', 'reports.export'),
  ('orders.void', 'sales.void'),
  ('orders.void', 'sales.refund'),
  ('orders.void', 'shifts.confirm'),
  ('orders.void', 'sales.reprint'),
  ('shifts.manage', 'shifts.confirm'),
  ('products.manage', 'menu.edit'),
  ('products.manage', 'menu.prices'),
  ('products.manage', 'menu.offers'),
  ('products.manage', 'menu.recipes'),
  ('products.manage', 'menu.costs'),
  ('products.manage', 'settings.payments'),
  ('products.manage', 'stations.manage'),
  ('customers.manage', 'customers.edit'),
  ('customers.manage', 'customers.credit'),
  ('staff.manage', 'staff.view'),
  ('staff.manage', 'staff.edit'),
  ('staff.manage', 'staff.roles'),
  ('settings.manage', 'settings.business'),
  ('settings.manage', 'settings.branches'),
  ('settings.manage', 'settings.payments'),
  ('settings.manage', 'settings.integrations'),
  ('settings.manage', 'receipt.manage'),
  ('settings.manage', 'stations.manage'),
  ('settings.manage', 'tables.manage'),
  ('settings.manage', 'devices.approve'),
  ('settings.manage', 'etims.manage'),
  ('settings.manage', 'changes.approve'),
  ('settings.manage', 'shifts.force_close'),
  ('settings.manage', 'shifts.close_day'),
  ('settings.manage', 'shifts.confirm'),
  ('settings.manage', 'sales.reprint')
  ) AS m(legacy, fine)       ON m.legacy = pl.key
  JOIN public.permissions pf ON pf.key = m.fine
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- A person's override of a broad key becomes the same override of each fine key — unless they already have their own
-- override of that fine key (it wins, as it was the more specific).
INSERT INTO public.user_permissions (user_id, permission_id, granted)
SELECT DISTINCT ON (up.user_id, pf.id) up.user_id, pf.id, up.granted
  FROM public.user_permissions up
  JOIN public.permissions pl ON pl.id = up.permission_id
  JOIN (VALUES
  ('reports.view', 'reports.overview'),
  ('reports.view', 'reports.sales'),
  ('reports.view', 'reports.items'),
  ('reports.view', 'reports.staff'),
  ('reports.view', 'reports.shifts'),
  ('reports.view', 'reports.voids'),
  ('reports.view', 'reports.inventory'),
  ('reports.view', 'reports.fuel'),
  ('reports.financial', 'reports.tax'),
  ('reports.financial', 'reports.costs'),
  ('reports.financial', 'reports.labour'),
  ('reports.financial', 'reports.monthly_pack'),
  ('reports.financial', 'reports.payments'),
  ('reports.financial', 'reports.export'),
  ('orders.void', 'sales.void'),
  ('orders.void', 'sales.refund'),
  ('orders.void', 'shifts.confirm'),
  ('orders.void', 'sales.reprint'),
  ('shifts.manage', 'shifts.confirm'),
  ('products.manage', 'menu.edit'),
  ('products.manage', 'menu.prices'),
  ('products.manage', 'menu.offers'),
  ('products.manage', 'menu.recipes'),
  ('products.manage', 'menu.costs'),
  ('products.manage', 'settings.payments'),
  ('products.manage', 'stations.manage'),
  ('customers.manage', 'customers.edit'),
  ('customers.manage', 'customers.credit'),
  ('staff.manage', 'staff.view'),
  ('staff.manage', 'staff.edit'),
  ('staff.manage', 'staff.roles'),
  ('settings.manage', 'settings.business'),
  ('settings.manage', 'settings.branches'),
  ('settings.manage', 'settings.payments'),
  ('settings.manage', 'settings.integrations'),
  ('settings.manage', 'receipt.manage'),
  ('settings.manage', 'stations.manage'),
  ('settings.manage', 'tables.manage'),
  ('settings.manage', 'devices.approve'),
  ('settings.manage', 'etims.manage'),
  ('settings.manage', 'changes.approve'),
  ('settings.manage', 'shifts.force_close'),
  ('settings.manage', 'shifts.close_day'),
  ('settings.manage', 'shifts.confirm'),
  ('settings.manage', 'sales.reprint')
  ) AS m(legacy, fine)       ON m.legacy = pl.key
  JOIN public.permissions pf ON pf.key = m.fine
 ORDER BY up.user_id, pf.id, up.granted ASC          -- a key taken away by any broad override stays taken away
ON CONFLICT (user_id, permission_id) DO NOTHING;

-- ─── 4. What had no check before ────────────────────────────────────────────
-- ONCE: only on the first run (the switches below are off after it, so a second run would read "never limited" and
-- give limited cashiers what the business had kept from them). Steps 1–3 and 5 are safe to repeat.
DO $a490$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '134_permission_catalogue') THEN
-- Roles that could sell.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r
  JOIN public.permissions p ON p.key = 'sales.discount'
 WHERE EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions k ON k.id = x.permission_id
                WHERE x.role_id = r.id AND k.key = 'orders.create')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- sales.history_all / shifts.cash_movements: every role that can sell, unless the business limited cashiers with the
-- switch — then only roles that confirm drawers (what "a manager" meant to that switch). The owner's role always.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r
  JOIN (VALUES ('sales.history_all', 'cashier_own_history'), ('shifts.cash_movements', 'cashier_no_money_out')) AS s(perm, flag) ON true
  JOIN public.permissions p ON p.key = s.perm
 WHERE lower(trim(r.name)) IN ('owner', 'admin')
    OR (EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions k ON k.id = x.permission_id
                 WHERE x.role_id = r.id AND k.key = 'orders.create')
        AND (NOT EXISTS (SELECT 1 FROM public.feature_flags f
                          WHERE f.business_id = r.business_id AND f.key = s.flag AND f.enabled)
             OR EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions k ON k.id = x.permission_id
                         WHERE x.role_id = r.id AND k.key = 'shifts.confirm')))
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Every role.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r
  JOIN public.permissions p ON p.key IN ('staff.view', 'reservations.manage', 'parking.manage', 'fuel.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

END IF;
END $a490$;

-- The owner's role holds every fine key (the cloud treats it as everything anyway; the rows keep the screen honest).
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r
  JOIN public.permissions p ON p.module <> 'legacy'
 WHERE lower(trim(r.name)) IN ('owner', 'admin')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- The broad rows go (grants and overrides).
DELETE FROM public.role_permissions rp USING public.permissions p
 WHERE rp.permission_id = p.id AND p.key IN ('reports.view', 'reports.financial', 'orders.void', 'shifts.manage', 'products.manage', 'customers.manage', 'staff.manage', 'settings.manage');
DELETE FROM public.user_permissions up USING public.permissions p
 WHERE up.permission_id = p.id AND p.key IN ('reports.view', 'reports.financial', 'orders.void', 'shifts.manage', 'products.manage', 'customers.manage', 'staff.manage', 'settings.manage');

-- The two switches the roles now decide (after the grants above read them).
UPDATE public.feature_flags
   SET enabled = false,
       notes   = trim(both ' ' FROM coalesce(notes, '') || ' A490: now a per-role permission (Roles and permissions).')
 WHERE key IN ('cashier_own_history', 'cashier_no_money_out') AND enabled;

-- ─── 5. Owners' database sessions read these two tables, never write them ───
-- EVERY policy on the two tables that lets anything but a read goes, whatever it is called (the baseline also has
-- "owner can update business" and "owner can insert business"; production may hold others). Reads stay.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies
            WHERE schemaname = 'public' AND tablename IN ('businesses', 'feature_flags') AND cmd <> 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;
DROP POLICY IF EXISTS owner_read ON public.feature_flags;
CREATE POLICY owner_read ON public.feature_flags FOR SELECT USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
DROP POLICY IF EXISTS owner_read ON public.businesses;
CREATE POLICY owner_read ON public.businesses FOR SELECT USING (owner_id = auth.uid());

-- ─── 6. Recorded ─────────────────────────────────────────────────────────────
INSERT INTO public.schema_migrations (version, notes)
VALUES ('134_permission_catalogue',
        'A490: the fine permission catalogue (shared/permissions.ts) registered; every role''s and person''s broad grants rewritten into the fine keys they stood for; formerly-unchecked actions granted to the roles that had them (the cashier history / money switches become per-role permissions and are switched off); owners'' DB sessions read-only on feature_flags and businesses.')
ON CONFLICT (version) DO NOTHING;
