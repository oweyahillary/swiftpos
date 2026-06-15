-- SwiftPOS: QR self-ordering
-- Adds a slug field to businesses for public menu URL.
-- QR orders are stored as regular orders with source='qr'

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS menu_slug    text UNIQUE,
  ADD COLUMN IF NOT EXISTS qr_ordering  boolean NOT NULL DEFAULT false;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS source       text DEFAULT 'pos'
              CHECK (source IN ('pos','qr','aggregator','online'));

CREATE INDEX IF NOT EXISTS idx_businesses_menu_slug ON public.businesses (menu_slug);
