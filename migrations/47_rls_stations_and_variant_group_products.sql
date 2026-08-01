-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 47 — RLS on the three tables created after migration 29
--
-- Migration 29 enabled Row Level Security on every table in the public schema,
-- on the reasoning that the anon key ships inside every dashboard JS bundle and
-- therefore anyone holding it can read or write straight through PostgREST
-- unless a policy says otherwise. Three tables created since then never got it:
--
--   print_stations           migration 44, applied 2026-07-30 20:16
--   category_stations        migration 44, applied 2026-07-30 20:16
--   variant_group_products   migration 45, applied 2026-07-31 07:01
--
-- And one that migration 29 simply missed at the time:
--
--   branch_prices            migration 20 — predates 29, never listed in it
--
-- branch_prices was found by scripts/check-rls-coverage.mjs on its first run. It
-- holds per-branch product pricing keyed by business_id, so it is commercially
-- sensitive in its own right, and it has been unprotected for longer than the
-- other three by some margin.
--
-- All four have been live and unprotected since those points. Migration 41
-- got this right for business_days, so the omission is inconsistent rather than
-- deliberate — which is exactly the kind of gap a convention held only in
-- someone's memory produces. scripts/check-rls-coverage.mjs now fails CI on it.
--
-- Policy convention is migration 29's, unchanged: a single "owner_all" policy
-- FOR ALL, scoped to
--     business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
-- auth.uid() is non-null only for a real Supabase Auth session — the owner login
-- path. Staff and PIN logins never create one, so they get nothing here, which
-- is intended: staff access goes through the Express API on the service_role
-- key, which bypasses RLS entirely and never sees these policies.
--
-- Purely additive. The Express API is unaffected. Nothing here can reject a
-- write that previously succeeded through the API.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Direct business_id column ───────────────────────────────────────────

ALTER TABLE public.print_stations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.print_stations;
CREATE POLICY owner_all ON public.print_stations FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
);

ALTER TABLE public.branch_prices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.branch_prices;
CREATE POLICY owner_all ON public.branch_prices FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
);

-- ─── 2. Scoped via parent tables (no business_id column of their own) ───────

-- category_stations is a link table and BOTH sides are tenant-owned, so both are
-- checked. Scoping on station_id alone would expose a row pairing one business's
-- category with another's station; scoping on category_id alone would do the
-- mirror image. A link row is only yours when both ends are.
ALTER TABLE public.category_stations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.category_stations;
CREATE POLICY owner_all ON public.category_stations FOR ALL USING (
  station_id IN (
    SELECT id FROM public.print_stations
     WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  )
  AND category_id IN (
    SELECT id FROM public.categories
     WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  )
);

-- variant_group_products is anchored on product_id rather than on
-- variant_group_id deliberately. Migration 45 introduced SHARED groups, whose
-- variant_groups.product_id is null by design — a group defined once and
-- attached to many items. Scoping through the group would therefore leave every
-- shared group's attachments unreachable by their own owner. product_id is
-- always present here: it is half of the primary key.
ALTER TABLE public.variant_group_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.variant_group_products;
CREATE POLICY owner_all ON public.variant_group_products FOR ALL USING (
  product_id IN (
    SELECT id FROM public.products
     WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  )
);

-- ─── 3. Verify ──────────────────────────────────────────────────────────────
-- Fails loudly here rather than leaving a silent gap for another eleven days.

DO $$
DECLARE
  t    text;
  miss text[] := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY['print_stations', 'branch_prices',
                           'category_stations', 'variant_group_products'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity
    ) THEN
      miss := miss || t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND policyname = 'owner_all'
    ) THEN
      miss := miss || (t || ' (policy)');
    END IF;
  END LOOP;

  IF array_length(miss, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'migration 47: RLS not in place for %', array_to_string(miss, ', ');
  END IF;

  RAISE NOTICE 'migration 47: RLS enabled with owner_all on all four tables.';
END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('47_rls_stations_and_variant_group_products',
        'RLS + owner_all on print_stations, category_stations, variant_group_products and branch_prices. The first three were created by migrations 44 and 45 after migration 29 had enabled RLS everywhere else; branch_prices predates 29 and was never listed in it. Additive; the service_role API path is unaffected.')
ON CONFLICT (version) DO NOTHING;
