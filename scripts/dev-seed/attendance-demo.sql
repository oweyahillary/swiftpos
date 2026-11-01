-- attendance-demo.sql — DUMMY attendance data for ONE test business on the DEV database, to see the Attendance report
-- (owner, 2026-10-31: "generate dummy data on attendance, we test how the report will look and see how we can improve").
--
-- DEV ONLY. Never run on production. Edit ONE line below (the test business's exact name), then run the whole file.
-- Undo: scripts/dev-seed/attendance-demo-cleanup.sql (removes exactly what this adds — everything is tagged).
--
-- What it adds to that business:
--   * the 'attendance' feature flag on (the report is premium), and a demo device on its main branch (serial
--     'DEMO-SEED-K40') — if the branch already has a device, that one is used (a branch has one device, A614);
--   * A616: three shifts on that branch, Day (demo) 07:30-16:30, Delivery (demo) 10:00-19:00, Night (demo) 18:00-06:00,
--     with the delivery person pinned to theirs (only once migration 184 has run);
--   * 8 attendance-only people (no sign-in: cooks, cleaners, guards), numbers 9001-9008, and up to 3 of the business's
--     existing active staff linked as numbers 9101-9103;
--   * 5 weeks of device punches (today included), Nairobi time, with what real shops show: day and night shifts, late
--     arrivals, overtime, a weekly day off, a sick week, a forgotten clock-out (an odd punch), a double tap, and punches for
--     number 9999 that nobody is linked to ("Not matched").
-- Idempotent: running it twice adds nothing twice (the device punch index is unique).

DO $seed$
DECLARE
  biz_name  text := 'CHANGE ME — the test business name';   -- ← the ONE line to edit
  b         uuid;
  br        uuid;
  dev       uuid;
  dev_serial text;
  p         record;
  d         date;
  day_no    int;
  start_h   numeric;
  end_h     numeric;
  late_m    int;
  n_staff   int := 0;
  u         record;
BEGIN
  SELECT id INTO b FROM public.businesses WHERE name = biz_name;
  IF b IS NULL THEN RAISE EXCEPTION 'No business named "%" — edit biz_name at the top.', biz_name; END IF;
  SELECT id INTO br FROM public.branches WHERE business_id = b ORDER BY is_main DESC, created_at LIMIT 1;
  IF br IS NULL THEN RAISE EXCEPTION 'The business has no branch.'; END IF;

  -- the premium switch (dev): the report shows only with it on
  INSERT INTO public.feature_flags (business_id, key, enabled, notes, set_by, updated_at)
  VALUES (b, 'attendance', true, 'DEMO-SEED attendance-demo.sql', 'dev seed', now())
  ON CONFLICT (business_id, key) DO UPDATE SET enabled = true, updated_at = now();

  -- the branch's device (one per branch): the existing one, else the demo device
  SELECT d.id, COALESCE(d.serial, 'DEMO-SEED-K40') INTO dev, dev_serial FROM public.attendance_devices d
    WHERE d.business_id = b AND d.branch_id = br AND d.removed_at IS NULL LIMIT 1;
  IF dev IS NULL THEN
    INSERT INTO public.attendance_devices (business_id, branch_id, name, ip, port, serial, model, last_pull_at, users_on_device)
    VALUES (b, br, 'Demo front door', '192.168.1.201', 4370, 'DEMO-SEED-K40', 'K40 (demo)', now(), 11)
    RETURNING attendance_devices.id, attendance_devices.serial INTO dev, dev_serial;
  END IF;

  -- the people: 8 attendance-only (no sign-in), then up to 3 existing staff. Plain names, as a device holds them (owner,
  -- 2026-11-01: no role in brackets); a re-run renames the demo people an older seed added with a role.
  INSERT INTO public.attendance_people (business_id, branch_id, name, attendance_no, active)
  SELECT b, br, n, no, true FROM (VALUES
    ('Wanjiku Kamau', 9001),      -- cook
    ('Otieno Ouma', 9002),        -- cook, late most often
    ('Achieng Atieno', 9003),     -- cleaner
    ('Mwangi Njoroge', 9004),     -- guard, nights
    ('Kiprono Cheruiyot', 9005),  -- guard, days
    ('Fatuma Hassan', 9006),      -- dishwasher
    ('Mutua Musyoka', 9007),      -- delivery
    ('Nyambura Wairimu', 9008)    -- kitchen helper
  ) AS t(n, no)
  ON CONFLICT (business_id, attendance_no) DO UPDATE SET name = EXCLUDED.name;
  FOR u IN SELECT id, name FROM public.users WHERE business_id = b AND status = 'active'
             AND id NOT IN (SELECT user_id FROM public.attendance_people WHERE business_id = b AND user_id IS NOT NULL)
             ORDER BY created_at LIMIT 3 LOOP
    n_staff := n_staff + 1;
    INSERT INTO public.attendance_people (business_id, branch_id, user_id, name, attendance_no, active)
    VALUES (b, br, u.id, COALESCE(u.name, 'Staff'), 9100 + n_staff, true)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- A616 shifts (migration 184; skipped where it has not run): the demo's own pattern, "(demo)" in the name for the
  -- cleanup. Delivery pinned to its shift; the night guard NOT pinned — the report finds his nights by itself.
  IF to_regclass('public.attendance_shifts') IS NOT NULL THEN
    INSERT INTO public.attendance_shifts (business_id, branch_id, name, start_min, end_min, grace_min, active)
    SELECT b, br, n, s, e, 10, true FROM (VALUES ('Day (demo)', 450, 990), ('Delivery (demo)', 600, 1140), ('Night (demo)', 1080, 360)) AS t(n, s, e)
    ON CONFLICT (branch_id, lower(btrim(name))) WHERE active DO NOTHING;
    UPDATE public.attendance_people SET shift_id = (SELECT id FROM public.attendance_shifts WHERE branch_id = br AND name = 'Delivery (demo)' AND active)
    WHERE business_id = b AND attendance_no = 9007;
  END IF;

  -- the punches: 35 days back to today, per person, Nairobi times (UTC = EAT - 3 h)
  FOR p IN SELECT id, attendance_no FROM public.attendance_people
             WHERE business_id = b AND attendance_no BETWEEN 9001 AND 9199 LOOP
    FOR day_no IN 0..34 LOOP
      d := (now() AT TIME ZONE 'Africa/Nairobi')::date - day_no;
      -- a weekly day off (a different weekday each), and a sick week for the kitchen helper (days 15-20)
      CONTINUE WHEN extract(dow FROM d)::int = (p.attendance_no % 7);
      CONTINUE WHEN p.attendance_no = 9008 AND day_no BETWEEN 15 AND 20;
      -- the shift: the night guard 18:00-06:00 (next morning); delivery 10:00-19:00; everyone else 07:30-16:30
      IF p.attendance_no = 9004 THEN start_h := 18; end_h := 30;
      ELSIF p.attendance_no = 9007 THEN start_h := 10; end_h := 19;
      ELSE start_h := 7.5; end_h := 16.5; END IF;
      -- late now and then (0-40 min, more often for 9002), early or late leaving, overtime on Saturdays for the cooks
      late_m := CASE WHEN abs(hashtext(p.attendance_no::text || d::text)) % (CASE WHEN p.attendance_no = 9002 THEN 3 ELSE 6 END) = 0
                     THEN abs(hashtext(d::text || p.attendance_no::text)) % 41 ELSE abs(hashtext(p.id::text || d::text)) % 6 END;
      IF extract(dow FROM d)::int = 6 AND p.attendance_no IN (9001, 9002) THEN end_h := end_h + 2.5; END IF;
      -- in
      INSERT INTO public.clock_events (business_id, branch_id, person_id, source, event_type, recorded_at, device_id, device_serial, device_user_id, attendance_no)
      VALUES (b, br, p.id, 'device', 'punch', (d + make_interval(mins => (start_h * 60)::int + late_m)) AT TIME ZONE 'Africa/Nairobi',
              dev, dev_serial, p.attendance_no::text, p.attendance_no)
      ON CONFLICT DO NOTHING;
      -- a double tap (a second punch 1 minute later) on some mornings
      IF abs(hashtext('tap' || p.attendance_no::text || d::text)) % 9 = 0 THEN
        INSERT INTO public.clock_events (business_id, branch_id, person_id, source, event_type, recorded_at, device_id, device_serial, device_user_id, attendance_no)
        VALUES (b, br, p.id, 'device', 'punch', (d + make_interval(mins => (start_h * 60)::int + late_m + 1)) AT TIME ZONE 'Africa/Nairobi',
                dev, dev_serial, p.attendance_no::text, p.attendance_no)
        ON CONFLICT DO NOTHING;
      END IF;
      -- out — except a forgotten clock-out now and then, and today for a shift that has not ended yet
      CONTINUE WHEN abs(hashtext('out' || p.attendance_no::text || d::text)) % 17 = 0;
      CONTINUE WHEN (d + make_interval(mins => (end_h * 60)::int)) > (now() AT TIME ZONE 'Africa/Nairobi');
      INSERT INTO public.clock_events (business_id, branch_id, person_id, source, event_type, recorded_at, device_id, device_serial, device_user_id, attendance_no)
      VALUES (b, br, p.id, 'device', 'punch',
              (d + make_interval(mins => (end_h * 60)::int + (abs(hashtext('o' || p.id::text || d::text)) % 25) - 10)) AT TIME ZONE 'Africa/Nairobi',
              dev, dev_serial, p.attendance_no::text, p.attendance_no)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  -- number 9999: punches from someone nobody has linked yet ("Not matched")
  FOR day_no IN 0..4 LOOP
    d := (now() AT TIME ZONE 'Africa/Nairobi')::date - day_no;
    INSERT INTO public.clock_events (business_id, branch_id, person_id, source, event_type, recorded_at, device_id, device_serial, device_user_id, attendance_no)
    VALUES (b, br, NULL, 'device', 'punch', (d + time '08:05') AT TIME ZONE 'Africa/Nairobi', dev, dev_serial, '9999', 9999)
    ON CONFLICT DO NOTHING;
  END LOOP;

  RAISE NOTICE 'Attendance demo for % (branch %): % existing staff linked, punches for 35 days.', biz_name, br, n_staff;
END $seed$;
