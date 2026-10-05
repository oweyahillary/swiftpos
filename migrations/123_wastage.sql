-- Migration 123 — A399: wastage log (2026-10-05)
--
-- Owner, 2026-10-05: "i will work with your pic" — the wastage log first: spoiled, expired or dropped items, each with a
-- reason, and what it cost.
--
-- public.wastage_entries — one item written off at one branch: how much, why (reason), what it cost (unit_cost, value —
--   a snapshot at the time), who recorded it. Several items recorded together share a ref (WST-0001 …). A stocked
--   product or an ingredient leaves the branch's stock at once (a movement naming the entry); an item that is not
--   stock-tracked (a burger made to order) is recorded for its value only. Voided, never deleted: a void puts the stock
--   back and keeps the row (voided_at, who, why).
-- permission inventory.waste — record wastage. Granted here to the manager role set (managers and supervisors write
--   off what spoils on their shift); voiding an entry stays with inventory.adjust (the owner's by default).
-- public.purge_test_data — re-created unchanged except that it counts and clears wastage_entries in the window too
--   (A396: clear a client's test data). Same signature.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.wastage_entries (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id         uuid          NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  ref               text          NOT NULL,
  item_kind         text          NOT NULL,
  product_id        uuid          REFERENCES public.products(id)    ON DELETE SET NULL,
  ingredient_id     uuid          REFERENCES public.ingredients(id) ON DELETE SET NULL,
  name              text          NOT NULL,
  quantity          numeric(14,3) NOT NULL,
  unit_cost         numeric(14,2),
  value             numeric(14,2) NOT NULL DEFAULT 0,
  stock_moved       boolean       NOT NULL DEFAULT false,
  reason            text          NOT NULL,
  note              text,
  recorded_by       uuid,
  recorded_by_name  text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  voided_at         timestamptz,
  voided_by_name    text,
  void_reason       text,
  CONSTRAINT wastage_entries_kind_check     CHECK (item_kind IN ('product', 'ingredient')),
  -- the id matches the kind (either may become NULL if the item is later deleted — the name stays)
  CONSTRAINT wastage_entries_item_check     CHECK ((item_kind = 'product' OR product_id IS NULL) AND (item_kind = 'ingredient' OR ingredient_id IS NULL)),
  CONSTRAINT wastage_entries_quantity_check CHECK (quantity > 0),
  CONSTRAINT wastage_entries_reason_check   CHECK (reason IN ('expired', 'spoiled', 'damaged', 'kitchen_mistake', 'returned', 'staff_meal', 'other'))
);
CREATE INDEX IF NOT EXISTS wastage_entries_business ON public.wastage_entries (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wastage_entries_branch   ON public.wastage_entries (branch_id, created_at DESC);
ALTER TABLE public.wastage_entries ENABLE ROW LEVEL SECURITY;

INSERT INTO public.permissions (key, label, module, description)
VALUES ('inventory.waste', 'Record wastage', 'inventory', 'Write off spoiled, expired or damaged stock, with a reason')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key = 'inventory.waste'
  -- Same normalised name match as 120 (inventory.count).
  AND  lower(replace(r.name, ' ', '_'))
         IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

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
DECLARE
  v_branches  uuid[];
  v_orders    uuid[];
  v_items     uuid[];
  v_shifts    uuid[];
  v_days      uuid[];
  v_bills     uuid[];
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

  -- ── Safety: never cut through something that carries on after the window ──
  SELECT count(*) INTO v_n FROM public.shifts WHERE id = ANY (v_shifts) AND (closed_at IS NULL OR closed_at > p_to);
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s shift(s) that began in the window are still open or closed after it — close them on the till, or end the window later.', v_n)); END IF;
  SELECT count(*) INTO v_n FROM public.business_days WHERE id = ANY (v_days) AND (closed_at IS NULL OR closed_at > p_to);
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s trading day(s) that began in the window are still open or closed after it — close the day, or end the window later.', v_n)); END IF;
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

COMMENT ON TABLE public.wastage_entries IS
  '123 (A399): an item written off (spoiled, expired, damaged …) — quantity, reason, value at the time; voided, never deleted.';
COMMENT ON FUNCTION public.purge_test_data IS
  '122 (A396), 123 (A399: wastage too): remove what a business did between two times (test data) — one transaction; dry_run = preview. Never touches menu, staff, branches, tills or settings.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('123_wastage', 'A399: wastage_entries, permission inventory.waste; purge_test_data clears wastage too')
ON CONFLICT (version) DO NOTHING;
