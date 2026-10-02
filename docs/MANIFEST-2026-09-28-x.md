# MANIFEST 2026-09-28-x — cashiers pick expense types; every expense records who entered it; backlog results recorded

**Base:** origin/dev `d0d442b`. **Delivered as a patch:** `swiftpos-2026-09-28-expenses.patch`. The owner applies it on `dev`,
commits and pushes. **No desktop release**: the till stays on 0.6.19.
**Deploy order (it matters):** **1. run migration 109 in Supabase → 2. deploy the cloud → 3. deploy the dashboard.** If the cloud
goes first, adding an expense on the web, the web Expenses list, and the tills' expense sync all fail until 109 runs (the
column they write is missing).

Owner, 2026-09-28: "build the cashier fix, one till only" (backlog S2: "cashier cannot select expense type") · "expense should
also capture who recorded it".

## What changed
1. **Cashiers can pick an expense type (A360).** The till reads the list of expense types from the cloud with the signed-in
   cashier's own login. The cloud used to refuse anyone without `expenses.view`, so a cashier's list was empty and their expenses
   arrived with no type. Now anyone signed in to the business can **read** the list. Adding, renaming and deleting a type
   is still managers and the owner only.
2. **Every expense records who entered it (A361).** There is a new **Recorded By** column on the dashboard's Expenses page, next
   to Paid By.
   - **Web:** the cloud stamps the signed-in person. It is never taken from the form and can't be edited later. "Paid By" stays
     your free choice.
   - **Till:** the cashier signed in on the till. The till already stored that person, so no till update is needed.
   - **Old expenses:** till expenses get their cashier filled in. Older web expenses stay "—", because nobody knows who typed them.
3. **Recorded:** the backlog checklist, 25 pass / 0 fail / 4 skip. Closed 27 items. §N ran on one till only, so the node items
   stay open.

## Files
| Area | Files |
|---|---|
| Database | NEW `migrations/109_expense_recorded_by.sql` (column, FK, till-row backfill, idempotent); `scripts/schema-index.json` (+ `expenses.recorded_by`) |
| Cloud | `apps/server/src/routes/expenses.ts` (GET /categories signed-in only; POST stamps `recorded_by`; names via explicit FK embeds), `routes/sync.ts` (`recorded_by` on synced expenses) |
| Dashboard | `apps/dashboard/src/pages/expenses/ExpensesPage.tsx` (Recorded By column) |
| Tests | NEW `tests/expense-recorder.test.mjs` (10), NEW `scripts/test-migration-109.mjs` (5, PGlite; the CI runner finds it) |
| Docs | `docs/AUDIT-REGISTER.md` (27 closed; A360, A361 new; migrations → 109), `docs/VERIFY-LOG-2026-09-28.md` (backlog results), this file |

## Verification (bench: Linux, Node 22)
```
expense-recorder 10/10 · test-migration-109 5/5 (real Postgres: till rows backfilled, web rows NOT guessed, FK refuses a
non-staff id, SET NULL on delete, idempotent) — 6 mutations bite.
Every tests/*.test.mjs · all 32 migration tests · every static gate (permission parity at baseline, schema-audit --strict 0,
schema drift OK, register consistency OK) · typecheck ratchet · server and dashboard builds.
```
Not verified here (rule 16): the live database, a cashier's till, the dashboard page.

## Rollout (owner)
1. Supabase → SQL editor → run `migrations/109_expense_recorded_by.sql`. Check it:
   `select column_name, data_type from information_schema.columns where table_name='expenses' and column_name='recorded_by';`
   → `recorded_by | uuid`.
2. Deploy the **cloud** from `dev`, then the **dashboard**.
3. Check: a **cashier** on the till → Shift → Expenses → the type list is filled; record one with a type → Sync → dashboard →
   Expenses shows the type and **Recorded By** = that cashier. Add one on the web → Recorded By = you.

## Rollback
```bash
git revert <the owner's commit>   # the column can stay (nullable, nothing else reads it)
```
