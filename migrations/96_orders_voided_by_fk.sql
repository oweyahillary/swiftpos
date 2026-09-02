-- A187: orders.voided_by referenced auth.users(id), but refunded_by and authorized_by
-- reference public.users(id) — and the void handler writes req.userId (a public.users
-- id, which is why refund works and void did not). Every void 500'd on the auth.users
-- FK. Re-point voided_by to public.users(id), matching the other actor columns.
-- Idempotent + guarded; defensively nulls any stray voided_by (there should be none,
-- since voids never succeeded) so ADD CONSTRAINT can't fail on old data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE constraint_name = 'orders_voided_by_fkey' AND table_name = 'orders') THEN
    ALTER TABLE public.orders DROP CONSTRAINT orders_voided_by_fkey;
  END IF;

  UPDATE public.orders o SET voided_by = NULL
   WHERE voided_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = o.voided_by);

  ALTER TABLE public.orders
    ADD CONSTRAINT orders_voided_by_fkey
    FOREIGN KEY (voided_by) REFERENCES public.users(id) ON DELETE SET NULL;
END $$;
