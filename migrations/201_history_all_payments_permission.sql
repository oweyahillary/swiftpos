-- 201_history_all_payments_permission.sql — A627: "See all payments in History" (sales.history_all_payments), and retire
-- the A387 "What cashiers see in History" payment-methods picker in favour of a right.
--
-- Owner, 2026-11-26: which payment methods a cashier sees in History was a business/branch multi-select
-- ('cashier_history_methods': [] = every method; a subset = only those). It is a RIGHT now — with it, History shows every
-- method; without it, only cash. The enforcement reads the right only; the picker + its plumbing stay dead.
-- packages/core/src/permissions.ts — the words below follow it.
--
-- Registered (idempotent). Granted ONCE (schema_migrations-guarded, so a role an owner later un-ticks stays un-ticked):
--   1. the owner roles (owner / admin).
--   2. the BUILT-IN Manager, General Manager, Supervisor, Operations Manager and Auditor (is_default).
--   3. PRESERVE: EVERY role of any business whose cashiers saw MORE than cash — no cashier_history_methods setting (default
--      = every method), an empty [] setting, or any business-/branch-level setting mentioning a method other than cash — so
--      nobody who saw more than cash loses it. A business restricted to cash-only everywhere keeps cash-only (grant nobody).
-- Nothing is taken away. The owner now un-ticks per role/person to restrict a cashier to cash.

-- NOTE: the VALUES tuple is on ONE line and the description carries no apostrophe, identical to the catalogue's — so
-- test-migration-134's `registeredLater` regex detects this key as later-registered and excludes it from 134/142/159.
INSERT INTO public.permissions (key, label, module, description) VALUES
  ('sales.history_all_payments', 'See all payments in History', 'selling', 'In History, see sales paid by every method. Without this, a cashier sees only cash sales (a split sale shows only its cash part).')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, description = EXCLUDED.description;

DO $a627c$
DECLARE
  v_owner integer := 0;
  v_senior integer := 0;
  v_preserve integer := 0;
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '201_history_all_payments_permission') THEN
  -- 1. the owner roles
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'sales.history_all_payments'
     WHERE lower(trim(r.name)) IN ('owner', 'admin')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_owner FROM added;
  -- 2. the BUILT-IN senior roles
  WITH added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'sales.history_all_payments'
     WHERE r.is_default = true
       AND regexp_replace(lower(trim(r.name)), '[[:space:]_]+', ' ', 'g')
             IN ('manager', 'general manager', 'supervisor', 'operations manager', 'auditor')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_senior FROM added;
  -- 3. PRESERVE: every role of a business whose cashiers saw more than cash.
  WITH mh AS (   -- value is jsonb in one table, text in the other, so normalise to text
    SELECT business_id, value::text AS value FROM public.business_settings WHERE key = 'cashier_history_methods'
    UNION ALL
    SELECT business_id, value::text AS value FROM public.branch_settings   WHERE key = 'cashier_history_methods'
  ),
  more_than_cash AS (
    SELECT b.id AS business_id FROM public.businesses b
     WHERE NOT EXISTS (SELECT 1 FROM mh WHERE mh.business_id = b.id)          -- no setting → default every method
        OR EXISTS (
             SELECT 1 FROM mh
              WHERE mh.business_id = b.id AND mh.value ~ '^\s*\['              -- a JSON array value
                AND ( mh.value::jsonb = '[]'::jsonb                           -- empty [] → every method
                      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(mh.value::jsonb) m
                                  WHERE lower(btrim(m)) <> 'cash') ))         -- mentions a non-cash method
  ),
  added AS (
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.key = 'sales.history_all_payments'
     WHERE r.business_id IN (SELECT business_id FROM more_than_cash)
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id
  ) SELECT count(*) INTO v_preserve FROM added;
  RAISE NOTICE 'A627: sales.history_all_payments to % owner + % senior; preserve % role(s) of more-than-cash businesses', v_owner, v_senior, v_preserve;
END IF;
END $a627c$;

INSERT INTO public.schema_migrations (version, notes)
VALUES ('201_history_all_payments_permission', 'A627: sales.history_all_payments registered + granted to owner/senior roles; preserve-grant to every role of a business whose cashiers saw more than cash (cashier_history_methods empty/unset or mentioning a non-cash method)')
ON CONFLICT (version) DO NOTHING;
