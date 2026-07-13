-- Migration: order idempotency key
-- Prevents duplicate orders when the desktop sync engine retries a push.
--
-- The desktop client sends X-Idempotency-Key on every POST /api/orders.
-- The server checks this column before inserting — if found, returns the
-- original order without re-processing.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Unique per business — same key can't create two orders for the same business
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_business_idx
  ON orders (business_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
