-- SwiftPOS: Hotel features
-- Adds room charge support and room number tracking

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS room_number  text,
  ADD COLUMN IF NOT EXISTS guest_name   text;

-- Allow room_charge as a payment method (payments.method is free text, no constraint to change)
-- Add index for room number lookups (hotel front desk reconciliation)
CREATE INDEX IF NOT EXISTS idx_orders_room_number
  ON public.orders (business_id, room_number)
  WHERE room_number IS NOT NULL;

COMMENT ON COLUMN public.orders.room_number IS
  'Hotel room number — populated when payment_method is room_charge';
