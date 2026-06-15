-- SwiftPOS: Clock in/out events
-- Records physical time-and-attendance for staff at POS

CREATE TABLE IF NOT EXISTS public.clock_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  staff_id     uuid        NOT NULL REFERENCES public.users(id)      ON DELETE CASCADE,
  branch_id    uuid        REFERENCES public.branches(id)            ON DELETE SET NULL,
  event_type   text        NOT NULL CHECK (event_type IN ('in', 'out')),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clock_events_staff_date
  ON public.clock_events (staff_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_clock_events_business_date
  ON public.clock_events (business_id, recorded_at DESC);
