-- 158_analytics.sql — A549: Analytics v1 (premium) - four read-only aggregate functions for /api/analytics.
--
-- Analytics v1 is a premium page on the web dashboard, switched on per client in the admin portal (feature_flags key
-- analytics, OFF unless set - as themes). The Render and Supabase quotas ran out once (A528, A531), so every figure is
-- AGGREGATED HERE, in SQL: the cloud never pulls a period of raw orders into Node. Each function returns a few hundred
-- rows at most (one per product sold, 7 x 24 heatmap cells, one per cashier and one per day, one per credit customer).
-- The cloud caps the range at 366 days and keeps each answer for a few minutes per business, branch and range.
--
--   analytics_menu_engineering(business, branch, from, to)  per product sold (completed orders): quantity, revenue
--       (order_items.subtotal) and the cost of ONE serving - products.cost_price when it is set (> 0), else its recipe
--       (recipes x ingredients.unit_cost, the lines with a unit cost, as the food-cost report), plus for a combo its
--       items (one level, each item at its own cost price or recipe - lib/comboStock servingCost). NULL = no cost set.
--   analytics_sales_heatmap(business, branch, from, to)      revenue (orders.total, gross - as /reports/hourly: demand
--       timing, not recognised revenue) and order count by ISO weekday (1 Monday .. 7 Sunday) x hour, in East Africa
--       Time (Africa/Nairobi - the zone of every cloud report; no daylight saving).
--   analytics_money_leaks(business, branch, from, to, cutoff) per cashier AND per business day (GROUPING SETS):
--       orders rung (completed + voided), voided orders (count, value at total), kitchen item voids (kitchen_voids),
--       refunds (orders.refunded_amount, dated by refunded_at, the sale cashier - as /reports/refunds), discounts
--       (completed orders with discount_amount > 0), wastage (wastage_entries not voided, by recorded_by, value at
--       cost), drawer over/short (shifts.cash_variance, closed in the period, per cashier) and day-close over/short
--       (business_days.cash_variance by business_date, per day). Over is +, short is - (counted minus expected).
--       The business day honours the owner cut-off (cutoff minutes after midnight, 0..360).
--   analytics_credit_ageing(business, branch, as_of)        each credit customer: the balance the LEDGER keeps
--       (customers.credit_balance, written only by apply_credit_transaction - not recomputed here) split by age. The
--       ledger has no per-sale paid flag, so repayments are allocated OLDEST FIRST (FIFO): the balance still owed is
--       the newest debits (ledger lines with amount > 0 - sales on account, positive adjustments), walked newest to
--       oldest until the balance is used up; each open part is aged by its own date: 0-30, 31-60, 61-90, 90+ days.
--       A balance larger than every debit the ledger holds (accounts from before the ledger) is unaged and counted
--       90+. For one branch: only the open parts of debits made at that branch (the unaged part has no branch).
--       Disputed sales: credit_confirmations (157) in state disputed, count and amount, per customer.
--
-- STABLE, SECURITY DEFINER, search_path public; the cloud service role only (each reads any business it is given).
-- No table, no trigger, no data change. Idempotent: safe to run twice.

