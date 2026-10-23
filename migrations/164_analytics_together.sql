-- 164_analytics_together.sql — A575: Analytics "What sells together" - one more read-only aggregate function for
-- /api/analytics/together and the "Do this next" cards that use it (stocking, placement, combos, a cashier's prompt -
-- never a price).
--
-- None of 158 / 160 / 161 / 162 looks INSIDE an order: they add every line of the period together. Which products end up
-- in the same order needs the order's lines side by side, so it is AGGREGATED HERE, in SQL - never a period of raw order
-- lines in Node. The answer is at most a few hundred rows whatever the period.
--
--   analytics_together(business, branch, from, to, limit)
--       completed orders of the period (and the branch, or every branch), their lines that are a product
--       (order_items.product_id set) with a price (subtotal > 0, quantity > 0): a free line (a gift, a zero-price
--       extra) is not a choice the customer paid for. Add-ons and modifiers are not order lines at all
--       (order_item_modifiers), so they never count. A product rung twice in one order counts once for that order.
--         kind 'total'  ONE row: `orders` = orders with at least one such line, `multi_orders` = those with two or more
--                       different products (the baskets the pairs come from);
--         kind 'pair'   each two different products found together in at least 2 orders: a (the smaller id) and b,
--                       their names (the product's name now, else the line's), whether each is fuel (products.is_fuel -
--                       a petrol station's pump sale is an order line too), how many orders hold each (`a_orders`,
--                       `b_orders`, over every order of the period) and how many hold both (`together`). The `limit`
--                       pairs found together most (default 100, at most 300).
--       An order with more than 25 different products (a big stock-up shop) counts in `orders` and in each product's
--       count but gives no pair: it would add hundreds of pairs that say little about what goes with what, and it keeps
--       the work bounded (at most 300 pairs an order).
--
-- STABLE, SECURITY DEFINER, search_path public; the cloud service role only (it reads any business it is given).
-- No table, no trigger, no data change, existing indexes (orders by business and date; order_items by order). Idempotent.

CREATE OR REPLACE FUNCTION public.analytics_together(p_business uuid, p_branch uuid, p_from timestamptz, p_to timestamptz, p_limit integer DEFAULT 100)
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
       AND (p_branch IS NULL OR o.branch_id = p_branch)
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

-- The cloud service role only: the function reads any business it is given, so it is not callable through the API.
REVOKE ALL ON FUNCTION public.analytics_together(uuid, uuid, timestamptz, timestamptz, integer) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.analytics_together(uuid, uuid, timestamptz, timestamptz, integer) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.analytics_together(uuid, uuid, timestamptz, timestamptz, integer) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('164_analytics_together', 'A575: Analytics what sells together - analytics_together: the orders of a period, how many hold two or more products, and the product pairs found together most (each product''s own order count beside them); priced product lines only, an aggregate, never raw rows.')
ON CONFLICT (version) DO NOTHING;
