-- =============================================================================
-- SwiftPOS — Inventory permissions (Phase 2 support)
-- =============================================================================
-- Run AFTER 23_per_branch_ingredient_stock.sql.
--
-- Adds three permission keys and wires them to existing roles:
--   ingredients.manage  → OWNER only  (create/edit the ingredient catalogue)
--   inventory.receive   → owner + manager + supervisor  (GRN / PO receipts)
--   inventory.adjust    → OWNER only  (manual add/remove/set + wastage)
--
-- Owners are never role-gated (auth grants them a wildcard), so the owner-only
-- keys need no role grant. Managers/supervisors need an explicit grant to
-- receive, so we backfill that for businesses that already exist.
-- =============================================================================

-- ─── 1. Register the permission keys ────────────────────────────────────────
INSERT INTO permissions (key, label, module, description) VALUES
  ('ingredients.manage', 'Manage ingredient catalogue', 'inventory',
     'Create and edit ingredient definitions (owner-level)'),
  ('inventory.receive',  'Receive stock',               'inventory',
     'Record goods received (GRN) and purchase-order receipts, per branch'),
  ('inventory.adjust',   'Adjust stock levels',         'inventory',
     'Manually add / remove / set ingredient stock and record wastage (owner-level)')
ON CONFLICT (key) DO NOTHING;

-- ─── 2. Backfill: existing manager/supervisor roles may RECEIVE (not adjust) ─
-- (role_permissions has no unique constraint on (role_id, permission_id), so we
--  guard with NOT EXISTS instead of ON CONFLICT.)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   roles r
CROSS JOIN permissions p
WHERE  p.key = 'inventory.receive'
  AND  lower(r.name) IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  NOT EXISTS (
         SELECT 1 FROM role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

-- Note: inventory.adjust and ingredients.manage are intentionally NOT granted to
-- any staff role here — they resolve to owner-only. If you later decide a role
-- should hold them, grant via the Roles screen or a follow-up migration.
