# MANIFEST 2026-09-30-a — desktop 0.6.24 + cloud: only a shift's owner or a manager can close it (A366); notes in the order (A367)

**Base:** origin/dev `2ccc5ee`. **Delivered as a patch:** `swiftpos-2026-09-30-v0.6.24.patch`. It **includes the version bump**
(apps/desktop → 0.6.24; till schema **58**, applied by the till itself). **No cloud migration** — `orders.notes` and `order_items.notes` exist since the baseline. Deploy the cloud and the dashboard; tag; approve.

Owner, 2026-09-30: "only the shift owner can close the shift not any other cashier, maybe the manager should be able to close it".

## What changed
- **The till.** Only the cashier who opened the shift, or a manager, can close it.
  - Anyone else signed in sees: "This shift belongs to Test Cashier. Only Test Cashier or a manager can close it — ask them to
    sign in."
  - They can still sell, pay in / out and record expenses on that drawer.
  - The rule is enforced in the till's main process, not only on the screen.
- **The cloud.** A close from anyone but the opener or a manager is refused. Before this, anyone "on the same terminal" could
  close it, which let the web POS standing in as T1 count out another cashier's drawer.
  - The one exception is the till's own later replay of a close. The till checked the rule when the cashier counted, and it
    replays under whoever is signed in when it syncs.
- **The web POS.** Close Shift shows who owns the shift, instead of the count form, unless you own it or are a manager.
- **Manager** means the same people who can confirm a shift: owner, manager, supervisor or admin roles, or '*', orders.void,
  shifts.manage or settings.manage. It's now one rule on the till.
- **A drawer the web opened as the till (A334)** is now closed by its owner or a manager, not by any cashier at the till.
- **The update bar no longer covers the till** (owner, 2026-09-30: "can we make the update banner not block user activity" —
  "Update ready" sat over the Close the day button). The bar reports its height and the manager, POS and receipt screens stop
  above it, so every button stays reachable. The sync notice rides above it, and dialogs now cover it (z-40), not the reverse.

### The locked till (0.6.24)
Owner, 2026-09-30 (screenshot of "Till locked"): "add the organization logo where the till is, the small wordings are not
readable". The lock screen now shows the client's logo on a white card (as the PIN screen does; the padlock only when there is
no logo). Its background is now solid: the old `bg-gray-950/98` is not a Tailwind opacity step, so no background was ever
generated and the blurred screen showed through the text. The two lines under "Till locked" are larger and brighter.
`components/LockCurtain.tsx`; NEW `apps/desktop/test/lock-curtain-brand.test.mjs` (5; CI step; 4 mutations bite).

### Notes in the order (A367)
Owner, 2026-09-30: "can we add notes in the order maybe if a customer wants a mixture of 3 normal and 2 spicy chicken pieces or
they want exta cheese if it pizza or no salt etc". Decided: free text + quick picks; a note on each line and on the order; free.
- **The till.** "+ Note" under every cart line and "+ Note for the order" above the totals. The editor has the owner's quick picks
  (tap to add, tap again to remove) and a text box ("3 normal, 2 spicy"). A plain tap never joins a line that has a note, so
  "2 spicy" and a plain piece stay two lines. Changing a note after "Send to kitchen" sends that line again. A held order keeps
  its note. The note never changes the price.
- **Paper.** Kitchen ticket: `NOTE: …` under the header, `** …` under each dish, one row per line typed, bold. Receipt: `Note: …`
  and `** …` under the item. A sale with no notes prints exactly as before. **Fixed on the way:** a plain dish's note was never
  printed on the kitchen ticket (the renderer skipped it).
- **The cloud** stores both (cleaned and capped, never refused), sends the quick picks to the tills and the web POS, and the KDS
  shows the order note above the dishes and each line's note.
- **The web POS** (restaurant/café cashier screen) has the same editor and picks; the notes print and reach the cloud.
- **Back office:** Settings → Business → **Restaurant setup** → **🍽 Service** → **Quick notes for orders** (beside "Keep off the kitchen ticket"). One per line;
  empty = no quick picks; never set = the defaults (No salt, Spicy, Mild, Extra cheese, No onions, No sauce, Well done, Takeaway
  pack).
- **Not changed:** the on-screen till receipt (owner-approved format). The retail, petrol and parking web screens.

