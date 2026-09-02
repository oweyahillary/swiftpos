ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_business_id_branch_id_order_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS orders_biz_branch_device_ordernum_uidx
  ON public.orders (business_id, branch_id, COALESCE(device_id, ''::text), order_number);
