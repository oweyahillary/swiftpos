-- =============================================================================
-- DRAFT — A184 Tier 3 (retire / archive a dead terminal). FOR REVIEW, NOT APPLIED.
--
-- This file lives in docs/ ON PURPOSE. It is not in migrations/ yet, so the
-- migration runner and the schema-drift gates do not see it and nothing breaks.
-- When approved: move it to `migrations/97_user_devices_retire.sql` (97 is the
-- next free number — highest applied is 96), add a `scripts/test-migration-97.mjs`
-- (mutation-checked against PGlite, like every migration since 41), and apply it
-- on prod inside a transaction. It is strictly ADDITIVE and backward-compatible —
-- no existing row or query changes behaviour until the code below is wired.
--
-- WHY. The Terminals screen counts decommissioned tills in its "N not syncing"
-- banner and lists reinstalled ghosts as if live (register A184). There is no
-- way to retire a dead row. `DELETE /api/devices/:id` exists but REVOKES access
-- (a security action, and it removes the row) — the wrong semantic for "this
-- machine is gone, stop alarming about it but keep its history."
--
-- DESIGN. A nullable `retired_at` (+ who did it) rather than a new status value:
--   * Additive, reversible (un-retire = set NULL), and it keeps the audit trail.
--   * The fleet query filters `retired_at IS NULL`; a retired till drops out of
--     the health view AND the not-syncing count, but its orders/shifts/history
--     are untouched (nothing references user_devices.retired_at).
--   * Not a new `status` value: `status` is an access state (pending/approved/
--     rejected) and the approve/reject/revoke guards branch on it — overloading
--     it with 'retired' would risk those paths. A separate column is safer.
-- =============================================================================

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS retired_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS retired_by  uuid        NULL REFERENCES public.users(id);

COMMENT ON COLUMN public.user_devices.retired_at IS
  'A184: when an owner retired this terminal. NULL = live. Retired rows drop out of '
  'the fleet health view and the not-syncing banner but keep all their history.';

-- Fast path for the fleet query''s `WHERE retired_at IS NULL` on a business.
CREATE INDEX IF NOT EXISTS user_devices_business_live_idx
  ON public.user_devices (business_id)
  WHERE retired_at IS NULL;

-- =============================================================================
-- CODE THAT WIRES THIS (build after the migration is applied — NOT in this batch):
--
--   1. GET /api/devices/fleet          → add `.is('retired_at', null)` to the select.
--   2. PATCH /api/devices/:id/retire    → set retired_at = now(), retired_by = req.userId
--                                         (requireAnyPermission('devices.approve',
--                                         'settings.manage'); owner-scoped like /label).
--   3. PATCH /api/devices/:id/unretire  → set retired_at = NULL (reversible).
--   4. FleetPage                        → a "Retire" action per row + an "Archived"
--                                         section (or filter toggle) to see retired tills.
--   5. The not-syncing banner count already reads the fleet list, so excluding
--      retired rows at (1) fixes the ghost count with no extra work.
--
-- Rollback (if ever needed): the columns are additive and unreferenced —
--   ALTER TABLE public.user_devices DROP COLUMN IF EXISTS retired_at, DROP COLUMN IF EXISTS retired_by;
--   DROP INDEX IF EXISTS user_devices_business_live_idx;
-- =============================================================================
