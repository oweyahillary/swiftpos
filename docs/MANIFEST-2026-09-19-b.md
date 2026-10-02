# Delivery manifest — 2026-09-19 (-b) · A280 rebuild reproducibility

**Base:** `origin/dev` (9e33afa). Server/DB change (runs via migrate.mjs on deploy). No desktop bump.

## What / why
A clean baseline+migrations rebuild didn't reproduce production — 7 items off. REPRODUCED here via a
pglite replay (0 migrations failed, all 7 absent). Three distinct causes, three fixes:
1. **6 missing columns** — migrations 58/60 put new columns inside `CREATE TABLE IF NOT EXISTS`, which
   skipped because 44/baseline already made the tables. Fix: **migration 103** adds them idempotently.
2. **ingredients.current_stock** — not drift; migration 98 drops it on purpose. Fix: **remove the stale
   entry from schema-index.json**.
3. **schema_migration_runs** — not drift; `migrate.mjs` bootstraps it. A raw replay misses it; a
   migrate.mjs rebuild has it. No code change — rebuild via migrate.mjs.

## Files
| File | Change |
|---|---|
| `migrations/103_reconcile_a280_columns.sql` | NEW. ADD COLUMN IF NOT EXISTS for the 6 columns; category_stations add-nullable → backfill (from categories.business_id) → SET NOT NULL; FK constraints guarded. Idempotent / no-op on prod. |
| `scripts/schema-index.json` | Remove stale `ingredients.current_stock`. |
| `docs/AUDIT-REGISTER.md` | A280 → FIX BUILT + full note + changelog. |
| `docs/MANIFEST-2026-09-19-b.md` | This file. |

## Verified on the bench (rule 9)
pglite replay of baseline + all migrations + 103: all 6 columns present with correct nullability,
current_stock correctly absent — matches the corrected index for all 7. `check-api-schema-drift`,
`check-schema-drift`, `check-register-consistency`, `check-doc-refs`, `check-root-clean`,
`check-test-registration`, `check-sql-binds`, `check-notnull-writes` all green.

## NOT verified — needs prod (rules 9, 16)
- `verify-db-schema` against the **prod** DATABASE_URL: confirm the index matches prod (no OTHER drift)
  and that fuel_tanks/parking_sessions are empty on prod (dead-path). 103 is additive/idempotent so it's
  a no-op where columns exist; if prod is ALSO missing them, 103 adds them (the correct fix, but a real
  prod schema change to review).
- CLOSE A280 when a migrate.mjs rebuild + `verify-db-schema` is green against prod.

## Apply
```
git apply "../patch files/swiftpos-A280-rebuild.patch"
git add -A && git commit -m "A280: reconcile migration 103 + drop stale current_stock from schema-index" && git push origin dev
```
