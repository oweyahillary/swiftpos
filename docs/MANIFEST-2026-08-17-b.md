# MANIFEST 2026-08-17-b — A109 green-CI fix (offline suite fixture)

**Base:** apply on top of A108 (`122dd9f`). Register ID **A109**. Test-only +
register; no product code, no schema, no deps.

Fixes the one red job after A108: `Server suites → Run offline suites` failed
with `table device_config has no column named continuous_operation`
(`tests/kitchen-exclusions-local.test.mjs:121`). A108's Node 20→22 bump
activated a `node:sqlite` test that self-skips on Node 20, which then caught a
stale test fixture left by **A104** (the real `deviceConfig.ts` INSERT has had
`continuous_operation` since A104; the test's hand-rolled `CREATE TABLE` never
got it).

## Files (2)

| File | Change | Why |
|---|---|---|
| `tests/kitchen-exclusions-local.test.mjs` | add `continuous_operation INTEGER` to the fixture `CREATE TABLE device_config` | match the real `localDb.ts:941` schema the test drives the real INSERT against. |
| `docs/AUDIT-REGISTER.md` | A109 entry (above A108) | rule 14. |

## Verified (Node 22)

- `node tests/kitchen-exclusions-local.test.mjs` → 17/17 pass.
- Mutation-checked: removing the column reproduces the exact CI error.
- Sweep: only this test hand-rolls a `device_config` schema; sibling node:sqlite
  test `register-status-parse` passes 12/12; all other CI jobs were already
  green (kitchen-exclusions was the sole failure in the run).

## Rollback

`git checkout -- tests/kitchen-exclusions-local.test.mjs docs/AUDIT-REGISTER.md`
