-- =============================================================================
-- SwiftPOS — Enable RLS on every remaining public table (audit C1)
-- =============================================================================
-- Only 14 tables had RLS enabled before this migration (see the FOREACH loop
-- in swiftpos_consolidated_migration.sql). Everything else -- orders, payments,
-- customers, users, businesses, products, shifts, and 60+ others -- had none.
-- The anon key ships in every JS bundle; without RLS, anyone holding it could
-- read or Realtime-stream every tenant's data straight from PostgREST/Realtime,
-- with no login required at all. This was live and exploitable, not theoretical
-- -- apps/dashboard/src/pages/OverviewPage.tsx already runs a raw Realtime
-- subscription on `orders` using that exact anon key.
--
-- This does NOT affect the Express API. Every route uses the service_role key
-- (see apps/server/src/lib/supabase.ts), which bypasses RLS by definition --
-- these policies are invisible to it. The only thing on the anon/authenticated
-- path today is apps/dashboard/src/lib/supabase.ts, used for exactly two
-- Realtime subscriptions (OverviewPage's live ticker, KDSPage). Both already
-- have a polling fallback that keeps working regardless (60s and 30s), so nothing
-- breaks outright -- see the accompanying dashboard note for what to expect.
--
-- Policy convention: reuses the exact pattern the existing 14 tables already
-- use -- a single "owner_all" policy (FOR ALL) scoped to
--   business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
-- auth.uid() is only non-null for a real Supabase Auth session (the owner
-- login path, apps/dashboard/src/pages/LoginPage.tsx). Staff/PIN logins never
-- create a Supabase session, so they get nothing here -- exactly as intended,
-- since staff access goes through the Express API (service_role), not direct
-- Supabase client calls.
--
-- Four groups below:
--   1. Tables with a business_id column directly -> owner_all, direct.
--   2. Tables without one, scoped via a parent table -> owner_all, joined.
--   3. Platform/sensitive tables (internal admin/tech tooling, session
--      tokens, API secrets) -- even the owner should not get direct
--      self-service read access to these, confirmed with the business
--      owner -> RLS enabled, NO policy at all. Only service_role can touch them.
--   4. businesses itself -- self-referential (owner_id = auth.uid()).
-- =============================================================================

-- ─── 1. Direct business_id column ───────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_log',
    'branches',
    'categories',
    'customer_credit_transactions',
    'customers',
    'discounts',
    'etims_branch_config',
    'etims_invoices',
    'feature_flags',
    'goods_received_notes',
    'ingredient_stock_levels',
    'invoices',
    'loyalty_transactions',
    'mode_switch_requests',
    'notifications',
    'onboarding_progress',
    'orders',
    'payments',
    'products',
    'purchase_orders',
    'receipt_templates',
    'roles',
    'shifts',
    'stock_adjustments',
    'stock_transfers',
    'subscriptions',
    'suppliers',
    'tables',
    'user_devices',
    'users',
    'webhooks',
    'whatsapp_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL USING (
         business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))', t);
  END LOOP;
END $$;

-- ─── 2. Scoped via a parent table (no business_id column of their own) ─────

