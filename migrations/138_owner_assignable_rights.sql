-- 138_owner_assignable_rights.sql — A502
--
-- Owner, 2026-10-15, on the A494 owner-only settings: "yes leave to owner but should be a right a user can be assigned".
-- Promotions, the void / refund rules and the stock-count freeze each become a permission of their own. No role is given
-- them here: they stay the owner's until the owner gives one to a role or a person (Settings › Roles, or a person's own
-- permissions). Registered so a role or a person can be granted them (role_permissions / user_permission_overrides name
-- a permissions row).
--
-- Idempotent: re-running updates the labels and descriptions only.

INSERT INTO public.permissions (key, label, module, description) VALUES
  ('menu.promotions', 'Promotions', 'menu', 'Create, change and delete promotions, which run at every branch'),
  ('inventory.count_freeze', 'Stock count freeze', 'stock', 'Choose whether a stock count stops sales of the items being counted'),
  ('settings.reversals', 'Void and refund rules', 'settings', 'Who may void and refund, for how long after a sale, and what a till may do offline')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

-- The owner's role holds every fine key (as 134 — the cloud treats it as everything anyway; the rows keep the Roles
-- screen honest). No other role is given them.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r
  JOIN public.permissions p ON p.key IN ('menu.promotions', 'inventory.count_freeze', 'settings.reversals')
 WHERE lower(trim(r.name)) IN ('owner', 'admin')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('138_owner_assignable_rights', 'A502: menu.promotions, inventory.count_freeze, settings.reversals registered - the owner''s until given to someone.')
ON CONFLICT (version) DO NOTHING;
