-- 143_payables_view.sql — A518
--
-- A514 left the Accountant without the supplier bills: the only key was payables.manage, which also records and pays
-- them. payables.view reads the supplier accounts (balances, bills, payments, returns) and records or pays nothing.
--
-- Registered (idempotent: re-running updates the label and description only, which follow shared/permissions.ts).
-- Once (guarded by its own schema_migrations row):
--   * every role that holds payables.manage gets payables.view too (nothing gained: whoever pays the bills sees them);
--   * every built-in Accountant role (named Accountant, case and spaces aside, is_default — the ones migration 142 made
--     and the ones seeded at sign-up since) gets payables.view;
--   * the owner roles (owner / admin) get it, as every new key (the cloud treats them as everything anyway).
-- A role the owner set up under another name, and an Accountant the owner made by hand (is_default false), are left alone.
-- People renew into it (the role_permissions trigger bumps permissions_version).

INSERT INTO public.permissions (key, label, module, description) VALUES
  ('payables.view', 'See supplier bills', 'stock', 'See supplier bills, payments and returns, without recording or paying them')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

DO $a518p$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '143_payables_view') THEN
  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT DISTINCT r.id, v.id
    FROM public.roles r
    JOIN public.permissions v ON v.key = 'payables.view'
   WHERE EXISTS (SELECT 1 FROM public.role_permissions rp
                   JOIN public.permissions m ON m.id = rp.permission_id
                  WHERE rp.role_id = r.id AND m.key = 'payables.manage')
      OR (r.is_default AND lower(regexp_replace(trim(r.name), '[[:space:]_]+', ' ', 'g')) = 'accountant')
      OR lower(trim(r.name)) IN ('owner', 'admin')
  ON CONFLICT (role_id, permission_id) DO NOTHING;
END IF;
END $a518p$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('143_payables_view', 'A518: payables.view registered - given to roles holding payables.manage, the built-in Accountant roles and the owner roles.')
ON CONFLICT (version) DO NOTHING;
