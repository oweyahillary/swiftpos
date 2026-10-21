-- 161_analytics_item_times.sql — A558: Analytics "decisions made easy" - one more read-only aggregate function for
-- /api/analytics/item-times ("what sells when") and the recommendations that use it.
--
-- None of 158's or 160's functions says WHAT sells WHEN: the heatmap is orders by weekday x hour, the menu matrix is
-- products over the whole period. As 158 / 160: AGGREGATED HERE, in SQL - never a period of raw order lines in Node.
--
--   analytics_item_times(business, branch, from, to, cutoff, limit)
--       one row per product sold (completed orders; order_items as the menu matrix - the product, or its name for a
--       line with no product) with its quantity and revenue (order_items.subtotal) in the period, and `cells`: a JSON
--       array of [weekday, hour, quantity, revenue], one per weekday x hour it sold in:
--         weekday  ISO 1 (Monday) .. 7 (Sunday) of the BUSINESS DAY - the owner's cut-off (cutoff minutes after
--                  midnight, 0..360) moves a 01:30 sale to the night before, so "Friday night" is Friday's;
--         hour     the clock hour 0..23, East Africa Time (Africa/Nairobi - the zone of every cloud report).
--       The `limit` best sellers by quantity (default 100, at most 300), so the answer stays a few hundred rows
--       whatever the menu - plus ONE row with is_total = true: every product's cells added together (the denominator of
--       "Pilau is 31% of what sells at lunch"), so the shares stay right when the tail is cut.
--
-- STABLE, SECURITY DEFINER, search_path public; the cloud service role only (it reads any business it is given).
-- No table, no trigger, no data change, existing indexes (orders by business and date; order_items by order). Idempotent.

CREATE OR REPLACE FUNCTION public.analytics_item_times(p_business uuid, p_branch uuid, p_from timestamptz, p_to timestamptz, p_cutoff integer, p_limit integer DEFAULT 100)
RETURNS TABLE (is_total boolean, product_id uuid, product_name text, qty numeric, revenue numeric, cells jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH c AS (SELECT make_interval(mins => greatest(0, least(coalesce(p_cutoff, 0), 360))) AS cut),
  line AS (
    SELECT oi.product_id,
           CASE WHEN oi.product_id IS NULL THEN oi.product_name END AS loose_name,
           oi.product_name,
           extract(isodow FROM ((o.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut))::integer AS dow,
           extract(hour FROM (o.created_at AT TIME ZONE 'Africa/Nairobi'))::integer AS hour,
           coalesce(oi.quantity, 0) AS qty, coalesce(oi.subtotal, 0) AS revenue
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
     CROSS JOIN c
     WHERE o.business_id = p_business
       AND o.status = 'completed'
       AND o.created_at >= p_from AND o.created_at <= p_to
       AND (p_branch IS NULL OR o.branch_id = p_branch)
  ),
  cell AS (
    SELECT l.product_id, l.loose_name, max(l.product_name) AS product_name, l.dow, l.hour,
           sum(l.qty) AS qty, sum(l.revenue) AS revenue
      FROM line l
     GROUP BY l.product_id, l.loose_name, l.dow, l.hour
  ),
  prod AS (
    SELECT ce.product_id, max(ce.product_name) AS product_name, sum(ce.qty) AS qty, sum(ce.revenue) AS revenue,
           jsonb_agg(jsonb_build_array(ce.dow, ce.hour, ce.qty, ce.revenue) ORDER BY ce.dow, ce.hour) AS cells,
           row_number() OVER (ORDER BY sum(ce.qty) DESC, sum(ce.revenue) DESC, max(ce.product_name)) AS rn
      FROM cell ce
     GROUP BY ce.product_id, ce.loose_name
    HAVING sum(ce.qty) > 0
  ),
  tot AS (
    SELECT ce.dow, ce.hour, sum(ce.qty) AS qty, sum(ce.revenue) AS revenue
      FROM cell ce
     GROUP BY ce.dow, ce.hour
  )
  SELECT false, p.product_id, p.product_name, p.qty, p.revenue, p.cells
    FROM prod p
   WHERE p.rn <= greatest(1, least(coalesce(p_limit, 100), 300))
  UNION ALL
  SELECT true, NULL::uuid, NULL::text, sum(t.qty), sum(t.revenue),
         jsonb_agg(jsonb_build_array(t.dow, t.hour, t.qty, t.revenue) ORDER BY t.dow, t.hour)
    FROM tot t
  HAVING count(*) > 0
$$;

-- The cloud service role only: the function reads any business it is given, so it is not callable through the API.
REVOKE ALL ON FUNCTION public.analytics_item_times(uuid, uuid, timestamptz, timestamptz, integer, integer) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.analytics_item_times(uuid, uuid, timestamptz, timestamptz, integer, integer) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.analytics_item_times(uuid, uuid, timestamptz, timestamptz, integer, integer) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('161_analytics_item_times', 'A558: Analytics decisions - analytics_item_times: per product sold, quantity and revenue by business weekday x hour (East Africa Time, the owner cut-off), the best sellers plus one total row; an aggregate, never raw rows.')
ON CONFLICT (version) DO NOTHING;
