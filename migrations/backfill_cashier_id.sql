-- Fix existing "Unknown" cashier names — orders where cashier_id holds the
-- Supabase auth UID instead of the internal users.id.
-- Run AFTER deploying the server fix (auth.ts).
-- Works purely within the public schema — no auth.users dependency.

-- ── Step 1: Preview (safe SELECT — run this first) ────────────────────────────
SELECT
  o.id            AS order_id,
  o.created_at,
  o.cashier_id    AS current_cashier_id,
  u.id            AS correct_users_id,
  u.name          AS owner_name,
  u.email         AS owner_email
FROM public.orders o
JOIN public.users u
  ON  u.business_id = o.business_id
  AND u.role_id IN (
    SELECT r.id FROM public.roles r
    WHERE r.business_id = o.business_id
      AND lower(r.name) IN ('admin', 'owner')
  )
WHERE
  o.cashier_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.users ux
    WHERE ux.id = o.cashier_id
      AND ux.business_id = o.business_id
  )
ORDER BY o.created_at DESC;

-- ── Step 2: Fix (run after confirming Step 1 looks correct) ──────────────────
UPDATE public.orders o
SET cashier_id = u.id
FROM public.users u
WHERE
  u.business_id = o.business_id
  AND u.role_id IN (
    SELECT r.id FROM public.roles r
    WHERE r.business_id = o.business_id
      AND lower(r.name) IN ('admin', 'owner')
  )
  AND o.cashier_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.users ux
    WHERE ux.id = o.cashier_id
      AND ux.business_id = o.business_id
  );

-- ── Step 3: Verify (should return 0 rows after step 2) ───────────────────────
SELECT COUNT(*) AS still_unknown
FROM public.orders o
WHERE o.cashier_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.users ux
    WHERE ux.id = o.cashier_id
      AND ux.business_id = o.business_id
  );
