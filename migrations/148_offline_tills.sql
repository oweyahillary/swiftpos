-- Migration 148 — A522: nothing may wait on a till that is switched off (2026-10-17)
--
-- Owner, 2026-10-17: "check if anything will break or fail to respond because a till has not responded, I know not all
-- tills will run 24/7 — even Pollo restaurant had the same issue when deleting the menu". Act on what is known, never
-- wait on an absent till, queue the rest for when it reconnects.
--
-- 1. public.shifts.till_counted_cash / till_counted_at — the till own count of a drawer the web closed first (it was
--    answered 409 ALREADY_CLOSED and the count was dropped). shifts.till_confirmed_methods — the till own confirmation
--    of a shift the web confirmed first (409 ALREADY_CONFIRMED). Kept for the owner, who is told (routes/shifts.ts).
--    Nullable, no default.
--
-- 2. Clear test data (A396 / A482) past shifts and days still open on a till that is off. Pollo: a clear was refused
--    because one shift and two trading days that began in the window were still open on tills that were off - ending
--    the window later never helps (they have no close). public.purge_test_window and public.purge_test_menu_window are
--    the definitions of 123 (purge_test_data) and 132 (purge_test_menu) with one more argument, p_close_open boolean
--    DEFAULT false: true clears such shifts and days (began in the window, still open, nothing after the window) with
--    the rest instead of refusing. Unticked they are named in problems of their own that point at the tick. counts gains
--    open_on_tills, open_shifts, open_days and close_open. Everything else is unchanged.
--    public.purge_test_data and public.purge_test_menu keep their names and 8-argument signatures (no overload - an
--    overload would make every call ambiguous, and re-running 122 / 123 / 132 must stay safe): they call the new ones
--    without the tick. The admin route calls the _window ones only when the box is ticked (routes/admin.ts).
--    The tills clear their own open test shifts anyway (apps/desktop/src/main/testDataClear.ts).
--
-- Additive and idempotent (nothing but definitions and nullable columns - nothing to guard). Declared in
-- scripts/schema-pending.json until it has run in production.

ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS till_counted_cash      numeric;
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS till_counted_at        timestamptz;
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS till_confirmed_methods jsonb;

