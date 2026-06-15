-- SwiftPOS: Table reservations and walk-in waitlist

CREATE TABLE IF NOT EXISTS public.reservations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id   uuid        NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  table_id    uuid        REFERENCES public.tables(id)              ON DELETE SET NULL,
  guest_name  text        NOT NULL,
  guest_phone text,
  party_size  integer     NOT NULL DEFAULT 2,
  reserved_date date      NOT NULL,
  reserved_time time      NOT NULL,
  notes       text,
  status      text        NOT NULL DEFAULT 'confirmed'
              CHECK (status IN ('confirmed','seated','completed','cancelled','no_show')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.waitlist (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id        uuid        NOT NULL REFERENCES public.branches(id)   ON DELETE CASCADE,
  guest_name       text        NOT NULL,
  guest_phone      text,
  party_size       integer     NOT NULL DEFAULT 2,
  estimated_wait   integer,        -- minutes
  added_at         timestamptz NOT NULL DEFAULT now(),
  seated_at        timestamptz,
  status           text        NOT NULL DEFAULT 'waiting'
                   CHECK (status IN ('waiting','seated','left')),
  notes            text
);

CREATE INDEX IF NOT EXISTS idx_reservations_branch_date
  ON public.reservations (branch_id, reserved_date);

CREATE INDEX IF NOT EXISTS idx_waitlist_branch_status
  ON public.waitlist (branch_id, status, added_at DESC);
