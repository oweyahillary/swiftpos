-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 45 — Choices vs upgrades; reusable groups; component scoping
--
-- One mechanism, `variant_groups`, is currently doing three unrelated jobs, with
-- nothing in the data to tell them apart. From the live menu:
--
--   3PC Chicken / Spice      Normal 0, Spicy 0, required       -> a free CHOICE
--   African Breakfast / Ugali normal 0, Medium +30, Large +50  -> a size LADDER
--                                                                 on a COMPONENT
--   3PC Chicken / Size       Large +60, Soda +50, optional     -> neither: a soda
--                                                                 is not a size
--
-- Because they are indistinguishable, a receipt cannot tell "the customer prefers
-- spicy" from "the customer paid 60 more", and the manager screen cannot show a
-- price column only where a price is possible.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--
--   kind          'choice'  — free, exactly one, no price column at all
--                 'upgrade' — priced ladder, first option is the included
--                             baseline at 0
--                 'review'  — could not be classified safely; see below
--
--   shared        A group defined once and attached to many items. "Spice"
--                 currently exists TWICE (3PC Chicken and 3PC Chicken Combo) as
--                 separate rows that must each be edited by hand, which is also
--                 how 'normal' and 'Normal' came to differ.
--
--   component     A group can size an INCLUDED COMPONENT rather than the item.
--                 African Breakfast / Ugali sizes the ugali, not the breakfast,
--                 and there is currently no way to say so.
--
-- ── WHY IT CLASSIFIES BUT NEVER DELETES ─────────────────────────────────────
-- Three of the five live groups cannot be classified by any rule:
--   • 3PC Chicken / Size contains a soda, so it is not a size ladder
--   • Cake / Size has no zero-priced baseline, so there is no "regular"
--   • Both are optional, so today a customer can pick nothing and pay the base
--
-- Guessing would change what customers can order and what they pay. So anything
-- ambiguous is marked 'review' and left exactly as it is — it keeps working
-- precisely as it does today, and the manager screen can list what needs a human.
-- A migration that quietly reprices a menu is worse than one that asks.
--
-- Purely additive. No option, group or price is altered.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.variant_groups
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'review',
  -- NULL product_id = a SHARED group, attached via variant_group_products below.
  -- Existing rows keep their product_id and are unaffected.
  ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false,
  -- Which included component this group sizes. NULL = it applies to the item
  -- itself, which is every existing row.
  ADD COLUMN IF NOT EXISTS combo_item_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'variant_groups_kind_check') THEN
    ALTER TABLE public.variant_groups
      ADD CONSTRAINT variant_groups_kind_check
      CHECK (kind = ANY (ARRAY['choice'::text, 'upgrade'::text, 'review'::text]));
  END IF;
END $$;

COMMENT ON COLUMN public.variant_groups.kind IS
  'choice = free preference, exactly one. upgrade = priced ladder with a zero baseline. review = ambiguous, left untouched and working as before.';
COMMENT ON COLUMN public.variant_groups.combo_item_id IS
  'The included component this group sizes. NULL = applies to the item itself.';

-- ── Attaching a shared group to many items ───────────────────────────────────
-- Separate table rather than widening variant_groups, so an existing per-product
-- group keeps working untouched and a shared one is opt-in.

CREATE TABLE IF NOT EXISTS public.variant_group_products (
  variant_group_id uuid NOT NULL REFERENCES public.variant_groups(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL,
  -- Which component of THIS product the group sizes, when it is component-scoped.
  -- Lives on the attachment, not the group: one shared "Size" ladder can size the
  -- fries on one combo and the drink on another.
  combo_item_id    uuid,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_group_id, product_id)
);

CREATE INDEX IF NOT EXISTS vgp_product_idx ON public.variant_group_products (product_id);

-- ── Classify what is already there ───────────────────────────────────────────
--
-- Only the two unambiguous rules run. Everything else stays 'review'.

-- 1. Every option free -> a genuine choice.
UPDATE public.variant_groups g
   SET kind = 'choice', updated_at = now()
 WHERE g.kind = 'review'
   AND EXISTS (SELECT 1 FROM public.variant_options o WHERE o.variant_group_id = g.id)
   AND NOT EXISTS (
     SELECT 1 FROM public.variant_options o
      WHERE o.variant_group_id = g.id AND o.price_adjustment <> 0
   );

-- 2. Required, has a zero-priced baseline AND at least one priced option
--    -> a properly formed ladder. Requiring the baseline is the point: without
--    one there is no "regular", and making such a group required later would
--    charge every customer the cheapest upgrade as a minimum.
UPDATE public.variant_groups g
   SET kind = 'upgrade', updated_at = now()
 WHERE g.kind = 'review'
   AND g.required IS TRUE
   AND EXISTS (
     SELECT 1 FROM public.variant_options o
      WHERE o.variant_group_id = g.id AND o.price_adjustment = 0
   )
   AND EXISTS (
     SELECT 1 FROM public.variant_options o
      WHERE o.variant_group_id = g.id AND o.price_adjustment <> 0
   );

DO $$
DECLARE c integer; u integer; r integer;
BEGIN
  SELECT count(*) INTO c FROM public.variant_groups WHERE kind = 'choice';
  SELECT count(*) INTO u FROM public.variant_groups WHERE kind = 'upgrade';
  SELECT count(*) INTO r FROM public.variant_groups WHERE kind = 'review';
  RAISE NOTICE 'migration 45: % choice, % upgrade, % need review', c, u, r;
  IF r > 0 THEN
    RAISE NOTICE 'migration 45: the % groups marked review are UNCHANGED and still work as before. They are listed in Menu -> needs review.', r;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS variant_groups_kind_idx ON public.variant_groups (kind);

INSERT INTO public.schema_migrations (version, notes)
VALUES ('45_variant_group_kind',
        'variant_groups gains kind/shared/combo_item_id; variant_group_products for reuse. Classifies free groups as choice and well-formed ladders as upgrade; anything ambiguous is left as review and untouched.')
ON CONFLICT (version) DO NOTHING;
