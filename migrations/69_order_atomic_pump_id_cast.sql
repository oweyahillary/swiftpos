-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 69 — HOTFIX: cast pump_id to uuid  (supersedes 66)
--
-- CREATE OR REPLACE of create_order_atomic (supersedes 62/64/65, cumulative).
-- The ONLY behavioural change is the reconciliation target.
--
-- ── WHY 69 EXISTS ───────────────────────────────────────────────────────────
-- Migration 66 (and 65 before it) inserted pump_id as RAW TEXT:
--
--     p_order->>'pump_id',        -- text
--
-- but orders.pump_id is UUID. PostgreSQL has no assignment cast from text to
-- uuid, so EVERY call fails at runtime with
--
--     column "pump_id" is of type uuid but expression is of type text
--
-- EVERY order, not only tipped ones, and regardless of whether pump_id is even
-- supplied — the type mismatch is in the statement, not in the value.
--
-- It slipped through because a plpgsql function body is NOT type-checked when
-- the function is created. CREATE OR REPLACE reports success and the failure
-- only appears on the first call. Nothing between running the migration and
-- taking a sale would have flagged it.
--
-- 69 is 66 with NULLIF(...)::uuid, matching how customer_id, discount_id,
-- shift_id and cashier_id were already handled in the same statement. The tip
-- reconciliation from 66 is unchanged.
--
-- RUN THIS IMMEDIATELY.
--
-- ── THE ORIGINAL BUG 66 FIXED (unchanged) ───────────────────────────────────
-- Migration 65 asserts  SUM(leg.amount) == p_order.total.
--
-- But `total` is the BILL (subtotal - discount); a tip is money on top of it,
-- carried in its own tip_amount column so it never inflates recognised revenue
-- or the VAT base. The payment legs, however, are the money that ACTUALLY
-- CHANGED HANDS — which is bill + tip.
--
-- So every tipped sale failed the guard and came back to the till as a 400,
-- mid-service, at the counter:
--
--     payment legs sum to 990 but order total is 900
--
-- On the web POS the sale is refused outright. On the desktop it is worse: the
-- order is written locally, the receipt prints, the cash goes in the drawer, and
-- only the later sync push is rejected — five times, then parked as 'failed'. A
-- paid, printed sale that never reaches the cloud.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- Reconcile against total + tip_amount. With tip_amount 0 or absent this is
-- byte-for-byte the old behaviour, so untipped sales are unaffected and the
-- anti-tampering property is unchanged: the legs must still equal a figure the
-- SERVER computed, never one the client asserted.
--
--     bill 900, tip 90  ->  legs must sum to 990   (was: 900)
--     bill 900, no tip  ->  legs must sum to 900   (unchanged)
--
-- Safe to run on a live database; it only replaces the function body.
-- ─────────────────────────────────────────────────────────────────────────────

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
  v_due      numeric;
  v_paid     numeric;
  v_item     jsonb;
  v_item_id  uuid;
  v_sub      jsonb;
BEGIN
  v_total := (p_order->>'total')::numeric;
  v_tip   := COALESCE((p_order->>'tip_amount')::numeric, 0);
  -- What the customer actually hands over. The bill is what the business
  -- recognises; the tip passes through it.
  v_due   := v_total + v_tip;

  SELECT COALESCE(SUM((leg->>'amount')::numeric), 0)
    INTO v_paid
    FROM jsonb_array_elements(p_payments) AS leg;

  IF abs(v_paid - v_due) > 0.01 THEN
    RAISE EXCEPTION 'payment legs sum to % but the amount due is % (total % + tip %)',
      v_paid, v_due, v_total, v_tip
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.orders (
    business_id, branch_id, customer_id, customer_name, customer_phone,
    order_number, order_type, delivery_person, status,
    subtotal, vat_amount, ctl_amount, discount_amount, discount_id,
    loyalty_points_used, total, tip_amount, shift_id, seated_at,
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
  'validating that payment legs reconcile to total + tip_amount. A tip is money '
  'on top of the bill, so it belongs in the legs but not in orders.total.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('69_order_atomic_pump_id_cast',
        'HOTFIX over 66: pump_id needs NULLIF(...)::uuid. Without it every order '
        'failed at runtime — a plpgsql body is not type-checked at CREATE time.')
ON CONFLICT (version) DO NOTHING;
