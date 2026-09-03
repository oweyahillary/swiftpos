# MANIFEST 2026-09-03-e — A184 Tier 3 **Phase 1**: migration 97 (retire/archive) + test

**Base commit:** `17d357a` (`dev`, the `-d` tip). **Scope:** one additive migration + its PGlite
test. **No application code changes** — deliberately. This is the migration half of a **two-phase**
change; the code (Phase 2) ships only after 97 is applied to prod.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## Why two phases (not optional)
`scripts/schema-index.json` is the **live** Postgres schema (from `information_schema`), on purpose —
so `schema-audit.py` catches code that names a column the database doesn't have. Therefore code that
selects/filters `retired_at` **cannot** pass the gates until the column is actually live. So:

1. **Phase 1 (this batch):** add + test the migration. Nothing references the column, so every gate
   stays green.
2. **You:** apply 97 to prod (db-migrate-prod), then refresh `schema-index.json` from live.
3. **Phase 2 (next):** the code — fleet `retired_at IS NULL` filter, `PATCH /:id/retire` +
   `/:id/unretire`, FleetPage retire action + archived view. Passes `schema-audit` once the column
   is in the live index.

## Files
| File | New? | Change |
|---|---|---|
| `migrations/97_user_devices_retire.sql` | **new** | Additive `retired_at`/`retired_by` (nullable) + partial `... WHERE retired_at IS NULL` index; self-registers in `schema_migrations`; idempotent (`IF NOT EXISTS`). |
| `scripts/test-migration-97.mjs` | **new** | 12 PGlite checks: additive, existing rows stay live, index created, retire round-trips + reverses, idempotent, records itself. Discovered by `run-migration-tests.mjs`. |
| `docs/AUDIT-REGISTER.md` | edit | A184 note: Tier 3 Phase 1 built. No count change. |

## Verification (rule 7)
- `node scripts/test-migration-97.mjs` → **12/12** (real PGlite), mutation-checked (break
  self-registration → 2 checks go red; restore → green).
- Gates: `schema-audit` (0), `check-api-schema-drift` (OK), `check-schema-drift`
  ("migrations and the database agree"), `check-test-registration`, `check-doc-refs`,
  `check-register-consistency`, `check-root-clean` → **all exit 0**, with 97 present but not applied.

**Could NOT verify here (rule 7):** the migration running against real prod Postgres (I have no DB
access). The PGlite run proves shape + idempotency; the prod apply is yours.

## Apply (Phase 1 → prod)
```bash
# land the migration file
git checkout dev && git pull origin dev
git am 0001-*.patch 0002-*.patch          # from repo root
git push origin dev

# apply to prod (your pipeline) — e.g. the db-migrate-prod workflow, or:
psql "$DATABASE_URL" -1 -f migrations/97_user_devices_retire.sql
# verify it recorded itself:
#   SELECT version FROM schema_migrations WHERE version='97_user_devices_retire';
# or GET /api/admin/migrations (A154) and confirm 97 is listed.

# THEN refresh the live schema index so Phase 2 can pass schema-audit:
#   psql "$DATABASE_URL" -f scripts/build-schema-index.sql > /tmp/live-schema.json
#   node scripts/build-schema-index.mjs --from-db /tmp/live-schema.json
#   git add scripts/schema-index.json && git commit -m "schema-index: refresh from live (post-97)"
```
Tell me once 97 is applied + the index refreshed and I'll build Phase 2.

## Rollback
```
rm migrations/97_user_devices_retire.sql scripts/test-migration-97.mjs docs/MANIFEST-2026-09-03-e.md
git checkout 17d357a -- docs/AUDIT-REGISTER.md
# if already applied to a db:
#   ALTER TABLE public.user_devices DROP COLUMN IF EXISTS retired_at, DROP COLUMN IF EXISTS retired_by;
#   DROP INDEX IF EXISTS user_devices_business_live_idx;
```
