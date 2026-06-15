-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 15: Direct pump → tank linkage
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Problem: pumps and tanks were only linked via fuel_product_id (the grade).
-- This breaks when a station has two tanks of the same grade (e.g. two Petrol
-- tanks — a primary and a secondary/overflow). Both tanks share the same
-- fuel_product_id so the deduction code would hit BOTH tanks, halving the
-- litres deducted from each instead of draining one specific tank.
--
-- Fix: add tank_id FK on pumps. The deduction code prefers tank_id when
-- present and falls back to fuel_product_id for existing/unconfigured pumps.
--
-- Safe on live data: ADD COLUMN IF NOT EXISTS with NULL default.
-- No data migration needed — existing pumps work via fallback until configured.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.pumps
  ADD COLUMN IF NOT EXISTS tank_id uuid REFERENCES public.fuel_tanks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pumps_tank_id_idx ON public.pumps (tank_id);

COMMENT ON COLUMN public.pumps.tank_id IS
  'Direct FK to the fuel tank this pump draws from. When set, deductions apply
   to this specific tank. When NULL, falls back to matching tanks by
   fuel_product_id (original behaviour — works when only one tank per grade).';