CREATE OR REPLACE FUNCTION public.purge_test_window(
  p_business         uuid,
  p_from             timestamptz,
  p_to               timestamptz,
  p_stock_mode       text    DEFAULT 'undo',
  p_delete_customers boolean DEFAULT false,
  p_dry_run          boolean DEFAULT true,
  p_done_by          text    DEFAULT NULL,
  p_reason           text    DEFAULT NULL,
  p_close_open       boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_branches  uuid[];
  v_orders    uuid[];
  v_items     uuid[];
  v_shifts    uuid[];
  v_days      uuid[];
  v_bills     uuid[];
  v_idle_shifts uuid[];
  v_idle_days   uuid[];
  v_problems  text[] := ARRAY[]::text[];
  v_counts    jsonb  := '{}'::jsonb;
  v_n         integer;
  v_first     timestamptz;
  v_last      timestamptz;
  v_next      timestamptz;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    v_problems := array_append(v_problems, 'The end of testing must be after its start.'::text);
  END IF;
  IF p_to > now() + interval '5 minutes' THEN
    v_problems := array_append(v_problems, 'The end of testing is in the future.'::text);
  END IF;
  IF p_stock_mode NOT IN ('undo', 'zero', 'keep') THEN
    v_problems := array_append(v_problems, 'Stock must be undo, zero or keep.'::text);
  END IF;
  IF array_length(v_problems, 1) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'problems', to_jsonb(v_problems), 'counts', v_counts);
  END IF;

  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_branches FROM public.branches WHERE business_id = p_business;
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]), min(created_at), max(created_at) INTO v_orders, v_first, v_last
    FROM public.orders WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  SELECT min(created_at) INTO v_next FROM public.orders WHERE business_id = p_business AND created_at > p_to;
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_items FROM public.order_items WHERE order_id = ANY (v_orders);
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_shifts
    FROM public.shifts WHERE business_id = p_business AND opened_at >= p_from AND opened_at <= p_to;
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_days
    FROM public.business_days WHERE business_id = p_business AND opened_at >= p_from AND opened_at <= p_to;
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_bills
    FROM public.supplier_bills WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;

  -- A522: still open on a till that is switched off - began in the window, never closed, and nothing after the window
  -- (no sale, cash in / out or expense on the shift, no shift outside the window on the day). Ending the window later
  -- never helps them (they have no close), so with p_close_open they are cleared with the rest instead of refusing.
  SELECT coalesce(array_agg(s.id), ARRAY[]::uuid[]) INTO v_idle_shifts FROM public.shifts s
   WHERE s.id = ANY (v_shifts) AND s.closed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.shift_id = s.id AND o.created_at > p_to)
     AND NOT EXISTS (SELECT 1 FROM public.float_transactions f WHERE f.shift_id = s.id AND f.created_at > p_to)
     AND NOT EXISTS (SELECT 1 FROM public.expenses e WHERE e.shift_id = s.id AND e.created_at > p_to);
  SELECT coalesce(array_agg(d.id), ARRAY[]::uuid[]) INTO v_idle_days FROM public.business_days d
   WHERE d.id = ANY (v_days) AND d.closed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.business_day_id = d.id AND NOT (s.id = ANY (v_shifts)))
     AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.business_day_id = d.id AND s.id = ANY (v_shifts)
                       AND (s.closed_at > p_to OR (s.closed_at IS NULL AND NOT (s.id = ANY (v_idle_shifts)))));

  -- ── Safety: never cut through something that carries on after the window ──
  SELECT count(*) INTO v_n FROM public.shifts WHERE id = ANY (v_shifts) AND (closed_at IS NULL OR closed_at > p_to)
     AND NOT (id = ANY (v_idle_shifts));
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s shift(s) that began in the window are still open or closed after it — close them on the till, or end the window later.', v_n)); END IF;
  SELECT count(*) INTO v_n FROM public.business_days WHERE id = ANY (v_days) AND (closed_at IS NULL OR closed_at > p_to)
     AND NOT (id = ANY (v_idle_days));
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s trading day(s) that began in the window are still open or closed after it — close the day, or end the window later.', v_n)); END IF;
  IF NOT coalesce(p_close_open, false) AND coalesce(array_length(v_idle_shifts, 1), 0) > 0 THEN
    v_problems := array_append(v_problems, format('%s shift(s) that began in the window are still open on a till that is switched off (nothing after the window) — close them on the till, or tick Also clear shifts and trading days still open on tills that are switched off.', array_length(v_idle_shifts, 1)));
  END IF;
  IF NOT coalesce(p_close_open, false) AND coalesce(array_length(v_idle_days, 1), 0) > 0 THEN
    v_problems := array_append(v_problems, format('%s trading day(s) that began in the window are still open on a till that is switched off (nothing after the window) — close the day, or tick Also clear shifts and trading days still open on tills that are switched off.', array_length(v_idle_days, 1)));
  END IF;
  SELECT count(*) INTO v_n FROM public.orders WHERE business_id = p_business AND created_at > p_to AND shift_id = ANY (v_shifts);
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s sale(s) after the window belong to a shift inside it — the window would cut a real shift in two.', v_n)); END IF;
  SELECT count(*) INTO v_n FROM public.shifts WHERE business_id = p_business AND NOT (id = ANY (v_shifts)) AND business_day_id = ANY (v_days);
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s shift(s) outside the window belong to a trading day inside it.', v_n)); END IF;
  SELECT count(*) INTO v_n FROM public.supplier_payments WHERE business_id = p_business AND bill_id = ANY (v_bills)
     AND NOT (created_at >= p_from AND created_at <= p_to);
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s supplier payment(s) after the window pay a bill inside it.', v_n)); END IF;
  SELECT count(*) INTO v_n FROM public.goods_received_notes g WHERE g.business_id = p_business AND g.created_at >= p_from AND g.created_at <= p_to
     AND (EXISTS (SELECT 1 FROM public.supplier_bills b WHERE b.grn_id = g.id AND NOT (b.created_at >= p_from AND b.created_at <= p_to))
       OR EXISTS (SELECT 1 FROM public.supplier_returns x WHERE x.grn_id = g.id AND NOT (x.created_at >= p_from AND x.created_at <= p_to)));
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s delivery(ies) inside the window are billed or returned after it.', v_n)); END IF;

  v_counts := jsonb_build_object(
    'sales',            coalesce(array_length(v_orders, 1), 0),
    'sales_value',      (SELECT coalesce(sum(total), 0) FROM public.orders WHERE id = ANY (v_orders)),
    'first_sale',       v_first,
    'last_sale',        v_last,
    'next_sale_after',  v_next,
    'payments',         (SELECT count(*) FROM public.payments WHERE order_id = ANY (v_orders)),
    'shifts',           coalesce(array_length(v_shifts, 1), 0),
    'trading_days',     coalesce(array_length(v_days, 1), 0),
    'open_on_tills',    coalesce(array_length(v_idle_shifts, 1), 0) + coalesce(array_length(v_idle_days, 1), 0),
    'open_shifts',      coalesce(array_length(v_idle_shifts, 1), 0),
    'open_days',        coalesce(array_length(v_idle_days, 1), 0),
    'close_open',       coalesce(p_close_open, false),
    'cash_in_out',      (SELECT count(*) FROM public.float_transactions WHERE order_id = ANY (v_orders) OR shift_id = ANY (v_shifts)
                           OR (branch_id = ANY (v_branches) AND created_at >= p_from AND created_at <= p_to)),
    'expenses',         (SELECT count(*) FROM public.expenses WHERE business_id = p_business AND (shift_id = ANY (v_shifts) OR (created_at >= p_from AND created_at <= p_to))),
    'stock_movements',  (SELECT count(*) FROM public.stock_movements WHERE branch_id = ANY (v_branches) AND created_at >= p_from AND created_at <= p_to)
                      + (SELECT count(*) FROM public.ingredient_stock_movements WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to),
    'stock_counts',     (SELECT count(*) FROM public.stock_takes WHERE business_id = p_business AND started_at >= p_from AND started_at <= p_to),
    'transfers',        (SELECT count(*) FROM public.stock_transfers WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to),
    'purchase_orders',  (SELECT count(*) FROM public.purchase_orders WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to),
    'deliveries',       (SELECT count(*) FROM public.goods_received_notes WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to),
    'supplier_bills',   coalesce(array_length(v_bills, 1), 0),
    'supplier_payments',(SELECT count(*) FROM public.supplier_payments WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to),
    'supplier_returns', (SELECT count(*) FROM public.supplier_returns WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to),
    'wastage',          (SELECT count(*) FROM public.wastage_entries WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to),
    'reservations',     (SELECT count(*) FROM public.reservations WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to),
    'customers_created',(SELECT count(*) FROM public.customers WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to),
    'customers_touched_before',
                        (SELECT count(DISTINCT c.id) FROM public.customers c
                           WHERE c.business_id = p_business AND c.created_at < p_from
                             AND (EXISTS (SELECT 1 FROM public.loyalty_transactions l WHERE l.customer_id = c.id AND l.order_id = ANY (v_orders))
                               OR EXISTS (SELECT 1 FROM public.customer_credit_transactions t WHERE t.customer_id = c.id AND t.order_id = ANY (v_orders))))
  );

  IF array_length(v_problems, 1) > 0 OR p_dry_run THEN
    RETURN jsonb_build_object('ok', coalesce(array_length(v_problems, 1), 0) = 0, 'problems', to_jsonb(v_problems), 'counts', v_counts, 'dry_run', p_dry_run);
  END IF;

  -- ── Stock first, while the movements still say what happened ──
  IF p_stock_mode = 'undo' THEN
    UPDATE public.stock_levels sl
       SET quantity   = sl.quantity   - CASE WHEN p.sold_by = 'piece' THEN 0 ELSE m.delta END,
           qty_pieces = sl.qty_pieces - CASE WHEN p.sold_by = 'piece' THEN round(m.delta)::integer ELSE 0 END,
           updated_at = now()
      FROM (SELECT product_id, branch_id, sum(quantity_change) AS delta FROM public.stock_movements
             WHERE branch_id = ANY (v_branches) AND created_at >= p_from AND created_at <= p_to
             GROUP BY product_id, branch_id) m
      JOIN public.products p ON p.id = m.product_id
     WHERE sl.product_id = m.product_id AND sl.branch_id = m.branch_id AND coalesce(p.is_fuel, false) = false;
    UPDATE public.ingredient_stock_levels il
       SET current_stock = il.current_stock - m.delta, updated_at = now()
      FROM (SELECT ingredient_id, branch_id, sum(quantity_change) AS delta FROM public.ingredient_stock_movements
             WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to
             GROUP BY ingredient_id, branch_id) m
     WHERE il.ingredient_id = m.ingredient_id AND il.branch_id = m.branch_id;
  ELSIF p_stock_mode = 'zero' THEN
    UPDATE public.stock_levels SET quantity = 0, qty_pieces = 0, updated_at = now() WHERE branch_id = ANY (v_branches);
    UPDATE public.ingredient_stock_levels SET current_stock = 0, updated_at = now() WHERE business_id = p_business;
  END IF;

  -- ── Sales and everything hanging off them ──
  DELETE FROM public.order_item_units     WHERE order_item_id = ANY (v_items);
  DELETE FROM public.order_item_modifiers WHERE order_item_id = ANY (v_items);
  DELETE FROM public.order_item_variants  WHERE order_item_id = ANY (v_items);
  DELETE FROM public.order_items          WHERE id = ANY (v_items);
  DELETE FROM public.payments             WHERE order_id = ANY (v_orders);
  DELETE FROM public.kitchen_tickets      WHERE order_id = ANY (v_orders);
  DELETE FROM public.kitchen_voids        WHERE order_id = ANY (v_orders) OR shift_id = ANY (v_shifts)
                                             OR (business_id = p_business AND created_at >= p_from AND created_at <= p_to);
  DELETE FROM public.loyalty_transactions WHERE order_id = ANY (v_orders)
                                             OR (business_id = p_business AND created_at >= p_from AND created_at <= p_to);
  DELETE FROM public.customer_credit_transactions WHERE order_id = ANY (v_orders)
                                             OR (business_id = p_business AND created_at >= p_from AND created_at <= p_to);
  DELETE FROM public.payment_exceptions   WHERE order_id = ANY (v_orders);
  DELETE FROM public.etims_invoices       WHERE order_id = ANY (v_orders);
  DELETE FROM public.whatsapp_deliveries  WHERE order_id = ANY (v_orders);
  DELETE FROM public.parking_sessions     WHERE order_id = ANY (v_orders)
                                             OR (business_id = p_business AND created_at >= p_from AND created_at <= p_to);
  DELETE FROM public.float_transactions   WHERE order_id = ANY (v_orders) OR shift_id = ANY (v_shifts)
                                             OR (branch_id = ANY (v_branches) AND created_at >= p_from AND created_at <= p_to);
  DELETE FROM public.expenses             WHERE business_id = p_business
                                             AND (shift_id = ANY (v_shifts) OR (created_at >= p_from AND created_at <= p_to));
  DELETE FROM public.stock_movements      WHERE branch_id = ANY (v_branches) AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.ingredient_stock_movements WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.orders               WHERE id = ANY (v_orders);
  DELETE FROM public.shifts               WHERE id = ANY (v_shifts);
  DELETE FROM public.business_days        WHERE id = ANY (v_days);
  DELETE FROM public.day_close_instructions WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.clock_events         WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;

  -- ── Stock work and suppliers ──
  DELETE FROM public.stock_takes          WHERE business_id = p_business AND started_at >= p_from AND started_at <= p_to;
  DELETE FROM public.stock_adjustments    WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.stock_transfers      WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.supplier_payments    WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.supplier_bills       WHERE id = ANY (v_bills);
  DELETE FROM public.supplier_returns     WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.wastage_entries      WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.goods_received_notes WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.purchase_orders      WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;

  -- ── The rest of the window ──
  DELETE FROM public.reservations         WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  DELETE FROM public.notifications        WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;
  IF p_delete_customers THEN
    DELETE FROM public.customers c WHERE c.business_id = p_business AND c.created_at >= p_from AND c.created_at <= p_to
       AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.customer_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM public.loyalty_transactions l WHERE l.customer_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM public.customer_credit_transactions t WHERE t.customer_id = c.id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('customers_deleted', v_n);
  END IF;

  INSERT INTO public.test_data_purges (business_id, from_at, to_at, stock_mode, delete_customers, counts, done_by, reason)
  VALUES (p_business, p_from, p_to, p_stock_mode, p_delete_customers, v_counts, p_done_by, p_reason);

  RETURN jsonb_build_object('ok', true, 'problems', '[]'::jsonb, 'counts', v_counts, 'dry_run', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_test_menu_window(
  p_business         uuid,
  p_from             timestamptz,
  p_to               timestamptz,
  p_stock_mode       text    DEFAULT 'undo',
  p_delete_customers boolean DEFAULT false,
  p_dry_run          boolean DEFAULT true,
  p_done_by          text    DEFAULT NULL,
  p_reason           text    DEFAULT NULL,
  p_close_open       boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_orders    uuid[];
  v_products  uuid[];
  v_cats      uuid[];
  v_vgroups   uuid[];
  v_mgroups   uuid[];
  v_slots     uuid[];
  v_agroups   uuid[];
  v_tanks     uuid[];
  v_problems  text[] := ARRAY[]::text[];
  v_menu      jsonb;
  v_res       jsonb;
  v_counts    jsonb;
  v_all       jsonb;
  v_n         integer;
BEGIN
  -- The window's sales, as purge_test_data takes them (they go first, so they never block).
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_orders
    FROM public.orders WHERE business_id = p_business AND created_at >= p_from AND created_at <= p_to;

  -- ── The menu ──
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_products FROM public.products   WHERE business_id = p_business;
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_cats     FROM public.categories WHERE business_id = p_business;
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_vgroups  FROM public.variant_groups  WHERE product_id = ANY (v_products);
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_mgroups  FROM public.modifier_groups WHERE product_id = ANY (v_products);
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_slots    FROM public.component_slots
    WHERE business_id = p_business OR product_id = ANY (v_products);
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_agroups  FROM public.attribute_groups WHERE business_id = p_business;
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_tanks    FROM public.fuel_tanks
    WHERE product_id = ANY (v_products) OR fuel_product_id = ANY (v_products);

  -- ── Safety: nothing real outside the window may still use the menu ──
  SELECT count(*) INTO v_n FROM (
    SELECT oi.order_id FROM public.order_items oi
     WHERE oi.product_id = ANY (v_products) AND NOT (oi.order_id = ANY (v_orders))
    UNION
    SELECT oi.order_id FROM public.order_item_units u JOIN public.order_items oi ON oi.id = u.order_item_id
     WHERE u.product_id = ANY (v_products) AND NOT (oi.order_id = ANY (v_orders))
  ) s;
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s real sale(s) outside the window use the menu — clear those first or untick "Also delete the whole menu".', v_n)); END IF;
  SELECT count(DISTINCT ri.return_id) INTO v_n FROM public.supplier_return_items ri JOIN public.supplier_returns r ON r.id = ri.return_id
   WHERE ri.product_id = ANY (v_products) AND NOT (r.created_at >= p_from AND r.created_at <= p_to);
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s supplier return(s) outside the window return menu items — clear those first or untick "Also delete the whole menu".', v_n)); END IF;

  v_menu := jsonb_build_object(
    'menu',               true,
    'menu_products',      coalesce(array_length(v_products, 1), 0),
    'menu_categories',    coalesce(array_length(v_cats, 1), 0),
    'menu_variants',      coalesce(array_length(v_vgroups, 1), 0)
                        + (SELECT count(*) FROM public.variant_options WHERE variant_group_id = ANY (v_vgroups)),
    'menu_modifiers',     coalesce(array_length(v_mgroups, 1), 0)
                        + (SELECT count(*) FROM public.modifier_options WHERE modifier_group_id = ANY (v_mgroups)),
    'menu_extras',        coalesce(array_length(v_agroups, 1), 0)
                        + (SELECT count(*) FROM public.attribute_options WHERE group_id = ANY (v_agroups)),
    'menu_combos',        (SELECT count(*) FROM public.combo_items WHERE combo_id = ANY (v_products) OR product_id = ANY (v_products))
                        + coalesce(array_length(v_slots, 1), 0),
    'menu_recipes',       (SELECT count(*) FROM public.recipes WHERE product_id = ANY (v_products))
                        + (SELECT count(*) FROM public.product_packaging WHERE product_id = ANY (v_products)),
    'menu_offers',        (SELECT count(*) FROM public.offers WHERE business_id = p_business)
                        + (SELECT count(*) FROM public.promotions WHERE business_id = p_business),
    'menu_branch_prices', (SELECT count(*) FROM public.branch_prices WHERE product_id = ANY (v_products)),
    'menu_stock_lines',   (SELECT count(*) FROM public.stock_levels WHERE product_id = ANY (v_products))
                        + (SELECT count(*) FROM public.stock WHERE product_id = ANY (v_products))
                        + (SELECT count(*) FROM public.stock_batches WHERE product_id = ANY (v_products))
                        + coalesce(array_length(v_tanks, 1), 0)
  );

  -- ── The window (122 / 123): a preview when this is one or the menu refuses, the clear otherwise ──
  v_res := public.purge_test_window(p_business, p_from, p_to, p_stock_mode, p_delete_customers,
                                  p_dry_run OR coalesce(array_length(v_problems, 1), 0) > 0, p_done_by, p_reason,
                                  coalesce(p_close_open, false));
  v_counts := coalesce(v_res->'counts', '{}'::jsonb) || v_menu;
  v_all := coalesce(v_res->'problems', '[]'::jsonb) || to_jsonb(v_problems);

  IF jsonb_array_length(v_all) > 0 OR coalesce((v_res->>'ok')::boolean, false) = false OR p_dry_run THEN
    RETURN jsonb_build_object('ok', jsonb_array_length(v_all) = 0 AND coalesce((v_res->>'ok')::boolean, false),
                              'problems', v_all, 'counts', v_counts, 'dry_run', p_dry_run);
  END IF;

  -- ── The whole menu, children first (no foreign key is relied on to cascade) ──
  DELETE FROM public.slot_options           WHERE slot_id = ANY (v_slots) OR option_product_id = ANY (v_products);
  DELETE FROM public.component_slots        WHERE id = ANY (v_slots);
  DELETE FROM public.variant_group_products WHERE variant_group_id = ANY (v_vgroups) OR product_id = ANY (v_products);
  DELETE FROM public.variant_options        WHERE variant_group_id = ANY (v_vgroups);
  UPDATE public.variant_options SET linked_product_id = NULL WHERE linked_product_id = ANY (v_products);
  DELETE FROM public.variant_groups         WHERE id = ANY (v_vgroups);
  DELETE FROM public.modifier_options       WHERE modifier_group_id = ANY (v_mgroups);
  DELETE FROM public.modifier_groups        WHERE id = ANY (v_mgroups);
  DELETE FROM public.product_attributes     WHERE product_id = ANY (v_products) OR group_id = ANY (v_agroups);
  DELETE FROM public.attribute_options      WHERE group_id = ANY (v_agroups);
  DELETE FROM public.attribute_groups       WHERE id = ANY (v_agroups);
  DELETE FROM public.combo_items            WHERE combo_id = ANY (v_products) OR product_id = ANY (v_products);
  DELETE FROM public.recipes                WHERE product_id = ANY (v_products);
  DELETE FROM public.product_packaging      WHERE product_id = ANY (v_products);
  DELETE FROM public.branch_prices          WHERE product_id = ANY (v_products);
  DELETE FROM public.offers                 WHERE business_id = p_business;
  DELETE FROM public.promotions             WHERE business_id = p_business;
  DELETE FROM public.wastage_entries        WHERE product_id = ANY (v_products);
  DELETE FROM public.stock_take_lines       WHERE product_id = ANY (v_products);
  DELETE FROM public.stock_transfer_items   WHERE product_id = ANY (v_products);
  DELETE FROM public.stock_adjustments      WHERE product_id = ANY (v_products);
  DELETE FROM public.stock_batches          WHERE product_id = ANY (v_products);
  DELETE FROM public.stock_movements        WHERE product_id = ANY (v_products);
  DELETE FROM public.stock_levels           WHERE product_id = ANY (v_products);
  DELETE FROM public.stock                  WHERE product_id = ANY (v_products);
  DELETE FROM public.supplier_return_items  WHERE product_id = ANY (v_products);   -- none outside the window (checked above)
  UPDATE public.pumps SET fuel_product_id = NULL WHERE fuel_product_id = ANY (v_products);
  UPDATE public.pumps SET tank_id = NULL         WHERE tank_id = ANY (v_tanks);
  DELETE FROM public.fuel_tanks             WHERE id = ANY (v_tanks);
  DELETE FROM public.products               WHERE id = ANY (v_products);
  DELETE FROM public.category_stations      WHERE category_id = ANY (v_cats);
  DELETE FROM public.categories             WHERE id = ANY (v_cats);

  -- The record purge_test_data just wrote (this transaction's) says the menu went too.
  UPDATE public.test_data_purges SET menu = true, counts = v_counts
   WHERE id = (SELECT id FROM public.test_data_purges WHERE business_id = p_business AND created_at = now()
                ORDER BY created_at DESC LIMIT 1);

  RETURN jsonb_build_object('ok', true, 'problems', '[]'::jsonb, 'counts', v_counts, 'dry_run', false);
END;
$$;

-- The old names and signatures, unchanged (8 arguments - no overload, so re-running 122 / 123 / 132 stays safe):
-- the same clear, without the tick.
CREATE OR REPLACE FUNCTION public.purge_test_data(
  p_business         uuid,
  p_from             timestamptz,
  p_to               timestamptz,
  p_stock_mode       text    DEFAULT 'undo',
  p_delete_customers boolean DEFAULT false,
  p_dry_run          boolean DEFAULT true,
  p_done_by          text    DEFAULT NULL,
  p_reason           text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN public.purge_test_window(p_business, p_from, p_to, p_stock_mode, p_delete_customers, p_dry_run, p_done_by, p_reason, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_test_menu(
  p_business         uuid,
  p_from             timestamptz,
  p_to               timestamptz,
  p_stock_mode       text    DEFAULT 'undo',
  p_delete_customers boolean DEFAULT false,
  p_dry_run          boolean DEFAULT true,
  p_done_by          text    DEFAULT NULL,
  p_reason           text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN public.purge_test_menu_window(p_business, p_from, p_to, p_stock_mode, p_delete_customers, p_dry_run, p_done_by, p_reason, false);
END;
$$;

COMMENT ON COLUMN public.shifts.till_counted_cash IS '148 (A522): the till own count of this drawer, sent after the web had closed it (the web close stands).';
COMMENT ON COLUMN public.shifts.till_counted_at IS '148 (A522): when the till counted it.';
COMMENT ON COLUMN public.shifts.till_confirmed_methods IS '148 (A522): a manager confirmation made on the till after the web had confirmed this shift (the web one stands).';
COMMENT ON FUNCTION public.purge_test_window IS
  '148 (A522): purge_test_data (122, 123) with p_close_open - shifts and days still open on a till that is off (began in the window, nothing after it) are cleared with the rest. One transaction, dry_run = preview.';
COMMENT ON FUNCTION public.purge_test_menu_window IS
  '148 (A522): purge_test_menu (132) with p_close_open, passed on to purge_test_window. One transaction, dry_run = preview.';
COMMENT ON FUNCTION public.purge_test_data IS
  '122 (A396), 123 (A399), 148 (A522: now purge_test_window without the tick): remove what a business did between two times (test data) - one transaction, dry_run = preview.';
COMMENT ON FUNCTION public.purge_test_menu IS
  '132 (A482), 148 (A522: now purge_test_menu_window without the tick): the window and the whole menu of the business - one transaction, dry_run = preview.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('148_offline_tills', 'A522: shifts.till_counted_cash, till_counted_at, till_confirmed_methods - purge_test_window and purge_test_menu_window take p_close_open (clear what is still open on tills that are off), the old names call them unticked')
ON CONFLICT (version) DO NOTHING;
