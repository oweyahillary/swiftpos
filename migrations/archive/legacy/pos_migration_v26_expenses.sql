-- ─────────────────────────────────────────────────────────────────────────────
-- SwiftPOS  Step 26 — Expenses: add optional shift linkage
--
-- The expense_categories and expenses tables were already created in the
-- main pos_migration_v2.sql. This migration only adds the shift_id FK column
-- so that expenses can optionally be tagged to a cashier shift for accurate
-- per-shift profit reporting.
--
-- Run this once against your Supabase project SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- Add optional shift_id to expenses
-- (shifts table was created as part of the shifts feature in earlier steps)
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_shift ON expenses(shift_id);

-- Ensure RLS policies exist (idempotent — safe to re-run)
DO $$
BEGIN
  -- expense_categories: owner full access
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'expense_categories' AND policyname = 'owner_all'
  ) THEN
    CREATE POLICY owner_all ON expense_categories
      FOR ALL USING (
        business_id IN (
          SELECT id FROM businesses WHERE owner_id = auth.uid()
        )
      );
  END IF;

  -- expenses: owner full access
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'expenses' AND policyname = 'owner_all'
  ) THEN
    CREATE POLICY owner_all ON expenses
      FOR ALL USING (
        business_id IN (
          SELECT id FROM businesses WHERE owner_id = auth.uid()
        )
      );
  END IF;
END $$;
