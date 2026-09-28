# MANIFEST 2026-09-28-u — desktop 0.6.18: refunds from History, the manager's own PIN, drinks off the kitchen ticket, and five more

**Base:** origin/dev `0199606` (v0.6.17) + this session's `bb0f7c8`, `4daab90` (A352 email) and `c8defe3` (A353/A354 register).
The owner fast-forwards `dev` onto this delivery, then bumps **0.6.18**.
**Deploy order:** cloud → dashboard + admin portal → tag v0.6.18 (stays a pre-release) → approve B Foods in the portal. No migration.

Owner, 2026-09-28, after the v0.6.17 checks (M4: "i cant find where a manager refunds", then "Invalid supervisor PIN"): "manager
can replace that [supervisor] role" · "3 is okay" · "build 1-7 and 9 as 0.6.18, expense types for 8, yes A341 are expense types".

## What changed
1. **Refund from History at any time (A355).**
   - On the POS → **History**, a sale shows **"Void / Refund"** for 30 minutes, then **"Refund"**. Before, its only button
     read "Void" and disappeared after 30 minutes, so older sales couldn't be refunded from the till at all.
   - A refunded sale shows a **"refunded"** tag.
   - **Cashiers no longer see these buttons.** Your rule: voids and refunds by owner or manager.
2. **The manager approves with their own PIN (A355).**
   - The window asks for **"Manager PIN"**, and a manager's (or the owner's) own sign-in PIN is accepted. The cloud records
     who approved.
   - Override PINs set up earlier, and the old business-wide supervisor PIN, still work.
   - A cashier's PIN never approves.
   - The window now shows the cloud's real message instead of always "Invalid supervisor PIN".
   - The supervisor role is left in place, not deleted.
3. **Web POS sales can be reversed from the till (A336 stage 2).** A web sale on the till's drawer gets the same buttons. A
   refund done on the till is counted once in the shift, even after the cloud's copy arrives.
4. **Drinks never print on the kitchen ticket (A276). The cause was found in the code.**
   - Both the till and the web POS applied the "no drinks in the kitchen" rule only to a line's sub-items (combo contents,
     options). A standalone soda has none, so it followed its category onto the kitchen ticket.
   - Now the drinks rule — soda, soft drinks, juice, water, Coke, Fanta, Sprite, Krest, Stoney, Minute Maid, plus your own
     Printers → Exclusions terms — applies to the whole line, on the till and the web POS.
   - Dispatch and the receipt still show drinks.
   - Sauces and dips are **not** removed from whole lines, because cooked dishes are named after their sauce.
5. **The POS says which filter it's showing (A279).** For example "Showing Soft Drinks · "coke" — 3 items" with **Clear ✕**.
   An empty grid now says why and offers **Show all products**.
6. **A manager adds expense types from the till (A341).**
   - In Shift → Expenses, **+ Add type** saves the type on the cloud and selects it.
   - An existing name is selected instead of duplicated.
   - Cashiers don't see the button.
7. **VAT is shown once on the Overview (A357).** The strip under the boxes now only shows what the boxes don't: CTL,
   refunds, discounts and tips.
8. **Admin portal release list (A356).**
   - A GitHub refusal now says what to do, e.g. rate limit → set GITHUB_RELEASES_TOKEN.
   - The portal keeps showing the last list it read, and the tills' update feed does the same.
   - The picker shows the newest 5 versions, plus the client's approved version if it's older, and "Show all N versions".

## Files
| Area | Files |
|---|---|
| Cloud | NEW `lib/approver.ts`; `routes/orders.ts` (verifyOverrideAuthorizer → findApprover; void + refund refusals); `lib/desktopReleases.ts` (describeGitHubFailure, listDesktopReleasesOrStale); `routes/admin.ts` (`?meta=1`), `routes/desktopUpdate.ts` |
| Shared printing | `shared/printing/src/routing.ts` (KITCHEN_DRINK_TERMS, kitchenExclusionTerms, stripKitchenIfExcluded); web bundle `scripts/escpos-renderer/entry.ts` → `apps/dashboard/src/lib/escposRenderer.js` + `.d.ts` |
| Web POS | `apps/dashboard/src/lib/printRouted.ts` |
| Admin portal | NEW `apps/admin/src/desktopVersions.ts`; `AdminPortal.tsx` |
| Till | NEW `renderer/lib/{voidRefund,posFilter,expenseTypes}.ts`; `renderer/{App,pages/POSPage,pages/ShiftPanel,pages/ManagerPage,components/VoidModal,lib/posApi}.tsx?`; `main/{escposBridge,ipcHandlers,ipcSchemas,preload}.ts` |
| CI | `.github/workflows/ci.yml` steps "Desktop void and refund from History", "Desktop 0.6.18 till extras" (root tests glob-run) |
| Tests | NEW `tests/approver.test.mjs` (12), `tests/kitchen-drinks.test.mjs` (3), `tests/desktop-releases-stale.test.mjs` (7), `apps/desktop/test/void-refund.test.mjs` (10), `apps/desktop/test/till-extras-0618.test.mjs` (10); `shared/printing/test/a276-soda-routing.test.ts` (+5), `apps/desktop/test/web-sales.test.mjs` (+3); `tests/tiny-bridge-printing.test.mjs` pin follows the helper |
| Docs | `docs/AUDIT-REGISTER.md` (A355, A356, A357 new; A276, A279, A341 FIX BUILT; A336 stage 2; Tree v0.6.18), `docs/checklists/VERIFY-CHECKLIST-v0.6.18.html` + `docs/VERIFY-CHECKLIST-v0.6.18.md` (27 checks), this file |

## Verification (bench: Linux, Node 22)
```
approver 12/12 — the COMPILED rule with real bcrypt hashes: a manager's / the owner's own PIN approves; a cashier's never; a
  per-person revoke beats the role; override PINs still work; picked approver only; "none" only when nobody can.
void-refund 10/10 · till-extras-0618 10/10 · kitchen-drinks 3/3 (both callers + the committed bundle) · desktop-releases-stale 7/7
  (the COMPILED lib vs a fake GitHub) · a276-soda-routing 9/9 · web-sales 28/28 (a till refund of a web sale counted once).
13 mutations bite (approver ×3, void/refund ×3, drinks ×2, filter, expense type, stale list, short list, …).
Every tests/*.test.mjs · every desktop test (non-Electron) · shared/printing npm test (golden receipts unchanged) · every static
gate · typecheck ratchet · server, desktop (main + renderer), dashboard and admin builds · web bundle reproducible (--check).
check-register-consistency: TREE LINE STALE (v0.6.18 vs package.json 0.6.17) until the owner's bump — as every release.
```
Not verified here (rule 16): the screens on a real till, the thermal tickets, the cloud's approval against the live staff data.

## Rollout (owner)
1. Fast-forward `dev`, bump **0.6.18**, push; wait for CI green.
2. Deploy the **cloud**, then the **dashboard** and the **admin portal**, from `dev`.
3. Tag **v0.6.18**. Leave it a pre-release.
4. Admin portal → B Foods → approve 0.6.18. Restart the till, and close and reopen it when the update is ready.
5. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.18.html`: §R, §V refunds, §K kitchen (needs the printer), §F, §E, §M, §A, §X.

## Rollback
```bash
git revert <this delivery's commits>   # no migration; tills on 0.6.18 keep working against the reverted cloud (legacy PINs)
```
