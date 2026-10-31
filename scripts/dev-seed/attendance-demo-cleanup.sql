-- attendance-demo-cleanup.sql — removes EXACTLY what attendance-demo.sql added (DEV ONLY). Edit the same ONE line.
--   * the punches of numbers 9001-9199 and 9999 from the demo device, or with the demo serial;
--   * the people numbered 9001-9199;
--   * the demo device (serial 'DEMO-SEED-K40') — a device that was already there is kept;
--   * the 'attendance' flag only if the seed set it (its note says DEMO-SEED).

DO $clean$
DECLARE
  biz_name text := 'CHANGE ME — the test business name';   -- ← the same name as in the seed
  b        uuid;
BEGIN
  SELECT id INTO b FROM public.businesses WHERE name = biz_name;
  IF b IS NULL THEN RAISE EXCEPTION 'No business named "%".', biz_name; END IF;
  DELETE FROM public.clock_events WHERE business_id = b AND source = 'device'
    AND (attendance_no BETWEEN 9001 AND 9199 OR attendance_no = 9999);
  DELETE FROM public.attendance_device_actions WHERE business_id = b
    AND person_id IN (SELECT id FROM public.attendance_people WHERE business_id = b AND attendance_no BETWEEN 9001 AND 9199);
  DELETE FROM public.attendance_people WHERE business_id = b AND attendance_no BETWEEN 9001 AND 9199;
  DELETE FROM public.attendance_devices WHERE business_id = b AND serial = 'DEMO-SEED-K40';
  DELETE FROM public.feature_flags WHERE business_id = b AND key = 'attendance' AND notes = 'DEMO-SEED attendance-demo.sql';
  RAISE NOTICE 'Attendance demo removed from %.', biz_name;
END $clean$;
