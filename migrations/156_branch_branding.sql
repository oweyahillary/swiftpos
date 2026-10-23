-- 156_branch_branding.sql — A544: a branch can override the business's action theme, brand colour and receipt footer.
--
-- Owner, 2026-10-21: "phase 2 branding - we need to do it before value add" ... "yes start" (per-branch branding). The
-- design is docs/SCOPE-A295-branding.md 14-15 (approved with A323): branch_branding, one optional row per branch, resolved
-- per field at the till and the web POS as branch override, then the business branding, then the ZapTill default. A branch
-- may override only its colour, only its theme, only its footer (a NULL column = use the business value).
--
-- public.branch_branding - branch_id (the key, FK to branches; a branch removed takes its row), theme_id (a curated id of
-- shared/themes.ts - no CHECK, the list lives in code as for 106), accent_hex (#rrggbb, the brand colour; the cloud checks
-- it can be seen on the till as the business colour is checked), receipt_footer (plain text, at most 300 characters; the
-- cloud checks the lines fit the paper), updated_at (set_updated_at). Premium: used only while the business feature flag
-- themes is on (A325) - with it off a row is kept but never served or applied.
--
-- Sync (A528 / A531): a change moves the catalogue version (tills before 1.0.20 pull on it) and writes ONE sync_changes
-- entry (table branch_branding, row = the branch, topic look, the entry at that branch - so only that branch tills are
-- told) - log_branch_branding_sync_change, a function of its own so 151 log_sync_change stays as it is. GET
-- /api/pos/changes answers it with the branch override as pos/init sends it.
--
-- RLS as business_branding (104): a member of the business may read the rows of its branches; writes go through the
-- server (the service role bypasses RLS). Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS public.branch_branding (
  branch_id       uuid        PRIMARY KEY REFERENCES public.branches(id) ON DELETE CASCADE,
  theme_id        text        NULL,
  accent_hex      text        NULL CHECK (accent_hex IS NULL OR accent_hex ~ '^#[0-9a-f]{6}$'),
  receipt_footer  text        NULL CHECK (receipt_footer IS NULL OR char_length(receipt_footer) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.branch_branding IS
  'A544: a branch override of the business branding (theme, brand colour, receipt footer). NULL = the business value. Used only while feature_flags themes is on.';

DROP TRIGGER IF EXISTS branch_branding_set_updated_at ON public.branch_branding;
CREATE TRIGGER branch_branding_set_updated_at BEFORE UPDATE ON public.branch_branding
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.branch_branding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branch_branding_business_member ON public.branch_branding;
CREATE POLICY branch_branding_business_member ON public.branch_branding
  USING (branch_id IN (SELECT b.id FROM public.branches b
                        WHERE b.business_id IN (SELECT u.business_id FROM public.users u WHERE u.id = auth.uid())));
DO $$ BEGIN
  REVOKE ALL ON public.branch_branding FROM anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.branch_branding TO authenticated;
  GRANT ALL ON public.branch_branding TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- One sync_changes entry per changed override, once per branch and operation per transaction (as 151). An update that
-- changes nothing but updated_at writes nothing. A delete is an upsert for the tills (the branch override is gone: the
-- cloud answers it with none). It never fails the write that fired it (a warning).
CREATE OR REPLACE FUNCTION public.log_branch_branding_sync_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row     jsonb;
  v_biz     uuid;
  v_branch  uuid;
  v_flag    text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); ELSE v_row := to_jsonb(NEW); END IF;
    IF TG_OP = 'UPDATE' AND (v_row - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN RETURN NULL; END IF;
    v_branch := (v_row->>'branch_id')::uuid;
    IF v_branch IS NULL THEN RETURN NULL; END IF;
    SELECT b.business_id INTO v_biz FROM public.branches b WHERE b.id = v_branch;
    IF v_biz IS NULL THEN RETURN NULL; END IF;
    v_flag := 'zaptill.sc' || md5(v_biz::text || '|' || v_branch::text || '|branch_branding|' || v_branch::text || '|upsert');
    IF current_setting(v_flag, true) = '1' THEN RETURN NULL; END IF;
    IF to_regclass('public.sync_changes') IS NULL THEN RETURN NULL; END IF;
    INSERT INTO public.sync_changes (business_id, branch_id, topic, table_name, row_id, op)
    VALUES (v_biz, v_branch, 'look', 'branch_branding', v_branch::text, 'upsert');
    PERFORM set_config(v_flag, '1', true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'log_branch_branding_sync_change: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.log_branch_branding_sync_change() FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.log_branch_branding_sync_change() FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS trg_log_branch_branding_sync_change ON public.branch_branding;
CREATE TRIGGER trg_log_branch_branding_sync_change AFTER INSERT OR UPDATE OR DELETE ON public.branch_branding
  FOR EACH ROW EXECUTE FUNCTION public.log_branch_branding_sync_change();

-- Tills before 1.0.20 pull on the catalogue version (migration 150): an override moves it too (bump_sync_version finds
-- the business through branch_id).
DO $a544$
BEGIN
  IF to_regprocedure('public.bump_sync_version()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_sync_version_catalogue ON public.branch_branding';
    EXECUTE 'CREATE TRIGGER trg_sync_version_catalogue AFTER INSERT OR UPDATE OR DELETE ON public.branch_branding '
         || 'FOR EACH ROW EXECUTE FUNCTION public.bump_sync_version(' || quote_literal('catalogue') || ')';
  END IF;
END $a544$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('156_branch_branding', 'A544: branch_branding - a branch override of the business theme, brand colour and receipt footer (premium, the themes flag), one sync_changes entry per change (topic look, at that branch), the catalogue version moves.')
ON CONFLICT (version) DO NOTHING;
