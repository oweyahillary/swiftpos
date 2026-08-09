# SwiftPOS — Chrome Agent Smoke Test: per-branch stock & recipe deduction

**Purpose:** Drive the live app end-to-end and prove that (a) ingredient stock is
tracked per branch, (b) a menu item pegged to ingredients deducts them on sale,
and (c) the deduction lands on the *selling* branch only.

**How to use:** Paste this whole file to the Claude Chrome agent. It performs each
step in order and reports **PASS/FAIL** at every ✅ checkpoint. If a checkpoint
fails, it stops and reports what it saw (screenshot + the numbers).

---

## Config (fill these in before running)

- `DASHBOARD_URL` = `http://localhost:5173`
- `POS_URL` = `http://localhost:5173/pos`   ← same app, POS surface
- Use a **fresh** owner email each run, e.g. `owner+<timestamp>@test.local`
- Owner password: `Test@1234`
- Owner PIN (for POS): `1234`

Test data the agent will create:
- Business: `Galitos Test <timestamp>` · type **Restaurant** · currency KES
- Ingredient: `Chicken Drumstick` · unit `pieces`
- Menu item (product): `2-Piece Meal` · price `650`
- Recipe: `2-Piece Meal` consumes **2** × `Chicken Drumstick` per serving

---

## Phase A — Create the business

1. Go to `DASHBOARD_URL`. If a landing/login page shows, choose **Sign up / Create account**.
2. Register with the fresh owner email + password. Complete the onboarding wizard:
   business name, type = **Restaurant**, currency **KES**. Accept defaults for the rest.
3. Finish onboarding until the main **dashboard** loads.

✅ **Checkpoint A:** The dashboard is visible and a branch name appears in the top
bar (the default "Main" branch). Record that branch name as **BRANCH 1**.

---

## Phase B — Create ingredient + stock (owner)

4. Navigate to **Stock → Ingredients** (`/dashboard/stock/ingredients`).
5. Click **Add ingredient**. Name `Chicken Drumstick`, unit `pieces`. Save.

✅ **Checkpoint B1:** The new ingredient appears with **current stock = 0**
(it starts empty — stock is added per branch, not at creation).

6. Confirm **BRANCH 1** is selected in the top-bar branch selector.
7. On the `Chicken Drumstick` row, open **Adjust**. Set type **add**, quantity **100**,
   and set **Reorder level (this branch) = 20**. Click **Apply**.

✅ **Checkpoint B2:** `Chicken Drumstick` now shows **100 pieces** for BRANCH 1.
Record this as **STOCK_BEFORE = 100**.

---

## Phase C — Create the menu item and peg its recipe

8. Go to **Products** (or **Menu Items**) → **Add**. Name `2-Piece Meal`,
   price `650`, category any. Save.
9. Open `2-Piece Meal` → **Recipe** (the recipe drawer). Add a line:
   ingredient `Chicken Drumstick`, quantity per serving **2**. Save the recipe.

✅ **Checkpoint C:** The recipe drawer lists `Chicken Drumstick × 2` and shows a
stock hint reflecting BRANCH 1's 100 pieces.

---

## Phase D — Sell it on the POS

10. Open `POS_URL`. Log in as the owner/cashier using PIN `1234`.
11. If prompted, **Open Shift** with an opening float of `5000`.
12. If a branch prompt appears, choose **BRANCH 1**.
13. Restaurant flow: go to the **tables** view → **▦ Grid** → tap a free table →
    set covers (e.g. 2) → **Open Table** to reach the product grid.
    (If the POS opens straight to a product grid, skip to the next step.)
14. Add **`2-Piece Meal` × 1** to the order.
15. **Charge** → leave tender blank for exact → **Confirm**. Wait for
    "Payment successful", then **New order**.

✅ **Checkpoint D:** The sale completed without error and a receipt/confirmation showed.

---

## Phase E — Verify deduction (the actual test)

16. Return to `DASHBOARD_URL` → **Stock → Ingredients**, with **BRANCH 1** selected.
17. Read `Chicken Drumstick` current stock. Record as **STOCK_AFTER**.

✅ **Checkpoint E1 (core):** `STOCK_AFTER == STOCK_BEFORE − 2` → **98 pieces**.
(1 meal sold × 2 drumsticks per serving = 2 deducted.) If it still reads 100,
deduction did not fire — **FAIL** and report.

18. Open the ingredient's **movements** history.

✅ **Checkpoint E2:** There is a movement of type **sale**, quantity change **−2**,
tied to the order, on **BRANCH 1**.

19. If the business has a second branch, switch the top-bar selector to it and read
    `Chicken Drumstick`.

✅ **Checkpoint E3 (isolation):** On the other branch the stock is **unchanged**
(still 0 / whatever it was) — the sale only touched BRANCH 1. If there is only one
branch, note "single-branch — isolation not tested" and skip.

20. Switch the selector to **All Branches** and read `Chicken Drumstick`.

✅ **Checkpoint E4 (roll-up):** The value equals the **sum across branches**
(e.g. 98 with one branch; 98 + other-branch stock if multiple).

---

## Report format

At the end, output a table:

| Checkpoint | Expected | Observed | Result |
|-----------|----------|----------|--------|
| A  | dashboard + branch name | … | PASS/FAIL |
| B1 | stock = 0 on create | … | … |
| B2 | 100 after +100 | … | … |
| C  | recipe = drumstick ×2 | … | … |
| D  | sale completes | … | … |
| E1 | 98 after sale | … | … |
| E2 | sale movement −2 | … | … |
| E3 | other branch unchanged | … | … |
| E4 | all-branches = sum | … | … |

**Overall: PASS only if E1 and E2 pass.** Those two are the whole point — they prove
sales update per-branch ingredient stock. Everything else is setup.

---

## Notes for the agent
- Never invent numbers — read them from the screen; screenshot each checkpoint.
- If a UI label differs (e.g. "Menu Items" instead of "Products", or a different
  path to open a table), adapt but keep the assertions identical.
- If any request errors (red toast / network error), capture the message and stop.
