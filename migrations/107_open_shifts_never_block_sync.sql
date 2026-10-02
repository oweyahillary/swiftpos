-- Migration 107 — a till's drawer never blocks another's sync (A338, 2026-09-27)
--
-- Owner, 2026-09-27: the till stopped syncing "because of the cloud till which is running … one should never block the
-- other from syncing".
--
-- What happened: migration 63 made "one OPEN shift per terminal" a UNIQUE index. The web POS can stand in for a till
-- (A273: it adopts the till's device id). When the web opens a drawer AS T1 and T1 already has its own drawer — opened
-- offline, before A334's join existed, or on a build that did not join — the till's shift arrives at /api/sync/push, the
-- index refuses it (23505 → duplicate_open_shift), and the till parks it. Everything hanging off that shift then fails:
--   * every sale on it — orders.shift_id is a foreign key to shifts, so each push 500s, and after 5 tries it is 'failed';
--   * its floats (missing_shift) and expenses;
--   * its close, which waits for its sales.
-- One running drawer stopped the other drawer's whole day from reaching the cloud, and Force sync could not help.
--
-- The rule the index enforced is still wanted where a PERSON opens a drawer — and it is enforced there, in the app:
-- POST /api/shifts/open refuses a second open drawer on a terminal (409) and the web picker joins the open one instead.
-- What the index added was refusing a drawer that ALREADY EXISTS on a till and is only now arriving. Refusing a fact
-- does not undo it; it only loses the sales. So the index becomes an ordinary (non-unique) one: the same lookups stay
-- fast, and a till's drawer always lands. Two drawers open on one terminal is then visible (both listed, each closes
-- and reconciles its own cash) instead of silently losing one of them.
--
-- Idempotent. Reversible only if no terminal has two open drawers at the time (recreate the unique index).

DROP INDEX IF EXISTS public.shifts_one_open_per_terminal;

CREATE INDEX IF NOT EXISTS shifts_open_by_terminal
  ON public.shifts (business_id, public.shift_terminal_key(device_id, terminal_code, branch_id))
  WHERE status = 'open';

COMMENT ON INDEX public.shifts_open_by_terminal IS
  'A338 (migration 107): open drawers by terminal, for lookups. NOT unique — a drawer that already exists on a till '
  'must always sync; opening a second drawer by hand is refused by the app (POST /api/shifts/open), not here.';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('107_open_shifts_never_block_sync', 'A338: shifts_one_open_per_terminal → non-unique shifts_open_by_terminal, so a till''s shift (and its sales) always sync')
ON CONFLICT (version) DO NOTHING;
