# MANIFEST 2026-09-13-g — CI fix round 3 (migration policy idempotency)

**Base:** the `-f` commit. **No `version` field touched.** No behaviour change.
One migration file.

## Why
`test-migration-102` runs the migration SQL **twice** to prove it's idempotent. The
RLS `CREATE POLICY owner_all …` added in `-f` has no `IF NOT EXISTS` (Postgres doesn't
support it for policies), so the second run failed:
`error: policy "owner_all" for table "day_close_instructions" already exists`.
That failed the "Migrations against real Postgres" step in the Server-suites job.

## Fix
Add `DROP POLICY IF EXISTS owner_all ON public.day_close_instructions;` immediately
before the `CREATE POLICY` — the same idempotency guard `86_payment_methods.sql` uses.

## Files
| File | Change | Why |
|---|---|---|
| `migrations/102_day_close_instructions.sql` | `DROP POLICY IF EXISTS` before `CREATE POLICY owner_all` | Makes re-running the migration a no-op (matches migration 86) |
| `docs/AUDIT-REGISTER.md` | Changelog `-g` note | Rule 14 |
| `docs/MANIFEST-2026-09-13-g.md` | NEW — this file | Rule 2 |

## Verification — RUN this round, not inferred (rule 7)
Installed `@electric-sql/pglite` on the bench and executed the real migrations:
- `node scripts/run-migration-tests.mjs` → **All 26 migration test files passed**
  (`test-migration-102` 6/6, including "re-running is a no-op (idempotent)").
- `node scripts/check-rls-coverage.mjs` → OK (102/102).
- `python3 scripts/schema-audit.py --strict` → total 0.
- `node scripts/check-schema-drift.mjs` → OK.
- Register/doc gates green.

`tsc`, Build and the desktop suites are untouched by this change (migration SQL only),
so the jobs that already went green after `-e`/`-f` stay green.

## Rollback
```
git checkout <-f commit> -- migrations/102_day_close_instructions.sql docs/AUDIT-REGISTER.md
git rm docs/MANIFEST-2026-09-13-g.md
```
