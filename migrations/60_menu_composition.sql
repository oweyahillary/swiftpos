-- ─────────────────────────────────────────────────────────────────────────────
-- Menu composition schema
--
-- This migration contains NO concept named combo, meal, burger, spice, or
-- Kudo. It knows only: products, slots on a product, options that fill a slot,
-- attribute groups, and which category routes to which station. Every menu this
-- POS will ever hold is some arrangement of those five ideas.
--
-- The test of that claim is not that it holds Kudo Kudo's menu. It is that the
-- SAME tables hold a coffee shop, a bar, and a butchery with no schema change —
-- see the two importer fixtures. If a future client needs a sixth idea, it goes
-- here as a new table, not as a special case bolted onto an existing one.
-- ─────────────────────────────────────────────────────────────────────────────

-- A product is anything with a name and, if sold on its own, a price. A latte,
-- a chicken piece, a whole family meal, a bag of fries — all products. What
-- makes one a "combo" is that it has slots; what makes one a hidden component
-- is menu_visible = false. Neither is a type, both are just column values.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS menu_visible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS portions integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.products.menu_visible IS
  'False for parts that exist only inside other products and are never sold alone. Kept off the sell grid.';
COMMENT ON COLUMN public.products.portions IS
  'Individually-choosable units in one product. A 3-piece is 3. Used to allocate attributes across pieces.';

-- A slot is a named decision on a product: "Drink", "Sauces", "Choose your
-- burger". min/max make it fixed (1/1 with one option), a single choice
-- (1/1 with many), or a multi-pick (4/4). There is no is_combo flag anywhere;
-- a product with zero slots is a plain item and that is the only distinction.
CREATE TABLE IF NOT EXISTS public.component_slots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  name         text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  min_select   integer NOT NULL DEFAULT 1,
  max_select   integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_min_le_max CHECK (min_select <= max_select),
  CONSTRAINT slot_min_nonneg CHECK (min_select >= 0)
);

-- An option is one product that can fill a slot, with a price delta THAT
-- BELONGS TO THIS RELATIONSHIP. The same product is 0 in one slot, +130 in
-- another, and sold alone at its own price — three different rows, one product.
-- This is the row that made "large fries is 60 as an upgrade but 200 alone"
-- expressible without lying about the product's price.
CREATE TABLE IF NOT EXISTS public.slot_options (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id           uuid NOT NULL REFERENCES public.component_slots(id) ON DELETE CASCADE,
  option_product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity          integer NOT NULL DEFAULT 1,
  price_delta_cents integer NOT NULL DEFAULT 0,
  is_default        boolean NOT NULL DEFAULT false,
  sort_order        integer NOT NULL DEFAULT 0,
  CONSTRAINT option_qty_positive CHECK (quantity > 0)
);

-- Attribute groups are reusable choices — Spice, Ice level, Temperature, Cut.
-- Attached to a product once (product_attributes), they apply everywhere that
-- product appears: standalone and inside every slot of every other product.
-- Defining Spice once and reusing it is what stops the duplicate-Spice-groups
-- problem the old model had.
CREATE TABLE IF NOT EXISTS public.attribute_groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name         text NOT NULL,
  min_select   integer NOT NULL DEFAULT 1,
  max_select   integer NOT NULL DEFAULT 1,
  CONSTRAINT attr_min_le_max CHECK (min_select <= max_select)
);

CREATE TABLE IF NOT EXISTS public.attribute_options (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          uuid NOT NULL REFERENCES public.attribute_groups(id) ON DELETE CASCADE,
  name              text NOT NULL,
  price_delta_cents integer NOT NULL DEFAULT 0,
  sort_order        integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.product_attributes (
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  group_id   uuid NOT NULL REFERENCES public.attribute_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, group_id)
);

