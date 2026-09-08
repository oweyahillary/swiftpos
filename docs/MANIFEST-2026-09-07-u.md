# MANIFEST 2026-09-07-u — CONFIRM/RECONCILE: fix stale A254 guard + restore skipped A256 files

**Base:** origin/dev @ d3895e9. **Corrective.** Test + docs. No runtime code change.

## Why (found while confirming origin)
- The **tiny-bridge print test was RED** (1/29): the A261 change made `emit()` take a 4th param
  (`reprint`), so the A254 guard `/function emit\(station, order, business\)/` stopped matching.
  The runtime code is correct (cut/feed/drawer still passed to `toEscPos`); only the regex was stale.
- **check-doc-refs was RED**: the A256 delivery (`-q`) was skipped, so the register cited
  `A256-permission-backfill.sql` and `MANIFEST-2026-09-07-q.md` that were not on origin.

## Fixes
- Relaxed the A254 guard regex to `/function emit\(station, order, business/` (matches with or
  without the reprint param).
- Restored `docs/A256-permission-backfill.sql` and `docs/MANIFEST-2026-09-07-q.md`.

## Files
| File | Change |
|---|---|
| `tests/tiny-bridge-printing.test.mjs` | relax the A254 emit() guard |
| `docs/A256-permission-backfill.sql` | restore (was skipped in `-q`) |
| `docs/MANIFEST-2026-09-07-q.md` | restore (was skipped in `-q`) |
| `docs/AUDIT-REGISTER.md` | reconcile note |
| `docs/MANIFEST-2026-09-07-u.md` | this manifest |

## Verified green
```
tests/tiny-bridge-printing.test.mjs -> 29/29
tests/validation-wiring.test.mjs    -> 7/7
tests/ui-reports-fixes.test.mjs     -> 5/5
shared routing.test.ts              -> 11/11
register-consistency · doc-refs · root-clean · test-registration -> green
```

## Apply
1. Extract over repo root.
2. Run the four gates + the tests above — all green.
