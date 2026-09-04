-- =============================================================================
-- 90_restore_order_types.sql
--
-- Restore the `orders.order_type` values that migration 58 silently dropped
-- (register A129). Fixes delivery/aggregator/other orders being rejected at sync
-- with: new row for relation "orders" violates check constraint
-- "orders_order_type_check".
--
-- ROOT CAUSE. The baseline `orders_order_type_check` allowed eight types:
-- retail, dine_in, takeaway, delivery, aggregator, parking_session, fuel_sale,
-- other. `58_universal_business_types.sql` DROPped and re-ADDed the constraint
-- from an incomplete list — dine_in, takeaway, retail, parking_session,
-- fuel_sale — dropping **delivery, aggregator, and other**. But the client still
-- produces those types: `POSPage.tsx` types the selector as
-- 'dine_in' | 'takeaway' | 'retail' | 'delivery', migration 35 added the whole
-- delivery-person feature, and aggregator orders come from Bolt/UberEats. So any
-- delivery/aggregator/other sale rings fine on the till and then fails forever at
-- the cloud INSERT (23514). Same class as the payments.method drift (A128): a
-- value the client emits that the server's CHECK no longer permits, with nothing
-- comparing the two. Observed on Till 1 / Beryl, order T1--14 (mpesa delivery).
--
-- THE FIX. Restore the full baseline set. This is a strict SUPERSET of migration
-- 58's list, so every row that satisfied 58's constraint still satisfies this one
-- and ADD CONSTRAINT cannot fail on existing data. delivery/aggregator/other rows
-- could not have been inserted under 58's constraint, so none exist to re-check.
--
-- No client change is needed: the till was always emitting these; the cloud just
-- stopped accepting them.
--
-- After PROD-MIGRATE: T1--14 (and any other parked delivery/aggregator/other
-- orders) re-push via the existing "retry failed" path, idempotent on order id.
--
-- Idempotent: DROP IF EXISTS then ADD, so re-running lands on the same
-- definition. Reversible (see REVERT), though reverting re-breaks delivery sync.
-- public.-qualified for search_path safety (A62).
--
-- REVERT:
--   ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
--   ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check
--     CHECK (order_type = ANY (ARRAY['dine_in','takeaway','retail','parking_session','fuel_sale']::character varying[]));
-- =============================================================================

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_order_type_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_order_type_check
  CHECK (order_type = ANY (ARRAY[
    'retail'::character varying,
    'dine_in'::character varying,
    'takeaway'::character varying,
    'delivery'::character varying,
    'aggregator'::character varying,
    'parking_session'::character varying,
    'fuel_sale'::character varying,
    'other'::character varying
  ]));
