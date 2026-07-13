-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 21 — M-Pesa payment tracking columns
--
-- Moves M-Pesa pending-payment state out of the server's in-memory Map and onto
-- the payments row itself, so state survives restarts / cold starts and works
-- across multiple server instances (audit finding M3).
--
-- The mpesa_checkout_id column and the payments.status column already exist
-- (see all_phases_migration.sql / swiftpos_consolidated_migration.sql). This
-- migration only adds the three fields the old Map used to hold:
--
--   • mpesa_phone        — the payer's phone (Safaricom-formatted 2547…), for
--                          display / receipts.
--   • mpesa_result_desc  — the failure/cancellation reason, surfaced by
--                          GET /api/mpesa/status/:checkoutId as `error`.
--   • mpesa_requested_at — when the STK push was initiated. GET /status uses this
--                          to time out a payment left 'pending' past the STK
--                          window, so no background timer is needed.
--
-- Backwards-compatible: additive columns only, all nullable. Existing rows and
-- the current cash/card flow are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS mpesa_phone        TEXT,
  ADD COLUMN IF NOT EXISTS mpesa_result_desc  TEXT,
  ADD COLUMN IF NOT EXISTS mpesa_requested_at  TIMESTAMPTZ;

-- Speeds up the /status lookup (mpesa_checkout_id + business_id) and the
-- callback match. The mpesa_checkout_id index already exists; this composite
-- helps the business-scoped read path.
CREATE INDEX IF NOT EXISTS payments_mpesa_checkout_business_idx
  ON payments (mpesa_checkout_id, business_id)
  WHERE mpesa_checkout_id IS NOT NULL;
