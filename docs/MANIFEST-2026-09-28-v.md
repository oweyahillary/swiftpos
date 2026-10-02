# MANIFEST 2026-09-28-v — desktop 0.6.19: History for cashiers, refund on the web, sauces off the kitchen ticket, expense types on the Expenses page

**Base:** origin/dev `5401208` (v0.6.18). **Delivered as a patch** — `swiftpos-2026-09-28-v0.6.19.patch`. The owner applies it on
`dev`, bumps **0.6.19**, commits and pushes (from 2026-09-28 the owner commits everything; no Claude commits).
**Deploy:** dashboard → tag v0.6.19 (stays a pre-release) → approve B Foods in the admin portal. **No cloud change, no migration.**

Owner, after the v0.6.18 checks: "all orders" (cashiers see every order in History) · "yes add web refund" · "sauce rule ok" ·
"add it here under expense but leave it under shifts also" · K2: "I had to add a kitchen printer i selected categories to be
printed and it worked".

## What changed
1. **History is back for cashiers (A358).** My 0.6.18 change hid the History button itself, not just the Void/Refund
   buttons.
   - Everyone sees the last 30 orders.
   - Only managers and the owner see the reversal buttons.
   - The window is wider, so there's no sideways scrolling.
2. **Refund on the web (A359).**
   - The web POS (POS Menu → Orders → Order History) and the manager dashboard's Orders now have **Refund** on completed
     sales.
   - It shows only for staff with `orders.void`.
   - You pick a reason and enter your own **Manager PIN**. A wrong PIN says so plainly, and a "refunded" tag appears
     afterwards.
3. **Sauces never print on the kitchen ticket (A358).**
   - An item whose name **is** a sauce or dip (BBQ Sauce, Honey Mustard Sauce, Garlic Dip) goes to dispatch only, on the
     till and the web POS.
   - A dish named after its sauce ("Wings in BBQ Sauce") stays on the kitchen ticket.
4. **Expense types on the manager's Expenses page (A358).**
   - An "Expense types" box lists them, with **+ Add type**.
   - Shift → Expenses keeps its own "+ Add type".
   - Both are shown to manager roles. If a role isn't allowed, the cloud says so rather than the button being silently
     hidden.
5. **Recorded:** the v0.6.17 and v0.6.18 checklist results. CLOSED A348, A350, A351, A276, A279, A356, A357.

**Known limit (A359):** when a sale rung on a till is refunded on the web, the cloud and the reports are right, but that
till's own screens don't learn of it. The till only downloads web-rung sales. Refund till sales from the till.

## Files
| Area | Files |
|---|---|
| Till | `renderer/pages/POSPage.tsx` (History for everyone; wider), `renderer/pages/ManagerPage.tsx` (Expenses page panel), NEW `renderer/components/ExpenseTypesPanel.tsx`, `renderer/lib/expenseTypes.ts` (manager roles) |
| Shared printing | `shared/printing/src/routing.ts` (`isStandaloneSauce` inside `stripKitchenIfExcluded`); web bundle `apps/dashboard/src/lib/escposRenderer.js` rebuilt |
| Web POS / dashboard | `apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx` (Refund), `apps/dashboard/src/pages/orderRefund.ts` (`canRefundOrder`, `REFUND_REASONS`) |
| Tests | NEW `tests/web-refund.test.mjs` (6); `apps/desktop/test/void-refund.test.mjs` (11), `apps/desktop/test/till-extras-0618.test.mjs` (11), `shared/printing/test/a276-soda-routing.test.ts` (11), `tests/kitchen-drinks.test.mjs` (3) |
| Docs | `docs/AUDIT-REGISTER.md` (A358, A359 new; seven closed; Tree v0.6.19), `docs/VERIFY-LOG-2026-09-28.md` (v0.6.17 + v0.6.18 results), `docs/checklists/VERIFY-CHECKLIST-v0.6.19.html` + `docs/VERIFY-CHECKLIST-v0.6.19.md` (27 checks), this file |

## Verification (bench: Linux, Node 22)
```
web-refund 6/6 · void-refund 11/11 · till-extras-0618 11/11 · a276-soda-routing 11/11 · kitchen-drinks 3/3 — 7 mutations bite.
Every tests/*.test.mjs · every desktop test (non-Electron) · shared/printing npm test (golden receipts unchanged) · every static
gate · typecheck ratchet · server, desktop (main + renderer) and dashboard builds · web bundle reproducible (--check).
check-register-consistency: TREE LINE STALE (v0.6.19 vs package.json 0.6.18) until the owner's bump — made in the same commit.
```
Not verified here (rule 16): the screens on a real till and web POS, the printed tickets.

## Apply (owner)
```bash
git checkout dev && git pull --ff-only origin dev
git apply --index swiftpos-2026-09-28-v0.6.19.patch
(cd apps/desktop && npm version 0.6.19 --no-git-tag-version) && git add apps/desktop/package.json apps/desktop/package-lock.json
git diff --cached --stat
git commit -m "desktop v0.6.19: History for cashiers, refund on the web, sauces off the kitchen ticket, expense types"
git push origin dev
```
Then CI green → deploy the dashboard → tag v0.6.19 → approve B Foods → `docs/checklists/VERIFY-CHECKLIST-v0.6.19.html`.

## Rollback
```bash
git revert <the owner's commit>   # no cloud or data change
```
