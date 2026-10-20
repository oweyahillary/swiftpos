-- 155_menus.sql — A537: menus (Food, Soft drinks, Alcohol, Tea …) above the categories, one menu per category.
--
-- Owner, 2026-10-20: "some restaurants have different menus - food menu, non-alcoholic drinks menu, alcoholic drinks
-- menu, tea menu etc, can we include such?" Decisions: plain menus (no hours or days for now), one menu per category
-- (a column on categories, not a join table), on the desktop till and the web POS alike.
--
-- public.menus - one row per menu of a business: name, sort_order (the order of the tabs), active (a menu switched off
-- is not shown on any POS - its categories show under Other), colour and icon (optional), deleted_at (a soft delete, as
-- offers: the row stays, the tills are told it is gone). A name is unique per business among the menus not deleted.
-- public.categories.menu_id - the menu a category is under (NULL = none). ON DELETE SET NULL: a menu removed for real
-- leaves its categories with none, never removes them.
--
-- Sync (A528 / A531): a menu moves the catalogue version (tills before 1.0.20 pull on it) and writes ONE sync_changes
-- entry per changed menu (table menus, topic menu, upsert or delete) - log_menu_sync_change, a function of its own so
-- 151 log_sync_change stays as it is. A category moved between menus is its own categories entry already (151 logs any
-- change of a categories row). GET /api/pos/changes answers a menu entry with the row, or a delete when it is off or gone.
--
-- RLS as categories: the business owner through the API key (authenticated), the cloud service role bypasses it.
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS public.menus (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name         text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  sort_order   integer     NOT NULL DEFAULT 0,
  active       boolean     NOT NULL DEFAULT true,
  color        text        NULL,
  icon         text        NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz NULL
);
CREATE INDEX IF NOT EXISTS menus_business_order ON public.menus (business_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS menus_business_name ON public.menus (business_id, lower(btrim(name))) WHERE deleted_at IS NULL;

ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS menu_id uuid NULL REFERENCES public.menus(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS categories_menu_id ON public.categories (menu_id) WHERE menu_id IS NOT NULL;

ALTER TABLE public.menus ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner can manage menus" ON public.menus;
CREATE POLICY "owner can manage menus" ON public.menus TO authenticated
  USING (business_id IN (SELECT b.id FROM public.businesses b WHERE b.owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT b.id FROM public.businesses b WHERE b.owner_id = auth.uid()));
DO $$ BEGIN
  REVOKE ALL ON public.menus FROM anon;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS trg_menus_updated ON public.menus;
CREATE TRIGGER trg_menus_updated BEFORE UPDATE ON public.menus FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One sync_changes entry per changed menu, once per menu and operation per transaction (as 151). An update that changes
-- nothing but updated_at writes nothing. It never fails the write that fired it (a warning).
CREATE OR REPLACE FUNCTION public.log_menu_sync_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row   jsonb;
  v_op    text;
  v_biz   uuid;
  v_id    text;
  v_flag  text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); v_op := 'delete'; ELSE v_row := to_jsonb(NEW); v_op := 'upsert'; END IF;
    IF TG_OP = 'UPDATE' AND (v_row - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN RETURN NULL; END IF;
    v_biz := (v_row->>'business_id')::uuid;
    v_id := v_row->>'id';
    IF v_biz IS NULL OR v_id IS NULL THEN RETURN NULL; END IF;
    v_flag := 'zaptill.sc' || md5(v_biz::text || '||menus|' || v_id || '|' || v_op);
    IF current_setting(v_flag, true) = '1' THEN RETURN NULL; END IF;
    IF to_regclass('public.sync_changes') IS NULL THEN RETURN NULL; END IF;
    INSERT INTO public.sync_changes (business_id, branch_id, topic, table_name, row_id, op)
    VALUES (v_biz, NULL, 'menu', 'menus', v_id, v_op);
    PERFORM set_config(v_flag, '1', true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'log_menu_sync_change: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.log_menu_sync_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_log_menu_sync_change ON public.menus;
CREATE TRIGGER trg_log_menu_sync_change AFTER INSERT OR UPDATE OR DELETE ON public.menus
  FOR EACH ROW EXECUTE FUNCTION public.log_menu_sync_change();

-- Tills before 1.0.20 pull on the catalogue version (migration 150): a menu moves it too.
DO $a537$
BEGIN
  IF to_regprocedure('public.bump_sync_version()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_sync_version_catalogue ON public.menus';
    EXECUTE 'CREATE TRIGGER trg_sync_version_catalogue AFTER INSERT OR UPDATE OR DELETE ON public.menus '
         || 'FOR EACH ROW EXECUTE FUNCTION public.bump_sync_version(' || quote_literal('catalogue') || ')';
  END IF;
END $a537$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('155_menus', 'A537: menus - a business groups its categories into menus (Food, Soft drinks, Alcohol, Tea), categories.menu_id, one sync_changes entry per changed menu, the catalogue version moves.')
ON CONFLICT (version) DO NOTHING;
