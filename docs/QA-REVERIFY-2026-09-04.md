# SwiftPOS re-verify — A197 + A203(v2) + A201 + A148 (paste into a Claude browsing agent)

Sign in as the **owner** of **B Fastfoods** (needs ≥2 branches — Main + Westlands exist).
Hard-refresh once. Keep DevTools → Network open.

## STEP 0 — confirm you're testing the latest build (do this FIRST)
A prior run showed behaviour that didn't match the deployed code, which suggests the dashboard may
serve an older build. Before testing, confirm the deploy is current:
- Open the Terminals page (Settings → Devices and printers → Terminals). If the **Stock Transfers**
  "Mark received" test below shows a **native browser dialog** (one that freezes the whole tab), the
  build is STALE — stop and report that; do not mark A203 FAIL for a stale build.
- If unsure which build is live, note it and proceed; flag anything that contradicts the expected fix.

## Report table (output exactly this)
| ID | Result | Evidence |
|----|--------|----------|
| A203+A197 transfer | PASS/FAIL | modal? hang? per-branch stock |
| A201 first-click export | PASS/FAIL/NOT-SEEN | first click result |
| A148 add option to saved group | PASS/FAIL | did the option appear |

---

## A203 (v2) + A197 — single user completes a transfer via the IN-APP modal, no hang
The fix: as the same user, clicking "Mark received" now opens an **in-app React modal immediately**
(before any server call) — there must be **no native dialog and no page freeze**.
1. Inventory → make sure Main Branch has stock of an item (Adjust → Set, e.g. 20). Note Main + Westlands.
2. Inventory → **Stock Transfers** → **New Transfer**: Main → Westlands, that item × 5. Save → Pending.
3. **Mark in transit** → In Transit (source −5).
4. **Mark received** → an in-app modal "Confirm your own despatch?" should appear **instantly**.
   Critically: screenshot capture and other JS must keep working (a native dialog would freeze them).
5. Click **Proceed & record**.
- **PASS if:** the in-app modal appears with **no hang / no native dialog**, transfer → **Received**,
  and stock moves: Main −5, **Westlands +5**.
- **FAIL if:** the tab freezes / a native browser dialog appears / it hangs before the modal, OR
  Westlands doesn't gain 5. (If it hangs, first re-check STEP 0 — could be a stale deploy.)

## A201 — first export click right after a hard refresh
1. **Hard-refresh** the Reports page. 2. **Immediately** (first click) Reports → Exports → **Daily Summary** Excel.
- **PASS if:** downloads a real .xlsx first try (no 401). **FAIL if** first click 401s but a retry works.
  **NOT-SEEN** if you can't hit the timing.

## A148 — add an option to a SAVED modifier group
1. Products → open a product → open its **Variants / Modifiers** drawer.
2. Find (or create + save) a **modifier group** (e.g. "Extras"). On the SAVED group, click **"+ Add option"**.
3. Enter a name (e.g. "Extra cheese") + price (e.g. 50) → **Add**.
- **PASS if:** the option appears in that group's list immediately (persists on reload).
- **FAIL if:** no "+ Add option" control, or it errors / doesn't persist.

---
For any FAIL: page URL, failing request name + status, and what you saw vs expected. For A203,
explicitly state whether the dialog was an **in-app modal** or a **native browser dialog**.
