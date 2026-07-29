-- =============================================================================
-- SwiftPOS — schema_migrations tracking table
-- =============================================================================
-- WHY THIS EXISTS
--   There has never been a way to ask the database what has been applied. That
--   is how migrations 19 and 20 went missing without anyone noticing, and why
--   SCHEMA_AUDIT.md had to infer applied-state from artefacts — archaeology
--   rather than a query.
--
--   Run this immediately after 00_baseline.sql. The backfill below records the
--   exact state captured in the baseline, verified against the 2026-07-28 dump.
--
-- USAGE
--   Applied list:  select version from public.schema_migrations order by version;
--   Outstanding:   compare that list against ls migrations/*.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version     text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text        NOT NULL DEFAULT current_user,
  notes       text
);

COMMENT ON TABLE public.schema_migrations IS
  'One row per applied migration file. Insert a row as the last statement of every migration.';

ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

-- Service role only. No tenant should read or write migration state.
DROP POLICY IF EXISTS schema_migrations_service_only ON public.schema_migrations;
CREATE POLICY schema_migrations_service_only ON public.schema_migrations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Backfill: state as captured in 00_baseline.sql ───────────────────────────
-- Verified individually against the dump: each migration's artefact (table or
-- column) was checked for existence. 19 and 20 are deliberately absent.
INSERT INTO public.schema_migrations (version, notes) VALUES
  ('00_baseline',                      'Full schema, generated from dev DB dump 2026-07-28'),
  ('swiftpos_consolidated_migration',  'folded into baseline'),
  ('universal_business_types',         'folded into baseline'),
  ('pos_migration_v26_expenses',       'folded into baseline'),
  ('pos_migration_v27_ingredients',    'folded into baseline'),
  ('pos_migration_v28_recipes',        'folded into baseline'),
  ('pos_migration_v29_printers',       'folded into baseline'),
  ('pos_migration_v30_pieces_and_reports', 'folded into baseline'),
  ('all_phases_migration',             'folded into baseline'),
  ('admin_portal',                     'folded into baseline'),
  ('tech_access',                      'folded into baseline'),
  ('01_promotions',                    'verified: table promotions'),
  ('02_hourly_rate',                   'verified: users.hourly_rate'),
  ('03_clock_events',                  'verified: table clock_events'),
  ('04_combos',                        'verified: table combo_items'),
  ('05_reservations',                  'verified: table reservations'),
  ('06_qr_ordering',                   'verified: table kitchen_tickets'),
  ('07_hotel_features',                'folded into baseline'),
  ('08_etims',                         'verified: table etims_invoices'),
  ('09_customer_credit',               'verified: table customer_credit_transactions'),
  ('10_shift_denominations',           'verified: shifts.denomination_breakdown'),
  ('11_restaurant_dinein',             'folded into baseline'),
  ('12_tips_whatsapp',                 'verified: orders.tip_amount'),
  ('13_auth_sessions',                 'verified: table refresh_tokens'),
  ('14_device_registration',           'verified: table user_devices'),
  ('15_pump_tank_link',                'folded into baseline'),
  ('16_override_pin',                  'verified: users.override_pin_hash'),
  ('17_order_device_id',               'verified: orders.device_id'),
  ('18_web_access_remodel',            'folded into baseline'),
  -- 19_branch_reveal_code  NOT APPLIED
  -- 20_branch_prices       NOT APPLIED
  ('21_mpesa_payment_tracking',        'verified: payments.mpesa_checkout_id'),
  ('22_shift_close_and_float',         'verified: table float_transactions'),
  ('23_per_branch_ingredient_stock',   'verified: table ingredient_stock_levels'),
  ('24_inventory_permissions',         'folded into baseline'),
  ('25_variant_stock_and_packaging',   'verified: table product_packaging'),
  ('26_variant_linked_ingredient',     'folded into baseline'),
  ('27_report_permissions',            'folded into baseline'),
  ('28_ingredient_cost_audit',         'verified: table ingredient_cost_history'),
  ('29_enable_rls_all_tables',         'verified: RLS on 85/85 tables, 94 policies'),
  ('30_payment_exceptions',            'verified: table payment_exceptions'),
  ('33_catering_levy',                 'verified: businesses.ctl_rate, orders.ctl_amount'),
  ('34_kitchen_categories',            'verified: categories.is_kitchen'),
  ('35_delivery_person',               'verified: orders.delivery_person'),
  ('36_device_app_version',            'verified: user_devices.app_version'),
  ('37_refunds',                       'verified: orders.refunded_at'),
  ('38_product_kitchen_override',      'verified: products.is_kitchen')
ON CONFLICT (version) DO NOTHING;

-- Numbers 31 and 32 were never written. Recorded so the gap is not mistaken
-- for a lost migration by whoever next reads this folder.
INSERT INTO public.schema_migrations (version, notes) VALUES
  ('31_SKIPPED', 'number never used'),
  ('32_SKIPPED', 'number never used')
ON CONFLICT (version) DO NOTHING;

INSERT INTO public.schema_migrations (version, notes) VALUES
  ('01_schema_migrations', 'this file')
ON CONFLICT (version) DO NOTHING;
