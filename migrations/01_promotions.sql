-- SwiftPOS: Promotions engine
-- Run in Supabase SQL editor before deploying server

CREATE TABLE IF NOT EXISTS public.promotions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  promo_type      text        NOT NULL DEFAULT 'happy_hour'
                              CHECK (promo_type IN ('happy_hour', 'bogo', 'quantity_discount')),
  start_date      date,
  end_date        date,
  start_time      time,
  end_time        time,
  days_of_week    integer[]   NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  applies_to      text        NOT NULL DEFAULT 'all'
                              CHECK (applies_to IN ('all', 'category', 'product')),
  product_ids     uuid[]      NOT NULL DEFAULT '{}',
  category_ids    uuid[]      NOT NULL DEFAULT '{}',
  discount_type   text        CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value  numeric(10,2),
  min_quantity    integer     NOT NULL DEFAULT 1,
  free_quantity   integer,
  status          text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'inactive')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promotions_business_status
  ON public.promotions (business_id, status);
