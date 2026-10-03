-- Migration 115 — 0.6.33: free delivery — the shop pays the rider, the customer pays no fee (2026-10-02)
--
-- Owner, 2026-10-02: "can we add an option of free delivery where its not a must for the cashier to key in delivery fee?
-- but that can be turned on and of by the hotel owner" — then: "though this free delivery the rider is still paid by the
-- shop so delivery fee is a must but the customer does not pay it".
--
-- public.orders.delivery_free — the order is a free delivery: orders.delivery_fee is still the rider's fee (paid in cash
-- from the drawer, as on every delivery — float_transactions), but the customer's payments do NOT include it.
-- create_order_atomic reconciles the legs to total + tip (+ the fee only when the delivery is not free) and stores the
-- flag. A payload without delivery_free (every till before 0.6.33) is unchanged. Body otherwise exactly migration 111.
--
-- Additive and idempotent.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_free boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.orders.delivery_free IS
  '115: a free delivery — delivery_fee is what the shop paid the rider; the customer paid no fee (not in the payments).';

-- The atomic order write: a free delivery's fee is not in the amount due.
CREATE OR REPLACE FUNCTION public.create_order_atomic(
  p_order    jsonb,
  p_items    jsonb,
  p_payments jsonb
)
RETURNS TABLE (order_id uuid, order_number text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id uuid;
  v_total    numeric;
  v_tip      numeric;
  v_fee      numeric;
  v_free     boolean;
  v_due      numeric;
  v_paid     numeric;
  v_item     jsonb;
  v_item_id  uuid;
  v_sub      jsonb;
BEGIN
  v_total := (p_order->>'total')::numeric;
  v_tip   := COALESCE((p_order->>'tip_amount')::numeric, 0);
  -- 111: the delivery fee passes through like the tip — paid on top of the bill, not sales.
  v_fee   := COALESCE((p_order->>'delivery_fee')::numeric, 0);
  -- 115: a FREE delivery — the shop pays the rider the fee, the customer does not; only with a fee to be free of.
  v_free  := COALESCE((p_order->>'delivery_free')::boolean, false) AND v_fee > 0;
  -- What the customer actually hands over. The bill is what the business
  -- recognises; the tip and the delivery fee pass through it (115: not a free delivery's fee).
  v_due   := v_total + v_tip + CASE WHEN v_free THEN 0 ELSE v_fee END;

  SELECT COALESCE(SUM((leg->>'amount')::numeric), 0)
    INTO v_paid
    FROM jsonb_array_elements(p_payments) AS leg;

  IF abs(v_paid - v_due) > 0.01 THEN
    RAISE EXCEPTION 'payment legs sum to % but the amount due is % (total % + tip % + delivery fee %, free delivery %)',
      v_paid, v_due, v_total, v_tip, v_fee, CASE WHEN v_free THEN 'yes' ELSE 'no' END
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.orders (
    business_id, branch_id, customer_id, customer_name, customer_phone,
    order_number, order_type, delivery_person, status,
    subtotal, vat_amount, ctl_amount, discount_amount, discount_id,
    loyalty_points_used, total, tip_amount, delivery_fee, delivery_free, shift_id, seated_at,
    idempotency_key, cashier_id, device_id, pump_id, sync_status,
    created_at
  )
  SELECT
    (p_order->>'business_id')::uuid,
    (p_order->>'branch_id')::uuid,
    NULLIF(p_order->>'customer_id','')::uuid,
    p_order->>'customer_name',
    p_order->>'customer_phone',
    p_order->>'order_number',
    p_order->>'order_type',
    p_order->>'delivery_person',
    'completed',
    (p_order->>'subtotal')::numeric,
    (p_order->>'vat_amount')::numeric,
    (p_order->>'ctl_amount')::numeric,
    (p_order->>'discount_amount')::numeric,
    NULLIF(p_order->>'discount_id','')::uuid,
    COALESCE((p_order->>'loyalty_points_used')::int, 0),
    v_total,
    v_tip,
    v_fee,
    v_free,
    NULLIF(p_order->>'shift_id','')::uuid,
    NULLIF(p_order->>'seated_at','')::timestamptz,
    p_order->>'idempotency_key',
    NULLIF(p_order->>'cashier_id','')::uuid,
    p_order->>'device_id',
    NULLIF(p_order->>'pump_id','')::uuid,
    'synced',
    COALESCE(NULLIF(p_order->>'created_at','')::timestamptz, now())
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.order_items (
      order_id, product_id, product_name, category_name,
      unit_price, quantity, subtotal, notes
    )
    VALUES (
      v_order_id,
      NULLIF(v_item->'item'->>'product_id','')::uuid,
      v_item->'item'->>'product_name',
      v_item->'item'->>'category_name',
      (v_item->'item'->>'unit_price')::numeric,
      (v_item->'item'->>'quantity')::numeric,
      (v_item->'item'->>'subtotal')::numeric,
      v_item->'item'->>'notes'
    )
    RETURNING id INTO v_item_id;

    IF jsonb_typeof(v_item->'variants') = 'array' THEN
      FOR v_sub IN SELECT * FROM jsonb_array_elements(v_item->'variants')
      LOOP
        INSERT INTO public.order_item_variants (
          order_item_id, variant_group_name, variant_option_name, price_adjustment
        ) VALUES (
          v_item_id, v_sub->>'variant_group_name', v_sub->>'variant_option_name',
          COALESCE((v_sub->>'price_adjustment')::numeric, 0)
        );
      END LOOP;
    END IF;

    IF jsonb_typeof(v_item->'modifiers') = 'array' THEN
      FOR v_sub IN SELECT * FROM jsonb_array_elements(v_item->'modifiers')
      LOOP
        INSERT INTO public.order_item_modifiers (
          order_item_id, modifier_group_name, modifier_option_name, price
        ) VALUES (
          v_item_id, v_sub->>'modifier_group_name', v_sub->>'modifier_option_name',
          COALESCE((v_sub->>'price')::numeric, 0)
        );
      END LOOP;
    END IF;
  END LOOP;

  INSERT INTO public.payments (
    order_id, business_id, branch_id, method, amount,
    amount_tendered, change_given, reference, status, sync_status
  )
  SELECT
    v_order_id,
    (p_order->>'business_id')::uuid,
    (p_order->>'branch_id')::uuid,
    leg->>'method',
    (leg->>'amount')::numeric,
    COALESCE((leg->>'amount_tendered')::numeric, (leg->>'amount')::numeric),
    COALESCE((leg->>'change_given')::numeric, 0),
    NULLIF(leg->>'reference',''),
    COALESCE(NULLIF(leg->>'status',''), 'completed'),
    'pending'
  FROM jsonb_array_elements(p_payments) AS leg;

  order_id     := v_order_id;
  order_number := p_order->>'order_number';
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.create_order_atomic IS
  'Writes order + items + variants + modifiers + payments in one transaction, '
  'validating that payment legs reconcile to total + tip_amount + delivery_fee (115: without the fee on a free delivery, '
  'which the shop pays the rider). A tip and a delivery fee are money on top of the bill: in the legs, not in orders.total.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('115_free_delivery', '0.6.33: orders.delivery_free — the shop pays the rider, the customer pays no fee (create_order_atomic)')
ON CONFLICT (version) DO NOTHING;
