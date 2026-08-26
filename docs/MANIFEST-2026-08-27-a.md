# MANIFEST 2026-08-27-a — A167: offline sign-in NOT NULL fix

**Base commit:** `6d50d2d` (dev). Patch verified `git apply --check` clean at that base.
**Artifact:** `swiftpos-2026-08-27-a.patch` (no zip — patch only, and `ipcHandlers.ts` has moved in the tree, so a whole-file overwrite would be wrong; rules 4, 18).

## What this fixes

Offline PIN sign-in threw `SqliteError: NOT NULL constraint failed:
staff_session.token` and locked the till out during a cloud outage — the exact
scenario the offline-auth chain (A17 / A152 / A160) exists to survive. Root cause:
`staff_session.token` is `TEXT NOT NULL` (`localDb.ts`) but `signInLocal`
(`ipcHandlers.ts`) wrote `token=NULL`. Full write-up in AUDIT-REGISTER.md § A167.

## Files

| File | Change |
|------|--------|
| `apps/desktop/src/main/ipcHandlers.ts` | `signInLocal`: write `token=''` (was `NULL`) in the INSERT `VALUES` and the `ON CONFLICT DO UPDATE`. `refresh_token` stays NULL (nullable). Added a comment explaining why `''` is the expected value, not a sentinel. Behaviour change: the offline session row now inserts instead of throwing. |
| `tests/offline-signin-write.test.mjs` | NEW. Builds the real `staff_session` schema and runs the real `signInLocal` statement; asserts INSERT + ON CONFLICT re-sign-in succeed and token is stored as `''`. Mutation: `token=NULL` → red naming `staff_session.token` (rules 10, 23). Closes the seam that `offline-auth-fallback.test.mjs` (routing-only) left open (rules 8, 24). |
| `docs/AUDIT-REGISTER.md` | A167 entry added to § A; `Last updated` changelog line; `Open` A-P0 count `2 → 3`; `Counts` A-P0 gains `A167`. `check-register-consistency` re-run green (rule 14). |
| `docs/MANIFEST-2026-08-27-a.md` | This file. |

## Verification run (rule 7)

- Reproduced the throw against the real schema (token=NULL) → `NOT NULL constraint failed: staff_session.token`.
- Applied the fix; `node tests/offline-signin-write.test.mjs` → **5 passed, 0 failed** (incl. the NULL mutation going red).
- `apps/desktop` `npx tsc --noEmit` → exit 0, no type errors.
- `node scripts/check-register-consistency.mjs` → OK, header agrees with body (131 entries).
- Bench engine: `node:sqlite`, Linux/Node 22 — **not** the target's better-sqlite3 under Electron 35 / Node 20 (rule 9).

## NOT verified here (rule 16 — target-only)

- The full Electron IPC path (`posApi.auth.verifyPin` → handler → SQLite write) on a real Windows till.
- An actual offline sign-in with the cloud down, and the **lock-curtain unlock** on the same till (Image 1's path). These are what close A167 from OPEN → CLOSED.

## Rule 15 note

This is a desktop change, so the till build must bump the desktop version and **tag after the build** — that bump is NOT in this patch (rule 22: the delivery carries the change, never the version). Batch it with any other desktop fix in the same build.

## Rollback

```
git apply -R swiftpos-2026-08-27-a.patch
```

Or, if committed: `git revert <commit>`. The code change is one file, one statement; the register and manifest edits are additive.
