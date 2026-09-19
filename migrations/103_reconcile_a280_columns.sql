-- 103_reconcile_a280_columns.sql
-- A280: migrations 58 (fuel_tanks, parking_sessions) and 60 (category_stations)
-- declared their newer columns INSIDE `CREATE TABLE IF NOT EXISTS`, which is a
-- no-op because the baseline / migration 44 already created those tables in an
-- older shape. So a clean baseline+migrations replay never gets the columns,
-- while production (built incrementally) has them — `verify-db-schema` fails on
-- a rebuilt DB. This reconcile adds them idempotently:
--   • ADD COLUMN IF NOT EXISTS is a no-op where the column already exists (prod),
--     so this is safe to apply to production.
--   • types/nullability match scripts/schema-index.json (the verify target).
-- On a fresh rebuild all three tables are empty (44's insert is SELECT-based over
-- businesses/categories and adds 0 rows on a seedless DB), so the NOT NULL adds
-- are safe. category_stations still uses add-nullable → backfill → SET NOT NULL
-- so it is also safe if a real DB ever has rows without the column.

-- category_stations.business_id  (uuid NOT NULL)
ALTER TABLE public.category_stations ADD COLUMN IF NOT EXISTS business_id uuid;
UPDATE public.category_stations cs
   SET business_id = c.business_id
  FROM public.categories c
 WHERE cs.category_id = c.id AND cs.business_id IS NULL;
ALTER TABLE public.category_stations ALTER COLUMN business_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE public.category_stations
    ADD CONSTRAINT category_stations_business_id_fkey
    FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- fuel_tanks.product_id / tank_name  (both uuid/varchar NOT NULL)
ALTER TABLE public.fuel_tanks
  ADD COLUMN IF NOT EXISTS product_id uuid NOT NULL,
  ADD COLUMN IF NOT EXISTS tank_name  character varying NOT NULL;
DO $$ BEGIN
  ALTER TABLE public.fuel_tanks
    ADD CONSTRAINT fuel_tanks_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES public.products(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- parking_sessions.billed_amount / cashier_id / notes  (all nullable)
ALTER TABLE public.parking_sessions
  ADD COLUMN IF NOT EXISTS billed_amount numeric,
  ADD COLUMN IF NOT EXISTS cashier_id    uuid,
  ADD COLUMN IF NOT EXISTS notes         text;
DO $$ BEGIN
  ALTER TABLE public.parking_sessions
    ADD CONSTRAINT parking_sessions_cashier_id_fkey
    FOREIGN KEY (cashier_id) REFERENCES public.users(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