## Files
| Area | Files |
|---|---|
| Till (main) | `shiftService.ts` (`shiftCloseRights`, `isShiftManager`; `closeShift` refuses `SHIFT_NOT_YOURS`), `ipcHandlers.ts` / `ipcSchemas.ts` / `preload.ts` (`shift:closeRights`; the confirm rule reuses `isShiftManager`) |
| Till (screen) | `pages/ShiftPanel.tsx`, `lib/posApi.ts`; update bar: `pages/UpdateBanner.tsx`, `index.css` (`.app-screen`, `.app-screen-min`), `pages/ManagerPage.tsx`, `pages/POSPage.tsx` |
| Cloud | `routes/shifts.ts` (`POST /:id/close`: owner or manager; the till's own replay) |
| Web POS | `pages/pos/ShiftModal.tsx` |
| Version | `apps/desktop/package.json`, `package-lock.json` → 0.6.24 |
| Notes — shared | NEW `shared/orderNotes.ts` + copies `apps/desktop/src/shared/`, `apps/desktop/src/main/`, `apps/dashboard/src/lib/`, `apps/server/src/lib/` (`scripts/check-shared-sync.mjs`) |
| Notes — till | `localDb.ts` (schema 58), `syncEngine.ts`, `deviceConfig.ts`, `referenceBundle.ts`, `nodeIngest.ts`, `webSales.ts`, `escposBridge.ts`, `ipcHandlers.ts`, `ipcSchemas.ts`, `preload.ts`; `lib/cart.ts`, `lib/heldOrders.ts`, `lib/posApi.ts`, `pages/POSPage.tsx`, NEW `components/NoteModal.tsx` |
| Notes — paper | `shared/printing/src/types.ts`, `render.ts`; `apps/dashboard/src/lib/escposRenderer.js` (rebuilt, `--check` OK) |
| Notes — cloud | `routes/orders.ts`, `pos.ts`, `business.ts`, `kitchen.ts`, `shifts.ts` (web-sales read), `lib/desktopSchema.ts` (58) |
| Notes — web | `lib/cart.ts`, `printRouted.ts`, `buildReceiptOrder.ts`, `reprintReceipt.ts`; `pages/pos/CashierScreen.tsx`, `PaymentModal.tsx`, NEW `NoteModal.tsx`, `cashier/useCart.ts`, `usePOSData.ts`, `types.ts`; `pages/kds/KDSPage.tsx`; `pages/settings/RestaurantSettingsPage.tsx` |
| Tests | `apps/desktop/test/shared-drawer.test.mjs` (+3), `apps/desktop/test/shift-confirm.test.mjs` (49), `tests/shift-confirm.test.mjs` (28), NEW `apps/desktop/test/update-banner-layout.test.mjs` (6; CI step in `.github/workflows/ci.yml`) |
| Tests (notes) | NEW `apps/desktop/test/order-notes.test.mjs` (34; CI step), NEW `tests/order-notes.test.mjs` (16), NEW `shared/printing/test/order-notes.test.ts` (7; in the package's `npm test`); `apps/desktop/test/shift-confirm.test.mjs` (schema pin ≥ 57), `apps/desktop/test/catalogue-refresh-signal.test.mjs` (stand-in gains `setOrderNotePicks`) |
| Docs | `docs/AUDIT-REGISTER.md` (A366, A367; F8 PASS; Tree v0.6.24), `docs/checklists/VERIFY-CHECKLIST-v0.6.24.html` + `.md`, this file |

## Verification (bench)
```
shift-confirm (till) 49/49 · shared-drawer 22/22 · shift-confirm (cloud, compiled route over HTTP) 28/28 · 5 mutations bite
(the till's guard, the manager rule, the desktop-only replay ×2, the manager path on the cloud).
update-banner-layout 6/6 · 5 mutations bite (h-screen back, no 0px reset, CSS without the variable, z-50, sync notice).
Rendered in Chromium with the built CSS: scrolled to the end, the last button sits above the bar (607px vs the bar at 631px).
order-notes (till, real dist/main on SQLite) 34/34 · order-notes (cloud + web) 16/16 · printing order-notes 7/7 · 17 mutations bite
(the till's stored note ×2, the picks cache ×2, the web-sales note, the merge rule ×2, the saved-empty picks, the cloud's scope and
cleaning, pos/init, the readable key, the web receipt, the kitchen order note, the plain-dish note, the typed lines, the receipt note).
Print golden files unchanged (bytes --check, sample --check). Every desktop test · every tests/*.test.mjs · printing npm test ·
every gate · Schema drift job · typecheck ratchet · 33 migration tests · server, desktop and dashboard builds.
Every desktop test (non-Electron) · every tests/*.test.mjs · every static gate · the CI "Schema drift" job · typecheck ratchet ·
migration tests · server, desktop (typecheck + main + renderer) and dashboard builds.
```

## Rollout (owner)
1. Apply, commit, push; CI green. Deploy the **cloud**, then the **dashboard**.
2. Tag **v0.6.24** → approve B Foods → T1 updates.
3. Settings → Business → Restaurant setup → 🍽 Service → Quick notes for orders: check the list (or keep the defaults).
4. Checklist v0.6.24 — §C (C5: the update bar), §N (notes).

## Rollback
```bash
git revert <the owner's commit>   # no data change
```
