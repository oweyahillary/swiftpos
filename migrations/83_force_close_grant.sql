-- =============================================================================
-- 83_force_close_grant.sql
--
-- Grants `shifts.force_close` to the manager-level role set (register A59).
--
-- Migration 75 REGISTERED shifts.force_close but granted it to no role, and
-- POST /api/shifts/:id/force-close enforced `settings.manage` instead — so the
-- dedicated key was inert and force-close required the broad settings.manage.
-- A59's closure recorded this as the one deferred thread ("touches a desktop
-- file"). The route is now requireAnyPermission('shifts.force_close',
-- 'settings.manage') and the till gates its force-close trigger on
-- has('shifts.force_close') || has('settings.manage') — BOTH additive, so anyone
-- who could force-close via settings.manage still can. This migration makes the
-- key real by granting it to the same manager role set as 75/76/78.
--
-- shifts.force_close ends a drawer WITHOUT a count — a manager action. The grant
-- goes to the roles that already hold settings.manage, so no role gains a
-- capability it lacked; the key just becomes the precise name for it.
--
-- No permissions_version bump: like 78, new grants are picked up when the POS
-- token next refreshes (<= 15m) — the established pattern.
--
-- REVERT:
--   DELETE FROM public.role_permissions rp USING public.permissions p
--   WHERE rp.permission_id = p.id AND p.key = 'shifts.force_close';
--
-- Every table reference is public.-qualified — this migration must survive a
-- search_path that excludes public, which is what broke 76 in the field (A62).
-- =============================================================================

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key = 'shifts.force_close'
  -- Normalised name match: "Branch Manager" with a space matches the same set
  -- as branch_manager. Deliberately NOT ILIKE '%manager%' (that would sweep in
  -- "Trainee Manager"). Same list and reasoning as 75 section 3, 76 (A61), 78.
  AND  lower(replace(r.name, ' ', '_'))
         IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

INSERT INTO public.schema_migrations (version, notes)
VALUES ('83_force_close_grant',
        'A59. Migration 75 registered shifts.force_close but granted it to no role, and POST /shifts/:id/force-close enforced settings.manage — so the dedicated key was inert. Route is now requireAnyPermission(shifts.force_close, settings.manage); the till gates its force-close trigger on has(shifts.force_close) || has(settings.manage). Both additive: no role loses force-close. Grants shifts.force_close to the manager role set using the SAME normalised name match as 75 section 3, 76 and 78. Idempotent via NOT EXISTS.')
ON CONFLICT (version) DO NOTHING;

-- ── Who this grants to. Safe to run on its own, before or after. ─────────────
-- SELECT b.name AS business, r.name AS role
-- FROM   public.roles r JOIN public.businesses b ON b.id = r.business_id
-- WHERE  lower(replace(r.name,' ','_')) IN ('manager','supervisor','branch_manager','admin','owner')
-- ORDER  BY b.name, r.name;
