-- 93_device_mac_binding.sql — A182.
--
-- A reset/reinstalled till gets a brand-new device_id, so the cloud sees a NEW
-- device and the operator re-names it by hand — often reusing "T1", whose order
-- numbers then collide with the old till's on the cloud (register A181). A MAC
-- address survives a reinstall, so we bind it here: on a fresh enrol the server
-- can find the machine's previous terminal_code/label by MAC and hand it back,
-- instead of a blank slate.
--
-- A HINT, not a credential. device_id stays the hard key; the MAC only proposes
-- "this is probably the same physical machine — reuse its old name".

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS mac_address text;

COMMENT ON COLUMN public.user_devices.mac_address IS
  'Stable machine MAC reported by a desktop till (A182). Used to restore a reinstalled machine''s terminal code/name. A hint, never an auth credential.';

-- Look-ups are "most recent device at this business with this MAC", so index the
-- pair. Partial: only rows that actually carry a MAC.
CREATE INDEX IF NOT EXISTS user_devices_business_mac_idx
  ON public.user_devices (business_id, mac_address)
  WHERE mac_address IS NOT NULL;
