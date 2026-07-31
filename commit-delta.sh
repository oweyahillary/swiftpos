#!/usr/bin/env bash
#
# commit-delta.sh — commit the work done SINCE d742fe5.
#
# The previous script assumed nothing was committed. It is not: d742fe5 already
# carries migrations 41/42, the schema-parity gate, the printing rewrite and the
# CI change. So its first `git add` staged nothing, `git commit` exited non-zero
# and `set -e` stopped the run. Nothing was lost and nothing was committed.
#
# This commits only the 29 files that are actually outstanding, in four slices.
#
# Each commit is guarded: if a slice stages nothing it is SKIPPED rather than
# aborting the run, so a file you happened to commit yourself cannot stop the rest.

set -u

test -d migrations || { echo "Run from the repo root."; exit 1; }

echo "==> Branch: $(git rev-parse --abbrev-ref HEAD)"
echo "==> Outstanding: $(git status --short | wc -l | tr -d ' ') files"
echo

# My working notes and the scripts themselves are not source. Left on disk,
# untracked, so the completeness check at the end must ignore them.
cat > /tmp/notsource <<'EOF'
DO_THIS.md
push-session.sh
commit-delta.sh
EOF

commit_if_staged () {
  if git diff --cached --quiet; then
    echo "--  skipped (nothing staged): $1"
  else
    git commit -q -m "$1" -m "$2"
    echo "==  committed: $1"
  fi
}

# ── 1. Desktop: lifecycle fixes, covers/APC, the open-drawer modal ───────────
git add -- apps/desktop/src/main/dayService.ts \
           apps/desktop/src/main/shiftService.ts \
           apps/desktop/src/main/localDb.ts \
           apps/desktop/src/main/syncEngine.ts \
           apps/desktop/src/main/preload.ts \
           apps/desktop/src/main/ipcHandlers.ts \
           apps/desktop/src/renderer/lib/posApi.ts \
           apps/desktop/src/renderer/pages/DayCloseTab.tsx \
           apps/desktop/src/renderer/pages/POSPage.tsx \
           apps/desktop/src/renderer/pages/ManagerPage.tsx \
           apps/desktop/src/renderer/components/OpenDrawerModal.tsx 2>/dev/null || true
commit_if_staged \
"fix(desktop): reachable Close Day, open-drawer prompt, covers/APC" \
"Close Day was gated on settings.manage, so a user whose ROLE is Manager but who
lacks that permission saw no tab at all — and since the day gate blocks the till
until the day is closed, that left the terminal with no way out. Now gated on
manager role, matching dayService.isManager(). The same gate is why Printers and
Receipt were also invisible to that user.

checkDayGate now distinguishes needsShift from needsManager. Previously only the
stale-day case was reported, so a cashier with no drawer open saw nothing at all,
rang up a full basket and met the refusal for the first time at payment. Splitting
it exposed a circularity — ensureDayOpen consulted the gate before opening the very
drawer that clears it, which would have refused every shift open — hence
checkStaleDay() for the manager-only obstruction.

The prompt is a blocking modal, not a banner: the stale-shift banner is advisory
because it fires mid-service with a customer waiting, whereas 'no drawer open'
happens at the start of a stint with Pay already disabled. Sign-out included,
because the modal cannot be dismissed and a trapped cashier invents a number.
Drawer field removed — the till identifies itself via device:identity.

DayCloseTab loaded four things with Promise.all, so one rejection skipped every
setState and the screen fell through to 'No trading day is open on this till' —
reporting absence when it meant failure. Now four independent calls with a visible
banner naming what could not be read.

getConflictedShifts joined a table that does not exist ('staff' — there is only
staff_session, one row for whoever is signed in; cashier names live in 'users').
SQLite threw 'no such table', which is what blanked the tab. Same fault in
openShift's already-open message path.

orders.covers added locally with a Pax input on dine-in. APC is dine-in net over
dine-in diners — dividing the whole day's takings by dine-in heads would inflate it
by every takeaway sale. Blank prints 'no covers recorded', never 0.00.

Expenses now reduce expected cash. expense:create writes no float_out, so a cashier
who paid 500 from the till and recorded it honestly counted 500 short and was
reported as 500 down — indistinguishable from pocketing it. The control punished
the honest one.

LOCAL_SCHEMA_VERSION 42 -> 43 and a schema_version table, so a till reports which
generation it carries and one-off backfills stop re-running every boot."

# ── 2. Reports ───────────────────────────────────────────────────────────────
git add -- apps/desktop/src/main/managerReports.ts \
           apps/desktop/src/main/reportExport.ts \
           apps/desktop/src/main/dailySalesReport.ts \
           apps/desktop/src/renderer/components/ReportRangeBar.tsx \
           apps/desktop/src/renderer/pages/PrintersTab.tsx \
           apps/desktop/package.json \
           apps/desktop/package-lock.json 2>/dev/null || true
commit_if_staged \
"feat(reports): date ranges, CSV export, Daily Sales Report xlsx" \
"Reports were hard-coded to todayRange() with no export path at all. Now
Today/Yesterday/7/30/month/custom, CSV, and an xlsx matching the incumbent report
staff already read, section for section.

