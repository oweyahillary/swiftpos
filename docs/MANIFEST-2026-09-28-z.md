# MANIFEST 2026-09-28-z — a cashier records an expense on the web POS

**Base:** origin/dev `48bc49d`. **Delivered as a patch:** `swiftpos-2026-09-28-web-pos-expense.patch`. The owner applies it on
`dev`, commits and pushes. **No migration** (109 is already applied), **no desktop release**.
**Deploy:** the **cloud**, then the **dashboard** (the button needs the new cloud route).

Owner, 2026-09-28: "web pos cannot record expences on cashier".

## What changed
1. **🧾 Expense on the web POS (A362).** It sits in the top bar beside 💵 Float, for anyone on a shift, the same as the till's
   Shift → Expenses.
   - The cashier picks a type, says what the money was for and enters the amount.
   - The expense is saved on the cloud against the open shift and comes off that shift's expected cash. If the web is sharing
     a till's drawer, the till counts it at close.
   - Paid By and Recorded By are both the signed-in cashier (A361).
   - "Record another" is offered after each one.
2. The back office's **Expenses** page is unchanged. It records any date and branch with a chosen Paid By, and stays managers
   and the owner only.

Before this, the web POS had no expense screen at all, and the only cloud route that saved an expense needed `expenses.manage`.

## Files
| Area | Files |
|---|---|
| Cloud | `apps/server/src/routes/shifts.ts` (NEW `POST /:id/expense`), NEW `apps/server/src/lib/expenseRecorder.ts` (`recorderId`, moved from `routes/expenses.ts` and shared) |
| Web POS | `apps/dashboard/src/pages/pos/ShiftModal.tsx` (mode `expense`), `apps/dashboard/src/pages/pos/CashierScreen.tsx` (🧾 Expense button) |
| Tests | NEW `tests/web-pos-expense.test.mjs` (8, compiled routes over HTTP as a cashier); `tests/expense-recorder.test.mjs` (pin follows the moved helper) |
| Docs | `docs/AUDIT-REGISTER.md` (A362), this file |

## Verification (bench: Linux, Node 22)
```
web-pos-expense 8/8 — a cashier (cashier keys only) reads the types, cannot add one, records into the OPEN shift under their own
name (a paid_by/recorded_by in the body is ignored), untyped is fine, a closed shift / no description / bad amount / another
business's type are refused, POST /api/expenses stays expenses.manage. 5 mutations bite.
Every tests/*.test.mjs · every static gate · schema-audit --strict 0 · typecheck ratchet · server and dashboard builds.
```
Not verified here (rule 16): the web POS screen in a browser, the live cloud.

## Rollout (owner)
1. Deploy the **cloud** from `dev`, then the **dashboard**.
2. On the web POS as a **cashier**: 🧾 Expense → pick a type → "Gas refill", 500 → Record. You should see "Expense recorded".
3. Dashboard → Expenses: the expense is listed with its type, and Recorded By shows that cashier. End the shift: expected cash
   is 500 lower.

## Rollback
```bash
git revert <the owner's commit>   # no data change; expenses already recorded stay
```
