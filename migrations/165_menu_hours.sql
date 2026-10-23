-- 165_menu_hours.sql — A578: menus by time of day (Breakfast Mon–Fri 06:00–11:00, Lunch 11:00–16:00, an alcohol
-- department only in licensed hours …).
--
-- Owner, 2026-10-23 (approved): each menu (a restaurant's Menus, a shop's Departments, anyone else's Groups — A573) may
-- carry optional availability: days of the week and one or more time windows. No schedule = always available (every
-- menu today, and the default).
--
-- public.menus.availability (jsonb, NULL = always):
--   { "days": [1,2,3,4,5] | null, "windows": [ { "start": "06:00", "end": "11:00" }, … ] }
-- 0 = Sunday … 6 = Saturday; a window whose end is before its start runs past midnight (22:00–02:00) and belongs to the
-- day it started; the business day's cut-off decides which day a moment after midnight belongs to. The cloud checks the
-- shape before storing it (shared/menuHours.ts checkAvailability, routes/menus.ts); the CHECK below is the floor: an
-- object or nothing. The POS reads it by its own clock (the till offline too) — the cloud never decides what is open.
--
-- Sync: nothing new. A change to a menu's hours is a change to its menus row, so 155's trg_log_menu_sync_change writes
-- ONE sync_changes entry (table menus, topic menu) and the catalogue version moves (155's trigger); /api/pos/init and
-- /api/pos/changes carry the column (lib/menus.ts, lib/syncChanges.ts). RLS: the menus table's own (155) — a column
-- adds no policy.
-- Idempotent: safe to run twice.

ALTER TABLE public.menus ADD COLUMN IF NOT EXISTS availability jsonb NULL;

DO $a578$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menus_availability_object' AND conrelid = 'public.menus'::regclass) THEN
    ALTER TABLE public.menus ADD CONSTRAINT menus_availability_object
      CHECK (availability IS NULL OR jsonb_typeof(availability) = 'object');
  END IF;
END $a578$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('165_menu_hours', 'A578: menus by time of day - menus.availability (days of the week and time windows; NULL = always). Synced as a menus row (155''s trigger).')
ON CONFLICT (version) DO NOTHING;
