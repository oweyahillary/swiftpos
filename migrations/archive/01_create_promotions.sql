-- SwiftPOS: Promotions engine
-- Time-based (happy hour), BOGO, and quantity discounts
-- Run in Supabase SQL editor

CREATE TABLE IF NOT EXISTS public.promotions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name            text NOT NULL,
  promo_type      text NOT NULL DEFAULT 'happy_hour'
                    CHECK (promo_type IN ('happy_hour', 'bogo', 'quantity_discount')),

  -- Date range (null = no date restriction)
  start_date      date,
  end_date        date,

  -- Time window (for happy_hour; null = all day)
  start_time      time,
  end_time        time,

  -- Days of week: 0=Sun, 1=Mon ... 6=Sat; empty = all days
  days_of_week    integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',

  -- What it applies to
  applies_to      text NOT NULL DEFAULT 'all'
                    CHECK (applies_to IN ('all', 'category', 'product')),
  product_ids     uuid[]   NOT NULL DEFAULT '{}',
  category_ids    uuid[]   NOT NULL DEFAULT '{}',

  -- Discount values (for happy_hour / quantity_discount)
  discount_type   text CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value  numeric(10,2),

  -- Quantity rules (for bogo / quantity_discount)
  min_quantity    integer NOT NULL DEFAULT 1,
  free_quantity   integer,   -- BOGO: buy min_quantity get free_quantity free

  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promotions_business_status
  ON public.promotions (business_id, status);
