# MANIFEST 2026-09-05-c — manager-portal reverify fixes (A214, A216, A217)

**Base:** `origin/dev` @ `75e5a62`.
**Delivery:** zip, extract over the repo root (mirrors structure). No renames/deletes. No version bumps.
All three found in the owner-run manager-PIN browser reverify on 2026-09-05.

## Files
| File | Change | Finding | Rollback |
|---|---|---|---|
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | branch-sync effect sets `branchSynced` from the session (no longer gated on the `branches` list containing the branch). | A214 | restore this file from `75e5a62` |
| `apps/dashboard/src/pages/manager/ManagerReportsPage.tsx` | `DateBar` debounce-auto-applies (presets + date edits, 400ms, skip mount, guard empty); Apply kept. `ShiftRow` reads `cashier_name` not `staff_name`. | A216, A217 | restore this file from `75e5a62` |
| `tests/manager-portal-2026-09-05.test.mjs` | NEW — source guards for all three (mutation-checked). | A214/216/217 | delete file |
| `docs/AUDIT-REGISTER.md` | A214 → FIX BUILT; A216, A217 entries added; header `\| Open \|` P2 19→20, P3 6→7; `\| Counts \|` +A217 (P2) +A216 (P3). | — | restore from `75e5a62` |
| `docs/MANIFEST-2026-09-05-c.md` | NEW — this manifest. | — | delete file |

## What ran + output (rule 7)
```
tests/manager-portal-2026-09-05.test.mjs   all green (4 passed)
  mutation A214 (restore coupled effect)   2 FAIL (A214 assertions)
  mutation A216 (remove debounce)          1 FAIL (A216)
  mutation A217 (revert to staff_name)     1 FAIL (A217)
  restored                                 4/4 green; files identical
apps/dashboard  npx tsc --noEmit           exit 0
check-register-consistency                 exit 0 ("header agrees with the body")
check-doc-refs                             exit 0
```
Environment: Linux, Node 22. Dashboard React only — no desktop/SQLite/Electron code.

## Notes / what could NOT be verified
- **Browser reverify** all three on the deployed dashboard after this ships (they are FIX BUILT).
- **A214 root follow-up (still OPEN in spirit):** this stops the hang, but the underlying reason the
  `branches` list omits the manager's branch (likely an owner-scoped branch-list fetch) is not fixed;
  `PrintersPage` reads `activeBranch` from context and may still lack a full branch object until that is
  addressed. Filed within the A214 entry.
- **A217** is a client field-name fix only; a DB query confirmed `shifts.cashier_id` resolves to the
  real cashier, so no server/attribution change was needed.

## Still outstanding from earlier batches (unchanged)
- Rotate the Supabase DB password + GitHub PAT pasted earlier.
- Confirm which DB migration 99 hit (run `env=unspecified` with a "Prod" string).
- Two stray files in `87a9fd1` (`docs/SIGNAGE-DESIGN.md`, `scripts/functions-index.json`).
- A205 full close: receive a transfer + GRN in the browser; then flip A133/A205 to CLOSED.