-- Routing is per category to station, exactly as the old model had it, because
-- routing per item does not scale past a hundred products. What changed is that
-- a combo's COMPONENTS carry their own categories, so a combo splits across
-- stations without any per-combo routing — the chicken's category routes to the
-- kitchen, the drink's category routes to dispatch, and the split falls out of
-- data that already exists.
CREATE TABLE IF NOT EXISTS public.category_stations (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  station_id  uuid NOT NULL REFERENCES public.stations(id) ON DELETE CASCADE,
  PRIMARY KEY (category_id, station_id)
);

-- The order line's resolved units, FROZEN at sale time. A reprint of a
-- six-month-old order must reproduce what was sold, not what today's menu says.
-- Everything the ticket needs is copied here so no historical print ever reads
-- a live catalogue row.
CREATE TABLE IF NOT EXISTS public.order_item_units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id   uuid NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  product_id      uuid REFERENCES public.products(id) ON DELETE SET NULL,
  name_snapshot   text NOT NULL,
  quantity        integer NOT NULL DEFAULT 1,
  portions        integer NOT NULL DEFAULT 1,
  price_delta_cents integer NOT NULL DEFAULT 0,
  chosen          boolean NOT NULL DEFAULT false,
  -- Resolved station ids at sale time, as a jsonb array of uuids. Snapshot, so
  -- re-routing a category later never changes an old ticket.
  station_ids     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Attributes as [{group,option,count,delta}], also snapshot.
  attributes      jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order      integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_component_slots_product ON public.component_slots(product_id);
CREATE INDEX IF NOT EXISTS idx_slot_options_slot ON public.slot_options(slot_id);
CREATE INDEX IF NOT EXISTS idx_order_item_units_item ON public.order_item_units(order_item_id);
CREATE INDEX IF NOT EXISTS idx_category_stations_cat ON public.category_stations(category_id);

-- One slot may have at most one default per option, and a product's slots are
-- ordered for the till UI. Nothing here references a specific menu.
CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_option_product
  ON public.slot_options(slot_id, option_product_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security for the composition tables
--
-- Follows the convention in migration 29: a single owner_all policy (FOR ALL)
-- scoped to business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()).
-- Tables with a business_id column are scoped directly; the rest are scoped
-- through their parent, exactly as combo_items is in migration 29. Staff/PIN
-- logins never create a Supabase session, so they get nothing here and continue
-- to reach these tables through the Express API (service_role) as intended.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Direct business_id.
ALTER TABLE public.component_slots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.component_slots;
CREATE POLICY owner_all ON public.component_slots FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

ALTER TABLE public.attribute_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.attribute_groups;
CREATE POLICY owner_all ON public.attribute_groups FOR ALL USING (
  business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

-- 2. Scoped through a parent.
ALTER TABLE public.slot_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.slot_options;
CREATE POLICY owner_all ON public.slot_options FOR ALL USING (
  slot_id IN (SELECT id FROM public.component_slots WHERE business_id IN (
    SELECT id FROM public.businesses WHERE owner_id = auth.uid())));

ALTER TABLE public.attribute_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.attribute_options;
CREATE POLICY owner_all ON public.attribute_options FOR ALL USING (
  group_id IN (SELECT id FROM public.attribute_groups WHERE business_id IN (
    SELECT id FROM public.businesses WHERE owner_id = auth.uid())));

ALTER TABLE public.product_attributes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.product_attributes;
CREATE POLICY owner_all ON public.product_attributes FOR ALL USING (
  product_id IN (SELECT id FROM public.products WHERE business_id IN (
    SELECT id FROM public.businesses WHERE owner_id = auth.uid())));

ALTER TABLE public.order_item_units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.order_item_units;
CREATE POLICY owner_all ON public.order_item_units FOR ALL USING (
  order_item_id IN (SELECT id FROM public.order_items WHERE order_id IN (
    SELECT id FROM public.orders WHERE business_id IN (
      SELECT id FROM public.businesses WHERE owner_id = auth.uid()))));
