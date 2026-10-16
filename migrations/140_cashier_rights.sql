-- 140_cashier_rights.sql — A511
--
-- Owner, 2026-10-16, after 139 gave cashiers back selling: "they still had the rights of seeing employees" — "have the
-- migration run to remove it if the owner wants they can remove it also" — and on customers.credit: "I think the manager
-- has to approve credit gate that behind a managers pin its not a cashiers right".
--
-- Once (guarded by its own schema_migrations row), from every role NAMED cashier (case and spaces aside):
--   * staff.view — the staff list (134 gave it to every role, as everyone had it before A490);
--   * customers.credit — credit limits, repayments, adjustments and now approving sales on account (A511): a cashier's
--     sale on account is approved with a manager's PIN instead. It is also what sent cashiers on 1.0.15 tills to the
--     manager screens (A499), so those tills open on the POS again before they update.
-- The owner can tick either back per role (Settings › Roles). Other roles and keys untouched. The key's description
-- follows the catalogue (shared/permissions.ts). People renew into it (the role_permissions trigger bumps
-- permissions_version).

DO $a511$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '140_cashier_rights') THEN
  DELETE FROM public.role_permissions rp
   USING public.roles r, public.permissions p
   WHERE rp.role_id = r.id AND rp.permission_id = p.id
     AND lower(trim(r.name)) = 'cashier'
     AND p.key IN ('staff.view', 'customers.credit');
END IF;
END $a511$;

UPDATE public.permissions
   SET description = 'Approve sales on account with their PIN, set credit limits, record repayments and adjust balances'
 WHERE key = 'customers.credit';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('140_cashier_rights', 'A511: cashier roles lose staff.view and customers.credit - credit sales are approved with a manager PIN.')
ON CONFLICT (version) DO NOTHING;
