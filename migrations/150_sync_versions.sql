-- 150_sync_versions.sql — A528: the database keeps one number per business that moves when the till's data changes.
--
-- Render suspended production (2026-10-19): its 5 GB bandwidth was 6.29 GB, 5 GB of it the server's own requests to
-- Supabase; Supabase was at 5.53/5 GB egress and 7.54/1 GB log ingestion (one log line per request). The root: every till
-- asked GET /api/pos/catalogue-version every 20 s, and each answer ran 16 queries (the newest updated_at of 16 tables).
-- Owner, 2026-10-19: "can we do it such that only a change can trigger data sync ... we need a solution and a quick one".
--
-- public.sync_versions — (business_id, topic) -> version, bumped by triggers:
--   catalogue  products, categories, business_settings, business_branding, feature_flags, users, tables, branches,
--              branch_printers, branch_prices, stock_takes, offers, promotions, print_stations, businesses,
--              branch_settings (the 16 tables catalogue-version read)
--   staff      users, roles, role_permissions, user_branches, user_permissions, and user_devices when its status,
--              retired_at, branch_id, business_id or device_role change (what a branch-staff answer depends on)
-- The cloud reads ONE row (cached 15 s per business) instead of 16 tables per till per 20 s (routes/pos.ts,
-- lib/syncVersions.ts).
--
-- bump_sync_version(topic): the business is the row's business_id; businesses its own id; a row without business_id
-- through its branch (branches), its role (roles) or its person (users). Once per business and topic per TRANSACTION
-- (a transaction-local flag): a bulk import of 2,000 products bumps once. Job bookkeeping rows in business_settings
-- (the e-mail jobs' last-sent marks) are not a change a till needs. It never fails the write that fired it (a warning).
-- SECURITY DEFINER: the table is the service role's only (RLS on, no policy), whoever writes the catalogue row.
-- A table that does not exist is skipped (to_regclass). Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS public.sync_versions (
  business_id  uuid        NOT NULL,
  topic        text        NOT NULL,
  version      bigint      NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, topic)
);

ALTER TABLE public.sync_versions ENABLE ROW LEVEL SECURITY;
-- No policy: anon and authenticated read and write nothing; the cloud's service role bypasses RLS (as 145, 149).
DO $$ BEGIN
  REVOKE ALL ON public.sync_versions FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.bump_sync_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topic text := COALESCE(TG_ARGV[0], 'catalogue');
  v_row   jsonb;
  v_biz   uuid;
  v_flag  text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); ELSE v_row := to_jsonb(NEW); END IF;

    -- The e-mail jobs keep their last-sent marks here (dailySummary, monthlyPack, ownerAlerts every 15 min): no till reads them.
    IF TG_TABLE_NAME = 'business_settings' AND (
         v_row->>'key' IN ('owner_alerts_state', 'weekly_summary_last_sent', 'monthly_pack_last_sent', 'report_schedule_last_sent')
         OR v_row->>'key' LIKE 'branch_open_tills_last_sent:%') THEN
      RETURN NULL;
    END IF;

    IF TG_TABLE_NAME = 'businesses' THEN
      v_biz := (v_row->>'id')::uuid;
    ELSIF v_row->>'business_id' IS NOT NULL THEN
      v_biz := (v_row->>'business_id')::uuid;
    ELSIF v_row->>'branch_id' IS NOT NULL THEN
      SELECT b.business_id INTO v_biz FROM public.branches b WHERE b.id = (v_row->>'branch_id')::uuid;
    ELSIF v_row->>'role_id' IS NOT NULL THEN
      SELECT r.business_id INTO v_biz FROM public.roles r WHERE r.id = (v_row->>'role_id')::uuid;
    ELSIF v_row->>'user_id' IS NOT NULL THEN
      SELECT u.business_id INTO v_biz FROM public.users u WHERE u.id = (v_row->>'user_id')::uuid;
    END IF;
    IF v_biz IS NULL THEN RETURN NULL; END IF;

    -- Once per business and topic per transaction.
    v_flag := 'zaptill.sv' || v_topic || replace(v_biz::text, '-', '');
    IF current_setting(v_flag, true) = '1' THEN RETURN NULL; END IF;

    INSERT INTO public.sync_versions AS s (business_id, topic, version, updated_at)
    VALUES (v_biz, v_topic, 1, now())
    ON CONFLICT (business_id, topic) DO UPDATE SET version = s.version + 1, updated_at = now();

    PERFORM set_config(v_flag, '1', true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'bump_sync_version % %: %', TG_TABLE_NAME, v_topic, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- The triggers: AFTER, per row (the once-per-transaction flag keeps a bulk write to one bump). Skipped for a table that
-- does not exist here.
DO $a528$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products', 'categories', 'business_settings', 'business_branding', 'feature_flags', 'users',
                           'tables', 'branches', 'branch_printers', 'branch_prices', 'stock_takes', 'offers', 'promotions',
                           'print_stations', 'businesses', 'branch_settings'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_sync_version_catalogue ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_sync_version_catalogue AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                  || 'FOR EACH ROW EXECUTE FUNCTION public.bump_sync_version(%L)', t, 'catalogue');
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['users', 'roles', 'role_permissions', 'user_branches', 'user_permissions'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_sync_version_staff ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_sync_version_staff AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                  || 'FOR EACH ROW EXECUTE FUNCTION public.bump_sync_version(%L)', t, 'staff');
    END IF;
  END LOOP;
END $a528$;

-- user_devices: a till is seen, renews, syncs all day (last_seen_at, last_sync_at, identity_seen_at) — none of that is a
-- staff change. Only a till joining, leaving, being blocked or moved is.
DROP TRIGGER IF EXISTS trg_sync_version_staff_ins_del ON public.user_devices;
CREATE TRIGGER trg_sync_version_staff_ins_del
  AFTER INSERT OR DELETE ON public.user_devices
  FOR EACH ROW EXECUTE FUNCTION public.bump_sync_version('staff');

DROP TRIGGER IF EXISTS trg_sync_version_staff_upd ON public.user_devices;
CREATE TRIGGER trg_sync_version_staff_upd
  AFTER UPDATE ON public.user_devices
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
     OR OLD.retired_at IS DISTINCT FROM NEW.retired_at
     OR OLD.branch_id IS DISTINCT FROM NEW.branch_id
     OR OLD.business_id IS DISTINCT FROM NEW.business_id
     OR OLD.device_role IS DISTINCT FROM NEW.device_role)
  EXECUTE FUNCTION public.bump_sync_version('staff');

-- Seed: every business has both rows, so the first read finds one.
INSERT INTO public.sync_versions (business_id, topic, version)
SELECT b.id, t.topic, 1
  FROM public.businesses b
 CROSS JOIN (VALUES ('catalogue'), ('staff')) AS t(topic)
ON CONFLICT (business_id, topic) DO NOTHING;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('150_sync_versions', 'A528: sync_versions - one catalogue and one staff version per business, bumped by triggers, read by catalogue-version and branch-staff instead of 16 tables per till per 20 s.')
ON CONFLICT (version) DO NOTHING;