ALTER TABLE public.combo_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.combo_items;
CREATE POLICY owner_all ON public.combo_items FOR ALL USING (
  combo_id IN (SELECT id FROM public.products WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.float_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.float_transactions;
CREATE POLICY owner_all ON public.float_transactions FOR ALL USING (
  branch_id IN (SELECT id FROM public.branches WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.grn_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.grn_items;
CREATE POLICY owner_all ON public.grn_items FOR ALL USING (
  grn_id IN (SELECT id FROM public.goods_received_notes WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.kitchen_tickets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.kitchen_tickets;
CREATE POLICY owner_all ON public.kitchen_tickets FOR ALL USING (
  branch_id IN (SELECT id FROM public.branches WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.modifier_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.modifier_groups;
CREATE POLICY owner_all ON public.modifier_groups FOR ALL USING (
  product_id IN (SELECT id FROM public.products WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.modifier_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.modifier_options;
CREATE POLICY owner_all ON public.modifier_options FOR ALL USING (
  modifier_group_id IN (SELECT id FROM public.modifier_groups WHERE product_id IN (SELECT id FROM public.products WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())))
);

ALTER TABLE public.order_item_modifiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.order_item_modifiers;
CREATE POLICY owner_all ON public.order_item_modifiers FOR ALL USING (
  order_item_id IN (SELECT id FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())))
);

ALTER TABLE public.order_item_variants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.order_item_variants;
CREATE POLICY owner_all ON public.order_item_variants FOR ALL USING (
  order_item_id IN (SELECT id FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())))
);

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.order_items;
CREATE POLICY owner_all ON public.order_items FOR ALL USING (
  order_id IN (SELECT id FROM public.orders WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.printer_stations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.printer_stations;
CREATE POLICY owner_all ON public.printer_stations FOR ALL USING (
  branch_id IN (SELECT id FROM public.branches WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.printer_template_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.printer_template_assignments;
CREATE POLICY owner_all ON public.printer_template_assignments FOR ALL USING (
  receipt_template_id IN (SELECT id FROM public.receipt_templates WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.purchase_order_items;
CREATE POLICY owner_all ON public.purchase_order_items FOR ALL USING (
  purchase_order_id IN (SELECT id FROM public.purchase_orders WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.role_permissions;
CREATE POLICY owner_all ON public.role_permissions FOR ALL USING (
  role_id IN (SELECT id FROM public.roles WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.stock;
CREATE POLICY owner_all ON public.stock FOR ALL USING (
  branch_id IN (SELECT id FROM public.branches WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.stock_levels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.stock_levels;
CREATE POLICY owner_all ON public.stock_levels FOR ALL USING (
  branch_id IN (SELECT id FROM public.branches WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.stock_movements;
CREATE POLICY owner_all ON public.stock_movements FOR ALL USING (
  branch_id IN (SELECT id FROM public.branches WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.stock_transfer_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.stock_transfer_items;
CREATE POLICY owner_all ON public.stock_transfer_items FOR ALL USING (
  transfer_id IN (SELECT id FROM public.stock_transfers WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.sync_log;
CREATE POLICY owner_all ON public.sync_log FOR ALL USING (
  branch_id IN (SELECT id FROM public.branches WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.sync_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.sync_queue;
CREATE POLICY owner_all ON public.sync_queue FOR ALL USING (
  branch_id IN (SELECT id FROM public.branches WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.user_branches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.user_branches;
CREATE POLICY owner_all ON public.user_branches FOR ALL USING (
  user_id IN (SELECT id FROM public.users WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.user_permissions;
CREATE POLICY owner_all ON public.user_permissions FOR ALL USING (
  user_id IN (SELECT id FROM public.users WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.variant_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.variant_groups;
CREATE POLICY owner_all ON public.variant_groups FOR ALL USING (
  product_id IN (SELECT id FROM public.products WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

ALTER TABLE public.variant_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.variant_options;
CREATE POLICY owner_all ON public.variant_options FOR ALL USING (
  variant_group_id IN (SELECT id FROM public.variant_groups WHERE product_id IN (SELECT id FROM public.products WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())))
);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.webhook_deliveries;
CREATE POLICY owner_all ON public.webhook_deliveries FOR ALL USING (
  webhook_id IN (SELECT id FROM public.webhooks WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
);

-- ─── 3. Platform/sensitive tables — RLS enabled, deliberately NO policy ────
-- No owner_all here on purpose (confirmed with the business owner): these are
-- either internal SwiftPOS tooling/audit trails about a client (not the
-- client's own data to browse) or things where direct read access is a risk
-- even within one tenant (refresh_tokens = live session hijack capability,
-- api_keys = secrets). RLS enabled + zero policies = default-deny for
-- anon/authenticated; only service_role can ever read these.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'admin_audit_log',
    'admin_client_notes',
    'admin_users',
    'api_keys',
    'permissions',
    'plans',
    'refresh_tokens',
    'tech_access_tokens',
    'tech_approval_flags',
    'tech_audit_log',
    'usage_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ─── 4. businesses — self-referential ───────────────────────────────────────
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.businesses;
CREATE POLICY owner_all ON public.businesses FOR ALL USING (
  owner_id = auth.uid()
);
