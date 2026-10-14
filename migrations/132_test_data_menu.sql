-- Migration 132 — A482: clearing test data can also delete the whole menu (2026-10-14)
--
-- Owner, 2026-10-14: "can we add purge menu where we delete everything in the menu even the test data, should be a check
-- box when deleting test data".
--
-- public.purge_test_menu(business, from, to, stock_mode, delete_customers, dry_run, done_by, reason) → jsonb
--   The clear of migration 122 / 123 (public.purge_test_data, called unchanged inside it) AND the whole menu of the
--   business, in ONE transaction (one function call): it all goes, or (on any refusal or error) nothing does.
--   After the window's sales are removed, every menu row of the business is deleted, children first:
--     component slot options → component slots → variant group links → variant options → variant groups → modifier
--     options → modifier groups → product attributes → extra (attribute) options → extra (attribute) groups → combo items
--     → recipes → packaging → branch prices → offers → promotions → wastage of menu items → stock-count lines →
--     transfer lines → stock adjustments → stock batches (expiry) → stock movements → stock levels → stock (legacy) →
--     the window's supplier-return lines → pumps unlinked from the fuel products / tanks (the pumps stay) → fuel tanks →
--     products → category station routing → categories.
--   Ingredients, suppliers, staff, branches, tills, print stations, discounts and settings stay. Product images in
--   storage stay (only the products' rows, which point at them, go).
--   SAFETY: a sale OUTSIDE the window (a real sale) of a menu item, or a supplier return outside it of a menu item,
--   refuses the whole clear (problems, nothing changed): "clear those first or untick 'Also delete the whole menu'".
--   Sales inside the window are removed first (by purge_test_data), so nothing real then refers to the menu.
--   dry_run = true: the preview — purge_test_data's counts plus menu_* counts; nothing changed.
--   The clear's record (test_data_purges, written by purge_test_data) gets menu = true and the menu counts; the tills
--   read it (GET /api/pos/test-data-clears → apps/desktop/src/main/testDataClear.ts) and empty their own menu.
--   No foreign key is changed: every child row is deleted explicitly.
-- public.test_data_purges.menu — this clear deleted the whole menu.
--
-- purge_test_data itself is NOT changed (no overload: re-running 122 / 123 stays safe). Additive and idempotent.

ALTER TABLE public.test_data_purges ADD COLUMN IF NOT EXISTS menu boolean NOT NULL DEFAULT false;

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
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s real sale(s) outside the window use the menu — clear those first or untick ''Also delete the whole menu''.', v_n)); END IF;
  SELECT count(DISTINCT ri.return_id) INTO v_n FROM public.supplier_return_items ri JOIN public.supplier_returns r ON r.id = ri.return_id
   WHERE ri.product_id = ANY (v_products) AND NOT (r.created_at >= p_from AND r.created_at <= p_to);
  IF v_n > 0 THEN v_problems := array_append(v_problems, format('%s supplier return(s) outside the window return menu items — clear those first or untick ''Also delete the whole menu''.', v_n)); END IF;

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
  v_res := public.purge_test_data(p_business, p_from, p_to, p_stock_mode, p_delete_customers,
                                  p_dry_run OR coalesce(array_length(v_problems, 1), 0) > 0, p_done_by, p_reason);
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

COMMENT ON FUNCTION public.purge_test_menu IS
  '132 (A482): purge_test_data (the window) and the whole menu of the business — one transaction; refuses while a real sale outside the window uses the menu; dry_run = preview.';
COMMENT ON COLUMN public.test_data_purges.menu IS '132 (A482): this clear deleted the whole menu — the tills empty theirs when they see it.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('132_test_data_menu', 'A482: purge_test_menu — clear test data and the whole menu in one transaction; test_data_purges.menu')
ON CONFLICT (version) DO NOTHING;
