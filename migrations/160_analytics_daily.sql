-- 160_analytics_daily.sql — A553: Analytics v2 - one more read-only aggregate function for /api/analytics/overview.
--
-- Analytics v2 (the KPI row, the revenue trend against the previous period and the payment mix) needs sales PER
-- BUSINESS DAY, which none of 158's functions gives (the heatmap is weekday x hour; money leaks per day counts orders,
-- not their value). As 158: AGGREGATED HERE, in SQL - never a period of raw orders in Node. The cloud asks for the
-- period AND the previous period of the same length in ONE call (at most 2 x 366 days), so the answer is at most one
-- row per day plus one per day and payment method.
--
--   analytics_daily_sales(business, branch, from, to, cutoff)
--       method NULL:  per business day - completed orders' total (orders.total, gross - as the heatmap and the daily
--                     series of /reports/sales: what was rung, before refunds) and their count;
--       method set:   per business day and payment method (lower-cased, trimmed - methods are free text since 89) -
--                     the completed payments (status completed, amount > 0) of those same completed orders, and their
--                     count. Dated by the ORDER (the day it was rung), so a day's methods add up to that day's sales.
--       The business day honours the owner cut-off (cutoff minutes after midnight, 0..360), in East Africa Time.
--
-- STABLE, SECURITY DEFINER, search_path public; the cloud service role only (it reads any business it is given).
-- No table, no trigger, no data change, existing indexes (orders by business and date; payments by order). Idempotent.

CREATE OR REPLACE FUNCTION public.analytics_daily_sales(p_business uuid, p_branch uuid, p_from timestamptz, p_to timestamptz, p_cutoff integer)
RETURNS TABLE (day date, method text, revenue numeric, orders bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH c AS (SELECT make_interval(mins => greatest(0, least(coalesce(p_cutoff, 0), 360))) AS cut),
  sold AS (
    SELECT o.id, ((o.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date AS day, coalesce(o.total, 0) AS total
      FROM public.orders o, c
     WHERE o.business_id = p_business
       AND o.status = 'completed'
       AND o.created_at >= p_from AND o.created_at <= p_to
       AND (p_branch IS NULL OR o.branch_id = p_branch)
  )
  SELECT s.day, NULL::text AS method, sum(s.total) AS revenue, count(*)::bigint AS orders
    FROM sold s
   GROUP BY s.day
  UNION ALL
  SELECT s.day, lower(btrim(p.method::text)), sum(p.amount), count(*)::bigint
    FROM sold s
    JOIN public.payments p ON p.order_id = s.id
   WHERE p.status = 'completed' AND coalesce(p.amount, 0) > 0
   GROUP BY s.day, lower(btrim(p.method::text))
$$;

-- The cloud service role only: the function reads any business it is given, so it is not callable through the API.
REVOKE ALL ON FUNCTION public.analytics_daily_sales(uuid, uuid, timestamptz, timestamptz, integer) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.analytics_daily_sales(uuid, uuid, timestamptz, timestamptz, integer) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.analytics_daily_sales(uuid, uuid, timestamptz, timestamptz, integer) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('160_analytics_daily', 'A553: Analytics v2 - analytics_daily_sales: completed sales and their payments per business day (and per method) for /api/analytics/overview, the period and the previous one in one call; an aggregate, never raw rows.')
ON CONFLICT (version) DO NOTHING;
