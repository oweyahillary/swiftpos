-- ============================================================================
-- SwiftPOS — Migration verification (READ-ONLY, changes nothing)
-- Run in the Supabase SQL editor. Confirms the parts of migrations 08–12 that a
-- table-only schema dump cannot show: tables, columns, the credit RPC, seed
-- settings, and indexes. Each row returns PASS or **MISSING**.
-- ============================================================================

-- ── A. Tables introduced by migrations 08–12 ────────────────────────────────
SELECT 'TABLE' AS kind, t AS object,
       CASE WHEN to_regclass('public.'||t) IS NOT NULL THEN 'PASS' ELSE '** MISSING **' END AS status
FROM (VALUES
  ('etims_branch_config'),            -- mig 08
  ('etims_invoices'),                 -- mig 08
  ('customer_credit_transactions'),   -- mig 09
  ('whatsapp_deliveries')             -- mig 12
) AS x(t)

UNION ALL
-- ── B. Columns introduced by migrations 08–12 ───────────────────────────────
SELECT 'COLUMN', tbl||'.'||col,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=tbl AND column_name=col
       ) THEN 'PASS' ELSE '** MISSING **' END
FROM (VALUES
  ('products','tax_type'),            -- mig 08
  ('products','kra_item_class_code'), -- mig 08
  ('businesses','etims_onboarded'),   -- mig 08
  ('customers','credit_limit'),       -- mig 09
  ('customers','credit_balance'),     -- mig 09
  ('shifts','denomination_breakdown'),-- mig 10
  ('order_items','course'),           -- mig 11
  ('order_items','fire_status'),      -- mig 11
  ('order_items','fired_at'),         -- mig 11
  ('order_items','sub_bill'),         -- mig 11
  ('orders','seated_at'),             -- mig 11
  ('orders','tip_amount')             -- mig 12
) AS x(tbl,col)

UNION ALL
-- ── C. Credit RPC (migration 09) — NOT visible in a table dump ───────────────
SELECT 'FUNCTION', 'apply_credit_transaction()',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='apply_credit_transaction'
       ) THEN 'PASS' ELSE '** MISSING **' END

UNION ALL
-- ── D. Indexes worth confirming ─────────────────────────────────────────────
SELECT 'INDEX', 'orders(seated_at)',  -- mig 11
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname='public' AND tablename='orders' AND indexdef ILIKE '%seated_at%'
       ) THEN 'PASS' ELSE '** MISSING (non-critical) **' END
ORDER BY kind, object;


-- ── E. Seed settings in business_settings (per business) ────────────────────
-- These migrations seed default rows per business. This shows, for EACH business,
-- which seed keys are present. Any 'MISSING' means that business never got the seed
-- (the app falls back to defaults in code, so this is usually low-severity).
SELECT b.id AS business_id, b.name,
       CASE WHEN s_denom.key IS NULL THEN '** MISSING **' ELSE 'PASS' END AS cash_denominations,     -- mig 10
       CASE WHEN s_turn.key  IS NULL THEN '** MISSING **' ELSE 'PASS' END AS turnover_alert_minutes, -- mig 11
       CASE WHEN s_tip.key   IS NULL THEN '** MISSING **' ELSE 'PASS' END AS tip_settings,           -- mig 12
       CASE WHEN s_wa.key    IS NULL THEN '** MISSING **' ELSE 'PASS' END AS whatsapp_settings        -- mig 12
FROM public.businesses b
LEFT JOIN public.business_settings s_denom ON s_denom.business_id=b.id AND s_denom.key='cash_denominations'
LEFT JOIN public.business_settings s_turn  ON s_turn.business_id =b.id AND s_turn.key ='turnover_alert_minutes'
LEFT JOIN public.business_settings s_tip   ON s_tip.business_id  =b.id AND s_tip.key  ='tip_settings'
LEFT JOIN public.business_settings s_wa    ON s_wa.business_id   =b.id AND s_wa.key   ='whatsapp_settings'
ORDER BY b.name;

-- NOTE: the exact seed key names above are inferred from the migration descriptions.
-- If a key shows MISSING for every business, first confirm the real key name with:
--   SELECT DISTINCT key FROM public.business_settings ORDER BY key;
-- before assuming the seed was skipped.
