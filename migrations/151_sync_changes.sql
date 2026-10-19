-- 151_sync_changes.sql — A531: the database writes down WHICH rows changed, so a till takes only those rows.
--
-- Owner, 2026-10-19: "the till does not have to check, the trigger should happen instantly - if I change fries from 100
-- to 150 the trigger should only send the affected product and price, not the whole menu (70 products, 69 needless); if
-- Eugene PIN changes only Eugene change gets synced, not all 150 staff." Measured after A528: /api/pos 5.0 MB in 36 min
-- across about 4 tills - every till took the whole /api/pos/init (about 300 KB, the logo included) every 10 minutes.
--
-- public.sync_changes - one entry per changed row: (seq, business, branch or null, topic, table, row, upsert or delete).
-- The table is LOGICAL - what GET /api/pos/changes serves, the row as a till stores it (shared/syncTopics.ts):
--   products         products (its own row), combo_items (the combo), branch_prices (the product, at that branch)
--   product_choices  variant_groups, variant_options, variant_group_products, modifier_groups, modifier_options (the product)
--   categories, offers, promotions                                        (their own rows)
--   stock_count      stock_takes (the branch), the stock_count_freeze setting (every branch)
--   staff            users (the person), user_branches and user_permissions (the person)
--   roles            roles, role_permissions (the role - the cloud sends each person holding it)
--   config           business_settings and branch_settings by key (public.sync_setting_topic), feature_flags,
--                    businesses (by column), payment_methods, branches - the row is the topic: money, look or setup
--   branding         business_branding, and the themes switch in feature_flags
--   print_stations   print_stations, category_stations (the whole station list, a few rows)
--   tables, pumps    their own rows (at their branch)
-- Topics: menu, staff, money are applied at once on a till; look and setup within 30 minutes or when the till is idle.
--
-- log_sync_change(): AFTER, per row. A delete of a row the till keeps by itself (a product, a category, a person, a table)
-- is a delete; a change of a part (an option, a combo line, a grant) is an upsert of what it belongs to. The same row and
-- operation is written once per transaction (a transaction-local flag: a bulk import of 2,000 products writes 2,000
-- entries, editing one product ten times in one save writes one). Not written: an update that changes nothing, a person
-- merely being active (last_active_at, sign-in code fields), a branch technician code, the e-mail jobs bookkeeping keys,
-- a business column no till reads. It never fails the write that fired it (a warning). SECURITY DEFINER: only the service
-- role reads the table (RLS on, no policy).
--
-- sync_versions (migration 150) keeps moving exactly as before - tills before 1.0.20 read it - and payment_methods,
-- category_stations and pumps now move its catalogue version too (old tills learned of them only on the 10-minute pull).
--
-- sync_changes_since(business, since, branch, limit): the entries after a till last applied, plus every entry of the last
-- 120 seconds (a transaction that took its number before another but committed after it is not skipped - the till drops
-- what it already applied). sync_changes_heads(after): one read for EVERY business - what is new since the server last
-- looked (its 5-second check for changes made outside it: the SQL editor, a migration). prune_sync_changes(days): entries
-- older than that go; sync_change_floor keeps the highest number removed - a till behind it takes the whole menu once.
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS public.sync_changes (
  seq          bigserial   PRIMARY KEY,
  business_id  uuid        NOT NULL,
  branch_id    uuid        NULL,
  topic        text        NOT NULL,
  table_name   text        NOT NULL,
  row_id       text        NOT NULL,
  op           text        NOT NULL CHECK (op IN ('upsert', 'delete')),
  changed_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS sync_changes_business_seq ON public.sync_changes (business_id, seq);
CREATE INDEX IF NOT EXISTS sync_changes_changed_at ON public.sync_changes (changed_at);

ALTER TABLE public.sync_changes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.sync_changes FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.sync_change_floor (
  id         integer     PRIMARY KEY CHECK (id = 1),
  floor_seq  bigint      NOT NULL DEFAULT 0,
  pruned_at  timestamptz NULL
);
INSERT INTO public.sync_change_floor (id, floor_seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.sync_change_floor ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON public.sync_change_floor FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- The topic of a business or branch setting, by its key. NULL = bookkeeping (nothing written). The SQL mirror of
-- settingTopic in shared/syncTopics.ts - change both together (scripts/test-migration-151.mjs runs both on the same keys).
CREATE OR REPLACE FUNCTION public.sync_setting_topic(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_key IN ('owner_alerts_state', 'weekly_summary_last_sent', 'monthly_pack_last_sent', 'report_schedule_last_sent')
      OR starts_with(p_key, 'branch_open_tills_last_sent:') THEN NULL
    WHEN p_key IN ('stock_count_freeze') THEN 'menu'
    WHEN p_key IN ('payment_methods_enabled', 'continuous_operation', 'business_day_cutoff',
                   'cashier_history_methods', 'cashier_sees_shift_sales', 'cashier_history_totals', 'cashier_own_history',
                   'cashier_no_reprint', 'cashier_no_money_out', 'service_charge_pct', 'pay_later_tabs', 'pay_before_kitchen',
                   'etims_enabled', 'default_parking_rate')
      OR starts_with(p_key, 'mpesa_') OR starts_with(p_key, 'receipt_pay_') OR starts_with(p_key, 'aggregator_commission_')
      OR starts_with(p_key, 'parking_rate_') OR starts_with(p_key, 'loyalty_') OR starts_with(p_key, 'delivery_')
      OR starts_with(p_key, 'void_') OR starts_with(p_key, 'offline_') OR starts_with(p_key, 'ctl_')
      OR strpos(p_key, 'tax') > 0 OR strpos(p_key, 'vat') > 0 THEN 'money'
    WHEN p_key IN ('thank_you_message')
      OR starts_with(p_key, 'receipt_') OR starts_with(p_key, 'business_') OR starts_with(p_key, 'contact_') THEN 'look'
    ELSE 'setup'
  END
$$;

CREATE OR REPLACE FUNCTION public.log_sync_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t       text := TG_TABLE_NAME;
  v_row     jsonb;
  v_old     jsonb;
  v_op      text;
  v_biz     uuid;
  v_branch  uuid;
  v_topic   text;
  v_tables  text[] := ARRAY[]::text[];
  v_ids     text[] := ARRAY[]::text[];
  v_topics  text[] := ARRAY[]::text[];
  v_ops     text[] := ARRAY[]::text[];
  v_pid     text;
  v_flag    text;
  i         integer;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); v_op := 'delete'; ELSE v_row := to_jsonb(NEW); v_op := 'upsert'; END IF;

    -- An update that changes nothing a till keeps.
    IF TG_OP = 'UPDATE' THEN
      v_old := to_jsonb(OLD);
      IF v_t = 'users' THEN
        IF (v_row - ARRAY['last_active_at', 'updated_at', 'otp_totp_secret', 'otp_version', 'otp_method', 'must_change_password', 'pin_upgraded'])
         = (v_old - ARRAY['last_active_at', 'updated_at', 'otp_totp_secret', 'otp_version', 'otp_method', 'must_change_password', 'pin_upgraded']) THEN
          RETURN NULL;
        END IF;
      ELSIF v_t = 'branches' THEN
        IF (v_row - ARRAY['updated_at', 'tech_reveal_code', 'kds_version', 'mode_switched_at', 'mode_switched_by'])
         = (v_old - ARRAY['updated_at', 'tech_reveal_code', 'kds_version', 'mode_switched_at', 'mode_switched_by']) THEN
          RETURN NULL;
        END IF;
      ELSIF v_t = 'stock_takes' THEN
        -- A counted item touches updated_at only (routes/stockTakes.ts): that IS the change (an item released from a freeze).
        IF v_row = v_old THEN RETURN NULL; END IF;
      ELSIF (v_row - 'updated_at') = (v_old - 'updated_at') THEN
        RETURN NULL;
      END IF;
    END IF;

    -- The business.
    IF v_t = 'businesses' THEN
      v_biz := (v_row->>'id')::uuid;
    ELSIF v_row ? 'business_id' AND v_row->>'business_id' IS NOT NULL THEN
      v_biz := (v_row->>'business_id')::uuid;
    END IF;
    IF v_row ? 'branch_id' AND v_row->>'branch_id' IS NOT NULL AND v_t IN ('branch_prices', 'stock_takes', 'branch_settings', 'tables', 'pumps') THEN
      v_branch := (v_row->>'branch_id')::uuid;
    END IF;

    -- What it is, for a till.
    IF v_t = 'products' THEN
      v_tables := ARRAY['products']; v_ids := ARRAY[v_row->>'id']; v_topics := ARRAY['menu']; v_ops := ARRAY[v_op];
    ELSIF v_t = 'categories' THEN
      v_tables := ARRAY['categories']; v_ids := ARRAY[v_row->>'id']; v_topics := ARRAY['menu']; v_ops := ARRAY[v_op];
    ELSIF v_t = 'combo_items' THEN
      v_pid := v_row->>'combo_id';
      v_tables := ARRAY['products']; v_ids := ARRAY[v_pid]; v_topics := ARRAY['menu']; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'branch_prices' THEN
      v_tables := ARRAY['products']; v_ids := ARRAY[v_row->>'product_id']; v_topics := ARRAY['menu']; v_ops := ARRAY['upsert'];
    ELSIF v_t IN ('variant_groups', 'modifier_groups', 'variant_group_products') THEN
      v_pid := v_row->>'product_id';
      v_tables := ARRAY['product_choices']; v_ids := ARRAY[v_pid]; v_topics := ARRAY['menu']; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'variant_options' THEN
      SELECT g.product_id::text INTO v_pid FROM public.variant_groups g WHERE g.id = (v_row->>'variant_group_id')::uuid;
      v_tables := ARRAY['product_choices']; v_ids := ARRAY[v_pid]; v_topics := ARRAY['menu']; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'modifier_options' THEN
      SELECT g.product_id::text INTO v_pid FROM public.modifier_groups g WHERE g.id = (v_row->>'modifier_group_id')::uuid;
      v_tables := ARRAY['product_choices']; v_ids := ARRAY[v_pid]; v_topics := ARRAY['menu']; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'offers' THEN
      v_tables := ARRAY['offers']; v_ids := ARRAY[v_row->>'id']; v_topics := ARRAY['menu']; v_ops := ARRAY[v_op];
    ELSIF v_t = 'promotions' THEN
      v_tables := ARRAY['promotions']; v_ids := ARRAY[v_row->>'id']; v_topics := ARRAY['menu']; v_ops := ARRAY[v_op];
    ELSIF v_t = 'stock_takes' THEN
      v_tables := ARRAY['stock_count']; v_ids := ARRAY[COALESCE(v_row->>'branch_id', '*')]; v_topics := ARRAY['menu']; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'users' THEN
      v_tables := ARRAY['staff']; v_ids := ARRAY[v_row->>'id']; v_topics := ARRAY['staff']; v_ops := ARRAY[v_op];
    ELSIF v_t IN ('user_branches', 'user_permissions') THEN
      v_pid := v_row->>'user_id';
      v_tables := ARRAY['staff']; v_ids := ARRAY[v_pid]; v_topics := ARRAY['staff']; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'roles' THEN
      v_tables := ARRAY['roles']; v_ids := ARRAY[v_row->>'id']; v_topics := ARRAY['staff']; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'role_permissions' THEN
      v_pid := v_row->>'role_id';
      v_tables := ARRAY['roles']; v_ids := ARRAY[v_pid]; v_topics := ARRAY['staff']; v_ops := ARRAY['upsert'];
    ELSIF v_t IN ('business_settings', 'branch_settings') THEN
      v_topic := public.sync_setting_topic(COALESCE(v_row->>'key', ''));
      IF TG_OP = 'UPDATE' AND v_topic IS NULL THEN v_topic := public.sync_setting_topic(COALESCE(v_old->>'key', '')); END IF;
      IF v_topic IS NULL THEN RETURN NULL; END IF;
      IF v_topic = 'menu' THEN
        v_tables := ARRAY['stock_count']; v_ids := ARRAY['*']; v_branch := NULL;
      ELSE
        v_tables := ARRAY['config']; v_ids := ARRAY[v_topic];
      END IF;
      v_topics := ARRAY[v_topic]; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'feature_flags' THEN
      IF v_row->>'key' = 'themes' THEN
        v_tables := ARRAY['branding']; v_ids := ARRAY['branding']; v_topics := ARRAY['look'];
      ELSE
        v_tables := ARRAY['config']; v_ids := ARRAY['money']; v_topics := ARRAY['money'];
      END IF;
      v_ops := ARRAY['upsert'];
    ELSIF v_t = 'businesses' THEN
      IF TG_OP <> 'UPDATE' THEN
        v_ids := ARRAY['money', 'look', 'setup'];
      ELSE
        IF (v_row->'vat_rate', v_row->'ctl_rate', v_row->'currency', v_row->'status', v_row->'web_access_expires_at')
           IS DISTINCT FROM (v_old->'vat_rate', v_old->'ctl_rate', v_old->'currency', v_old->'status', v_old->'web_access_expires_at') THEN
          v_ids := v_ids || 'money'::text;
        END IF;
        IF (v_row->'name') IS DISTINCT FROM (v_old->'name') THEN v_ids := v_ids || 'look'::text; END IF;
        IF (v_row->'type', v_row->'support_admin_id') IS DISTINCT FROM (v_old->'type', v_old->'support_admin_id') THEN
          v_ids := v_ids || 'setup'::text;
        END IF;
      END IF;
      v_tables := array_fill('config'::text, ARRAY[COALESCE(array_length(v_ids, 1), 0)]);
      v_topics := v_ids;
      v_ops := array_fill('upsert'::text, ARRAY[COALESCE(array_length(v_ids, 1), 0)]);
    ELSIF v_t = 'payment_methods' THEN
      v_tables := ARRAY['config']; v_ids := ARRAY['money']; v_topics := ARRAY['money']; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'branches' THEN
      v_tables := ARRAY['config']; v_ids := ARRAY['setup']; v_topics := ARRAY['setup']; v_ops := ARRAY['upsert'];
    ELSIF v_t = 'business_branding' THEN
      v_tables := ARRAY['branding']; v_ids := ARRAY['branding']; v_topics := ARRAY['look']; v_ops := ARRAY['upsert'];
    ELSIF v_t IN ('print_stations', 'category_stations') THEN
      v_tables := ARRAY['print_stations']; v_ids := ARRAY['*']; v_topics := ARRAY['setup']; v_ops := ARRAY['upsert'];
    ELSIF v_t IN ('tables', 'pumps') THEN
      v_tables := ARRAY[v_t]; v_ids := ARRAY[v_row->>'id']; v_topics := ARRAY['setup']; v_ops := ARRAY[v_op];
    ELSE
      RETURN NULL;
    END IF;

    -- A row without business_id: through what it belongs to.
    IF v_biz IS NULL THEN
      IF v_t IN ('combo_items', 'variant_groups', 'modifier_groups', 'variant_group_products', 'variant_options', 'modifier_options') AND v_ids[1] IS NOT NULL THEN
        SELECT p.business_id INTO v_biz FROM public.products p WHERE p.id::text = v_ids[1];
      ELSIF v_t IN ('user_branches', 'user_permissions') THEN
        SELECT u.business_id INTO v_biz FROM public.users u WHERE u.id = (v_row->>'user_id')::uuid;
      ELSIF v_t = 'role_permissions' THEN
        SELECT r.business_id INTO v_biz FROM public.roles r WHERE r.id = (v_row->>'role_id')::uuid;
      ELSIF v_row ? 'branch_id' AND v_row->>'branch_id' IS NOT NULL THEN
        SELECT b.business_id INTO v_biz FROM public.branches b WHERE b.id = (v_row->>'branch_id')::uuid;
      ELSIF v_t = 'category_stations' THEN
        SELECT c.business_id INTO v_biz FROM public.categories c WHERE c.id = (v_row->>'category_id')::uuid;
      END IF;
    END IF;
    IF v_biz IS NULL THEN RETURN NULL; END IF;

    FOR i IN 1 .. COALESCE(array_length(v_tables, 1), 0) LOOP
      CONTINUE WHEN v_ids[i] IS NULL;
      -- Once per row and operation per transaction.
      v_flag := 'zaptill.sc' || md5(v_biz::text || '|' || COALESCE(v_branch::text, '') || '|' || v_tables[i] || '|' || v_ids[i] || '|' || v_ops[i]);
      CONTINUE WHEN current_setting(v_flag, true) = '1';
      INSERT INTO public.sync_changes (business_id, branch_id, topic, table_name, row_id, op)
      VALUES (v_biz, v_branch, v_topics[i], v_tables[i], v_ids[i], v_ops[i]);
      PERFORM set_config(v_flag, '1', true);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'log_sync_change %: %', v_t, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- The triggers: AFTER, per row, on every table a till keeps something of. Skipped for a table that does not exist here.
DO $a531$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products', 'categories', 'combo_items', 'branch_prices', 'variant_groups', 'variant_options',
                           'variant_group_products', 'modifier_groups', 'modifier_options', 'offers', 'promotions',
                           'stock_takes', 'users', 'user_branches', 'user_permissions', 'roles', 'role_permissions',
                           'business_settings', 'branch_settings', 'feature_flags', 'businesses', 'payment_methods',
                           'branches', 'business_branding', 'print_stations', 'category_stations', 'tables', 'pumps'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_log_sync_change ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_log_sync_change AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                  || 'FOR EACH ROW EXECUTE FUNCTION public.log_sync_change()', t);
    END IF;
  END LOOP;

  -- Tills before 1.0.20 pull on the catalogue version (migration 150): payment methods, the categories of a print station
  -- and pumps move it too now (they waited for the 10-minute pull). bump_sync_version finds their business_id.
  FOREACH t IN ARRAY ARRAY['payment_methods', 'category_stations', 'pumps'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_sync_version_catalogue ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_sync_version_catalogue AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                  || 'FOR EACH ROW EXECUTE FUNCTION public.bump_sync_version(%L)', t, 'catalogue');
    END IF;
  END LOOP;
END $a531$;

-- The entries a till has not applied (after p_since), plus the last 120 seconds, oldest first; its branch or every branch.
CREATE OR REPLACE FUNCTION public.sync_changes_since(p_business uuid, p_since bigint, p_branch uuid, p_limit integer)
RETURNS TABLE (seq bigint, topic text, table_name text, row_id text, op text, changed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.seq, c.topic, c.table_name, c.row_id, c.op, c.changed_at
    FROM public.sync_changes c
   WHERE c.business_id = p_business
     AND (c.seq > p_since OR c.changed_at > clock_timestamp() - interval '120 seconds')
     AND (c.branch_id IS NULL OR p_branch IS NULL OR c.branch_id = p_branch)
   ORDER BY c.seq
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000))
$$;

