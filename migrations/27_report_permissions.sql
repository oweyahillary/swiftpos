-- =============================================================================
-- SwiftPOS — Report permissions (audit H6)
-- =============================================================================
-- Every report/export endpoint was reachable by any authenticated user — no
-- requirePermission check existed at all. Fixing that (see reports.ts /
-- reports-export.ts) needs two things done first:
--
--   1. 'reports.view'      — should already exist (two endpoints already
--      reference it: orders.ts turnover/report, etims.ts invoices) but this
--      insert is here defensively/idempotently in case some environment
--      never got it. Broad gate for the 13 general report endpoints.
--   2. 'reports.financial' — NEW. Stricter gate for the Tax Report, Food
--      Cost/margins, SPLH & labour cost, aggregator commission, and every
--      /reports/export/* endpoint.
--
-- Tier, confirmed with the business owner (not assumed):
--   reports.view      → owner + manager/supervisor/branch_manager
--   reports.financial → OWNER ONLY. Managers keep reports.view (general
--                       reports) but not the stricter set — matches the same
--                       owner-only precedent as settings.manage /
--                       inventory.adjust / ingredients.manage.
--
-- Existing businesses are backfilled below so a manager who could see reports
-- yesterday can still see the general ones today — only the deploy of this
-- migration + the corresponding code change actually starts enforcing
-- anything; nobody's access silently changes before that.
-- =============================================================================

-- ─── 1. Register the permission keys ────────────────────────────────────────
INSERT INTO permissions (key, label, module, description) VALUES
  ('reports.view',      'View reports',           'reports',
     'General sales/product/staff/inventory/shift reports'),
  ('reports.financial', 'View financial reports', 'reports',
     'Tax report, food cost & margins, SPLH & labour cost, aggregator commission, and all report exports (owner-level)')
ON CONFLICT (key) DO NOTHING;

-- ─── 2. Backfill: existing owner/manager-tier roles get reports.view ────────
-- (role_permissions has no unique constraint on (role_id, permission_id), so
--  guard with NOT EXISTS instead of ON CONFLICT, same as 24_inventory_permissions.sql.)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   roles r
CROSS JOIN permissions p
WHERE  p.key = 'reports.view'
  AND  lower(r.name) IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  NOT EXISTS (
         SELECT 1 FROM role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

-- Note: reports.financial is intentionally NOT granted to any staff role here
-- — it resolves to owner-only (the owner auth path grants a permission
-- wildcard regardless of role, so no row is needed for the owner either). If
-- you later decide a manager should hold it, grant via the Roles screen.
