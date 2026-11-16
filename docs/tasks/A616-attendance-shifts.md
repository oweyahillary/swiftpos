# A616 — Attendance: work days, shifts and late arrivals

**Owner, 2026-10-31.** The request: "On the attendance section add shifts section", with the rule *"Any timestamp between
00:00 and 05:59 belongs to the previous calendar day's shift"*. The owner shared a real ZKTeco export (`data_bbs.xls`:
16 people, 693 punches, March 2026) and a summary made from it.

**Owner's choices:**
- Shifts are set **per branch**, and can be copied from another branch.
- Each day, a person's shift is **the one starting nearest their first punch**, or **one pinned to them**.
- The report shows **late arrivals** only. Early leaving, overtime and importing a device file were offered but not chosen.

## 1. What the real file showed

| | Before (pairing across days) | A616 (work days) | Claude's summary |
|---|---|---|---|
| Team hours | 1,907 | **1,890** | 1,907 |
| Kowsar | **96.9 h** (wrong) | 83.1 h | 83.1 h |
| Long pairs flagged | 8, chained across days | 5, genuine | — |

The old pairing ran across days, so **one forgotten punch-out moved every later day**. For example, 18:31 with no
punch-out was paired with the next morning's 08:21. Umi's 20th to 22nd went wrong one after another, and the estimated
pay (hours × rate) was too high.

## 2. The rule now (`apps/server/src/lib/attendanceRules.ts`)

1. **Group, then pair.** A person's punches are grouped into work days, then paired within each day alone: in, out, in, …
   An odd last punch is a missing punch-out, flagged and not counted. A double tap within 2 minutes is ignored.
2. **When a work day starts:**
   - **Pinned:** 6 h before the pinned shift, for example 09:00 → 03:00, and Night 18:00 → noon.
   - **Not pinned:** the best fit among three options: 06:00 (the owner's rule), noon, and 6 h before each of the branch's
     shifts. The best fit has the fewest missing punch-outs and long pairs, and first punches nearest a shift start.
   - So a night guard, 18:00 → 06:10, pairs correctly without being pinned, **as long as the branch has a Night shift**.
     With no shifts at all, a night guard's punches are ambiguous: 06:10 → 18:00 looks the same as 18:00 → 06:10.
   - The sales day cut-off plays no part.
3. **The day's shift:** the pinned one, else the one starting nearest the first punch (on the 24-hour clock).
4. **Late:** the first punch is more than the shift's grace after its start. Grace is 10 min by default and can be 0–120.
   Minutes late are counted from the start.
5. **Long:** a pair over 12 h, or over the shift's length + 2 h when that is longer. A 12 h night guard is not "long".

## 3. Data (migration 184, `migrations/184_attendance_shifts.sql`)

- **`attendance_shifts`:**
  - columns: branch, name, `start_min` / `end_min` (minutes after midnight; an end at or before the start runs past
    midnight), `grace_min`, `active`;
  - an ended shift is kept, so old reports keep its name;
  - one active name per branch;
  - service role only.
- **`attendance_people.shift_id`:** the pinned shift. When a shift is deleted, its people are unpinned (SET NULL).

**Run order:** migration 184 can run any time; nothing reads it until the server is deployed. If the server is deployed
first, the report works exactly as with no shifts. The shifts read falls back to none and never fails the report.

## 4. The web (`routes/attendance.ts`, `pages/attendance/AttendancePage.tsx`)

- **API:**
  - `GET /shifts`, `POST /shifts`, `PATCH /shifts/:id`;
  - `DELETE /shifts/:id` ends the shift and clears its pins;
  - `POST /shifts/copy` copies the names the branch hasn't got;
  - `PUT /people/:id/shift` pins a shift, or `null` for the nearest each day.
- **Rights:** attendance.edit for shifts and pins. A manager works on their own branch only.
- **Page:**
  - a **Shifts** section;
  - a **Shift** column in People, "Nearest each day" or a shift;
  - a **Late arrivals** card;
  - a bar under a late day in the grid;
  - each day's shift and "25 min late" in a person's days;
  - Late columns in the Excel download.
  - All of this appears only once the branch has shifts.
- **Fixed with it:**
  - "All branches" now means all. It used to read only the sidebar's branch.
  - "This month" no longer stretches the page: the grid scrolls inside its card.

## 5. Dev demo

`scripts/dev-seed/attendance-demo.sql` now adds Day (demo) 07:30–16:30, Delivery (demo) 10:00–19:00 and
Night (demo) 18:00–06:00. The delivery person is pinned; the night guard is not. The cleanup removes the "(demo)" shifts.
