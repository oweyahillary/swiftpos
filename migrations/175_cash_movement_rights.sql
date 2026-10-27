-- 175_cash_movement_rights.sql — A594
--
-- Owner, 2026-10-26 (a cashier at a client typed the drawer's counts into Cash in — twice, 21 seconds apart, no reason,
-- nobody approving — and the expected cash read about 10,000 more than the drawer held): "we need to turn off that option
-- for cashiers by default unless allowed"; then "some items can be permissions; in fact we need to break those permissions
-- further". A453's admin switch 'cashier_no_money_out' became one key in A490 (shifts.cash_movements, "Cash in, cash out and
-- drawer expenses"); from A594 it is three, none a cashier default (shared/permissions.ts):
--   shifts.cash_movements  Record cash in              (the same key, relabelled: a 1.0.21 desktop POS checks it by name)
--   shifts.cash_out        Record cash out / pay-outs  (new)
--   expenses.record        Record expenses             (new)
-- Without one, the POS asks a manager's PIN on the spot for that cash in, cash out or expense (the approver is kept).
--
-- Registered (idempotent: re-running updates the words only, which follow shared/permissions.ts). Once (guarded by its
-- own schema_migrations row), for every role that is not the owner's (owner / admin) and holds shifts.cash_movements:
--   * a role that approves drawers (shifts.confirm, or a broad key that stood for it: orders.void, shifts.manage,
--     settings.manage) — Manager, Supervisor, General Manager … — keeps it and gets shifts.cash_out + expenses.record;
--   * a role at a business that ever set the switch (a stored feature_flags row for cashier_no_money_out, on or off: the
--     admin chose for that client, and migration 134 already turned an "on" into the roles' grants) keeps it and gets the
--     two new keys — nothing changes for that business;
--   * every other role (a business that never touched the switch: Cashier, Waiter, Fuel attendant, a selling role of the
--     owner's) LOSES shifts.cash_movements and gets neither new key — the owner's new default. A role's grants are saved as
--     a whole by the Roles screen, so an owner who ticked it on purpose cannot be told from the default.
-- The owner roles get both new keys (as every new key). A person's own override of shifts.cash_movements (Staff) is the
-- owner's explicit choice: it is kept, and the same override (given or taken) is added for the two new keys.
-- Nothing else changes. The role_permissions / user_permissions triggers bump permissions_version (tokens renew) and log
-- a staff change for the desktop POS.
--
-- To see beforehand what happens per role (read-only):
--   SELECT b.name AS business, r.name AS role,
--          CASE WHEN EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions k ON k.id = x.permission_id
--                             WHERE x.role_id = r.id AND k.key IN ('shifts.confirm', 'orders.void', 'shifts.manage', 'settings.manage'))
--                 THEN 'keeps (approves drawers) + cash out + expenses'
--               WHEN EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.business_id = r.business_id AND f.key = 'cashier_no_money_out')
--                 THEN 'keeps (switch set for this business) + cash out + expenses'
--               ELSE 'loses cash in (new default)' END AS outcome
--     FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id AND p.key = 'shifts.cash_movements'
--     JOIN public.roles r ON r.id = rp.role_id JOIN public.businesses b ON b.id = r.business_id
--    WHERE lower(trim(r.name)) NOT IN ('owner', 'admin')
--    ORDER BY 1, 2;

INSERT INTO public.permissions (key, label, module, description) VALUES
  ('shifts.cash_out', 'Record cash out / pay-outs', 'drawer', 'Take cash out of their drawer, with a reason - a manager approves every one with their PIN'),
  ('expenses.record', 'Record expenses', 'drawer', 'Record an expense paid from their drawer - a manager approves every one with their PIN')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

UPDATE public.permissions SET label = 'Record cash in', description = 'Put cash into their drawer, with a reason, with nobody approving it (without this, a manager approves each cash in with their PIN)'
 WHERE key = 'shifts.cash_movements';

DO $a594$
DECLARE
  v_lost integer := 0;
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '175_cash_movement_rights') THEN
  -- 1. Roles that keep cash in get cash out and expenses (read BEFORE anything is taken away).
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT DISTINCT r.id, n.id
    FROM public.roles r
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id AND p.key = 'shifts.cash_movements'
    JOIN public.permissions n ON n.key IN ('shifts.cash_out', 'expenses.record')
   WHERE lower(trim(r.name)) NOT IN ('owner', 'admin')
     AND (EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions k ON k.id = x.permission_id
                   WHERE x.role_id = r.id AND k.key IN ('shifts.confirm', 'orders.void', 'shifts.manage', 'settings.manage'))
          OR EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.business_id = r.business_id AND f.key = 'cashier_no_money_out'))
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- 2. The owner's new default: cash in off every other role.
  WITH gone AS (
    DELETE FROM public.role_permissions rp
     USING public.permissions p, public.roles r
     WHERE rp.permission_id = p.id AND p.key = 'shifts.cash_movements'
       AND r.id = rp.role_id
       AND lower(trim(r.name)) NOT IN ('owner', 'admin')
       AND NOT EXISTS (SELECT 1 FROM public.role_permissions x JOIN public.permissions k ON k.id = x.permission_id
                        WHERE x.role_id = r.id AND k.key IN ('shifts.confirm', 'orders.void', 'shifts.manage', 'settings.manage'))
       AND NOT EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.business_id = r.business_id AND f.key = 'cashier_no_money_out')
    RETURNING rp.role_id
  )
  SELECT count(*) INTO v_lost FROM gone;

  -- 3. The owner roles: every new key.
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, n.id
    FROM public.roles r
    JOIN public.permissions n ON n.key IN ('shifts.cash_out', 'expenses.record')
   WHERE lower(trim(r.name)) IN ('owner', 'admin')
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- 4. A person's own override of cash in / out (Staff) — the same for the two new keys.
  INSERT INTO public.user_permissions (user_id, permission_id, granted)
  SELECT up.user_id, n.id, up.granted
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id AND p.key = 'shifts.cash_movements'
    JOIN public.permissions n ON n.key IN ('shifts.cash_out', 'expenses.record')
  ON CONFLICT (user_id, permission_id) DO NOTHING;

  RAISE NOTICE 'A594: cash in taken off % role(s) at businesses that never set the switch', v_lost;
END IF;
END $a594$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('175_cash_movement_rights', 'A594: cash in / cash out / expenses as three rights (shifts.cash_movements relabelled Record cash in; shifts.cash_out, expenses.record) - off cashier roles unless the business had set the switch.')
ON CONFLICT (version) DO NOTHING;
