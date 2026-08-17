-- =============================================================================
-- 75_permission_registry.sql
--
-- Register A57 (the gap), A46 (the split), A58 (three invisible manager tabs).
--
-- NUMBERED 75. 72 is absent from this repository and 68 is known to exist only
-- in production (register A4), so 75 follows 74 without reusing either.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
-- `requirePermission` fails CLOSED (rbac.ts:20 — allow on isOwner, '*', or the
-- exact key), and `role_permissions.permission_id` has a foreign key to
-- `permissions.id` (00_baseline.sql:5212). So a key with no `permissions` row
-- can never be attached to a role, can never reach req.permissionKeys, and the
-- routes behind it are OWNER-ONLY with nothing anywhere saying so.
--
-- `scripts/check-permission-parity.mjs` measured SIX enforced keys with no row
-- in any migration, covering ~62 routes:
--
--     products.manage 29 · settings.manage 16 · staff.manage 6
--     expenses.manage  6 · expenses.view    3 · orders.void   2
--
-- READ THE SCOPE CAREFULLY. This does NOT assert those routes are broken in
-- production. The live table is very likely seeded — these are the oldest keys
-- and 00_baseline.sql is a schema-only dump with no INSERTs. What it asserts is
-- that THE REPOSITORY CANNOT REBUILD A WORKING PERMISSION SET: a new tenant, a
-- staging rebuild or a PGlite migration test produces a database where a manager
-- cannot be granted any of them. That is the A4 shape, and it is why this
-- migration exists whatever production turns out to hold.
--
-- ── WHY IT IS SAFE TO RUN EITHER WAY ────────────────────────────────────────
-- Every INSERT is `ON CONFLICT (key) DO NOTHING` against `permissions_key_key`
-- (00_baseline.sql:2533), and every role grant is guarded by NOT EXISTS. If
-- production already holds these rows this migration is a no-op. That
-- idempotence is why it did not need to wait on a production query, and the
-- convention is migration 24's and 49's, not a new one.
--
-- Note on the NOT EXISTS guards: migration 24 says role_permissions has no
-- unique constraint on (role_id, permission_id). It does —
-- role_permissions_role_id_permission_id_key, 00_baseline.sql:2693. The comment
-- is stale. NOT EXISTS is kept anyway because it is correct under both.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
-- It grants NOTHING for section 1 or section 2. Section 1's keys describe
-- access that already exists, and handing them to a role would be a live
-- permission change dressed up as a backfill. Section 2's keys are not yet
-- enforced by any route, so a grant would be inert today and forgotten later.
-- Section 3 is the ONE behaviour change here and it is called out as such.
-- =============================================================================

-- ─── 1. A57 — keys the cloud enforces that were never registered ────────────
-- Labels and modules follow the existing rows' style (migration 24 / 27 / 49).
-- No role grants: see the header.
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('products.manage',  'Manage products',        'products',
     'Create, edit and delete products, categories, variants, modifiers, combos and print stations'),
  ('settings.manage',  'Manage business settings','settings',
     'Business-wide settings, feature flags, device approval, eTIMS registration and table setup'),
  ('staff.manage',     'Manage staff',            'staff',
     'Create, edit and deactivate staff, assign roles, PINs, hourly rates and branch access'),
  ('expenses.manage',  'Manage expenses',         'expenses',
     'Record, edit and delete branch expenses and expense categories'),
  ('expenses.view',    'View expenses',           'expenses',
     'Read branch expenses and expense reports'),
  ('orders.void',      'Void orders',             'orders',
     'Void a completed order, with a reason, after supervisor authorisation')
ON CONFLICT (key) DO NOTHING;

