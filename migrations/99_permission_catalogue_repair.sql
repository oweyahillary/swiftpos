-- =============================================================================
-- 99_permission_catalogue_repair.sql
--
-- Register A211 — the permission catalogue is MISSING 7 keys on databases that
-- were bootstrapped from a consolidated dump rather than migrated in order.
--
-- FINDING (from the live dev DB, 2026-09-05)
-- ------------------------------------------
-- `permissions` was missing every key first registered by migrations 09/24/27:
--     customers.view, customers.manage        (09_customer_credit)
--     inventory.receive, inventory.adjust,
--     ingredients.manage                      (24_inventory_permissions)
--     reports.view, reports.financial         (27_report_permissions)
-- `schema_migrations` lists 09, 24 and 27 as APPLIED, yet their INSERTs left no
-- rows here — while 49's inventory.transfer survived. The ledger also carries a
-- consolidated-dump fingerprint (swiftpos_consolidated_migration,
-- all_phases_migration, pos_migration_v26..v30, 40_correct_migration_log): this
-- DB was seeded from a dump and had its version list hand-populated, so the
-- per-domain INSERTs never actually ran against it. "Applied" != "its effects are
-- present".
--
-- WHY IT MATTERS (register A57 / permission-model.md)
-- --------------------------------------------------
-- An unregistered key can never attach to a role (role_permissions.permission_id
-- -> permissions.id is a FK), so requirePermission FAILS CLOSED and the dashboard
-- nav filter hides the item — silently, with no error. On any affected DB this
-- makes non-owner customer management, stock receiving, the ingredient catalogue
-- and financial reports owner-only, and strips the manager's
-- Receiving / Reports / Customers tabs (register A133 / A205). It ALSO cannot be
-- fixed from Settings -> Roles, because that screen only renders checkboxes for
-- keys that exist in the catalogue.
--
-- WHAT THIS DOES (additive, idempotent, reversible; the rollout recipe)
-- --------------------------------------------------------------------
--   1. Registers the 7 missing keys, (key,label,module,description) copied
--      VERBATIM from 09/24/27, ON CONFLICT (key) DO NOTHING — a no-op wherever a
--      key already exists, so this is safe on a fully-migrated DB too.
--   2. Grants them to roles by tier, mirroring apps/server/src/lib/
--      defaultRolePermissions.ts EXACTLY, so no role gains anything it shouldn't:
--        - admin / owner                       : all 7
--        - manager / supervisor / branch_manager : the 4 NOT on MANAGER_DENY
--            customers.view, customers.manage, inventory.receive, reports.view
--            (NOT inventory.adjust / ingredients.manage / reports.financial —
--             those stay owner-only: they are where shrinkage/theft hides and the
--             financial numbers live)
--        - cashier                             : customers.view, customers.manage
--            (the CASHIER_KEYS subset that lives among these 7)
--      Role names are normalised lower(replace(name,' ','_')) — the A61-SAFE form.
--      (24/27 used bare lower(), which silently missed a role typed "Branch
--       Manager" with a space; 76 fixed that. This does not repeat the bug.)
--      role_permissions has NO unique (role_id,permission_id) constraint, so each
--      grant is guarded with NOT EXISTS — re-running adds nothing.
--
-- Enforce (routes) and Gate (dashboard/till) already reference these keys, so
-- steps 1+2 close the Register + Grant surfaces and they stop failing closed.
--
-- IDEMPOTENT: safe to run any number of times, on any DB (dump-seeded or migrated).
-- ADDITIVE  : grants only; revokes nothing; changes no existing row.
--
-- ROLLBACK (removes exactly what this migration can add):
--   DELETE FROM public.role_permissions rp USING public.permissions p
--     WHERE rp.permission_id = p.id
--       AND p.key IN ('customers.view','customers.manage','ingredients.manage',
--                     'inventory.adjust','inventory.receive','reports.view',
--                     'reports.financial');
--   DELETE FROM public.permissions
--     WHERE key IN ('customers.view','customers.manage','ingredients.manage',
--                   'inventory.adjust','inventory.receive','reports.view',
--                   'reports.financial');
--   DELETE FROM public.schema_migrations WHERE version = '99_permission_catalogue_repair';
--   NOTE: the role_permissions delete above also removes any grant an owner may
--   have since added by hand in Settings -> Roles for these keys. If that matters,
--   revert only the permissions rows this run inserted.
-- =============================================================================

-- ─── 1. Register the 7 missing keys (verbatim from 09/24/27) ─────────────────
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('customers.view',     'View customers & credit',     'Customers',  NULL),
  ('customers.manage',   'Manage customers & credit',   'Customers',  NULL),
  ('inventory.receive',  'Receive stock',               'inventory',
     'Record goods received (GRN) and purchase-order receipts, per branch'),
  ('inventory.adjust',   'Adjust stock levels',         'inventory',
     'Manually add / remove / set ingredient stock and record wastage (owner-level)'),
  ('ingredients.manage', 'Manage ingredient catalogue', 'inventory',
     'Create and edit ingredient definitions (owner-level)'),
  ('reports.view',       'View reports',                'reports',
     'General sales/product/staff/inventory/shift reports'),
  ('reports.financial',  'View financial reports',      'reports',
     'Tax report, food cost & margins, SPLH & labour cost, aggregator commission, and all report exports (owner-level)')
ON CONFLICT (key) DO NOTHING;

-- ─── 2a. Grant: admin / owner get all 7 ─────────────────────────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key IN ('customers.view','customers.manage','ingredients.manage',
                 'inventory.adjust','inventory.receive','reports.view','reports.financial')
  AND  lower(replace(r.name, ' ', '_')) IN ('admin','owner')
  AND  NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

-- ─── 2b. Grant: manager tier gets the 4 keys NOT on MANAGER_DENY ─────────────
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key IN ('customers.view','customers.manage','inventory.receive','reports.view')
  AND  lower(replace(r.name, ' ', '_')) IN ('manager','supervisor','branch_manager')
  AND  NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

-- ─── 2c. Grant: cashier gets the two customer keys (CASHIER_KEYS subset) ─────
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key IN ('customers.view','customers.manage')
  AND  lower(replace(r.name, ' ', '_')) = 'cashier'
  AND  NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

-- ─── 3. Ledger ──────────────────────────────────────────────────────────────
INSERT INTO public.schema_migrations (version, notes)
VALUES ('99_permission_catalogue_repair',
        'A211 — register 7 catalogue keys (customers.view/manage, inventory.receive/adjust, ingredients.manage, reports.view/financial) first added by 09/24/27 but absent on dump-seeded DBs, then grant per tier mirroring defaultRolePermissions (manager gets the 4 non-deny keys; cashier the 2 customer keys). Additive/idempotent, A61-safe normalisation, fully public.-qualified (A62). Pairs with A212 (Printers nav re-point to stations.manage).')
ON CONFLICT (version) DO NOTHING;

-- ── Who this affects. Safe to run on its own, before or after committing. ─────
-- SELECT b.name AS business, r.name AS role, p.key
-- FROM   public.role_permissions rp
-- JOIN   public.permissions p ON p.id = rp.permission_id
-- JOIN   public.roles r       ON r.id = rp.role_id
-- JOIN   public.businesses b  ON b.id = r.business_id
-- WHERE  p.key IN ('customers.view','customers.manage','inventory.receive','reports.view')
-- ORDER  BY b.name, r.name, p.key;
