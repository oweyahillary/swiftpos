-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 16 — Per-user manager-override PIN
--
-- Replaces the single business-wide supervisor PIN with per-supervisor override
-- PINs, so privileged actions (voiding a paid order, and future overrides like
-- large discounts or price changes) are authorized by an identifiable person
-- and recorded for audit.
--
--   users.override_pin_hash  — bcrypt hash of a staff member's override PIN.
--                              NULL means the user cannot authorize overrides.
--                              Granting authority = setting this PIN in Staff
--                              Management; revoking = clearing it.
--
--   orders.authorized_by     — the supervisor whose override PIN approved the
--                              action. `voided_by` remains the cashier who rang
--                              the void, giving a two-name audit trail.
--
-- The legacy business-wide supervisor_pin / supervisor_pin_hash settings are
-- left in place; the server falls back to them only when NO user in the
-- business has an override PIN configured (transition period).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS override_pin_hash text;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS authorized_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.users.override_pin_hash IS
  'bcrypt hash of the per-user manager-override PIN. NULL = user cannot authorize overrides.';

COMMENT ON COLUMN public.orders.authorized_by IS
  'Supervisor whose override PIN authorized a privileged action (e.g. voiding a paid order). voided_by remains the cashier who initiated it.';
