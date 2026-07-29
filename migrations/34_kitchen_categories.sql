-- SwiftPOS: kitchen routing flag on categories
--
-- The kitchen ticket must list only what is actually cooked. The menu's own
-- groupings can't be used for this — its "SIDES" block mixes rice and poutine
-- fries (cooked) with cole slaw and burger bread (not). Cole slaw is prepped
-- ahead; burger bread is bought in from a vendor.
--
-- Flagged per category rather than per product so the client can retire or add
-- items without anyone touching a routing rule, and so a mis-set flag is visible
-- in one place rather than scattered across a hundred SKUs.
--
-- Defaults to false: a category is non-kitchen until someone says otherwise. A
-- missing item on the kitchen ticket gets noticed in seconds; a drink printing
-- into a fryer station just adds noise nobody reads.

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS is_kitchen boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.categories.is_kitchen IS
  'Items in this category appear on the kitchen prep ticket. Dispatcher ticket lists everything regardless.';

-- Combo categories stay false on purpose. A combo product never prints on the
-- kitchen ticket itself — it is expanded into its components first, and each
-- component routes on its OWN category. A Kanka Combo therefore sends its
-- chicken burger to the kitchen and its Coca-Cola nowhere.
