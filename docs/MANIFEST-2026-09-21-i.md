# MANIFEST 2026-09-21-i — CI: harden the migration test runner (A305)

**Supersedes 2026-09-21-h** (Rule 3). Prevents the class of failure that stalled CI ~30 min.

**Base commit:** `72c4c1e` (`dev` tip — the test-104 hotfix).
**Scope:** the migration test runner + one CI step + the register. No product code, no migration.
**Working rules:** unchanged. **Register ID:** A305.

## Why

The test-104 hotfix (-h) fixed the specific hang, but the root exposure was the runner:
`run-migration-tests.mjs` ran the 27 tests **sequentially with no per-test timeout**, so any test
that never exits stalls the whole `Server suites` job invisibly. That is what turned a 4-second
bug into a 30-minute CI hang. This makes a hang fail fast and named, and speeds the phase up.

## What changed and why

| File | Change | ID |
|---|---|---|
| `scripts/run-migration-tests.mjs` | Rewritten: (1) **per-test hard timeout** (default 120s; `MIGRATION_TEST_TIMEOUT_MS`) — on timeout the child is SIGKILLed and reported a **named FAILURE**, never a silent pass; (2) **bounded parallel pool** (default `min(cpus,4)`; `MIGRATION_TEST_CONCURRENCY`) — PGlite is in-process/in-memory/isolated, so safe to parallelise; (3) **`--self-test`** proving the runner catches a passing, a failing, and a hanging test. Failure reporting + exit code preserved. | A305 |
| `.github/workflows/ci.yml` | Run `node scripts/run-migration-tests.mjs --self-test` before `test:migrations` in the `Migrations against real Postgres` step (mirrors the other gates' `--self-test` in CI). | A305 |
| `docs/AUDIT-REGISTER.md` | A305 entry + Open `19 P3`→`20 P3` + Counts `…A304 A305` + a `2026-09-21 (ci)` changelog line. | A305 |

## Verification (Rule 7 — what was run)

Bench, Linux (this sandbox reports **1 CPU**, so it ran 1-way — the parallel win is a multi-core
CI property, not measurable here; rule 9):
- **`node scripts/run-migration-tests.mjs --self-test` → 3/3 in ~2s**: a passing test → ok, a
  failing (exit 1) test → FAIL, a **hanging test → SIGKILLed and FAIL** (the safety net proven).
- **Real runner smoke** — starts, prints `27 file(s), 1-way, 120s/test timeout`, and processes
  tests in order including `test-migration-104` now **passing 8/8 in-line** (no hang) and the run
  continuing past it.
- Full static gate set green (register-consistency A305 → P3 20, doc-refs finds `-i`, root-clean,
  test-registration).

**Could NOT verify here (rule 9):** the wall-clock reduction from parallelism — needs a multi-core
runner. On CI (`min(cpus,4)`) the ~27 cold PGlite boots overlap instead of running end-to-end.

## Rollback (Rule 2)

```bash
git checkout 72c4c1e -- scripts/run-migration-tests.mjs .github/workflows/ci.yml docs/AUDIT-REGISTER.md
```

## Commit (direct to dev, explicit paths — never `git add -A`)

```bash
git checkout dev && git pull                    # confirm 72c4c1e; else re-apply the register edits
git add scripts/run-migration-tests.mjs .github/workflows/ci.yml \
        docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-i.md
git status --short                              # expect exactly these four
node scripts/run-migration-tests.mjs --self-test && node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git commit -m "ci(A305): harden migration runner — per-test timeout + parallel pool + self-test"
git push
```

Then watch CI: `Server suites` should drop well below its previous time, and a future hang will
fail fast and named instead of stalling the job.
