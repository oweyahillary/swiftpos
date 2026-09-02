-- =============================================================================
-- 90_order_type_delivery_check.sql
--
-- Re-admit 'delivery' to the cloud `orders.order_type` domain so delivery sales
-- can sync (register A129, same shape as A128).
--
-- ROOT CAUSE. Baseline `00_baseline.sql` defined `orders_order_type_check` over
-- eight values including 'delivery' (and 'aggregator', 'other'). Migration 58
-- ("universal business types") DROPped and re-ADDed the constraint with a
-- narrowed five-value list — dine_in | takeaway | retail | parking_session |
-- fuel_sale — dropping 'delivery'. But delivery is a LIVE, shipping feature:
--   * apps/desktop … POSPage.tsx `chooseOrderType` offers 'delivery' and the
--     order-type state union includes it;
--   * the server request validator ACCEPTS it — apps/server/src/lib/schemas.ts
--     `order_type: z.enum(['retail','dine_in','takeaway','delivery'])`;
--   * the create path sets a delivery_person specifically for it
--     (apps/server/src/routes/orders.ts, `order_type === 'delivery'`), and the
--     till prints delivery KOTs / a "Delivery Boy" receipt line.
-- Local `orders.order_type` is free TEXT, so the till stores a delivery order
-- fine. Migration 35's header even asserts "'delivery' is already an accepted
-- order_type" — true when written, silently falsified by 58.
--
-- So `create_order_atomic` (migration 69) does
--   INSERT INTO public.orders (... order_type ...) VALUES (p_order->>'order_type' …)
-- and for a delivery order that INSERT fails 23514 (check_violation). The RPC
-- aborts, POST /api/orders returns an error, and the till's sync engine parks the
-- order in sync_queue (5 retries -> failed). The sale is safe on the till and
-- shows complete to the cashier; it just never reaches the cloud or dashboard —
-- silent, because the till's LOCAL order_type has no check. The two schemas
-- disagreed and nothing compared them. (This is exactly the A128 story on a
-- different column; scripts/check-push-domain-parity.mjs now guards the class.)
--
-- THE FIX. Restore 'delivery' to the value list. The domain stays a fixed list
-- (unlike A128's free-text method) because order_type IS a closed set — it is not
-- per-business or user-generated. This is not loosening a gate to admit junk
-- (rule 20): it re-admits one value the application provably produces and the
-- baseline always intended, and nothing else.
--
--   Final admitted set: dine_in | takeaway | retail | delivery | parking_session
--                       | fuel_sale
--
-- NOT re-admitted here, deliberately: 'aggregator' and 'other'. Neither is
-- WRITTEN by any code path (grep: 'aggregator' as order_type appears only in
-- reads — reports.ts `.eq('order_type','aggregator')` — and 'other' only as a JS
-- channel-map fallback). Re-adding them would admit values nothing emits. The
-- dead Aggregators report that queries a value no order can hold is filed
-- separately (A130); it is a reporting-wiring question, not a sync-loss one, and
-- is not fixed by widening this constraint.
--
-- Existing rows: no order can currently hold 'delivery' (the check forbade it),
-- so every existing row is a subset of the new list and ADD CONSTRAINT cannot
-- fail on live data. Parked delivery orders drain on their own: each till's
-- retryFailedOrders() re-pushes the queued payload with
-- X-Idempotency-Key: order_id, so the resend inserts once and dedups.
--
-- Verified against real Postgres (PGlite) before ship (scripts/test-migration-90.mjs):
-- pre-migration a delivery order -> 23514; post-migration delivery accepted while
-- '', 'aggregator', and 'nonsense' still rejected; idempotent.
--
-- Idempotent: guarded by pg_constraint so re-running is a no-op. Reversible (see
-- REVERT), though reverting re-breaks delivery sync.
--
-- REVERT:
--   ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
--   ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check
--     CHECK (order_type = ANY (ARRAY[
--       'dine_in'::varchar, 'takeaway'::varchar, 'retail'::varchar,
--       'parking_session'::varchar, 'fuel_sale'::varchar]));
--
-- public.-qualified for search_path safety (A62).
-- =============================================================================

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_order_type_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_order_type_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_order_type_check
      CHECK (order_type = ANY (ARRAY[
        'dine_in'::character varying,
        'takeaway'::character varying,
        'retail'::character varying,
        'delivery'::character varying,
        'parking_session'::character varying,
        'fuel_sale'::character varying
      ]));
  END IF;
END $$;

COMMENT ON CONSTRAINT orders_order_type_check ON public.orders IS
  'Admitted order types: dine_in | takeaway | retail | delivery | parking_session | fuel_sale. '
  'delivery restored in A129 (migration 58 dropped it while the feature stayed live). '
  'aggregator/other intentionally excluded — no code writes them (see A130).';
