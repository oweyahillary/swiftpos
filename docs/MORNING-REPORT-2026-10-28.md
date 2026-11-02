# Morning report: 28 Oct 2026 (overnight build)

Nothing has been committed, pushed, deployed or run against a database. Everything is on `dev` as uncommitted changes (89 paths).

## 1. What was built

### A596: branch server certificate fix (already committed, 7b58e17)
This fixes the failure on PR #91's desktop CI (`ERR_OSSL_ASN1_ILLEGAL_PADDING`). About 1 certificate in 200 had a serial number that OpenSSL refuses, so that branch server's secure connection could not start. The test now makes 2,000 certificates and loads each one.

### A598: fewer Supabase calls from the watchdog
- The watchdog drops from about 2,200 calls a day to about 1,000. Staff and branch names are kept for 30 minutes, the "last seen" write happens at most hourly, and governed facts are kept 30 minutes instead of 10.
- Test: `tests/supabase-calls-a598.test.mjs`, 8/8.
- Left as is:
  - foreign-orders: it touches the drawer arithmetic.
  - branch-drawers: needs your `BRANCH_DRAWERS_MEMO_S=300` on prod Render.
  - auth/refresh: goes with the own-auth move.

### A597: brand colours (premium, set by the owner)
- **Migration 179** adds `business_branding.primary_hex` and `secondary_hex`.
- **Colours:** any colour is accepted. Text colour and shades are worked out from it.
- **Where they apply:** the web portal (sidebar logo and colour band; this fixes "web portal never adopts shop branding"), the web POS and the desktop POS.
- **Order of priority:** branch theme, then brand colours, then the chosen theme, then the default.
- **Who can set them:** owner only. The setting sits under the existing `themes` premium flag, which is relabelled "App themes and brand colours" in admin. With the flag off everything looks as it does today.
- **Tests:** 30/30 server, 19/19 desktop, plus test-migration-179.

### A599: attendance (premium, ZKTeco)
**Cloud (migration 180)**
- Four new tables: devices, attendance-only people, the device user list, and pending device actions.
- `clock_events` gains `source` (pin, device or correction) and device fields. Device punches cannot be stored twice.
- **Attendance-only people** (cooks, guards and so on) are a separate table. They have no sign-in, no PIN and no seat, and can never appear in staff lists or pickers.
- **When the `attendance` flag is off** (admin only): every route returns 403 and the menu entry is hidden.
- **When it is on:** web POS PIN clock-in is refused and its Clock button is hidden.
- **Rights:** the owner and partners get view, edit and devices. The Manager and General Manager get view and edit. Cashiers get none.
- **Device user sync:** staff added, deactivated or moved are pushed to the device. Users found only on the device show as "New on the device" for you to link; they are never auto-created.

**Web report, Attendance page**
- **Choices:** one person or all staff; this week, last week, this month, last month or a custom range.
- **One person:** five coloured cards, weekly bars, a monthly heat-map calendar, and a day list with a Fix button. Fixes need a reason, and the original punch is kept.
- **All staff:** ranked bars, a staff-by-day heat grid, and team totals (pay shown only to the owner and holders of `staff.pay`).
- **Panels:** Not matched, New on the device, People and numbers, Devices.
- **Also:** Excel export, Print, and light and dark mode.

**Desktop (branch server)**
- **The job:** every 3 minutes it reads each device and sends it to the cloud:
  - the serial, model, firmware and clock drift;
  - the device's user list;
  - pending user writes and deletes, each acknowledged;
  - new punches, converted to UTC, in batches of 500 or fewer.
- **Safety:** the device log is never cleared. A device that is unplugged shows an error and does not hold anything else up.
- **Tech page:** a new "Attendance device" section, shown only on the branch server with the flag on. It has Test connection, a clock-drift warning with "Set device time", and Pull now. Devices are added on the web portal under Attendance → Devices.
- **Local schema:** not bumped (still 77), so the desktop update is ordinary.

**Tests**
- attendance 38/38
- test-migration-180 9/9
- zkteco 77/77
- desktop attendance job 77/77
- Mutation checks were run on each of these.

