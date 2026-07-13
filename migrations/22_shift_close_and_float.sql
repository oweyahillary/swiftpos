-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 22 — shift close reconciliation columns + float_transactions table
--
-- Fixes two code/schema mismatches surfaced in POS testing:
--
--  1. POST /api/shifts/:id/close writes shifts.expected_cash and
--     shifts.cash_variance, but no migration ever created those columns, so the
--     UPDATE failed and every shift close returned 500. (closing_float / closed_at
--     / notes are added here too with IF NOT EXISTS — no-ops if they already
--     exist — so close succeeds regardless of base-schema drift.)
--
--  2. The shift float in/out endpoints and the close handler read/write a
--     `float_transactions` table that no migration created. This creates it to
--     match the columns the code uses (shift_id, branch_id, cashier_id, type,
--     amount, reason). cashier_id is intentionally NOT a strict FK to users(id):
--     an owner authenticated via Supabase may not have a users row, and a strict
--     FK would 500 their float operations (same class of bug as inventory adjust).
--
-- Idempotent and additive — safe to run on any environment.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS closing_float  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS closed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expected_cash  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS cash_variance  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS notes          TEXT;

CREATE TABLE IF NOT EXISTS float_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id    UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  branch_id   UUID,
  cashier_id  UUID,                       -- staff users.id OR owner id; no strict FK on purpose
  type        TEXT NOT NULL CHECK (type IN ('float_in', 'float_out')),
  amount      NUMERIC(12,2) NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS float_transactions_shift_idx ON float_transactions (shift_id);
