# MANIFEST 2026-09-21-h — HOTFIX: test-migration-104 hung CI (A303 test)

**Supersedes 2026-09-21-g** (Rule 3). Urgent — unblocks the stuck `Server suites` CI job.

**Base commit:** `a5f0136` (`dev` tip — the commit CI is stuck on).
**Scope:** one file, `scripts/test-migration-104.mjs`. No production code, no migration, no schema.
**Working rules:** unchanged. **Register ID:** A303 (a test fix to A303's deliverable).

## Why

CI's `Migrations against real Postgres` step ran 100/101/102 green, then **hung ~30 min on the
next file in sorted order — `test-migration-104.mjs` (mine, A303)**. The test's `ok()` helper
called its **async** assertion functions **without awaiting them**, so the final assertion's
in-flight `await db.exec(SQL)` (the idempotent re-run) was still running when `await db.close()`
fired — closing PGlite mid-operation deadlocked, so the process printed its last `ok` line but
never printed the summary and never reached `process.exit`. The 8 assertions did pass (the
register's "8/8" claim was true) — but the process never exited, which a strict-sequential runner
with no per-test timeout turns into a 30-minute stall.

My other new tests don't hit this: `branding-sync-pull` / `branding-feed-wiring` use `node:sqlite`
(synchronous, no `db.close()`) and exit cleanly.

## What changed and why

| File | Change | ID |
|---|---|---|
| `scripts/test-migration-104.mjs` | `const ok = (n, fn) =>` → `const ok = async (n, fn) => { … await fn(); … }`, and `await` on all 8 `ok(...)` calls, so each assertion completes before the next and before `db.close()`. No assertion text changed. | A303 |

## Verification (Rule 7)

- Before: `timeout 75 node scripts/test-migration-104.mjs` → **exit 124 (timed out)**, summary line
  never printed.
- After: same command → **8 passed, 0 failed, exit 0, ~4 s**.
- Diff is exactly `ok`→`async` + eight `await` prefixes (confirmed).

## Rollback (Rule 2)

```bash
git checkout a5f0136 -- scripts/test-migration-104.mjs
```

## Commit (direct to dev, explicit path — never `git add -A`)

```bash
git checkout dev && git pull
git add scripts/test-migration-104.mjs
git status --short          # expect exactly: M scripts/test-migration-104.mjs
timeout 60 node --no-warnings scripts/test-migration-104.mjs   # 8/8, exits ~4s
git commit -m "test(A303): await async assertions in test-migration-104 (fix CI hang)"
git push
```

**Also: cancel the stuck CI run** — it will not recover. Re-run after this pushes.

## Strongly recommended follow-up (separate change)

`scripts/run-migration-tests.mjs` runs the 27 tests **sequentially with no per-test timeout**, so
any wedged test stalls the whole job (this was a 30-minute lesson). Add a per-test timeout to the
`spawnSync` (e.g. `timeout: 120_000, killSignal: 'SIGKILL'`) so a future hang fails fast with the
file name, and parallelize the pool to cut the migration phase substantially. I can ship that next.
