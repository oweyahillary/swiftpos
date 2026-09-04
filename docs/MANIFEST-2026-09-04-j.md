# MANIFEST 2026-09-04-j — A133 Slice 2: manager dashboard nav parity

**Base commit:** current `dev`. **Scope:** one dashboard file + a test + register.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## What & why
Slice 1 grouped the OWNER sidebar into labelled sections. Slice 2 does the same for the MANAGER
dashboard — a flat 10-item PIN/permission tab switcher. `ManagerDashboard.tsx` now groups its
`NAV_ITEMS` and renders labelled sidebar sections (the same group→items pattern), honouring the
existing permission filter.

## Grouping (flagged for review)
The owner's 3-section Users/Devices/Business Settings taxonomy doesn't map 1:1 to the manager's fewer
items, so this is the *sensible* parity, not a mechanical copy:
- **top-level:** Overview · Inventory
- **FINANCE:** Orders · Reports · Turnover · Expenses
- **CUSTOMERS:** Customers · Credit
- **SETTINGS:** Staff · Printers (the only settings-like items)

Adjust any grouping by moving an item's `group` value — tell me and I'll re-cut it.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | `NavItem` gains `group`; `NAV_ITEMS` grouped + reordered; `GROUP_ORDER` added; sidebar renders GROUP_ORDER sections with uppercase headers, filtering `visibleNav` by group; a group with no permitted items renders nothing. No change to tab switch / renderContent / auth. |
| `tests/manager-nav-grouped.test.mjs` | 3 mutation-checked checks (group field + GROUP_ORDER; Settings grouping; grouped render honouring permissions). |
| `docs/AUDIT-REGISTER.md` | A133 Slice 2 note. No count change (stays OPEN pending browser). |

## Verification (rule 7)
- `apps/dashboard` `tsc --noEmit` **0 errors**; `vite build` **exit 0** (ManagerDashboard chunk emits).
- `tests/manager-nav-grouped.test.mjs` **3/3**, mutation-checked (drop the group header → red).
- `check-api-routes` (289), register/doc/test gates green.

**Could NOT verify here (rule 16):** the browser — sign in as a **manager (PIN)**, confirm the
sidebar shows the grouped sections with headers, each item still switches its tab, and a manager
missing a permission doesn't see that item/group. That closes A133 (Slice 1 already owner-verified).

## Rollback
```
git checkout <base> -- apps/dashboard/src/pages/manager/ManagerDashboard.tsx docs/AUDIT-REGISTER.md
rm tests/manager-nav-grouped.test.mjs docs/MANIFEST-2026-09-04-j.md
```
