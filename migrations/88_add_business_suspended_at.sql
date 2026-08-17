-- =============================================================================
-- 88_add_business_suspended_at.sql
--
-- Track WHEN a business was suspended, so the grace-period data purge (decision
-- D2: suspend is the end-state; long-suspended clients are purged after a grace
-- window) can be measured. Today suspend only flips status='suspended', with no
-- timestamp — `updated_at` is unreliable (any edit moves it).
--
-- The admin suspend endpoint sets this; activate clears it back to NULL.
-- NULL = not suspended. No data is purged by this migration — this is only the
-- groundwork the purge will read. Register A122. Idempotent; reversible by
-- dropping the column.
-- =============================================================================

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
