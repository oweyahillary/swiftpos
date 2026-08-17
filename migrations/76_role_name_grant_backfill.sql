-- =============================================================================
-- 76_role_name_grant_backfill.sql
--
-- Register A61 — one bug in three migrations.
--
-- `roles.name` is free text and per business (roles.business_id is NOT NULL, so
-- every tenant names its own roles). Migrations 24, 49 and 75 all grant on:
--
--     lower(r.name) IN ('manager','supervisor','branch_manager','admin','owner')
--
-- A business that typed "Branch Manager" with a SPACE never matched
-- `branch_manager`, so it silently received no grant. Migration 24 shipped
-- 2026-07 and 49 shipped 2026-08, which means any such role has been missing
-- `inventory.receive` and `inventory.transfer` since then, and would have been
-- missing `orders.view_all` / `inventory.view` from 75 as well.
--
-- Nobody would see an error. The staff member simply cannot receive stock, and
-- the manager dashboard simply has fewer tabs — the A58 shape exactly, which is
-- how this was found: running the A58 verification query against a seeded test
-- database surfaced a "Branch Manager" row with no grants.
--
-- 75 is fixed at source in this same batch. This migration backfills the rows
-- that 24, 49 and the pre-fix 75 already missed in a database that has run them.
--
-- ── WHY NORMALISE RATHER THAN WIDEN ─────────────────────────────────────────
-- `lower(replace(name,' ','_'))` matches the SAME five names with punctuation
-- variance. It deliberately does NOT use ILIKE '%manager%', which would sweep in
-- role names nobody has looked at — "Trainee Manager", "Duty Manager Assistant"
-- — and hand them stock and revenue access as a side effect of a backfill. If a
-- business uses a name outside this set, that grant is a deliberate act in the
-- Roles screen, not something a migration should guess at.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- NOT EXISTS guards every insert, so re-running changes nothing, and a database
-- whose roles were all named with underscores gets zero new rows.
--
-- ── THIS GRANTS ACCESS. READ BEFORE RUNNING. ────────────────────────────────
-- inventory.receive lets a role record goods received. orders.view_all and
-- inventory.view show branch orders, turnover and stock. If a role named
-- "Branch Manager" was meant NOT to have what "branch_manager" has, do not run
-- this — fix the role's name instead, or grant explicitly in the Roles screen.
-- The SELECT at the bottom of this file lists exactly who is affected; run it
-- FIRST if you want to see the blast radius before committing.
-- =============================================================================

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key IN (
         'inventory.receive',    -- migration 24
         'inventory.transfer',   -- migration 49
         'orders.view_all',      -- migration 75
         'inventory.view'        -- migration 75
       )
  -- Normalised form matches; the raw form did not. That difference IS the bug,
  -- so restricting to it keeps this migration to the rows the originals missed
  -- rather than re-deriving every grant from scratch.
  AND  lower(replace(r.name, ' ', '_'))
         IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  lower(r.name)
         NOT IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

INSERT INTO public.schema_migrations (version, notes)
VALUES ('76_role_name_grant_backfill',
        'A61. Migrations 24, 49 and 75 granted on lower(r.name) IN (...,''branch_manager'',...), so a business that named the role "Branch Manager" with a space matched nothing and silently received no grant — no error, just missing stock receipt and missing manager tabs. 75 is normalised at source in the same batch; this backfills the rows 24, 49 and the pre-fix 75 already missed. Restricted to roles whose NORMALISED name matches but whose RAW name did not, so it touches only the rows the bug skipped. Idempotent via NOT EXISTS.')
ON CONFLICT (version) DO NOTHING;

-- ── Who this affected. Safe to run on its own, before or after. ─────────────
-- SELECT b.name AS business, r.name AS role
-- FROM   public.roles r JOIN public.businesses b ON b.id = r.business_id
-- WHERE  lower(replace(r.name,' ','_')) IN ('manager','supervisor','branch_manager','admin','owner')
--   AND  lower(r.name)                  NOT IN ('manager','supervisor','branch_manager','admin','owner')
-- ORDER  BY b.name, r.name;
