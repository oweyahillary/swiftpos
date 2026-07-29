-- SwiftPOS: per-product kitchen routing override
--
-- Routing has been decided by the CATEGORY alone (migration 34), which was the
-- right default and remains it: a category is one place to look, and a mis-set
-- flag is visible immediately rather than scattered across a hundred SKUs.
--
-- What it cannot express is a category whose members genuinely differ. The
-- client's own menu has one: "SIDES" holds rice and poutine fries (cooked) next
-- to cole slaw and burger bread (not). The workaround is to split the category
-- in two, which works but distorts the menu structure to suit a routing rule —
-- and it has to be done again every time someone adds an item that doesn't fit.
--
-- TRI-STATE, DELIBERATELY:
--
--   NULL   inherit the category. The default, and what almost every product
--          should stay on.
--   TRUE   always print on the kitchen ticket, whatever the category says.
--   FALSE  never print, whatever the category says.
--
-- Nullable rather than a boolean defaulting to false, because those two states
-- are not the same thing. "Nobody has said" must keep following the category —
-- if it collapsed to "no", flipping a category to kitchen would stop working for
-- every product already in it, silently, and the first anyone would know is an
-- empty kitchen ticket during service.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_kitchen boolean;

COMMENT ON COLUMN public.products.is_kitchen IS
  'Kitchen routing override. NULL = follow the category (normal). TRUE/FALSE = force, ignoring it.';
