-- 171_analytics_branch_sets.sql — A582: "All my branches" — the analytics aggregates over a SET of branches.
--
-- Owner, 2026-10-23: "assume i have partner a and they fully own shop x,y and z they should never see general sales for
-- all stores only their store" … "yes i want all my branch feature".
--
-- A partner (A550) who works at some branches (two or more, not every one) picks "All my branches" on the dashboard: every
-- figure is theirs combined — never the business's (p_branch NULL is EVERY branch, the owner's view). Ten NEW functions,
-- one beside each aggregate of 158 / 160 / 161 / 162 / 164, named <name>_set: the same arguments with p_branch uuid replaced
-- by p_branches uuid[], the same body with every branch filter `(p_branch IS NULL OR x.branch_id = p_branch)` replaced by
-- `x.branch_id = ANY (p_branches)` — no "every branch" case at all: a NULL or empty list matches nothing (fail closed).
-- Credit ageing's unaged part (a balance older than the ledger, no branch) is 0, as it is for one branch; stock use's on
-- hand is NULL (stock is counted per branch).
--
-- The ten functions the owner's and everyone else's calls use are NOT touched (no signature changes, no DROP): the cloud
-- calls a _set function only for a partner's set. Before this runs, that call answers "Analytics is being set up" for
-- that partner only — never every branch. scripts/test-migration-171 runs each against its original (one branch alone,
-- every branch as the sum, a third branch never present). STABLE, SECURITY DEFINER, search_path public; the cloud
-- service role only. No table, no trigger, no data change. Idempotent: safe to run twice.

-- analytics_menu_engineering_set: analytics_menu_engineering of 158_analytics.sql over a set (1 branch filters)
CREATE OR REPLACE FUNCTION public.analytics_menu_engineering_set(p_business uuid, p_branches uuid[], p_from timestamptz, p_to timestamptz)
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
       AND o.branch_id = ANY (p_branches)
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

-- analytics_sales_heatmap_set: analytics_sales_heatmap of 158_analytics.sql over a set (1 branch filters)
CREATE OR REPLACE FUNCTION public.analytics_sales_heatmap_set(p_business uuid, p_branches uuid[], p_from timestamptz, p_to timestamptz)
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
     AND o.branch_id = ANY (p_branches)
   GROUP BY 1, 2
$$;

