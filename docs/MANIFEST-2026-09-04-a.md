# MANIFEST 2026-09-04-a — A12 Phase 6: drop the dead `ingredients.current_stock`

**Base commit:** current `dev` (A143 close applied). **Scope:** one migration + its test + register.
No application code change. **This is a prod-migrate — held for your apply.**
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## Context
A12's bug (Recipes drawer showing the dead `ingredients.current_stock` as "0 in red") was already
FIXED in code — recipes.ts + stock.ts serve the live per-branch value from `ingredient_stock_levels`.
This batch does the cleanup migration 23 deferred ("Phase 6") and closes the class.

## Pre-flight sweep (why the drop is safe)
- **0 writers** of `ingredients.current_stock` anywhere (verified by AST-ish scan).
- **0 explicit readers** — recipes.ts repointed to the live table; stock.ts's `select('*')` pulls it
  but overrides it; the ingredient-create insert doesn't set it; clients read the computed API value.
- Migration 23's own header names this drop as "Phase 6".

## Files
| File | Change |
|---|---|
| `migrations/98_drop_ingredients_current_stock.sql` | `ALTER TABLE ingredients DROP COLUMN IF EXISTS current_stock` — idempotent, self-registering. Live per-branch stock (`ingredient_stock_levels`) untouched. |
| `scripts/test-migration-98.mjs` | 8 PGlite checks: drops the dead column, keeps the row + other columns, leaves the LIVE table's current_stock intact, idempotent, self-registers. Mutation-checked. |
| `docs/AUDIT-REGISTER.md` | A12 Phase-6 note. No count change (A12 stays OPEN pending live check + apply). |

## The "missing gate", solved for free
The A12 entry asked for a column-level read/write comparator (`check-table-usage` is table-level).
Dropping the dead column makes **`schema-audit`** do exactly that: after apply + index refresh, any
code that reads `ingredients.current_stock` fails the gate because the column is no longer in the
live schema. No new gate to build or maintain.

## Verification (rule 7)
- `node scripts/test-migration-98.mjs` → 8/8 (real PGlite), mutation-checked.
- `schema-audit` (0), `check-api-schema-drift` (OK), `check-test-registration`,
  `check-register-consistency`, `check-doc-refs` — green.
- **Could NOT verify here:** the migration against real prod Postgres (no DB access), and the live
  Recipes-drawer figure. Both are the owner steps that close A12.

## Apply (prod-migrate → then close A12)
```bash
# land the migration
git checkout dev && git pull origin dev
git am 0001-*.patch 0002-*.patch          # from repo root
git push origin dev

# apply to the dev DB (Supabase SQL editor, or psql), then refresh the index:
#   \i migrations/98_drop_ingredients_current_stock.sql   (idempotent, safe)
#   psql "$DEV_DATABASE_URL" -At -f scripts/build-schema-index.sql > /tmp/live.json
#   node scripts/build-schema-index.mjs --from-db /tmp/live.json
#   git add scripts/schema-index.json && git commit -m "schema-index: refresh (post-98)"
```
Then the live check: open the Recipes drawer on an ingredient that has branch stock — it should show
the true figure (not "0 in red") and match IngredientsPage. That closes A12.

## Rollback
```
rm migrations/98_drop_ingredients_current_stock.sql scripts/test-migration-98.mjs docs/MANIFEST-2026-09-04-a.md
git checkout <base> -- docs/AUDIT-REGISTER.md
# if already applied and ever needed back (data is gone — it was dead anyway):
#   ALTER TABLE public.ingredients ADD COLUMN current_stock numeric DEFAULT 0;
```
