# MANIFEST 2026-08-14-l — recipe stock reads live per-branch figure (A12); A4 unblocking step

**Delta on your pushed `dev`** (base `a9d7be6`). Server-only — no desktop, no
version bump, `package.json` not shipped.

**Register:** A12 fix applied (stays OPEN pending live check). A4 needs a prod
query only you can run — see below; nothing to ship for it yet.

---

## A12 — the fix (in this zip)

| File | What |
|---|---|
| `apps/server/src/routes/recipes.ts` | Three reads now join `ingredient_stock_levels` (live, per-branch) instead of the dead `ingredients.current_stock`, flattened via `branchScope(req)` exactly like `stock.ts`. |
| `docs/AUDIT-REGISTER.md` | A12 fix recorded. |
| `docs/MANIFEST-2026-08-14-l.md` | this file. |

**Why:** migration 23 moved ingredient stock to `ingredient_stock_levels` and left
`ingredients.current_stock` frozen. `recipes.ts` kept reading the frozen column, so
the Recipes drawer showed "0 in stock" (red) for everything created since, while
the Ingredients page showed the true figure. Now both go through the same
per-branch flatten, so they agree: staff see their branch, owner sees the
business-wide sum.

**Deploy:** cloud (Render) only. **Verify live:** open the Recipes drawer for a
product whose ingredient has branch stock — it should show the real number, and
match the Ingredients page for the same branch (not "0" in red).

**Follow-up, not built:** the class "a dead column inside a live table" has no gate
(`check-table-usage` is table-level). A column-level read/write comparator would
catch the next one. Say the word and I'll add it.

---

## A4 — needs your prod DB (I can't reach it from here)

Migration 68 (and possibly 72) is applied in production but absent from git, so the
repo can't reproduce prod. I can't see prod's schema from the bench. Two steps,
both on you:

**1. List what prod has applied** (psql against the prod DB, or Supabase SQL editor):
```sql
select version, applied_at from public.schema_migrations order by version;
```
Paste me the output. I'll diff it against `migrations/*.sql` and name exactly which
versions are missing.

**2. Recover the missing migration's DDL.** For each missing version, either you
have the SQL that was run, or extract it from prod. Cleanest is a schema-only dump:
```bash
pg_dump --schema-only --no-owner --no-privileges "$PROD_DATABASE_URL" > prod-schema.sql
```
Send that (or just the objects the missing migration created), and I'll author the
forward migration file(s) so a fresh environment reproduces prod, and reconcile the
migration ledger (§M) in the register.

Once you paste step 1's output, I can start immediately.

---

## Rollback (A12)
```bash
cd /c/swiftpos/pos
git checkout a9d7be6 -- apps/server/src/routes/recipes.ts docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-14-l.md
```

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- `apps/server` `tsc`: **0 errors**. Dead-column read gone; three reads repointed.
- Gates green: register-consistency, doc-refs, check-table-usage, supabase-catch, own-rows.

## NOT verified here — live (rules 9, 16) — closes A12
- Recipes drawer shows the true per-branch stock and matches the Ingredients page.
- Owner view (no branch) shows the business-wide sum.
