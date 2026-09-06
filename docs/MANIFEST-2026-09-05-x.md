# MANIFEST 2026-09-05-x — A238 manager Printer Setup fix (unblocks pairing)

**Base:** `origin/dev` @ `da73e6f`. **Delivery:** zip, extract over root. Dashboard-only, no migration, no server change.

## What this fixes
A manager's Settings → Printers was stuck on "Select a branch from the selector above" (there is no
selector in the manager portal), because `BranchContext` runs on the owner auth and is empty for a
PIN-authed manager. `PrintersPage` now takes an optional `branchId` prop; `ManagerDashboard` passes the
manager's session branch, so the page (and the A235 pairing card) render. Unblocks silent-print setup.

## Files
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/pages/settings/PrintersPage.tsx` | optional `branchId` prop, preferred over BranchContext | restore from `da73e6f` |
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | pass `session.branchId` to PrintersPage | restore from `da73e6f` |
| `tests/manager-printers-branch.test.mjs` | NEW — source guard (mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A238 entry; counts P2 21→22 | restore from `da73e6f` |
| `docs/MANIFEST-2026-09-05-x.md` | NEW — this manifest | delete file |

## What ran + output (rule 7)
```
tests/manager-printers-branch.test.mjs   3/3  (mutation: drop branchId prop → red)
apps/dashboard  npx tsc --noEmit         exit 0
register · doc-refs                       exit 0
```
NOTE: the owner-only `/api/printers` list may still be empty for a manager (the A214 auth root); the
device-local A235 pairing card (token + receipt printer) does not depend on it, so pairing works.

## Apply
1. Extract over root; run the test + gates. 2. `git add` the 4 files; commit; push. 3. Deploy dashboard.
