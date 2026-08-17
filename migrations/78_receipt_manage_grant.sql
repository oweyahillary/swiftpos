-- =============================================================================
-- 78_receipt_manage_grant.sql
--
-- Register A45 — the last step: grant the key the allow-list depends on.
--
-- A45 closed the cloud side on 2026-08-11: POST /business/settings now admits a
-- caller holding only `receipt.manage` and lets them write receipt header/footer
-- WITHOUT reaching the bcrypt or M-Pesa-credential branches (proven by
-- receipt-permission.test.mjs). Migration 75 REGISTERED the key. But a key
-- granted to nobody is inert: a 2026-08-12 query returned ZERO roles holding
-- `receipt.manage` across every business, so the narrow path A45 built has never
-- been reachable — a manager still needs the wide `settings.manage` to edit a
-- receipt, which is exactly the grant A45 exists to avoid.
--
-- This migration grants `receipt.manage` to the manager-level role set. That is
-- the ONE behaviour change here, and it is deliberate.
--
-- ── WHY A MIGRATION, NOT A CONSOLE INSERT ───────────────────────────────────
-- A one-line INSERT in the SQL console would apply to production and NOWHERE
-- else. A rebuilt staging or PGlite database would lack it — which is precisely
-- the A57 rebuild-gap diagnosed in this same session: a fact enforced in code
-- but present only where someone typed it by hand. A grant that should hold on
-- every database built from this repo belongs in a migration. A grant that is
-- one shop's preference belongs in the Roles screen. Receipt-editing for
-- managers is the former: A45 came from a manager refused on a live till — the
-- intended default, not a per-shop toggle.
--
-- ── WHY THIS ROLE SET ───────────────────────────────────────────────────────
-- The SAME normalised set migrations 75 §3 and 76 use:
--     lower(replace(r.name,' ','_')) IN ('manager','supervisor','branch_manager','admin','owner')
-- Identical lists across migrations IS the A61 fix — a set that drifts between
-- migrations is how "Branch Manager" with a space silently missed its grants.
-- `receipt.manage` is low blast radius by construction: it edits receipt header
-- and footer text ONLY (branch address, phone, thank-you line — NOT business
-- identity, NOT a supervisor PIN, NOT an M-Pesa credential; that separation is
-- the allow-list in business.ts). Owner already passes via the '*' wildcard, so
-- the explicit row is redundant for owner and harmless — kept only so the list
-- matches 75 and 76 exactly.
--
-- If receipt-editing should be NARROWER (e.g. 'manager' only), reduce the IN
-- list below before running. If it should be a per-shop choice instead, do not
-- run this — grant in the Roles screen per business.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- NOT EXISTS guards the insert; re-running changes nothing. Safe on a database
-- where some roles already hold the key.
--
-- ── REVERT ──────────────────────────────────────────────────────────────────
--   DELETE FROM public.role_permissions rp USING public.permissions p
--   WHERE rp.permission_id = p.id AND p.key = 'receipt.manage';
--
-- ── BLAST RADIUS ────────────────────────────────────────────────────────────
-- The SELECT at the foot lists exactly which roles WOULD receive the grant. Run
-- it first if you want to see who is affected before committing.
--
-- Every table reference is public.-qualified: this migration must survive a
-- search_path that excludes public, which is what broke 76 in the field (A62).
-- =============================================================================

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   public.roles r
CROSS JOIN public.permissions p
WHERE  p.key = 'receipt.manage'
  -- Normalised name match: "Branch Manager" with a space matches the same five
  -- roles as branch_manager. Deliberately NOT ILIKE '%manager%', which would
  -- sweep in "Trainee Manager" and hand it receipt access as a migration side
  -- effect. Same list, same reasoning, as 75 §3 and 76 (A61).
  AND  lower(replace(r.name, ' ', '_'))
         IN ('manager', 'supervisor', 'branch_manager', 'admin', 'owner')
  AND  NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
       );

INSERT INTO public.schema_migrations (version, notes)
VALUES ('78_receipt_manage_grant',
        'A45. Migration 75 registered receipt.manage but granted it to no role; a 2026-08-12 query found zero holders across all businesses, so the narrow allow-list added to POST /business/settings on 2026-08-11 was unreachable and a manager still needed settings.manage to edit a receipt. Grants receipt.manage to the manager-level role set using the SAME normalised name match as 75 section 3 and 76 (A61). receipt.manage edits receipt header/footer text only — never business identity, a PIN, or an M-Pesa credential. Idempotent via NOT EXISTS.')
ON CONFLICT (version) DO NOTHING;

-- ── Who this grants to. Safe to run on its own, before or after. ─────────────
-- SELECT b.name AS business, r.name AS role
-- FROM   public.roles r JOIN public.businesses b ON b.id = r.business_id
-- WHERE  lower(replace(r.name,' ','_')) IN ('manager','supervisor','branch_manager','admin','owner')
-- ORDER  BY b.name, r.name;
