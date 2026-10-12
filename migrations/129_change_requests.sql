-- Migration 129 — A448: changes made on a till (offline or not) reach the cloud, and a clash waits for the owner (2026-10-12)
--
-- Owner, 2026-10-11/12: "a totally offline till can't add another printer — that's bad; they should be able to work
-- independently; cloud should never block a till from working … cloud and local instance complement one another but none
-- is superior unless an override is done"; on a clash: "if they are the same keep them, if not notify the owner requesting
-- approval"; "offline supersedes online change when it comes to PIN change".
--
-- A manager's change on a till (a print station, a category, a product, a cashier's PIN) is saved on the till first and
-- works at once; the till sends it later with the value it saw before (`base`). The cloud then:
--   applied    — nobody else changed it (the cloud still holds `base`): applied as it is
--   identical  — the cloud already holds the same thing (the same change made elsewhere, or a replay): kept, nothing to do
--   awaiting   — someone else changed it differently meanwhile: NOT applied; the owner is notified and decides
--   approved   — the owner took the till's change: applied
--   rejected   — the owner kept the cloud's: the till takes the cloud's on its next pull
--   refused    — it cannot be applied (not allowed, something it names no longer exists): the reason is shown on the till
--
-- public.change_requests — one row per change a till sent; `id` is the till's own id for it (a replay is recognised).
--   entity        station | category | product | staff (a cashier added on a till) | staff_pin
--   op            create | update | delete
--   base          the fields as the till saw them before its change (update / delete)
--   proposed      the till's values
--   cloud_value   the cloud's values of those fields when it clashed (what the owner compares)
--   canonical_id  a create the cloud already had under another id (the same name): the till renames its own to this
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.change_requests (
  id             uuid          PRIMARY KEY,
  business_id    uuid          NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id      uuid,
  device_id      text,
  entity         text          NOT NULL,
  entity_id      uuid          NOT NULL,
  op             text          NOT NULL,
  base           jsonb,
  proposed       jsonb         NOT NULL DEFAULT '{}'::jsonb,
  cloud_value    jsonb,
  status         text          NOT NULL,
  message        text,
  canonical_id   uuid,
  made_by        uuid,
  made_by_name   text,
  made_at        timestamptz,
  received_at    timestamptz   NOT NULL DEFAULT now(),
  decided_by     uuid,
  decided_by_name text,
  decided_at     timestamptz,
  CONSTRAINT change_requests_entity_check CHECK (entity IN ('station', 'category', 'product', 'staff', 'staff_pin')),
  CONSTRAINT change_requests_op_check     CHECK (op IN ('create', 'update', 'delete')),
  CONSTRAINT change_requests_status_check CHECK (status IN ('applied', 'identical', 'awaiting', 'approved', 'rejected', 'refused'))
);
CREATE INDEX IF NOT EXISTS change_requests_awaiting ON public.change_requests (business_id, status) WHERE status = 'awaiting';
CREATE INDEX IF NOT EXISTS change_requests_entity   ON public.change_requests (business_id, entity, entity_id);
ALTER TABLE public.change_requests ENABLE ROW LEVEL SECURITY;
