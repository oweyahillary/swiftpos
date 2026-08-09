-- Fix all existing orders with cashier_id = NULL
-- Assigns them to the correct users.id based on who owns each business.
-- 
-- From your DB: the owner users are:
--   Kizzy James  → 165bf123-b0ab-4130-afbc-0f98b635d4d5  (role: owner)
--   Kizzy test   → ff77d4bc-7203-4e77-adf3-38e673747369  (role: owner)
--   Eugene       → 9855dc46-76c6-40de-a51f-f02d411895de  (role: owner)
--   mazuri1      → 8596509c-157b-4fab-818e-160032765c8d  (role: cashier)
--
-- Step 1: Preview — see which orders will be updated and to which user
SELECT
  o.id,
  o.created_at,
  o.total,
  o.business_id,
  u.id   AS will_set_cashier_id,
  u.name AS will_set_name
FROM public.orders o
JOIN public.users u ON u.business_id = o.business_id
JOIN public.roles  r ON r.id = u.role_id
  AND lower(r.name) IN ('admin', 'owner')
WHERE o.cashier_id IS NULL
ORDER BY o.created_at DESC;

-- Step 2: Apply the fix (uncomment after verifying Step 1)
/*
UPDATE public.orders o
SET cashier_id = u.id
FROM public.users u
JOIN public.roles r ON r.id = u.role_id
  AND lower(r.name) IN ('admin', 'owner')
WHERE u.business_id = o.business_id
  AND o.cashier_id IS NULL;
*/

-- Step 3: Verify — should return 0
-- SELECT COUNT(*) FROM public.orders WHERE cashier_id IS NULL;
