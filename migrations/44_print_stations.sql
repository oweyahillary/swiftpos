-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 44 — Print stations, and routing by category
--
-- Replaces `categories.is_kitchen` — a single boolean meaning "one kitchen" —
-- with named stations a category can be routed to.
--
-- WHY THIS IS NOT COSMETIC
--   The boolean is why 3PC Chicken never reached the kitchen: routing was one
--   tick box on the category, nobody had ticked it, and nothing anywhere said so.
--   A category that routes to no station is now visibly unassigned instead of
--   silently printing nowhere.
--
-- WHY ROUTING IS PER CATEGORY AND NEVER PER ITEM
--   The owner's decision, and it is the right one: per-item routing is a field
--   that must be set correctly on every product forever, and the failure is
--   silent every time it is missed. A category is set once and inherited.
--
--   products.is_kitchen is therefore NOT dropped but is no longer authoritative.
--   Dropping it would silently re-route every product carrying an override the
--   moment this migration ran, mid-service, with nothing on screen to explain the
--   change. It stays as a legacy override the manager screen surfaces so the
--   overrides can be cleared deliberately.
--
-- WHY MANY-TO-MANY
--   One order line legitimately prints in several places with DIFFERENT content:
--     kitchen     what is cooked — excluding drinks
--     dispatcher  everything, for packing the bag
--     receipt     the menu item only, not itemised
--   Chicken belongs to kitchen AND dispatcher; a drink belongs to dispatcher
--   only. That is a set per category, not a flag.
--
-- WHAT IS DELIBERATELY NOT HERE
--   The PRINTER. A station is a business-level idea ("Grill"); which physical
--   printer serves it is a property of the terminal, because three tills have
--   three different printers attached. The binding lives in each till's local
--   printer settings, keyed on station id.
--
-- Purely additive. Nothing here can reject an existing write.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.print_stations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  -- NULL means the station exists at every branch. Branches with different
  -- layouts can define their own without forcing every branch to match.
  branch_id   uuid,
  name        text NOT NULL,

  -- What the station is FOR, which decides how a ticket is rendered — not merely
  -- where it goes. 'kitchen' prints prepared components; 'dispatch' prints
  -- everything for packing; 'receipt' prints the customer's copy, item names
  -- only and not itemised.
  kind        text NOT NULL DEFAULT 'kitchen',

  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT print_stations_kind_check
    CHECK (kind = ANY (ARRAY['kitchen'::text, 'dispatch'::text, 'receipt'::text]))
);

COMMENT ON TABLE public.print_stations IS
  'Named print destinations (Grill, Dispatcher, Till). The physical printer is bound per terminal, not here.';
COMMENT ON COLUMN public.print_stations.kind IS
  'kitchen = prepared items only; dispatch = everything for packing; receipt = customer copy, not itemised.';

-- Two stations at a branch cannot share a name — the manager screen and every
-- ticket header identify a station by its name, so duplicates are unreadable.
CREATE UNIQUE INDEX IF NOT EXISTS print_stations_name_uniq
  ON public.print_stations (business_id, COALESCE(branch_id::text, ''), lower(name));

CREATE INDEX IF NOT EXISTS print_stations_business_idx ON public.print_stations (business_id);

-- ── Category → station routing ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.category_stations (
  category_id uuid NOT NULL,
  station_id  uuid NOT NULL REFERENCES public.print_stations(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category_id, station_id)
);

COMMENT ON TABLE public.category_stations IS
  'Which stations a category prints at. A category with no rows here prints nowhere — surfaced as unassigned in the manager screen.';

CREATE INDEX IF NOT EXISTS category_stations_station_idx ON public.category_stations (station_id);

-- ── Backfill from the old boolean ────────────────────────────────────────────
--
-- Creates a single "Kitchen" station per business and routes every category that
-- had is_kitchen = true to it, so behaviour on the day of the migration is
-- unchanged. Stations are then split up by hand, which is a deliberate choice a
-- manager makes rather than something inferred from a boolean that never carried
-- the information.
--
-- Guarded on there being no stations yet, so re-running cannot duplicate them.

DO $$
DECLARE
  biz  record;
  sid  uuid;
  n    integer;
BEGIN
  FOR biz IN SELECT DISTINCT business_id FROM public.categories WHERE business_id IS NOT NULL LOOP
    IF EXISTS (SELECT 1 FROM public.print_stations WHERE business_id = biz.business_id) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.print_stations (business_id, name, kind, sort_order)
    VALUES (biz.business_id, 'Kitchen', 'kitchen', 0)
    RETURNING id INTO sid;

    INSERT INTO public.category_stations (category_id, station_id)
    SELECT c.id, sid
      FROM public.categories c
     WHERE c.business_id = biz.business_id
       AND c.is_kitchen IS TRUE
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'migration 44: business % — created Kitchen station, routed % categories', biz.business_id, n;
  END LOOP;
END $$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('44_print_stations',
        'print_stations + category_stations; replaces categories.is_kitchen as the routing authority. products.is_kitchen kept as a legacy override.')
ON CONFLICT (version) DO NOTHING;
