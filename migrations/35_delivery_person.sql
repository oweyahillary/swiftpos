-- SwiftPOS: delivery rider on an order
--
-- 'delivery' is already an accepted order_type (orders_order_type_check), but
-- there was nowhere to record WHO took it out. The incumbent system prints a
-- "Delivery Boy" line on the receipt, and without it a disputed delivery has no
-- name attached to it.
--
-- Free text rather than a foreign key to users. Riders at a place like this are
-- frequently casual, shared with a neighbouring outlet, or an aggregator's
-- courier who will never have a login. Forcing them into the staff table would
-- mean creating a user record — with a PIN and a role — for someone who must
-- never be able to sign in to a till.
--
-- Distinct from aggregator_name, which records the PLATFORM (Bolt, Glovo) rather
-- than the person. An order can have both.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_person text;

COMMENT ON COLUMN public.orders.delivery_person IS
  'Name of the rider who took this delivery. Free text — riders are often casual or third-party couriers with no user account.';
