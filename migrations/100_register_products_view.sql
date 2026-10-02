-- =============================================================================
-- 100_register_products_view.sql
--
-- Register A220 — `products.view` is gated in the UI but registered NOWHERE.
--
-- FINDING (parity, 2026-09-05)
-- ---------------------------
-- The manager Menu tab gates on `products.view` (ManagerDashboard.tsx, from A208),
-- and `products.view` is a cashier/manager key by design (lib/defaultRolePermissions
-- CASHIER_KEYS). But no migration ever registered it — `check-permission-parity`
-- reports it as a PHANTOM ("UI gates on a key that exists nowhere"). Same class as
-- A211/A212: an unregistered key can never attach to a role, so `hasPermission`
-- is always false for non-owners and the Menu tab is silently invisible to every
-- manager — exactly like Receiving/Reports/Customers/Printers were before A211/A212.
--
-- WHAT THIS DOES (additive, idempotent, reversible)
-- -------------------------------------------------
--   1. Registers `products.view` (ON CONFLICT DO NOTHING).
--   2. Grants it per tier, mirroring defaultRolePermissions: admin/owner, the
--      manager tier (not on MANAGER_DENY), and cashier (CASHIER_KEYS) all get it.
--      A61-safe normalisation, NOT EXISTS-guarded, fully public.-qualified (A62).
--
-- After this, parity's phantom count returns to its baseline (0) because the key
-- is registered, and the manager Menu tab renders. products.view is a read/view
-- gate; it is intentionally not enforced on a write route.
--
-- ROLLBACK:
--   DELETE FROM public.role_permissions rp USING public.permissions p
--     WHERE rp.permission_id = p.id AND p.key = 'products.view';
--   DELETE FROM public.permissions WHERE key = 'products.view';
--   DELETE FROM public.schema_migrations WHERE version = '100_register_products_view';
-- =============================================================================

-- ─── 1. Register ─────────────────────────────────────────────────────────────
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('products.view', 'View products & menu', 'products',
     'Read-only view of the product/menu catalogue')
ON CONFLICT (key) DO NOTHING;

-- ─── 2a. admin / owner ───────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key = 'products.view'
  AND  lower(replace(r.name, ' ', '_')) IN ('admin','owner')
  AND  NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                   WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- ─── 2b. manager tier (products.view is not on MANAGER_DENY) ──────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key = 'products.view'
  AND  lower(replace(r.name, ' ', '_')) IN ('manager','supervisor','branch_manager')
  AND  NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                   WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- ─── 2c. cashier (CASHIER_KEYS) ──────────────────────────────────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key = 'products.view'
  AND  lower(replace(r.name, ' ', '_')) = 'cashier'
  AND  NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                   WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- ─── 3. Ledger ───────────────────────────────────────────────────────────────
INSERT INTO public.schema_migrations (version, notes)
VALUES ('100_register_products_view',
        'A220 — register products.view (gated by the A208 Menu tab, registered by no migration -> parity phantom) + grant per tier (admin/owner, manager tier, cashier per CASHIER_KEYS). Additive/idempotent, A61-safe, public.-qualified.')
ON CONFLICT (version) DO NOTHING;
