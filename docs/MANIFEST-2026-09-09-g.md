# MANIFEST 2026-09-09-g — browser verification pass: 12 CLOSED + 3 fixes

**Base:** `origin/dev` @ `161634e`. **Dashboard + register.** No migration, no server change.
Records the results of a Claude-in-Chrome agent verification pass (owner + manager logins) and
the three real bugs it surfaced, now fixed.

## Two things in one delivery (folded per the owner's request)
1. **Close the 12 items the agent verified on screen.**
2. **Fix the 3 real issues the agent found** (they were FAIL/observed, so they stay FIX BUILT —
   bench-verified but needing a visual confirm — not CLOSED).

## 1. Closed (verified on screen, no code change) — 12
Manager portal: **A212** (Printers tab visible to managers), **A238** (Printer Setup loads a
branch, not stuck), **A207** (Shift oversight + force-close), **A208** (read-only Menu tab).
Reports/receiving: **A216** (no Apply button), **A263** (one active preset, Today default),
**A261** (Reprint receipt action), **A224** (received qty + note shown), **A229** (GRN note
field), **A230** (real date, not "Invalid Date"), **A217** (manager Shifts shows the real
cashier). POS: **A188** (tables render as a grid with no saved layout).
Counts: **A-P2 29→22, A-P3 17→12.**

## 2. Fixes for what the agent found — 3 (stay FIX BUILT, need a visual confirm)
| ID | What the agent saw | Fix |
|---|---|---|
| A258 | Owner Overview still STACKED Top sellers + Payment methods (the fix had only reached the manager Overview) | Swapped the owner `OverviewPage` grid: row 1 = Payment methods + Top sellers, row 2 = 7-day trend + Low stock. Extended the guard to the owner path (the old guard only checked the manager view — why it slipped). |
| A257 | Empty category/product submit was a silent no-op — no message at all | Empty name now sets "Name is required" and the Save button is enabled so the click surfaces it — both CategoriesPage and ProductsPage. |
| A259 | Owner Reports → Staff Performance cashier column BLANK ("worse than Unknown") | Owner `ReportsPage` read stale `s.name`/`s.cashier_id`; the A259d server fix emits `staff_name`/`staff_id`. Corrected the type + row, dropped the phantom Branch column (server sends none). |

## Could not verify (needs the till, not a browser)
**A262** — the shift report button only *prints* ("Print server not connected on this device").
Verify it in the till print session; leave FIX BUILT for now.

## Files
| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/pages/OverviewPage.tsx` | owner Overview grid swap (Payment methods beside Top sellers) | A258 |
| `apps/dashboard/src/pages/ReportsPage.tsx` | owner Staff Performance reads staff_name/staff_id/avg_order_value; Branch column dropped | A259 |
| `apps/dashboard/src/pages/products/CategoriesPage.tsx` | empty-name message + enabled Save | A257 |
| `apps/dashboard/src/pages/products/ProductsPage.tsx` | empty-name message + enabled Save | A257 |
| `tests/ui-reports-fixes.test.mjs` | +3 guards (owner Overview pairing, owner staff field-name, empty-submit) — 8→11 | A257/A258/A259 |
| `docs/AUDIT-REGISTER.md` | 12 CLOSED + counts; A258/A257/A259 fix notes; changelog | — |
| `docs/MANIFEST-2026-09-09-g.md` | this record | — |

## What ran (rule 7)
```
dashboard tsc --noEmit         0 errors ; ratchet green
tests/ui-reports-fixes.test.mjs  11/11 ; the 3 new guards mutation-checked (revert fix → red; restore → green)
offline suites  tests/*.test.mjs  96/96
gates  register-consistency / doc-refs / root-clean / test-registration  OK
```

## NOT verified here (rule 16)
- The VISUAL result of the 3 fixes (owner Overview layout, the empty-submit message, the owner
  Staff Performance names). Bench type-check + source guards pass; confirm on screen after deploy.
- A262 (shift report) — needs the till print server.

## Known cosmetic drift (not fixed here, flagged)
The register's `Counts:` ID list undercounts the `Open` summary (e.g. the A-P2 list has fewer IDs
than the summary's 22). The consistency gate checks the SUMMARY against the body (both agree), not
the ID list, so this is cosmetic. A259 was re-added to the list; a full reconcile is a separate
hygiene task.

## Apply
```
git pull origin dev
# extract this zip over the repo root, then:
cd apps/dashboard && npx tsc --noEmit   # 0 errors
cd ../.. && node tests/ui-reports-fixes.test.mjs   # 11/11
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git add apps/dashboard/src/pages/OverviewPage.tsx apps/dashboard/src/pages/ReportsPage.tsx apps/dashboard/src/pages/products/CategoriesPage.tsx apps/dashboard/src/pages/products/ProductsPage.tsx tests/ui-reports-fixes.test.mjs docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-09-g.md
git commit -m "Browser verification: close 12 items + fix owner Overview/staff-report/empty-submit (A258/A257/A259)"
git push origin dev
# then confirm the 3 fixes on screen, and A262's shift report on the till.
```
Rollback: revert this commit — dashboard + register only.
