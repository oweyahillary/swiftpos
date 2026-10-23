-- 153_sync_stock_changes.sql - A535: stock levels travel on change, like the menu (A531), instead of a 30-minute re-read.
--
-- Owner, 2026-10-19: "this should only happen when there is a change, no need to keep asking for the same item" - and
-- "for a setup like KRUNCH only the server does the communication to cloud, not all tills". Until now (A531) a till
-- re-read the whole branch stock list every 30 minutes, because the change log (migration 151) did not carry stock: a
-- sale, a restock, a transfer, wastage and a stock count all move public.stock_levels, and none of them wrote an entry.
--
-- log_sync_stock_change(): AFTER, per row, on public.stock_levels. One sync_changes entry per changed level:
--   topic stock, table stock, row = the product, branch = the level branch (another branch never sees it), upsert or
--   delete. Not written: an update that changes nothing but updated_at.
-- Volume (a busy branch writes stock on every sale - adjust_product_stock, once per tracked line, each its own
-- transaction): the same level is written ONCE per transaction (a transaction-local flag, as 151), and the older entry of
-- the same level is removed when a newer one is written - GET /api/pos/changes serves the level as it is now, so the
-- newest entry is all a till needs. The log then holds at most one stock entry per product and branch, however many
-- sales: a 10-line sale writes 10 entries (one per tracked product), the next sale of the same 10 products replaces them.
-- A till whose number is between the two still gets the newer one (a higher number).
-- It never fails the write that fired it (a warning). SECURITY DEFINER: only the service role reads the log (151).
--
-- sync_changes_heads_by_branch(after): as sync_changes_heads (151), per business AND branch - the push channel rings a
-- stock-only change to the sockets of THAT branch only (another branch of the business is not woken for it).
-- sync_stock_ready(): true - the cloud asks it once to know this migration ran (it then tells the tills that stock
-- travels on change, and they stop re-reading it every 30 minutes).
-- Idempotent: safe to run twice.

CREATE INDEX IF NOT EXISTS sync_changes_stock_row ON public.sync_changes (business_id, row_id) WHERE table_name = 'stock';

CREATE OR REPLACE FUNCTION public.log_sync_stock_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row     jsonb;
  v_old     jsonb;
  v_op      text;
  v_biz     uuid;
  v_branch  uuid;
  v_pid     text;
  v_flag    text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); v_op := 'delete'; ELSE v_row := to_jsonb(NEW); v_op := 'upsert'; END IF;
    IF TG_OP = 'UPDATE' THEN
      v_old := to_jsonb(OLD);
      IF (v_row - 'updated_at') = (v_old - 'updated_at') THEN RETURN NULL; END IF;
    END IF;
    v_pid := v_row->>'product_id';
    IF v_pid IS NULL OR v_row->>'branch_id' IS NULL THEN RETURN NULL; END IF;
    v_branch := (v_row->>'branch_id')::uuid;
    SELECT b.business_id INTO v_biz FROM public.branches b WHERE b.id = v_branch;
    IF v_biz IS NULL THEN RETURN NULL; END IF;

    -- Once per level and operation per transaction.
    v_flag := 'zaptill.ss' || md5(v_biz::text || '|' || v_branch::text || '|' || v_pid || '|' || v_op);
    IF current_setting(v_flag, true) = '1' THEN RETURN NULL; END IF;
    -- The older entry of this level goes: the newest is all a till needs (the level is read as it is now).
    DELETE FROM public.sync_changes c
     WHERE c.business_id = v_biz AND c.table_name = 'stock' AND c.row_id = v_pid AND c.branch_id = v_branch;
    INSERT INTO public.sync_changes (business_id, branch_id, topic, table_name, row_id, op)
    VALUES (v_biz, v_branch, 'stock', 'stock', v_pid, v_op);
    PERFORM set_config(v_flag, '1', true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'log_sync_stock_change: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DO $a535$
BEGIN
  IF to_regclass('public.stock_levels') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_log_sync_stock_change ON public.stock_levels;
    CREATE TRIGGER trg_log_sync_stock_change AFTER INSERT OR UPDATE OR DELETE ON public.stock_levels
      FOR EACH ROW EXECUTE FUNCTION public.log_sync_stock_change();
  END IF;
END $a535$;

-- For every business and branch: the newest entry after p_after (and in the last 120 seconds), how many, the topics.
CREATE OR REPLACE FUNCTION public.sync_changes_heads_by_branch(p_after bigint)
RETURNS TABLE (business_id uuid, branch_id uuid, max_seq bigint, n bigint, topics text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.business_id, c.branch_id, max(c.seq), count(*), array_agg(DISTINCT c.topic)
    FROM public.sync_changes c
   WHERE c.seq > p_after OR c.changed_at > clock_timestamp() - interval '120 seconds'
   GROUP BY c.business_id, c.branch_id
$$;

CREATE OR REPLACE FUNCTION public.sync_stock_ready()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT true
$$;

REVOKE ALL ON FUNCTION public.sync_changes_heads_by_branch(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_stock_ready() FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.sync_changes_heads_by_branch(bigint) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.sync_stock_ready() FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.sync_changes_heads_by_branch(bigint) TO service_role;
  GRANT EXECUTE ON FUNCTION public.sync_stock_ready() TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('153_sync_stock_changes', 'A535: stock levels in sync_changes (topic stock, one entry per level, the older one replaced), sync_changes_heads_by_branch, sync_stock_ready.')
ON CONFLICT (version) DO NOTHING;
