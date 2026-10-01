-- Migration 111 — 0.6.27: a prospect's requests (2026-09-30)
--
-- Owner, 2026-09-30 (after a meeting with a prospect): "we can find a way of turning this features on and off per
-- clients requests". The switches live in feature_flags (admin portal); this migration adds the three columns they need
-- and teaches the atomic order write about the delivery fee. Additive and idempotent; nothing existing changes meaning.
--
-- 1. orders.delivery_fee — what the customer pays ON TOP of the bill for a delivery ("delivery fee is usually paid by
--    the client as an addition to the order amount"). Pass-through, like tip_amount (migration 69): it is in the
--    payment legs, NOT in orders.total, so sales, VAT and every report of sales are unchanged. The rider is paid it in
--    cash from the drawer — a float_out the till (or, for a web sale, the cloud) records, so expected cash is the fee
--    lower while the method the customer paid with (M-Pesa) carries it.
--    create_order_atomic now reconciles the legs against total + tip + delivery_fee and stores the fee. A payload
--    without delivery_fee (every till before 0.6.27) is unchanged: the fee is 0.
--
-- 2. expenses.payment_method — how an expense was paid ("some expenses are paid using mpesa or cash"). Only 'cash'
--    leaves the drawer; M-Pesa etc. come off that method's expected total. Every expense so far was cash (the drawer
--    paid it), so the column defaults to 'cash' and existing rows read as what they were.
--
--    float_transactions.order_id — the sale a pay-out was FOR (the rider's fee on a web sale), so voiding that sale
--    finds the pay-out and puts it back. NULL for every other pay-in/out. (A till keeps its own link locally.)
--
-- 3. shifts.confirm_reasons — the confirming manager's reason per method where their count differs from the cashier's
--    ({"cash": "200 found under the tray"}). NULL = none given / confirmed before 111.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_fee numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_delivery_fee_nonneg;
ALTER TABLE public.orders ADD CONSTRAINT orders_delivery_fee_nonneg CHECK (delivery_fee >= 0);
COMMENT ON COLUMN public.orders.delivery_fee IS
  '111: the delivery fee paid on top of the bill (pass-through to the rider, like tip_amount) — in the payment legs, not in total.';

ALTER TABLE public.float_transactions
  ADD COLUMN IF NOT EXISTS order_id uuid;
ALTER TABLE public.float_transactions DROP CONSTRAINT IF EXISTS float_transactions_order_id_fkey;
ALTER TABLE public.float_transactions
  ADD CONSTRAINT float_transactions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.float_transactions.order_id IS
  '111: the sale this pay-out/pay-in was for (a rider''s delivery fee, and its return when the sale is voided). NULL otherwise.';

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS payment_method character varying(40) NOT NULL DEFAULT 'cash';
ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_payment_method_format;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_payment_method_format CHECK (payment_method ~ '^[a-z0-9_]{1,40}$');
COMMENT ON COLUMN public.expenses.payment_method IS
  '111: how the expense was paid (a payment method code). Only cash comes out of the drawer; others come off that method''s expected total.';

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS confirm_reasons jsonb;
COMMENT ON COLUMN public.shifts.confirm_reasons IS
  '111: the confirming manager''s reason per payment method where their count differs from the cashier''s declaration.';

-- The atomic order write, with the delivery fee (body otherwise exactly migration 69).
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
  -- What the customer actually hands over. The bill is what the business
  -- recognises; the tip and the delivery fee pass through it.
  v_due   := v_total + v_tip + v_fee;

  SELECT COALESCE(SUM((leg->>'amount')::numeric), 0)
    INTO v_paid
    FROM jsonb_array_elements(p_payments) AS leg;

  IF abs(v_paid - v_due) > 0.01 THEN
    RAISE EXCEPTION 'payment legs sum to % but the amount due is % (total % + tip % + delivery fee %)',
      v_paid, v_due, v_total, v_tip, v_fee
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.orders (
    business_id, branch_id, customer_id, customer_name, customer_phone,
    order_number, order_type, delivery_person, status,
    subtotal, vat_amount, ctl_amount, discount_amount, discount_id,
    loyalty_points_used, total, tip_amount, delivery_fee, shift_id, seated_at,
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
  'validating that payment legs reconcile to total + tip_amount + delivery_fee. A tip and a delivery fee are money '
  'on top of the bill, so they belong in the legs but not in orders.total.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('111_prospect_requests', '0.6.27: orders.delivery_fee (pass-through, in create_order_atomic), float_transactions.order_id, expenses.payment_method, shifts.confirm_reasons')
ON CONFLICT (version) DO NOTHING;
