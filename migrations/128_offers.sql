-- Migration 128 — A445: offers a manager creates, applied by themselves at the till and the web POS (2026-10-11)
--
-- Owner, 2026-10-11: "a manager can create an offer i.e runs on specific days or on a certain duration" — % or amount
-- off, a special price, buy X get Y free ("buy one or buy 2 and get this for free"), spend over X get money off, and a
-- custom meal (chosen items together for one price); dates + weekdays + hours; the owner for every or chosen branches,
-- a manager for their own branch; a manual discount still applies on top, capped as before on what is left.
--
-- public.offers — one offer. The rules live in shared/offers.ts (the till, the web POS and the cloud run the same file):
--   kind            percent_off | amount_off | special_price | buy_get | spend_get | meal
--   value           the %, the amount off each item, the special price, the spend reward, or the meal's price
--   spend_type      spend_get: the reward is a 'percent' of the bill or an 'amount'
--   applies_to      all | products | categories (with product_ids / category_ids)
--   buy_qty, get_qty, get_product_id   buy_get (get_product_id NULL = the same items; the cheapest of each group is free)
--   min_spend       spend_get
--   meal_items      meal: [{label, product_ids[], category_ids[], qty}]
--   start_date, end_date, days (0 = Sunday … 6), start_time, end_time — when it runs, on the till's own clock
--   branch_ids      NULL = every branch (the owner's choice); a manager's offer names their own branch
--   updated_at      moved on every change and on delete, so a till's 20-s catalogue check (GET /api/pos/catalogue-version)
--                   sees it; deleted_at  a deleted offer is kept (marked) for that reason and for the sales that name it.
-- public.orders.offer_discount — what offers took off the sale (part of discount_amount, which stays the WHOLE discount
--   so every report, receipt and total keeps working unchanged); the manual part is discount_amount − offer_discount.
-- public.orders.offers — which offers, by name and amount: [{offer_id, name, amount}] (the receipt and the reports).
--
-- The older public.promotions table (never charged at the till) is left as it is; the back office now edits offers.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.offers (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name            text          NOT NULL,
  kind            text          NOT NULL,
  value           numeric(12,2) NOT NULL DEFAULT 0,
  spend_type      text          NOT NULL DEFAULT 'amount',
  applies_to      text          NOT NULL DEFAULT 'all',
  product_ids     uuid[]        NOT NULL DEFAULT '{}',
  category_ids    uuid[]        NOT NULL DEFAULT '{}',
  buy_qty         integer       NOT NULL DEFAULT 0,
  get_qty         integer       NOT NULL DEFAULT 0,
  get_product_id  uuid          REFERENCES public.products(id) ON DELETE SET NULL,
  min_spend       numeric(12,2) NOT NULL DEFAULT 0,
  meal_items      jsonb         NOT NULL DEFAULT '[]'::jsonb,
  start_date      date,
  end_date        date,
  days            smallint[],
  start_time      time,
  end_time        time,
  branch_ids      uuid[],
  active          boolean       NOT NULL DEFAULT true,
  created_by      uuid,
  created_by_name text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT offers_kind_check       CHECK (kind IN ('percent_off', 'amount_off', 'special_price', 'buy_get', 'spend_get', 'meal')),
  CONSTRAINT offers_spend_type_check CHECK (spend_type IN ('percent', 'amount')),
  CONSTRAINT offers_applies_to_check CHECK (applies_to IN ('all', 'products', 'categories')),
  CONSTRAINT offers_value_check      CHECK (value >= 0 AND min_spend >= 0 AND buy_qty >= 0 AND get_qty >= 0),
  CONSTRAINT offers_dates_check      CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  CONSTRAINT offers_days_check       CHECK (days IS NULL OR (days <@ ARRAY[0,1,2,3,4,5,6]::smallint[] AND cardinality(days) BETWEEN 1 AND 6))
);
CREATE INDEX IF NOT EXISTS offers_business_active ON public.offers (business_id, active);
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS offer_discount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS offers         jsonb;
