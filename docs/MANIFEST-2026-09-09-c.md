# MANIFEST 2026-09-09-c — A271 CI follow-up: fix the print-resilience stale guard

**Base:** `origin/dev` after the A271 commit. **One test file + docs.** No app code, no
behaviour change. This is the fix for the desktop "Print resilience" CI job going red after A271.

## Why it went red
A271 renamed every desktop `ipcMain.handle('<channel>'` to a validating `handle('<channel>'`
wrapper. I updated the two gates I knew searched for the old string (`check-ipc-parity`), but
missed `scripts/test-print-resilience.mjs`. Its `body(channel)` helper found a handler by
`IH.indexOf("ipcMain.handle('<channel>'")` and sliced to the next `ipcMain.handle(`. After the
rename that returns -1, so the slice was garbage and the assertion
**"station writes refresh ONLY the two station tables"** failed.

This was a **stale guard, not a behaviour regression**: all four station writes
(`manage:createStation/updateStation/deleteStation/setStationCategories`) still call
`refreshStationsLocal()` and none calls `refreshCatalogue()` — the code the guard checks is
correct; the guard just couldn't find it.

## The fix
`scripts/test-print-resilience.mjs` — `body()` now locates a handler by either
`handle('<channel>'` (the wrapper) or a raw `ipcMain.handle('<channel>'`, and finds the next
handler boundary the same way. Identical approach to the `check-ipc-parity` fix in A271.

## Files
| File | Change | ID |
|---|---|---|
| `scripts/test-print-resilience.mjs` | `body()` matches the validating `handle(` wrapper as well as `ipcMain.handle(` | A271 |
| `docs/AUDIT-REGISTER.md` | A271 CI-follow-up note + changelog | — |
| `docs/MANIFEST-2026-09-09-c.md` | this record | — |

## What ran (rule 7)
```
node scripts/test-print-resilience.mjs      55 passed, 0 failed  (was 54/1)
mutation check                              inject refreshCatalogue() into a station write → RED; restore → 55/55
swept the other 8 desktop-job scripts       none string-searches handle(; test-print-resilience was the only casualty
offline suites  for f in tests/*.test.mjs   96/96
gates  parity / ipc-validation / register-consistency / doc-refs / root-clean / test-registration   all OK
```

## Apply
```
git pull origin dev
# extract this zip over the repo root, then:
node scripts/test-print-resilience.mjs      # 55/55
git add scripts/test-print-resilience.mjs docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-09-c.md
git commit -m "A271 CI follow-up: fix print-resilience stale guard after the handle() rename"
git push origin dev
```
Rollback: revert this commit — it only changes a test helper.
