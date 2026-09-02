-- ============================================================================
-- SwiftPOS — future-proofing the device-naming / order-number collision (A181)
-- Apply BOTH of these on the cloud database, once. Idempotent and additive.
--
--   93  → bind a machine MAC so a reinstalled till gets its old name back (A182)
--   94  → make order numbers unique PER DEVICE, so a duplicated name can never
--         again lose a sale (A183) — this is the one that makes it impossible.
--
-- Safe to run together, in one transaction. If the sanity check at the end finds
-- pre-existing genuine duplicates it ROLLS BACK and changes nothing — send me the
-- rows if that happens.
-- ============================================================================

BEGIN;

-- ── 93: MAC binding (A182) — additive, cannot fail on existing data ──────────
ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS mac_address text;

COMMENT ON COLUMN public.user_devices.mac_address IS
  'Stable machine MAC reported by a desktop till (A182). Restores a reinstalled machine''s terminal code/name. A hint, never an auth credential.';

CREATE INDEX IF NOT EXISTS user_devices_business_mac_idx
  ON public.user_devices (business_id, mac_address)
  WHERE mac_address IS NOT NULL;

-- ── 94: per-device order-number uniqueness (A183) — the real mitigation ──────
-- Drop the branch-wide constraint; recreate it per-device. device_id is already
-- on every till order, so two tills' identical numbers coexist by device instead
-- of colliding. Web/legacy NULL-device orders keep branch-wide uniqueness via
-- COALESCE. Strictly MORE permissive, so existing rows cannot violate it.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_business_id_branch_id_order_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS orders_biz_branch_device_ordernum_uidx
  ON public.orders (business_id, branch_id, COALESCE(device_id, ''::text), order_number);

COMMENT ON INDEX public.orders_biz_branch_device_ordernum_uidx IS
  'A183: order_number unique per (business, branch, device). Two tills reusing T1--N no longer collide; a genuine re-push still dedupes by idempotency_key; NULL-device web/legacy orders keep branch-wide uniqueness.';

-- ── Sanity check ────────────────────────────────────────────────────────────
-- Must be 0. If it isn't, there are genuine duplicate numbers on the SAME device
-- that need reconciling first — ROLLBACK and investigate rather than COMMIT.
SELECT count(*) AS same_device_duplicates FROM (
  SELECT business_id, branch_id, COALESCE(device_id,'') AS dev, order_number
  FROM public.orders
  GROUP BY 1,2,3,4
  HAVING count(*) > 1
) d;

-- If same_device_duplicates = 0 above:
COMMIT;
-- else:  ROLLBACK;
