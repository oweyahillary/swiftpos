-- 162_analytics_stock_customers_costs.sql — A561: Analytics adds how fast stock goes, who comes back, what each sale
-- really earns and which items have no cost. Three more read-only aggregate functions for /api/analytics.
--
-- As 158 / 160 / 161: AGGREGATED HERE, in SQL - never a period of raw rows in Node. Each answer is a few hundred rows at
-- most (one per stock item used, one per customer kept, one per day and order type, one per ingredient whose cost moved).
--
--   analytics_stock_use(business, branch, from, to, prev_from, limit)
--       one row per stock item USED in the period or the previous one (prev_from .. from):
--         kind 'product'     a product that tracks stock (track_stock, not fuel, not sold through a recipe - its stock is
--                            the ingredients'): sold = what the cloud took off on sale (stock_movements 'sale', the
--                            reference the sale wrote; a variant's stock factor and a combo's items included, as
--                            lib/stockEffects deducts them) less what a void or refund of a paid order put back
--                            ('correction' "Void of Order ..." / "Refund of Order ..."), counted in the unit the stock is
--                            kept in (pieces for a product sold by the piece);
--         kind 'ingredient'  an ingredient: sold = ingredient_stock_movements 'sale' (recipes, variant links, takeaway
--                            packaging, as the cloud deducts them on sale);
--       wasted = wastage written off (wastage_entries not voided, by product or ingredient, its own quantity). Both for
--       the period and the previous one of the same length. on_hand = the level NOW at the branch asked
--       (stock_levels.quantity, or qty_pieces by the piece; ingredient_stock_levels.current_stock) - NULL with every
--       branch (stock is counted per branch). The `limit` items used most (default 300, at most 1000).
--
--   analytics_customers(business, branch, from, to, prev_from, cutoff, with_customers, limit)
--       completed orders only, business days (the owner's cut-off, East Africa Time):
--         kind 'period'    which = 'now' / 'prev': orders, sales (orders.total), orders and sales WITH a customer,
--                          customers seen, and NEW customers (their first completed order ever - in this scope - fell in
--                          that period);
--         kind 'type'      per business day of the period and order type (lower-cased): orders and sales;
--         kind 'customer'  (only when with_customers) per customer seen in the period or in the 90 days to its end:
--                          name, phone, visits (distinct business days) and orders and spend in the period, visits in
--                          the previous period, visits in the 90 days, the first of those 90 days and the last visit.
--                          The `limit` best by spend plus the `limit` with the most visits in 90 days (default 200).
--       Without with_customers no customer row and no name is read - the order-type mix needs none.
--
--   analytics_cost_watch(business, branch, from, to)
--         kind 'ingredient'      each ingredient whose cost moved in the period: its cost at the start (the last known
--                                before it, else the first change's old cost, else the first delivery's), at the end, how
--                                many changes, and how many recipes use it. Price points: ingredient_cost_history (an
--                                edit of unit_cost) and grn_items.unit_cost (a delivery, on its received_date).
--         kind 'product'         each product made from a recipe (no cost price of its own) and each moved ingredient in
--                                it: the change per serving from that ingredient (quantity per serving x its end - start
--                                cost), the recipe cost now, and `names` = [that ingredient's id];
--         kind 'top_ingredient'  each recipe product: the ingredient that costs the most in one serving (now);
--         kind 'unsold_no_cost'  how many active products have no cost at all (no cost price, no costed recipe line, no
--                                costed combo item - the rule of 158) and did NOT sell in the period (branch scope), with
--                                the first names.
--       Product cost prices keep no history (products.cost_price is overwritten), so a product's own cost change is not
--       seen; only recipe costs through their ingredients.
--
-- STABLE, SECURITY DEFINER, search_path public; the cloud service role only (each reads any business it is given).
-- No table, no trigger, no data change, existing indexes. Idempotent: safe to run twice.

CREATE OR REPLACE FUNCTION public.analytics_stock_use(p_business uuid, p_branch uuid, p_from timestamptz, p_to timestamptz, p_prev_from timestamptz, p_limit integer DEFAULT 300)
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
       AND (p_branch IS NULL OR m.branch_id = p_branch)
     GROUP BY m.product_id
  ),
  imove AS (
    SELECT m.ingredient_id AS id,
           sum(-m.quantity_change) FILTER (WHERE m.created_at >= p_from) AS sold,
           sum(-m.quantity_change) FILTER (WHERE m.created_at < p_from) AS prev_sold
      FROM public.ingredient_stock_movements m
     WHERE m.business_id = p_business AND m.movement_type = 'sale'
       AND m.created_at >= p_prev_from AND m.created_at <= p_to
       AND (p_branch IS NULL OR m.branch_id = p_branch)
     GROUP BY m.ingredient_id
  ),
  waste AS (
    SELECT w.product_id, w.ingredient_id,
           sum(w.quantity) FILTER (WHERE w.created_at >= p_from) AS wasted,
           sum(w.quantity) FILTER (WHERE w.created_at < p_from) AS prev_wasted
      FROM public.wastage_entries w
     WHERE w.business_id = p_business AND w.voided_at IS NULL
       AND w.created_at >= p_prev_from AND w.created_at <= p_to
       AND (p_branch IS NULL OR w.branch_id = p_branch)
     GROUP BY w.product_id, w.ingredient_id
  ),
  items AS (
    SELECT 'product'::text AS kind, pr.id, pr.name::text AS name, pr.unit, pr.by_piece,
           coalesce(pm.sold, 0) AS sold, coalesce(wp.wasted, 0) AS wasted,
           coalesce(pm.prev_sold, 0) AS prev_sold, coalesce(wp.prev_wasted, 0) AS prev_wasted,
           CASE WHEN p_branch IS NULL THEN NULL
                ELSE (SELECT CASE WHEN pr.by_piece THEN sl.qty_pieces::numeric ELSE sl.quantity END
                        FROM public.stock_levels sl WHERE sl.product_id = pr.id AND sl.branch_id = p_branch LIMIT 1) END AS on_hand
      FROM prod pr
      LEFT JOIN pmove pm ON pm.id = pr.id
      LEFT JOIN waste wp ON wp.product_id = pr.id AND wp.ingredient_id IS NULL
    UNION ALL
    SELECT 'ingredient'::text, i.id, i.name::text, nullif(btrim(coalesce(i.unit, '')), ''), false,
           coalesce(im.sold, 0), coalesce(wi.wasted, 0), coalesce(im.prev_sold, 0), coalesce(wi.prev_wasted, 0),
           CASE WHEN p_branch IS NULL THEN NULL
                ELSE (SELECT il.current_stock FROM public.ingredient_stock_levels il
                       WHERE il.ingredient_id = i.id AND il.branch_id = p_branch LIMIT 1) END
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

CREATE OR REPLACE FUNCTION public.analytics_customers(p_business uuid, p_branch uuid, p_from timestamptz, p_to timestamptz, p_prev_from timestamptz,
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
       AND (p_branch IS NULL OR o.branch_id = p_branch)
  ),
  firsts AS (
    SELECT o.customer_id, min(((o.created_at AT TIME ZONE 'Africa/Nairobi') - c.cut)::date) AS first_day
      FROM public.orders o, c
     WHERE o.business_id = p_business AND o.status = 'completed' AND o.customer_id IS NOT NULL AND o.created_at <= p_to
       AND (p_branch IS NULL OR o.branch_id = p_branch)
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

CREATE OR REPLACE FUNCTION public.analytics_cost_watch(p_business uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
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
       AND (p_branch IS NULL OR o.branch_id = p_branch)
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

-- The cloud service role only: each function reads any business it is given, so it is not callable through the API.
REVOKE ALL ON FUNCTION public.analytics_stock_use(uuid, uuid, timestamptz, timestamptz, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_customers(uuid, uuid, timestamptz, timestamptz, timestamptz, integer, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_cost_watch(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.analytics_stock_use(uuid, uuid, timestamptz, timestamptz, timestamptz, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_customers(uuid, uuid, timestamptz, timestamptz, timestamptz, integer, boolean, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.analytics_cost_watch(uuid, uuid, timestamptz, timestamptz) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.analytics_stock_use(uuid, uuid, timestamptz, timestamptz, timestamptz, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_customers(uuid, uuid, timestamptz, timestamptz, timestamptz, integer, boolean, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.analytics_cost_watch(uuid, uuid, timestamptz, timestamptz) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('162_analytics_stock_customers_costs', 'A561: Analytics - analytics_stock_use (stock used, wasted and on hand per item), analytics_customers (who comes back, new and returning, the order-type mix), analytics_cost_watch (ingredient cost moves, recipe cost changes, products with no cost that did not sell); aggregates, never raw rows.')
ON CONFLICT (version) DO NOTHING;
