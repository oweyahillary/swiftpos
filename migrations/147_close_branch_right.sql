-- 147_close_branch_right.sql — A520
--
-- Owner, 2026-10-17: "On rights break close day and close branch as two, supervisor can have close day but not branch, a
-- manager can both." Until now shifts.close_day was both: Close Day on a till and Close Branch on the branch server.
--   shifts.close_day    Close the day     one till's own trading day (Close Day) - the way out of the day lock
--   shifts.close_branch Close the branch  Close Branch on the branch server (every till's day, the day totals confirmed)
--
-- Registered (idempotent: re-running updates the label and description only, which follow shared/permissions.ts), and
-- shifts.close_day relabelled to its narrower meaning. Once (guarded by its own schema_migrations row):
--   * every role that holds shifts.close_day gets shifts.close_branch (nothing lost: they could close the branch before),
--     EXCEPT roles named supervisor (case, spaces and underscores aside) - they keep Close Day only;
--   * the owner roles (owner / admin) get it, as every new key (the cloud treats them as everything anyway).
-- Nothing is ever removed. Migration 146 is final and not changed. A branch server still on 1.0.17 or older checks
-- shifts.close_day for Close Branch until it updates. People renew into it (the role_permissions trigger bumps
-- permissions_version).

INSERT INTO public.permissions (key, label, module, description) VALUES
  ('shifts.close_branch', 'Close the branch', 'drawer', 'Close Branch on the branch server: confirm the day totals of every till and close every till day')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

UPDATE public.permissions SET label = 'Close the day', description = 'Close the trading day on a till (Close Day) - the way out of the day lock'
 WHERE key = 'shifts.close_day';

DO $a520b$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '147_close_branch_right') THEN
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT DISTINCT r.id, b.id
    FROM public.roles r
    JOIN public.permissions b ON b.key = 'shifts.close_branch'
   WHERE (EXISTS (SELECT 1 FROM public.role_permissions rp
                    JOIN public.permissions d ON d.id = rp.permission_id
                   WHERE rp.role_id = r.id AND d.key = 'shifts.close_day')
          AND replace(replace(lower(trim(r.name)), '_', ''), ' ', '') <> 'supervisor')
      OR lower(trim(r.name)) IN ('owner', 'admin')
  ON CONFLICT (role_id, permission_id) DO NOTHING;
END IF;
END $a520b$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('147_close_branch_right', 'A520: shifts.close_branch registered - given to roles holding shifts.close_day (not supervisors) and the owner roles; close_day relabelled Close the day.')
ON CONFLICT (version) DO NOTHING;