-- For every business: the newest entry after p_after (and in the last 120 seconds), how many, and their topics.
CREATE OR REPLACE FUNCTION public.sync_changes_heads(p_after bigint)
RETURNS TABLE (business_id uuid, max_seq bigint, n bigint, topics text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.business_id, max(c.seq), count(*), array_agg(DISTINCT c.topic)
    FROM public.sync_changes c
   WHERE c.seq > p_after OR c.changed_at > clock_timestamp() - interval '120 seconds'
   GROUP BY c.business_id
$$;

-- Entries older than p_keep_days go; the floor remembers the highest number removed.
CREATE OR REPLACE FUNCTION public.prune_sync_changes(p_keep_days integer DEFAULT 30)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_floor bigint;
  v_n     bigint := 0;
BEGIN
  SELECT max(c.seq) INTO v_floor FROM public.sync_changes c
   WHERE c.changed_at < now() - make_interval(days => GREATEST(1, COALESCE(p_keep_days, 30)));
  IF v_floor IS NULL THEN RETURN 0; END IF;
  DELETE FROM public.sync_changes c WHERE c.seq <= v_floor;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.sync_change_floor AS f (id, floor_seq, pruned_at) VALUES (1, v_floor, now())
  ON CONFLICT (id) DO UPDATE SET floor_seq = GREATEST(f.floor_seq, EXCLUDED.floor_seq), pruned_at = now();
  RETURN v_n;
END;
$$;

-- The cloud service role only (they read every business): not callable through the public API.
REVOKE ALL ON FUNCTION public.sync_changes_since(uuid, bigint, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_changes_heads(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_sync_changes(integer) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.sync_changes_since(uuid, bigint, uuid, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.sync_changes_heads(bigint) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.prune_sync_changes(integer) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.sync_changes_since(uuid, bigint, uuid, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.sync_changes_heads(bigint) TO service_role;
  GRANT EXECUTE ON FUNCTION public.prune_sync_changes(integer) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('151_sync_changes', 'A531: sync_changes - one entry per changed row (topic, logical table, row, upsert or delete) written by triggers, served by GET /api/pos/changes and pushed over /api/pos/live; prune and floor.')
ON CONFLICT (version) DO NOTHING;