CREATE OR REPLACE FUNCTION public.analytics_menu_engineering(p_business uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (product_id uuid, product_name text, category_name text, qty numeric, revenue numeric, unit_cost numeric, cost_source text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sold AS (
    SELECT oi.product_id,
           CASE WHEN oi.product_id IS NULL THEN oi.product_name END AS loose_name,
           max(oi.product_name) AS product_name, max(oi.category_name) AS category_name,
           sum(coalesce(oi.quantity, 0)) AS qty, sum(coalesce(oi.subtotal, 0)) AS revenue
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
     WHERE o.business_id = p_business
       AND o.status = 'completed'
       AND o.created_at >= p_from AND o.created_at <= p_to
       AND (p_branch IS NULL OR o.branch_id = p_branch)
     GROUP BY oi.product_id, CASE WHEN oi.product_id IS NULL THEN oi.product_name END
  ),
  recipe AS (
    SELECT r.product_id, sum(r.quantity_per_serving * i.unit_cost) AS cost
      FROM public.recipes r
      JOIN public.ingredients i ON i.id = r.ingredient_id
     WHERE r.business_id = p_business AND i.unit_cost IS NOT NULL
     GROUP BY r.product_id
  ),
  own AS (
    SELECT p.id,
           CASE WHEN coalesce(p.cost_price, 0) > 0 THEN p.cost_price ELSE rc.cost END AS cost,
           CASE WHEN coalesce(p.cost_price, 0) > 0 THEN 'product' WHEN rc.cost IS NOT NULL THEN 'recipe' END AS src
      FROM public.products p
      LEFT JOIN recipe rc ON rc.product_id = p.id
     WHERE p.business_id = p_business
  ),
  combo AS (
    SELECT ci.combo_id, sum(ow.cost * coalesce(nullif(ci.quantity, 0), 1)) AS cost
      FROM public.combo_items ci
      JOIN own ow ON ow.id = ci.product_id
     WHERE ow.cost IS NOT NULL AND ci.product_id <> ci.combo_id
       AND ci.combo_id IN (SELECT s.product_id FROM sold s WHERE s.product_id IS NOT NULL)
     GROUP BY ci.combo_id
  )
  SELECT s.product_id, s.product_name, s.category_name, s.qty, s.revenue,
         round(CASE WHEN ow.src = 'product' THEN ow.cost
                    WHEN ow.cost IS NOT NULL OR cb.cost IS NOT NULL THEN coalesce(ow.cost, 0) + coalesce(cb.cost, 0) END, 4),
         CASE WHEN ow.src = 'product' THEN 'product' WHEN ow.cost IS NOT NULL THEN 'recipe' WHEN cb.cost IS NOT NULL THEN 'combo' END
    FROM sold s
    LEFT JOIN own ow ON ow.id = s.product_id
    LEFT JOIN combo cb ON cb.combo_id = s.product_id
$$;

CREATE OR REPLACE FUNCTION public.analytics_sales_heatmap(p_business uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (dow integer, hour integer, revenue numeric, orders bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT extract(isodow FROM o.created_at AT TIME ZONE 'Africa/Nairobi')::integer AS dow,
         extract(hour FROM o.created_at AT TIME ZONE 'Africa/Nairobi')::integer AS hour,
         sum(coalesce(o.total, 0)) AS revenue,
         count(*) AS orders
    FROM public.orders o
   WHERE o.business_id = p_business
     AND o.status = 'completed'
     AND o.created_at >= p_from AND o.created_at <= p_to
     AND (p_branch IS NULL OR o.branch_id = p_branch)
   GROUP BY 1, 2
$$;

CREATE OR REPLACE FUNCTION public.analytics_money_leaks(p_business uuid, p_branch uuid, p_from timestamptz, p_to timestamptz, p_cutoff integer)
RETURNS TABLE (by_cashier boolean, cashier_id uuid, day date, orders bigint, voids bigint, void_value numeric,
               item_voids bigint, item_void_value numeric, refunds bigint, refund_value numeric, discounts bigint,
               discount_value numeric, wastage bigint, wastage_value numeric, drawer_variance numeric, day_close_variance numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH c AS (SELECT make_interval(mins => greatest(0, least(coalesce(p_cutoff, 0), 360))) AS cut),
  ev AS (
    SELECT o.cashier_id, ((o.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date AS day,
           1 AS orders, (o.status = 'voided')::int AS voids,
           CASE WHEN o.status = 'voided' THEN coalesce(o.total, 0) ELSE 0 END AS void_value,
           0 AS item_voids, 0::numeric AS item_void_value, 0 AS refunds, 0::numeric AS refund_value,
           (o.status = 'completed' AND coalesce(o.discount_amount, 0) > 0)::int AS discounts,
           CASE WHEN o.status = 'completed' THEN coalesce(o.discount_amount, 0) ELSE 0 END AS discount_value,
           0 AS wastage, 0::numeric AS wastage_value, 0::numeric AS drawer_variance, 0::numeric AS day_close_variance
      FROM public.orders o, c
     WHERE o.business_id = p_business AND o.status IN ('completed', 'voided')
       AND o.created_at >= p_from AND o.created_at <= p_to
       AND (p_branch IS NULL OR o.branch_id = p_branch)
    UNION ALL
    SELECT o.cashier_id, ((o.refunded_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date,
           0, 0, 0, 0, 0, 1, coalesce(o.refunded_amount, 0), 0, 0, 0, 0, 0, 0
      FROM public.orders o, c
     WHERE o.business_id = p_business AND o.refunded_at IS NOT NULL AND coalesce(o.refunded_amount, 0) > 0
       AND o.refunded_at >= p_from AND o.refunded_at <= p_to
       AND (p_branch IS NULL OR o.branch_id = p_branch)
    UNION ALL
    SELECT kv.cashier_id, ((kv.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date,
           0, 0, 0, 1, coalesce(kv.amount, 0), 0, 0, 0, 0, 0, 0, 0, 0
      FROM public.kitchen_voids kv, c
     WHERE kv.business_id = p_business
       AND kv.created_at >= p_from AND kv.created_at <= p_to
       AND (p_branch IS NULL OR kv.branch_id = p_branch)
    UNION ALL
    SELECT w.recorded_by, ((w.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date,
           0, 0, 0, 0, 0, 0, 0, 0, 0, 1, coalesce(w.value, 0), 0, 0
      FROM public.wastage_entries w, c
     WHERE w.business_id = p_business AND w.voided_at IS NULL
       AND w.created_at >= p_from AND w.created_at <= p_to
       AND (p_branch IS NULL OR w.branch_id = p_branch)
    UNION ALL
    SELECT s.cashier_id, ((s.closed_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date,
           0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, coalesce(s.cash_variance, 0), 0
      FROM public.shifts s, c
     WHERE s.business_id = p_business AND s.cash_variance IS NOT NULL AND s.closed_at IS NOT NULL
       AND s.closed_at >= p_from AND s.closed_at <= p_to
       AND (p_branch IS NULL OR s.branch_id = p_branch)
    UNION ALL
    SELECT NULL::uuid, bd.business_date,
           0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, coalesce(bd.cash_variance, 0)
      FROM public.business_days bd, c
     WHERE bd.business_id = p_business AND bd.cash_variance IS NOT NULL
       AND bd.business_date >= ((p_from AT TIME ZONE 'Africa/Nairobi') - c.cut)::date
       AND bd.business_date <= ((p_to AT TIME ZONE 'Africa/Nairobi') - c.cut)::date
       AND (p_branch IS NULL OR bd.branch_id = p_branch)
  )
  SELECT GROUPING(ev.day) = 1 AS by_cashier, ev.cashier_id, ev.day,
         sum(ev.orders)::bigint, sum(ev.voids)::bigint, sum(ev.void_value),
         sum(ev.item_voids)::bigint, sum(ev.item_void_value), sum(ev.refunds)::bigint, sum(ev.refund_value),
         sum(ev.discounts)::bigint, sum(ev.discount_value), sum(ev.wastage)::bigint, sum(ev.wastage_value),
         sum(ev.drawer_variance), sum(ev.day_close_variance)
    FROM ev
   GROUP BY GROUPING SETS ((ev.cashier_id), (ev.day))
$$;

CREATE OR REPLACE FUNCTION public.analytics_credit_ageing(p_business uuid, p_branch uuid, p_as_of timestamptz)
RETURNS TABLE (customer_id uuid, customer_name text, phone text, balance numeric, owed numeric, d0_30 numeric,
               d31_60 numeric, d61_90 numeric, d90_plus numeric, unaged numeric, oldest_at timestamptz,
               disputed_count bigint, disputed_amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH disputed AS (
    SELECT cc.customer_id, count(*) AS n, sum(cc.amount) AS amount
      FROM public.credit_confirmations cc
     WHERE cc.business_id = p_business AND cc.state = 'disputed' AND cc.customer_id IS NOT NULL
       AND (p_branch IS NULL OR cc.branch_id = p_branch)
     GROUP BY cc.customer_id
  ),
  cust AS (
    SELECT cu.id, cu.name, cu.phone, greatest(coalesce(cu.credit_balance, 0), 0) AS balance
      FROM public.customers cu
     WHERE cu.business_id = p_business
       AND (coalesce(cu.credit_balance, 0) > 0 OR cu.id IN (SELECT d.customer_id FROM disputed d))
  ),
  debits AS (
    SELECT t.customer_id, t.branch_id, t.created_at, t.amount,
           sum(t.amount) OVER (PARTITION BY t.customer_id ORDER BY t.created_at DESC, t.id DESC) AS newer_incl
      FROM public.customer_credit_transactions t
      JOIN cust ON cust.id = t.customer_id
     WHERE t.business_id = p_business AND t.amount > 0 AND t.created_at <= p_as_of
  ),
  open_parts AS (
    SELECT d.customer_id, d.branch_id, d.created_at,
           greatest(0, least(d.amount, cu.balance - (d.newer_incl - d.amount))) AS amt,
           (p_as_of AT TIME ZONE 'Africa/Nairobi')::date - (d.created_at AT TIME ZONE 'Africa/Nairobi')::date AS age
      FROM debits d
      JOIN cust cu ON cu.id = d.customer_id
  ),
  allocated AS (
    SELECT op.customer_id, sum(op.amt) AS amt FROM open_parts op GROUP BY op.customer_id
  ),
  aged AS (
    SELECT op.customer_id,
           sum(op.amt) AS owed,
           sum(op.amt) FILTER (WHERE op.age <= 30) AS d0_30,
           sum(op.amt) FILTER (WHERE op.age BETWEEN 31 AND 60) AS d31_60,
           sum(op.amt) FILTER (WHERE op.age BETWEEN 61 AND 90) AS d61_90,
           sum(op.amt) FILTER (WHERE op.age > 90) AS d90_plus,
           min(op.created_at) AS oldest_at
      FROM open_parts op
     WHERE op.amt > 0 AND (p_branch IS NULL OR op.branch_id = p_branch)
     GROUP BY op.customer_id
  ),
  acct AS (
    SELECT cu.id, cu.name, cu.phone, cu.balance,
           CASE WHEN p_branch IS NULL THEN greatest(0, cu.balance - coalesce(al.amt, 0)) ELSE 0 END AS unaged,
           ag.owed, ag.d0_30, ag.d31_60, ag.d61_90, ag.d90_plus, ag.oldest_at,
           coalesce(dz.n, 0) AS disputed_count, coalesce(dz.amount, 0) AS disputed_amount
      FROM cust cu
      LEFT JOIN allocated al ON al.customer_id = cu.id
      LEFT JOIN aged ag ON ag.customer_id = cu.id
      LEFT JOIN disputed dz ON dz.customer_id = cu.id
  )
  SELECT r.id, r.name, r.phone, r.balance,
         coalesce(r.owed, 0) + r.unaged, coalesce(r.d0_30, 0), coalesce(r.d31_60, 0), coalesce(r.d61_90, 0),
         coalesce(r.d90_plus, 0) + r.unaged, r.unaged, r.oldest_at, r.disputed_count, r.disputed_amount
    FROM acct r
   WHERE coalesce(r.owed, 0) + r.unaged > 0 OR r.disputed_count > 0
$$;

-- The cloud service role only: each function reads any business it is given, so it is not callable through the API.
REVOKE ALL ON FUNCTION public.analytics_menu_engineering(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_sales_heatmap(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_money_leaks(uuid, uuid, timestamptz, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_credit_ageing(uuid, uuid, timestamptz) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.analytics_menu_engineering(uuid, uuid, timestamptz, timestamptz) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_sales_heatmap(uuid, uuid, timestamptz, timestamptz) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_money_leaks(uuid, uuid, timestamptz, timestamptz, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_credit_ageing(uuid, uuid, timestamptz) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.analytics_menu_engineering(uuid, uuid, timestamptz, timestamptz) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_sales_heatmap(uuid, uuid, timestamptz, timestamptz) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_money_leaks(uuid, uuid, timestamptz, timestamptz, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_credit_ageing(uuid, uuid, timestamptz) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('158_analytics', 'A549: Analytics v1 (premium) - analytics_menu_engineering, analytics_sales_heatmap, analytics_money_leaks, analytics_credit_ageing: aggregates for /api/analytics, never raw rows; credit ageing allocates repayments oldest first (FIFO) against the ledger balance.')
ON CONFLICT (version) DO NOTHING;