Overrides architecture decision D9 (desktop = today only, view-only) at the owner's
request. The reason D9 existed has not gone away and is handled rather than
ignored: a till holds only ITS OWN orders — only the aggregation node holds the
branch's. Every range report therefore states its scope on screen and in the CSV
header, amber when the data is one till. A partial report is fine; a silently
partial one is not.

Ranges use the terminal's local time, midnight to midnight. UTC would cut the day
at 03:00 Nairobi and split an evening's takings across two dates.

The xlsx arithmetic was verified against a real incumbent export first: net + CTL +
VAT = gross, round-off and the collection total all already agreed with how
SwiftPOS computes a sale, so no model change was needed.

Two bugs found by generating a report and reading it back rather than trusting the
compile: a false 'Unreconciled difference' on EVERY report, because collections
legitimately differ from the exact gross by the round-off (it now compares against
the charged total, and a real shortfall is still caught); and float noise in cells,
because numFmt formats without rounding and the raw value survives into any sum
built on the sheet.

getRecentOrders ran one payments query per order — fine for 30 rows on screen, not
for a month's export. Now one query, grouped in memory.

exceljs added (pure JS, no native bindings). electron-builder compression: store,
because 7-Zip could not allocate memory at -mx=9 on a 302 MiB payload."

# ── 3. Server ────────────────────────────────────────────────────────────────
git add -- apps/server/src/routes/shifts.ts \
           apps/server/src/routes/sync.ts \
           apps/server/src/routes/auth.ts \
           apps/server/src/routes/devices.ts \
           apps/server/src/lib/desktopSchema.ts 2>/dev/null || true
commit_if_staged \
"fix(server): shift attribution syncs; expenses in expected cash; fleet endpoint" \
"Shift attribution never left the till. pushLocalRecords selected only the original
thirteen columns and the server mapped a fixed eight, so business_day_id,
business_date, device_id, terminal_code, drawer_label and opened_by — every column
migration 41 added to tell three drawers apart — stayed local. The cloud saw NULL
for every terminal-originated shift, the dashboard showed 'Till: unknown', and the
whole point of 41 was not reaching Postgres. Confirmed by real data: two shifts
pushed today had NULL device_id while an older one had it, because 41's one-off
backfill could infer it from that shift's orders.

Trusted from the client because they describe the TERMINAL, not money — which is
why status and the close figures are still refused while these are not.

Expenses subtracted from expected cash in /close and /force-close, identical to the
desktop's computeZReport. If the two differed, every reconciliation would become an
argument about which screen to believe.

computeExpectedCash extracted so the open-shift list can show a manager what they
are about to write off. It previously existed only inside /close — at the exact
moment it was too late to be useful.

GET /api/devices/fleet: per-terminal build, schema and last_sync_at, stale first.
last_seen_at is written at SIGN-IN, so a till that signed in at 07:00 and silently
stopped syncing at 07:05 looked healthy and the first symptom was the day's takings
arriving short hours later.

The till's device_id was already sent on every verify-pin and discarded. Now
stored: 'fingerprint' is a User-Agent hash, and three Electron tills on one build
produce near-identical UAs, so it is a poor key for telling terminals apart.

REQUIRED_DESKTOP_SCHEMA moved to lib/desktopSchema.ts — two routes need it, and
hardcoding it in the dashboard would let the fleet screen report every till current
while /api/sync/push warned them all they were behind."

# ── 4. Dashboard + migration 43 ──────────────────────────────────────────────
git add -- migrations/43_device_fleet_telemetry.sql \
           apps/dashboard/src/pages/FleetPage.tsx \
           apps/dashboard/src/pages/OpenShiftsPage.tsx \
           apps/dashboard/src/App.tsx \
           apps/dashboard/src/components/DashboardLayout.tsx 2>/dev/null || true
commit_if_staged \
"feat(dashboard): terminal fleet view and dead-terminal drawer release" \
"Open Drawers (Finance): releases a drawer stranded on a terminal that has died.
Migration 42 enforces one open shift per cashier, so a dead till locked that
cashier out of EVERY till — and forceCloseShift() runs on the machine holding the
shift, the dead one. The endpoint existed but nothing called it, so the only remedy
was editing the database by hand: a five-minute hardware fault became a day-long
outage.

Deliberately awkward. A reason is mandatory, expected cash is shown before
confirming, and the shift is recorded closed_unreconciled with NULL float and NULL
variance — a zero variance asserts somebody counted. Without that friction it would
get used instead of counting drawers and the variance data would become fiction.

No time-based auto-release. Closing drawers on a schedule would record
reconciliations nobody performed, which is the one thing this design refuses to do.

Terminals (Settings) + migration 43: schema_version, last_sync_at and device_id on
user_devices, all nullable and written best-effort — a till must never fail to push
a day's sales because a statistics column is missing."

# ── 5. Completeness ─────────────────────────────────────────────────────────
rm -f push-session.sh
LEFT=$(git status --short | grep -v -F -f /tmp/notsource || true)
echo
if [ -n "$LEFT" ]; then
  echo "!! Still uncommitted (excluding notes/scripts):"
  echo "$LEFT"
  echo
  echo "Commit these before pushing."
  exit 1
fi

echo "==> Clean. Review, then push:"
echo "      git log --oneline -4"
echo "      git push"