### Update, 28 Oct morning: tested on a real device
- **Read-only check of a K40** at 197.248.17.67 (firmware 6.60, no Comm Key). Everything read correctly: 138 users, 2 admins, 1,364 punches, all matched. The device clock is 95 s slow. Nothing was written.
- **Bug found and fixed: wrong person on a fingerprint.** A device bought before ZapTill already has its own people numbered from 1. Our sync could have written a staff name onto someone else's number, so their fingerprint became our staff member's punches. Now:
  - new numbers skip every number already on a device;
  - a number held by someone else is never overwritten or deleted. It shows as a **Number clash** on the Attendance page, and the fix there is to give the person the number they really have on the device;
  - punches from a slot that isn't ours stay "Not matched";
  - the branch server refuses such a write as a second check.
- Migration 180 gained one column, `attendance_device_actions.overwrite`. It has not been run anywhere yet.

## 2. Decisions I made overnight (please confirm or change)
1. Attendance numbers are unique per **business**, not per branch.
2. New staff get an attendance number automatically while Attendance is on.
3. Pairing rules:
   - punches alternate in / out;
   - a second punch within 2 minutes is ignored (double tap);
   - a punch with no pair within 16 hours is a "missing punch-out", flagged and not counted;
   - shifts over 12 hours are flagged "check";
   - a shift counts on the day of its first punch.
4. Report periods are capped at 93 days.
5. The desktop job is gated on the Attendance flag only, not also on the online licence. Say if you want both.
6. Partners get all three attendance rights.

## 3. Things to check on the K90 Pro (when you give access)
Please tell me:
- the device's network address and port (normally 4370);
- whether a Comm Key is set;
- the firmware version;
- whether ADMS (cloud push) is switched on.

Then we test:
- the connection and Comm Key;
- that the user and punch records read correctly;
- that writing a user's name **keeps their fingerprints**;
- that writing onto an admin number is refused;
- that drift and "Set device time" land on Kenya time;
- how long a full log read takes;
- how an unplugged device shows on the Tech page and on the web.

## 4. Local CI result
**Steps:** all 252 ci.yml steps were run locally across everything above. Two real failures were found and fixed:
- **A new raw green on the POS Tech panel.** It now uses the theme's action colour.
- **The new attendance routes missing from the A541 gateway table.** They are now classified as background. The test passes 52/52.

**What still fails is the known Windows noise:**
- the schema audit (no python3 on this PC);
- the libuv `async.c` crash after every case has passed. Each affected file was re-run on its own and passed with 0 failed:
  - server-join 37
  - server-setup-a503 30
  - a554 41
  - monthly-pack 19
  - petrol 17
- money-reports, the known timezone case.

**Checks:** the desktop typecheck is clean, and the register and shared-copy checks print OK.

## 5. Commit (one commit: files are shared between the three pieces, so separate commits would not build on their own)

Run in Git Bash:

```
cd /c/swiftpos/pos && git add -A .github/workflows/ci.yml apps/admin apps/dashboard apps/desktop apps/server docs scripts shared tests migrations/179_brand_colours.sql migrations/180_attendance.sql && git status --short
```

Check the list looks right (nothing unexpected), then:

```
git commit -m "Brand colours: owner picks any primary and secondary colour, applied on web portal, web POS and desktop POS, premium under the themes flag (A597, migration 179); Attendance: ZKTeco devices on the branch server, attendance-only staff, device user sync, colourful worked-hours report, PIN clock-in off when on, premium admin flag (A599, migration 180); watchdog Supabase calls roughly halved (A598)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then `git push`, and CI runs on dev.

## 6. Order for today
1. **PR #91 first.** It should now go green (the A596 fix). Merge it; that runs migrations 175–178 on prod. Tag **v1.0.22** the same day.
2. Commit tonight's work (above) and push to dev.
3. Run migrations **179 and 180 on dev only** for testing. They go to prod with the next release PR.
4. Turn on `themes` and `attendance` for a test business in admin, then:
   - set brand colours;
   - add the K90 Pro on the web (Attendance → Devices);
   - test from the branch server.
5. The attendance device part needs a desktop release, the next batch after 1.0.22.

## 7. Still on your list
- Set `BRANCH_DRAWERS_MEMO_S=300` on prod Render.
- Mary's cash-in fix.
- **Rotate the prod DB password.**
- Magas duplicate owners.
- 32-bit POS rollout.
- K90 Pro access details (section 3).

## 8. One slip to know about
The attendance agent deleted a pre-existing temp file `/tmp/h.txt` (662 bytes, dated 19 Oct), mistaking it for its own. It was outside the repo and cannot be restored.
