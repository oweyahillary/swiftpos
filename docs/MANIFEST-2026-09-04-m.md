# MANIFEST 2026-09-04-m — A207: manager Shifts tab (web shift oversight); Close Day = desktop-only

**Base:** stacks on the A133/A205/A206 manager work. **Scope:** dashboard only.

## Built — Shifts tab
Comparing the desktop manager to the web portal, the web lacked shift oversight. New **Shifts** tab
(`ManagerShiftTab`, Finance group) lists open shifts at the manager's branch (cashier · till · age ·
float · expected cash) via `GET /api/shifts?status=open`, and lets a manager **force-close a stranded
drawer** (reason required, recorded uncounted, `POST /api/shifts/:id/force-close`, gated on
`shifts.force_close`). Normal cash-counted close stays on the till's End Shift — the manager's only
mutation is force-close.

## NOT built — Close Day (recorded decision)
The trading day (`business_days`) is a desktop/offline construct: the till manages + gates it and
syncs it up (`sync.ts`); the web has no trading-day gate and manages no `business_days`. The web's
end-of-day unit is the shift (now covered). A parallel web business-day system would duplicate the
till — deliberately skipped. **Close Branch** likewise stays desktop-only.

| File | Change |
|---|---|
| `apps/dashboard/src/pages/manager/ManagerShiftTab.tsx` | new — open shifts + force-close (reason). |
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | Shifts nav item (Finance) + `case 'shift'` + import. |
| `tests/manager-shift-tab.test.mjs` | 4 mutation-checked checks. |
| `docs/AUDIT-REGISTER.md` | A207 FIX BUILT; Close Day decision recorded. Counts A-P2 15→16. |

## Verification (rule 7)
dashboard tsc 0 · vite build 0 · `tests/manager-shift-tab.test.mjs` 4/4 mutation-checked ·
check-api-routes 289 · register/doc/test gates green. **Could NOT verify:** the browser (manager PIN):
Shifts tab lists open drawers; force-close (reason) releases one.

## Rollback
```
git checkout <base> -- apps/dashboard/src/pages/manager/ManagerDashboard.tsx docs/AUDIT-REGISTER.md
rm apps/dashboard/src/pages/manager/ManagerShiftTab.tsx tests/manager-shift-tab.test.mjs docs/MANIFEST-2026-09-04-m.md
```
