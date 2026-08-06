-- ─────────────────────────────────────────────────────────────────────────────
-- create_order_atomic — write an order and everything that MUST be consistent
-- with it inside a single transaction.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────────
-- POST /api/orders wrote the order in ~15 sequential PostgREST calls: insert
-- order, then items, then variants, then modifiers, then payments, then stock,
-- then loyalty, then the KDS ticket. PostgREST has no cross-request transaction,
-- so a failure — or a dropped connection — after the order row but before the
-- payments left a COMPLETED order with no payment legs, or items belonging to no
-- order. checkPaymentIntegrity() noticed the symptom and logged it; nothing
-- prevented it. The desktop already does this correctly inside db.transaction();
-- the server had no equivalent.
--
-- ── WHAT THIS COVERS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
-- Inside the transaction: order, order_items, order_item_variants,
-- order_item_modifiers, payments. These are the INVARIANT UNIT — an order is not
-- a valid order without its lines and its tender, and none of them make sense on
-- their own. If any insert fails, the whole thing rolls back and no partial
-- order exists.
--
-- NOT inside: stock deduction, loyalty, discount-usage counters, the KDS ticket.
-- Those are secondary EFFECTS of a sale, not part of its identity. They remain
-- in the handler as post-commit steps. The critical change is that they now run
-- AFTER a durable, complete order exists, so a failure in stock deduction can no
-- longer orphan the order — at worst it leaves stock to be reconciled, which is
-- a smaller and detectable problem than a phantom paid order.
--
-- ── PAYMENT VALIDATION (finding #15) ─────────────────────────────────────────
-- The legs must sum to the order total, checked HERE, inside the transaction,
-- so a mismatch aborts the write instead of being logged after the fact. An
-- order that says paid-in-full for the wrong amount is a financial integrity
-- failure, not a warning. A one-cent tolerance absorbs rounding.
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
-- The unique index on (business_id, idempotency_key) still guards duplicates.
-- If a retry races in, the INSERT ... the unique violation surfaces as a
-- distinct SQLSTATE (23505) the caller maps to "already created".
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_order_atomic(
  p_order    jsonb,   -- the orders row, fully resolved server-side
  p_items    jsonb,   -- [{ item, variants:[...], modifiers:[...] }]
  p_payments jsonb    -- [{ method, amount, amount_tendered, change_given, reference }]
)
RETURNS TABLE (order_id uuid, order_number text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id   uuid;
  v_total      numeric;
  v_paid       numeric;
  v_item       jsonb;
  v_item_id    uuid;
  v_sub        jsonb;
BEGIN
  v_total := (p_order->>'total')::numeric;

  -- Payment legs must reconcile to the total BEFORE anything is written.
  SELECT COALESCE(SUM((leg->>'amount')::numeric), 0)
    INTO v_paid
    FROM jsonb_array_elements(p_payments) AS leg;

  IF abs(v_paid - v_total) > 0.01 THEN
    RAISE EXCEPTION 'payment legs sum to % but order total is %', v_paid, v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── orders ────────────────────────────────────────────────────────────────
  INSERT INTO public.orders (
    business_id, branch_id, customer_id, customer_name, customer_phone,
    order_number, order_type, delivery_person, status,
    subtotal, vat_amount, ctl_amount, discount_amount, discount_id,
    loyalty_points_used, total, tip_amount, shift_id, seated_at,
    idempotency_key, cashier_id, device_id, pump_id, sync_status
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
    COALESCE((p_order->>'tip_amount')::numeric, 0),
    NULLIF(p_order->>'shift_id','')::uuid,
    NULLIF(p_order->>'seated_at','')::timestamptz,
    p_order->>'idempotency_key',
    NULLIF(p_order->>'cashier_id','')::uuid,
    p_order->>'device_id',
    p_order->>'pump_id',
    'synced'
  RETURNING id INTO v_order_id;

  -- ── order_items (+ variants, modifiers) ────────────────────────────────────
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
          v_item_id,
          v_sub->>'variant_group_name',
          v_sub->>'variant_option_name',
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
          v_item_id,
          v_sub->>'modifier_group_name',
          v_sub->>'modifier_option_name',
          COALESCE((v_sub->>'price')::numeric, 0)
        );
      END LOOP;
    END IF;
  END LOOP;

  -- ── payments ───────────────────────────────────────────────────────────────
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
    'completed',
    'pending'
  FROM jsonb_array_elements(p_payments) AS leg;

  order_id     := v_order_id;
  order_number := p_order->>'order_number';
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.create_order_atomic IS
  'Writes order + items + variants + modifiers + payments in one transaction, '
  'validating that payment legs reconcile to the total. Replaces ~15 sequential '
  'PostgREST inserts that could leave a completed order with no payments.';