-- analytics_money_leaks_set: analytics_money_leaks of 158_analytics.sql over a set (6 branch filters)
CREATE OR REPLACE FUNCTION public.analytics_money_leaks_set(p_business uuid, p_branches uuid[], p_from timestamptz, p_to timestamptz, p_cutoff integer)
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
       AND o.branch_id = ANY (p_branches)
    UNION ALL
    SELECT o.cashier_id, ((o.refunded_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date,
           0, 0, 0, 0, 0, 1, coalesce(o.refunded_amount, 0), 0, 0, 0, 0, 0, 0
      FROM public.orders o, c
     WHERE o.business_id = p_business AND o.refunded_at IS NOT NULL AND coalesce(o.refunded_amount, 0) > 0
       AND o.refunded_at >= p_from AND o.refunded_at <= p_to
       AND o.branch_id = ANY (p_branches)
    UNION ALL
    SELECT kv.cashier_id, ((kv.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date,
           0, 0, 0, 1, coalesce(kv.amount, 0), 0, 0, 0, 0, 0, 0, 0, 0
      FROM public.kitchen_voids kv, c
     WHERE kv.business_id = p_business
       AND kv.created_at >= p_from AND kv.created_at <= p_to
       AND kv.branch_id = ANY (p_branches)
    UNION ALL
    SELECT w.recorded_by, ((w.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date,
           0, 0, 0, 0, 0, 0, 0, 0, 0, 1, coalesce(w.value, 0), 0, 0
      FROM public.wastage_entries w, c
     WHERE w.business_id = p_business AND w.voided_at IS NULL
       AND w.created_at >= p_from AND w.created_at <= p_to
       AND w.branch_id = ANY (p_branches)
    UNION ALL
    SELECT s.cashier_id, ((s.closed_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date,
           0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, coalesce(s.cash_variance, 0), 0
      FROM public.shifts s, c
     WHERE s.business_id = p_business AND s.cash_variance IS NOT NULL AND s.closed_at IS NOT NULL
       AND s.closed_at >= p_from AND s.closed_at <= p_to
       AND s.branch_id = ANY (p_branches)
    UNION ALL
    SELECT NULL::uuid, bd.business_date,
           0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, coalesce(bd.cash_variance, 0)
      FROM public.business_days bd, c
     WHERE bd.business_id = p_business AND bd.cash_variance IS NOT NULL
       AND bd.business_date >= ((p_from AT TIME ZONE 'Africa/Nairobi') - c.cut)::date
       AND bd.business_date <= ((p_to AT TIME ZONE 'Africa/Nairobi') - c.cut)::date
       AND bd.branch_id = ANY (p_branches)
  )
  SELECT GROUPING(ev.day) = 1 AS by_cashier, ev.cashier_id, ev.day,
         sum(ev.orders)::bigint, sum(ev.voids)::bigint, sum(ev.void_value),
         sum(ev.item_voids)::bigint, sum(ev.item_void_value), sum(ev.refunds)::bigint, sum(ev.refund_value),
         sum(ev.discounts)::bigint, sum(ev.discount_value), sum(ev.wastage)::bigint, sum(ev.wastage_value),
         sum(ev.drawer_variance), sum(ev.day_close_variance)
    FROM ev
   GROUP BY GROUPING SETS ((ev.cashier_id), (ev.day))
$$;

-- analytics_credit_ageing_set: analytics_credit_ageing of 158_analytics.sql over a set (2 branch filters) — the unaged part (a balance older than the ledger, no branch) is 0, as for one branch
CREATE OR REPLACE FUNCTION public.analytics_credit_ageing_set(p_business uuid, p_branches uuid[], p_as_of timestamptz)
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
       AND cc.branch_id = ANY (p_branches)
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
     WHERE op.amt > 0 AND op.branch_id = ANY (p_branches)
     GROUP BY op.customer_id
  ),
  acct AS (
    SELECT cu.id, cu.name, cu.phone, cu.balance,
           0::numeric AS unaged,
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

-- analytics_daily_sales_set: analytics_daily_sales of 160_analytics_daily.sql over a set (1 branch filters)
CREATE OR REPLACE FUNCTION public.analytics_daily_sales_set(p_business uuid, p_branches uuid[], p_from timestamptz, p_to timestamptz, p_cutoff integer)
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
       AND o.branch_id = ANY (p_branches)
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

-- analytics_item_times_set: analytics_item_times of 161_analytics_item_times.sql over a set (1 branch filters)
CREATE OR REPLACE FUNCTION public.analytics_item_times_set(p_business uuid, p_branches uuid[], p_from timestamptz, p_to timestamptz, p_cutoff integer, p_limit integer DEFAULT 100)
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
       AND o.branch_id = ANY (p_branches)
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

-- analytics_stock_use_set: analytics_stock_use of 162_analytics_stock_customers_costs.sql over a set (3 branch filters) — on hand NULL (stock is counted per branch)
CREATE OR REPLACE FUNCTION public.analytics_stock_use_set(p_business uuid, p_branches uuid[], p_from timestamptz, p_to timestamptz, p_prev_from timestamptz, p_limit integer DEFAULT 300)
RETURNS TABLE (kind text, item_id uuid, item_name text, unit text, by_piece boolean, sold numeric, wasted numeric,
               prev_sold numeric, prev_wasted numeric, on_hand numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH prod AS (
    SELECT p.id, p.name, coalesce(p.sold_by, '') = 'piece' AS by_piece,
           CASE WHEN coalesce(p.sold_by, '') = 'piece' THEN 'pieces' ELSE nullif(btrim(coalesce(p.unit_label, '')), '') END AS unit
      FROM public.products p
     WHERE p.business_id = p_business
       AND coalesce(p.track_stock, false)
       AND NOT coalesce(p.is_fuel, false)
       AND NOT EXISTS (SELECT 1 FROM public.recipes r WHERE r.product_id = p.id AND r.business_id = p_business)
  ),
  pmove AS (
    SELECT m.product_id AS id,
           sum(CASE WHEN m.movement_type = 'sale' THEN -m.quantity_change
                    WHEN NOT pr.by_piece AND (m.notes LIKE 'Void of Order%' OR m.notes LIKE 'Refund of Order%') THEN -m.quantity_change
                    ELSE 0 END) FILTER (WHERE m.created_at >= p_from) AS sold,
           sum(CASE WHEN m.movement_type = 'sale' THEN -m.quantity_change
                    WHEN NOT pr.by_piece AND (m.notes LIKE 'Void of Order%' OR m.notes LIKE 'Refund of Order%') THEN -m.quantity_change
                    ELSE 0 END) FILTER (WHERE m.created_at < p_from) AS prev_sold
      FROM public.stock_movements m
      JOIN prod pr ON pr.id = m.product_id
     WHERE m.movement_type IN ('sale', 'correction')
       AND m.created_at >= p_prev_from AND m.created_at <= p_to
       AND m.branch_id = ANY (p_branches)
     GROUP BY m.product_id
  ),
  imove AS (
    SELECT m.ingredient_id AS id,
           sum(-m.quantity_change) FILTER (WHERE m.created_at >= p_from) AS sold,
           sum(-m.quantity_change) FILTER (WHERE m.created_at < p_from) AS prev_sold
      FROM public.ingredient_stock_movements m
     WHERE m.business_id = p_business AND m.movement_type = 'sale'
       AND m.created_at >= p_prev_from AND m.created_at <= p_to
       AND m.branch_id = ANY (p_branches)
     GROUP BY m.ingredient_id
  ),
  waste AS (
    SELECT w.product_id, w.ingredient_id,
           sum(w.quantity) FILTER (WHERE w.created_at >= p_from) AS wasted,
           sum(w.quantity) FILTER (WHERE w.created_at < p_from) AS prev_wasted
      FROM public.wastage_entries w
     WHERE w.business_id = p_business AND w.voided_at IS NULL
       AND w.created_at >= p_prev_from AND w.created_at <= p_to
       AND w.branch_id = ANY (p_branches)
     GROUP BY w.product_id, w.ingredient_id
  ),
  items AS (
    SELECT 'product'::text AS kind, pr.id, pr.name::text AS name, pr.unit, pr.by_piece,
           coalesce(pm.sold, 0) AS sold, coalesce(wp.wasted, 0) AS wasted,
           coalesce(pm.prev_sold, 0) AS prev_sold, coalesce(wp.prev_wasted, 0) AS prev_wasted,
           NULL::numeric AS on_hand
      FROM prod pr
      LEFT JOIN pmove pm ON pm.id = pr.id
      LEFT JOIN waste wp ON wp.product_id = pr.id AND wp.ingredient_id IS NULL
    UNION ALL
    SELECT 'ingredient'::text, i.id, i.name::text, nullif(btrim(coalesce(i.unit, '')), ''), false,
           coalesce(im.sold, 0), coalesce(wi.wasted, 0), coalesce(im.prev_sold, 0), coalesce(wi.prev_wasted, 0),
           NULL::numeric
      FROM public.ingredients i
      LEFT JOIN imove im ON im.id = i.id
      LEFT JOIN waste wi ON wi.ingredient_id = i.id AND wi.product_id IS NULL
     WHERE i.business_id = p_business
  ),
  used AS (
    SELECT it.*, row_number() OVER (ORDER BY it.sold + it.wasted DESC, it.prev_sold + it.prev_wasted DESC, it.name) AS rn
      FROM items it
     WHERE it.sold + it.wasted > 0 OR it.prev_sold + it.prev_wasted > 0
  )
  SELECT u.kind, u.id, u.name, u.unit, u.by_piece, u.sold, u.wasted, u.prev_sold, u.prev_wasted, u.on_hand
    FROM used u
   WHERE u.rn <= greatest(1, least(coalesce(p_limit, 300), 1000))
$$;

-- analytics_customers_set: analytics_customers of 162_analytics_stock_customers_costs.sql over a set (2 branch filters)
CREATE OR REPLACE FUNCTION public.analytics_customers_set(p_business uuid, p_branches uuid[], p_from timestamptz, p_to timestamptz, p_prev_from timestamptz,
                                                      p_cutoff integer, p_with_customers boolean, p_limit integer DEFAULT 200)
RETURNS TABLE (kind text, which text, day date, order_type text, orders bigint, sales numeric, linked_orders bigint,
               linked_sales numeric, customers bigint, new_customers bigint, customer_id uuid, customer_name text, phone text,
               visits bigint, spend numeric, prev_visits bigint, visits_90 bigint, first_90 date, last_visit date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH c AS (SELECT make_interval(mins => greatest(0, least(coalesce(p_cutoff, 0), 360))) AS cut),
  b AS (
    SELECT ((p_from AT TIME ZONE 'Africa/Nairobi') - c.cut)::date AS now_from,
           ((p_prev_from AT TIME ZONE 'Africa/Nairobi') - c.cut)::date AS prev_from,
           p_to - interval '90 days' AS since90
      FROM c
  ),
  o AS (
    SELECT o.customer_id, lower(btrim(coalesce(o.order_type, ''))) AS order_type, coalesce(o.total, 0) AS total, o.created_at,
           ((o.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date AS day
      FROM public.orders o, c, b
     WHERE o.business_id = p_business AND o.status = 'completed'
       AND o.created_at <= p_to AND o.created_at >= least(p_prev_from, b.since90)
       AND o.branch_id = ANY (p_branches)
  ),
  firsts AS (
    SELECT o.customer_id, min(((o.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date) AS first_day
      FROM public.orders o, c
     WHERE o.business_id = p_business AND o.status = 'completed' AND o.customer_id IS NOT NULL AND o.created_at <= p_to
       AND o.branch_id = ANY (p_branches)
     GROUP BY o.customer_id
  ),
  per AS (
    SELECT CASE WHEN o.created_at >= p_from THEN 'now' ELSE 'prev' END AS which, o.*
      FROM o WHERE o.created_at >= p_prev_from
  ),
  cust AS (
    SELECT o.customer_id,
           count(DISTINCT o.day) FILTER (WHERE o.created_at >= p_from) AS visits,
           coalesce(sum(o.total) FILTER (WHERE o.created_at >= p_from), 0) AS spend,
           count(DISTINCT o.day) FILTER (WHERE o.created_at >= p_prev_from AND o.created_at < p_from) AS prev_visits,
           count(DISTINCT o.day) FILTER (WHERE o.created_at >= b.since90) AS visits_90,
           min(o.day) FILTER (WHERE o.created_at >= b.since90) AS first_90,
           max(o.day) AS last_visit
      FROM o, b
     WHERE o.customer_id IS NOT NULL AND p_with_customers
     GROUP BY o.customer_id
  ),
  ranked AS (
    SELECT cu.*, row_number() OVER (ORDER BY cu.spend DESC, cu.visits DESC, cu.customer_id) AS r1,
           row_number() OVER (ORDER BY cu.visits_90 DESC, cu.last_visit DESC, cu.customer_id) AS r2
      FROM cust cu
     WHERE cu.visits > 0 OR cu.visits_90 > 0
  )
  SELECT 'period'::text, pe.which, NULL::date, NULL::text, count(*)::bigint, sum(pe.total),
         count(*) FILTER (WHERE pe.customer_id IS NOT NULL)::bigint, coalesce(sum(pe.total) FILTER (WHERE pe.customer_id IS NOT NULL), 0),
         count(DISTINCT pe.customer_id)::bigint,
         count(DISTINCT pe.customer_id) FILTER (WHERE f.first_day >= CASE WHEN pe.which = 'now' THEN b.now_from ELSE b.prev_from END
                                                  AND f.first_day < CASE WHEN pe.which = 'now' THEN 'infinity'::date ELSE b.now_from END)::bigint,
         NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::numeric, NULL::bigint, NULL::bigint, NULL::date, NULL::date
    FROM per pe CROSS JOIN b
    LEFT JOIN firsts f ON f.customer_id = pe.customer_id
   GROUP BY pe.which, b.now_from, b.prev_from
  UNION ALL
  SELECT 'type', 'now', pe.day, pe.order_type, count(*)::bigint, sum(pe.total), NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    FROM per pe WHERE pe.which = 'now'
   GROUP BY pe.day, pe.order_type
  UNION ALL
  SELECT 'customer', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         r.customer_id, cu.name::text, cu.phone::text, r.visits, r.spend, r.prev_visits, r.visits_90, r.first_90, r.last_visit
    FROM ranked r
    JOIN public.customers cu ON cu.id = r.customer_id AND cu.business_id = p_business
   WHERE r.r1 <= greatest(1, least(coalesce(p_limit, 200), 1000)) OR r.r2 <= greatest(1, least(coalesce(p_limit, 200), 1000))
$$;

-- analytics_cost_watch_set: analytics_cost_watch of 162_analytics_stock_customers_costs.sql over a set (1 branch filters)
CREATE OR REPLACE FUNCTION public.analytics_cost_watch_set(p_business uuid, p_branches uuid[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (kind text, item_id uuid, item_name text, unit text, cost_start numeric, cost_end numeric, changes bigint,
               used_in bigint, delta numeric, cost_now numeric, names text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pts AS (
    SELECT h.ingredient_id, h.created_at AS at, h.new_unit_cost AS cost, h.old_unit_cost AS was
      FROM public.ingredient_cost_history h
     WHERE h.business_id = p_business AND h.created_at <= p_to AND h.new_unit_cost IS NOT NULL
    UNION ALL
    SELECT gi.ingredient_id, ((g.received_date::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Nairobi'), gi.unit_cost, NULL::numeric
      FROM public.grn_items gi
      JOIN public.goods_received_notes g ON g.id = gi.grn_id
     WHERE g.business_id = p_business AND coalesce(gi.unit_cost, 0) > 0
       AND ((g.received_date::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Nairobi') <= p_to
  ),
  agg AS (
    SELECT p.ingredient_id,
           (array_agg(p.cost ORDER BY p.at DESC) FILTER (WHERE p.at < p_from))[1] AS before_cost,
           (array_agg(coalesce(p.was, p.cost) ORDER BY p.at) FILTER (WHERE p.at >= p_from))[1] AS first_in,
           (array_agg(p.cost ORDER BY p.at DESC))[1] AS end_cost,
           count(*) FILTER (WHERE p.at >= p_from) AS changes
      FROM pts p
     GROUP BY p.ingredient_id
    HAVING count(*) FILTER (WHERE p.at >= p_from) > 0
  ),
  moved AS (
    SELECT a.ingredient_id, coalesce(a.before_cost, a.first_in) AS cost_start, a.end_cost AS cost_end, a.changes
      FROM agg a
     WHERE coalesce(a.before_cost, a.first_in) IS NOT NULL AND a.end_cost IS DISTINCT FROM coalesce(a.before_cost, a.first_in)
  ),
  recipe_now AS (
    SELECT r.product_id, sum(r.quantity_per_serving * i.unit_cost) AS cost
      FROM public.recipes r JOIN public.ingredients i ON i.id = r.ingredient_id
     WHERE r.business_id = p_business AND i.unit_cost IS NOT NULL
     GROUP BY r.product_id
  ),
  own AS (
    SELECT p.id, p.name, p.status, coalesce(p.is_fuel, false) AS is_fuel,
           CASE WHEN coalesce(p.cost_price, 0) > 0 THEN p.cost_price ELSE rn.cost END AS cost,
           coalesce(p.cost_price, 0) > 0 AS has_price
      FROM public.products p LEFT JOIN recipe_now rn ON rn.product_id = p.id
     WHERE p.business_id = p_business
  ),
  combo AS (
    SELECT ci.combo_id, sum(ow.cost) AS cost
      FROM public.combo_items ci JOIN own ow ON ow.id = ci.product_id
     WHERE ow.cost IS NOT NULL AND ci.product_id <> ci.combo_id
     GROUP BY ci.combo_id
  ),
  sold AS (
    SELECT DISTINCT oi.product_id
      FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
     WHERE o.business_id = p_business AND o.status = 'completed'
       AND o.created_at >= p_from AND o.created_at <= p_to
       AND o.branch_id = ANY (p_branches)
       AND oi.product_id IS NOT NULL
  ),
  unsold AS (
    SELECT ow.name::text AS name
      FROM own ow LEFT JOIN combo cb ON cb.combo_id = ow.id
     WHERE ow.status = 'active' AND NOT ow.is_fuel AND ow.cost IS NULL AND cb.cost IS NULL
       AND ow.id NOT IN (SELECT s.product_id FROM sold s)
  ),
  top_ing AS (
    SELECT DISTINCT ON (r.product_id) r.product_id, i.name::text AS name, r.quantity_per_serving * i.unit_cost AS cost
      FROM public.recipes r JOIN public.ingredients i ON i.id = r.ingredient_id
     WHERE r.business_id = p_business AND i.unit_cost IS NOT NULL AND i.unit_cost > 0
     ORDER BY r.product_id, r.quantity_per_serving * i.unit_cost DESC, i.name
  )
  SELECT 'ingredient'::text, i.id, i.name::text, nullif(btrim(coalesce(i.unit, '')), ''), m.cost_start, m.cost_end, m.changes,
         (SELECT count(DISTINCT r.product_id) FROM public.recipes r WHERE r.ingredient_id = i.id AND r.business_id = p_business),
         NULL::numeric, i.unit_cost, NULL::text[]
    FROM moved m JOIN public.ingredients i ON i.id = m.ingredient_id AND i.business_id = p_business
  UNION ALL
  SELECT 'product', ow.id, ow.name::text, NULL, NULL, NULL, NULL, NULL,
         round(sum(r.quantity_per_serving * (m.cost_end - m.cost_start)), 4), round(rn.cost, 4),
         ARRAY[m.ingredient_id::text]
    FROM own ow
    JOIN public.recipes r ON r.product_id = ow.id AND r.business_id = p_business
    JOIN moved m ON m.ingredient_id = r.ingredient_id
    LEFT JOIN recipe_now rn ON rn.product_id = ow.id
   WHERE NOT ow.has_price
   GROUP BY ow.id, ow.name, rn.cost, m.ingredient_id
  UNION ALL
  SELECT 'top_ingredient', t.product_id, t.name, NULL, NULL, NULL, NULL, NULL, NULL, round(t.cost, 4), NULL
    FROM top_ing t
  UNION ALL
  SELECT 'unsold_no_cost', NULL, NULL, NULL, NULL, NULL, count(*)::bigint, NULL, NULL, NULL,
         (array_agg(u.name ORDER BY u.name))[1:5]
    FROM unsold u
$$;

-- analytics_together_set: analytics_together of 164_analytics_together.sql over a set (1 branch filters)
CREATE OR REPLACE FUNCTION public.analytics_together_set(p_business uuid, p_branches uuid[], p_from timestamptz, p_to timestamptz, p_limit integer DEFAULT 100)
RETURNS TABLE (kind text, orders bigint, multi_orders bigint, a_id uuid, a_name text, a_fuel boolean, a_orders bigint,
               b_id uuid, b_name text, b_fuel boolean, b_orders bigint, together bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH line AS (
    SELECT oi.order_id, oi.product_id, max(oi.product_name) AS product_name
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
     WHERE o.business_id = p_business
       AND o.status = 'completed'
       AND o.created_at >= p_from AND o.created_at <= p_to
       AND o.branch_id = ANY (p_branches)
       AND oi.product_id IS NOT NULL
       AND coalesce(oi.subtotal, 0) > 0
       AND coalesce(oi.quantity, 0) > 0
     GROUP BY oi.order_id, oi.product_id
  ),
  basket AS (
    SELECT l.order_id, count(*) AS n FROM line l GROUP BY l.order_id
  ),
  item AS (
    SELECT l.product_id, count(*) AS n, max(l.product_name) AS product_name FROM line l GROUP BY l.product_id
  ),
  pair AS (
    SELECT a.product_id AS a_id, b.product_id AS b_id, count(*) AS together
      FROM line a
      JOIN line b ON b.order_id = a.order_id AND a.product_id < b.product_id
      JOIN basket k ON k.order_id = a.order_id AND k.n BETWEEN 2 AND 25
     GROUP BY a.product_id, b.product_id
    HAVING count(*) >= 2
  ),
  ranked AS (
    SELECT pr.*, row_number() OVER (ORDER BY pr.together DESC, pr.a_id, pr.b_id) AS rn FROM pair pr
  )
  SELECT 'total'::text, (SELECT count(*) FROM basket)::bigint, (SELECT count(*) FROM basket WHERE n >= 2)::bigint,
         NULL::uuid, NULL::text, NULL::boolean, NULL::bigint, NULL::uuid, NULL::text, NULL::boolean, NULL::bigint, NULL::bigint
  UNION ALL
  SELECT 'pair'::text, NULL::bigint, NULL::bigint,
         r.a_id, coalesce(pa.name, ia.product_name)::text, coalesce(pa.is_fuel, false), ia.n::bigint,
         r.b_id, coalesce(pb.name, ib.product_name)::text, coalesce(pb.is_fuel, false), ib.n::bigint,
         r.together::bigint
    FROM ranked r
    JOIN item ia ON ia.product_id = r.a_id
    JOIN item ib ON ib.product_id = r.b_id
    LEFT JOIN public.products pa ON pa.id = r.a_id AND pa.business_id = p_business
    LEFT JOIN public.products pb ON pb.id = r.b_id AND pb.business_id = p_business
   WHERE r.rn <= greatest(1, least(coalesce(p_limit, 100), 300))
$$;

-- The cloud service role only: each function reads any business it is given, so it is not callable through the API.
REVOKE ALL ON FUNCTION public.analytics_menu_engineering_set(uuid, uuid[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_sales_heatmap_set(uuid, uuid[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_money_leaks_set(uuid, uuid[], timestamptz, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_credit_ageing_set(uuid, uuid[], timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_daily_sales_set(uuid, uuid[], timestamptz, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_item_times_set(uuid, uuid[], timestamptz, timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_stock_use_set(uuid, uuid[], timestamptz, timestamptz, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_customers_set(uuid, uuid[], timestamptz, timestamptz, timestamptz, integer, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_cost_watch_set(uuid, uuid[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_together_set(uuid, uuid[], timestamptz, timestamptz, integer) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.analytics_menu_engineering_set(uuid, uuid[], timestamptz, timestamptz) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_sales_heatmap_set(uuid, uuid[], timestamptz, timestamptz) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_money_leaks_set(uuid, uuid[], timestamptz, timestamptz, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_credit_ageing_set(uuid, uuid[], timestamptz) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_daily_sales_set(uuid, uuid[], timestamptz, timestamptz, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_item_times_set(uuid, uuid[], timestamptz, timestamptz, integer, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_stock_use_set(uuid, uuid[], timestamptz, timestamptz, timestamptz, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_customers_set(uuid, uuid[], timestamptz, timestamptz, timestamptz, integer, boolean, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_cost_watch_set(uuid, uuid[], timestamptz, timestamptz) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_together_set(uuid, uuid[], timestamptz, timestamptz, integer) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.analytics_menu_engineering_set(uuid, uuid[], timestamptz, timestamptz) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_sales_heatmap_set(uuid, uuid[], timestamptz, timestamptz) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_money_leaks_set(uuid, uuid[], timestamptz, timestamptz, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_credit_ageing_set(uuid, uuid[], timestamptz) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_daily_sales_set(uuid, uuid[], timestamptz, timestamptz, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_item_times_set(uuid, uuid[], timestamptz, timestamptz, integer, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_stock_use_set(uuid, uuid[], timestamptz, timestamptz, timestamptz, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_customers_set(uuid, uuid[], timestamptz, timestamptz, timestamptz, integer, boolean, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_cost_watch_set(uuid, uuid[], timestamptz, timestamptz) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_together_set(uuid, uuid[], timestamptz, timestamptz, integer) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('171_analytics_branch_sets', 'A582: All my branches - ten analytics aggregates over a set of branches (<name>_set, p_branches uuid[]; the originals untouched): a partner of some branches reads exactly their branches combined.')
ON CONFLICT (version) DO NOTHING;