-- ─── 2. A46 — the narrow keys that split settings.manage ────────────────────
-- Every one is ADDITIVE: the routes accept `requireAnyPermission(narrow,
-- 'settings.manage')`, so nobody loses access on the day of the split and these
-- are what a MANAGER role gets granted instead of the one big switch.
--
-- Seeded here but granted to no role, and three of them are not yet enforced by
-- any route (receipt.manage, stations.manage, shifts.force_close). Registering
-- them now means the route re-point that follows is a pure code change with no
-- migration — which matters under rule 13, when a release is in flight.
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('devices.approve',    'Approve and revoke terminals', 'settings',
     'Approve, reject or delete a registered terminal and authorise handover of the branch node role'),
  ('etims.manage',       'Manage eTIMS / KRA',           'settings',
     'eTIMS configuration and KRA fiscal device registration. Owner-level in practice'),
  ('tables.manage',      'Manage tables and zones',      'settings',
     'Create, edit and delete dining tables and zones'),
  ('receipt.manage',     'Edit receipt text',            'settings',
     'Edit receipt header and footer only — branch address, phone, thank-you line. NOT business identity'),
  ('stations.manage',    'Manage print stations',        'settings',
     'Create, edit and delete print stations and their per-station exclusions (PHASE6 8c)'),
  ('shifts.force_close', 'Force-close a drawer',         'shifts',
     'Close a shift with no cash count. Audited; produces a variance the report cannot reconcile')
ON CONFLICT (key) DO NOTHING;

-- ─── 3. A58 — the two keys three manager nav items gate on ──────────────────
-- ManagerDashboard.tsx NAV_ITEMS gates Orders (:68), Inventory (:69) and
-- Turnover (:73) on these. Neither is enforced by any route and neither existed
-- as a permissions row, and hasPermission is
-- `permissions['*'] === true || permissions[key] === true`
-- (POSAuthContext.tsx:134) — so for anyone who is not the owner the gate can
-- only ever be false, and visibleNav (:1191) drops all three tabs. No error, no
-- log, nothing to report: the tabs are simply not there.
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('orders.view_all',  'View all orders',      'orders',
     'See every order for the branch on the manager dashboard, not only own orders'),
  ('inventory.view',   'View inventory',       'inventory',
     'Read stock levels and inventory screens for the branch')
ON CONFLICT (key) DO NOTHING;

-- THIS IS THE ONE BEHAVIOUR CHANGE IN THIS MIGRATION, and it is deliberate.
--
-- Roles named the same way migration 49 names them, and for its stated reason:
-- "a permission nobody holds gets granted to everybody within a week." These are
-- MANAGER DASHBOARD tabs — a manager dashboard whose Orders, Inventory and
-- Turnover tabs are invisible is not a security posture, it is a defect.
--
-- Turnover shows branch revenue. If a branch manager is not meant to see branch
-- revenue, DO NOT RUN THIS BLOCK — delete it and the tabs stay hidden. That is
-- the owner's call, not this migration's, and it is the reason this section is
-- separated rather than folded into section 1.
--
-- To revert just this grant, leaving the keys registered:
--   DELETE FROM role_permissions rp USING permissions p
--   WHERE rp.permission_id = p.id AND p.key IN ('orders.view_all','inventory.view');
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key IN ('orders.view_all', 'inventory.view')
  -- Role names are free text per business (roles.business_id is NOT NULL), so a
  -- shop that typed "Branch Manager" with a space was missed by the underscore
  -- form. Normalising space -> underscore matches the SAME set with punctuation
  -- variance, and deliberately does NOT widen to ILIKE '%manager%', which would
  -- sweep in names nobody has looked at. Migrations 24 and 49 carry the same
  -- unnormalised list and the same blind spot (register A61).
  AND  lower(replace(r.name, ' ', '_'))
         IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

INSERT INTO public.schema_migrations (version, notes)
VALUES ('75_permission_registry',
        'A57: registers the six enforced-but-unregistered keys (products.manage, settings.manage, staff.manage, expenses.manage, expenses.view, orders.void) covering ~62 routes that were owner-only on any database built from this repo, because requirePermission fails closed and role_permissions has an FK to permissions.id. A46: registers the six narrow keys that additively split settings.manage. A58: registers orders.view_all and inventory.view and grants them to manager-level roles, restoring three manager nav items whose gate could only ever be false. Idempotent: ON CONFLICT (key) DO NOTHING plus NOT EXISTS guards, so it is a no-op where production is already seeded.')
ON CONFLICT (version) DO NOTHING;
