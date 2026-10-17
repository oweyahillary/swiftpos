-- 146_manager_close_day.sql — A520
--
-- Owner, 2026-10-17, KRUNCH & CO: tills locked ("Trading day 2026-10-15 was never closed on this till. A manager must count
-- the cash and close it before 2026-10-16 can start"), and "Manager should be able to close a day and branch, did you remove
-- that right from them?" — yes. Before A490 (1.0.15) the till let close the day / Close Branch to anyone whose ROLE NAME
-- was manager, supervisor, admin or branch_manager, or who held settings.manage (dayService.ts isManager). A490 made it the
-- key shifts.close_day, and migration 134 gave that key only through settings.manage — a role merely NAMED Manager (most
-- shops: B Foods, KRUNCH) lost closing the day and the branch, and the tills' day lock could then not be lifted by anyone
-- but the owner. 134 promised "nothing gained, nothing lost".
--
-- The repair, once (guarded by its own schema_migrations row): every role named manager, supervisor or branch manager
-- (case, spaces and underscores aside) gets shifts.close_day (Close Day / Close Branch, the day lock's way out),
-- shifts.force_close and shifts.confirm (confirming each cashier's shift before Close Branch) — what those roles could do
-- before A490. Other roles and keys untouched; the owner may untick them afterwards. People renew into it (the
-- role_permissions trigger bumps permissions_version); a sign-in again applies it at once.

DO $a520$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '146_manager_close_day') THEN
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM public.roles r
    JOIN public.permissions p ON p.key IN ('shifts.close_day', 'shifts.force_close', 'shifts.confirm')
   WHERE replace(replace(lower(trim(r.name)), '_', ''), ' ', '') IN ('manager', 'supervisor', 'branchmanager')
  ON CONFLICT (role_id, permission_id) DO NOTHING;
END IF;
END $a520$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('146_manager_close_day', 'A520: roles named manager, supervisor or branch manager get shifts.close_day, force_close and confirm back - 134 gave them only through settings.manage.')
ON CONFLICT (version) DO NOTHING;
