-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 17 — Per-till device attribution on orders
--
-- The desktop multi-till edition stamps each order with the `device_id` of the
-- physical terminal that created it (generated once per install, stored in the
-- local device_config). It travels with the order through till → aggregation
-- node → cloud, so cloud reports and the tech audit trail can attribute a sale
-- to a specific machine. NULL for web-POS orders, which have no device concept.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS device_id text;

COMMENT ON COLUMN public.orders.device_id IS
  'Desktop terminal (till) that created this order. NULL for web-POS orders.';
