-- =============================================================================
-- 82_manager_deny_reconcile.sql
--
-- Register A64 — two manager deny-lists disagreed; the owner chose the strict one.
--
-- The onboarding seeder (`defaultRolePermissions.ts`) denies managers FOUR keys:
--   settings.manage, inventory.adjust, ingredients.manage, reports.financial
-- The backfill migration 59 denied managers only ONE (settings.manage), so on
-- tenants that existed when 59 ran, a manager may hold the other three —
-- inventory.adjust (where shrinkage/theft hides), ingredients.manage, and
-- reports.financial (food cost, margins, labour — audit H6). New tenants are
-- already correct; this is the reconcile for the old ones.
--
-- OWNER DECISION (2026-08-13): managers RECEIVE stock and SEE inventory and
-- branch reports; they do NOT manage or adjust inventory and do NOT see financial
-- reports — that lives on the web only. So the strict seeder policy is the
-- authoritative one, and this revokes the three over-granted keys from the
-- manager role set.
--
-- ── WHAT IT DOES NOT TOUCH ───────────────────────────────────────────────────
-- * Only the manager role set — `manager`, `supervisor`, `branch_manager`
--   (normalised, so "Branch Manager" with a space is included — A61). NOT owner
--   or admin, who hold these legitimately (via the '*' wildcard or explicit grant).
-- * Only the three keys above. Every other manager grant — inventory.view,
--   inventory.receive, reports.view, products.*, orders.* — is left in place.
--
-- ── PER-SHOP EXCEPTIONS ──────────────────────────────────────────────────────
-- This sets the DEFAULT. If a specific shop wants a specific manager to hold one
-- of these keys, that is a per-shop preference and belongs in the Roles screen,
-- re-granted after this runs — the same split migrations 76/78 use. A blanket
-- policy belongs in a migration; a shop's exception does not.
--
-- ── BLAST RADIUS ─────────────────────────────────────────────────────────────
-- Run the SELECT at the foot FIRST to see exactly which (business, role, key)
-- rows will be removed before committing. The register notes this over-grant is
-- verified in code but its runtime presence was not (the parity parser is blind
-- to 59's CROSS JOIN form), so the set removed may be empty on some databases —
-- that is fine, the DELETE is a no-op there.
--
-- ── IDEMPOTENT / REVERSIBLE ──────────────────────────────────────────────────
-- A DELETE of rows matching a condition is naturally idempotent. To reverse,
-- re-grant via the Roles screen (per shop) or re-run the relevant grant for the
-- key. Every table reference is public.-qualified (survives a search_path without
-- public — A62).
-- =============================================================================

DELETE FROM public.role_permissions rp
USING public.roles r, public.permissions p
WHERE rp.role_id       = r.id
  AND rp.permission_id = p.id
  AND p.key IN ('inventory.adjust', 'ingredients.manage', 'reports.financial')
  AND lower(replace(r.name, ' ', '_')) IN ('manager', 'supervisor', 'branch_manager');

INSERT INTO public.schema_migrations (version, notes)
VALUES ('82_manager_deny_reconcile',
        'A64. Owner chose the strict manager policy: managers receive stock and see inventory + branch reports, but do NOT adjust/manage inventory or see financial reports (web only). Migration 59 backfilled managers everything-except-settings.manage, over-granting inventory.adjust / ingredients.manage / reports.financial on tenants that existed then; the seeder (defaultRolePermissions MANAGER_DENY) already denies all four. Revokes the three over-granted keys from the manager/supervisor/branch_manager role set (normalised names, A61), leaving owner/admin and every other manager grant untouched. Per-shop exceptions go through the Roles screen. Idempotent.')
ON CONFLICT (version) DO NOTHING;

-- ── Who this removes from. Safe to run on its own, before committing. ─────────
-- SELECT b.name AS business, r.name AS role, p.key
-- FROM   public.role_permissions rp
-- JOIN   public.roles r        ON r.id = rp.role_id
-- JOIN   public.businesses b   ON b.id = r.business_id
-- JOIN   public.permissions p  ON p.id = rp.permission_id
-- WHERE  p.key IN ('inventory.adjust','ingredients.manage','reports.financial')
--   AND  lower(replace(r.name,' ','_')) IN ('manager','supervisor','branch_manager')
-- ORDER  BY b.name, r.name, p.key;
