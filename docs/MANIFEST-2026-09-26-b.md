# MANIFEST 2026-09-26-b — A329 step 3 built: the back office is SwiftPOS teal

**Base commit:** `645c8f4` (origin/dev, delivery 2026-09-26-a; CI #405 green). **Delivered as one commit on
`claude/modest-cray-f21ll5`** — the owner fast-forwards `dev` onto it (new route, WORKING-METHOD §5). **Deploy: dashboard only.**
No desktop change, no version bump.

Why: A329 step 3 — the back office's actions, the wordmark and its accents move from green/blue to a FIXED SwiftPOS teal (never the
client's theme — A323 4b-2), exactly as classified in `docs/A329-back-office-colour-classification.md` (owner answers 2026-09-26:
1a, accents OK, pairs OK, log the follow-up).

## What changed
- **58 back-office screens + 2 lib files**: 619 uses rewritten at their classified positions — 610 by script (the shade per use chosen
  from the label its own class string carries), 9 by hand (the prod favicon `#0d9488` + its comment, 6 sign-in grid `rgba`s). Status,
  money, data and blue-info colours untouched. Branding palette: **"SwiftPOS Teal" `#0d9488`** first; the old duplicate "Teal" slot
  is now **"Blue" `#3b82f6`** (same 8 colours).
- `apps/dashboard/tailwind.config.js` — the `swift` palette (7 tokens) reading `index.css` variables.
- `apps/dashboard/src/index.css` — the token values (fills fixed; text 400/300 on dark, 700/800 on white); OUTSIDE `@layer base`:
  the light-mode focus ring for `focus:border-swift`, and white labels kept white on `swift-strong` (the light theme turns
  `.text-white` slate: 3.26:1 on teal 700). The dead green focus rule (no users; never compiled) removed.
- NEW `scripts/check-back-office-colour.mjs` + `scripts/back-office-colour-baseline.json` (397) — ratchet, every colour form; CI step
  added in `.github/workflows/ci.yml`.
- NEW `tests/back-office-teal.test.mjs` (runs in the existing `tests/*.test.mjs` loop).
- `tests/ui-reports-fixes.test.mjs` — A263's pin re-pinned to intent: the active period preset is `bg-swift-strong` (was blue-600).
- `docs/AUDIT-REGISTER.md` — A329 step 3 built; NEW **A332** (P2, web POS light mode: hover 3.26, white labels 3.26, A328's focus rule
  never compiled) and **A333** (P3, status greens 1.74 in light mode); header, counts, changelog.
- `docs/WORKING-METHOD.md` — the delivery route (session branch + fast-forward, one block, "landed" = dev IS the commit); four §9 rows.
- `docs/A329-back-office-colour-classification.md` — owner answers + applied note.

## Files (69)
Screens / lib (60): `lib/appFlavor.ts` · `pages/BranchesPage.tsx` · `pages/DiscountsPage.tsx` · `pages/FleetPage.tsx` · `pages/ForcePasswordChangePage.tsx` · `pages/LoginPage.tsx` · `pages/OnboardingPage.tsx` · `pages/OrdersPage.tsx` · `pages/OverviewPage.tsx` · `pages/PaymentMethodsPage.tsx` · `pages/PromotionsPage.tsx` · `pages/QRMenuPage.tsx` · `pages/ReportsPage.tsx` · `pages/ReservationsPage.tsx` · `pages/SettingsPage.tsx` · `pages/crm/CustomersPage.tsx` · `pages/customers/CreditAccountsPage.tsx` · `pages/expenses/ExpensesPage.tsx` · `pages/inventory/AdjustmentModal.tsx` · `pages/inventory/InventoryPage.tsx` · `pages/inventory/MovementsDrawer.tsx` · `pages/kds/KDSPage.tsx` · `pages/manager/ManagerDashboard.tsx` · `pages/manager/ManagerMenuTab.tsx` · `pages/manager/ManagerReceivingTab.tsx` · `pages/manager/ManagerReportsPage.tsx` · `pages/manager/ManagerShiftTab.tsx` · `pages/products/BulkImageUpload.tsx` · `pages/products/BulkPriceEditor.tsx` · `pages/products/BulkProductImport.tsx` · `pages/products/CategoriesPage.tsx` · `pages/products/CombosPage.tsx` · `pages/products/MenuUpload.tsx` · `pages/products/ProductsPage.tsx` · `pages/products/RecipeDrawer.tsx` · `pages/products/VariantsDrawer.tsx` · `pages/settings/BranchReceiptOverrides.tsx` · `pages/settings/BrandingTab.tsx` · `pages/settings/BulkItemCodeModal.tsx` · `pages/settings/BusinessProfileTab.tsx` · `pages/settings/DevicesTab.tsx` · `pages/settings/EtimsSettingsPage.tsx` · `pages/settings/FloorPlanTab.tsx` · `pages/settings/KitchenDisplayTab.tsx` · `pages/settings/MinimartSettingsPage.tsx` · `pages/settings/ParkingSettingsPage.tsx` · `pages/settings/PetrolSettingsPage.tsx` · `pages/settings/PrintersPage.tsx` · `pages/settings/ReportSchedulerTab.tsx` · `pages/settings/RestaurantSettingsPage.tsx` · `pages/settings/RolesTab.tsx` · `pages/settings/StaffTab.tsx` · `pages/settings/WebhooksTab.tsx` · `pages/stock/BulkIngredientImport.tsx` · `pages/stock/IngredientsPage.tsx` · `pages/stock/PurchaseOrdersPage.tsx` · `pages/stock/StockTransfersPage.tsx` · `pages/stock/SuppliersPage.tsx`.
Other (9): `apps/dashboard/src/index.css` · `apps/dashboard/tailwind.config.js` · `.github/workflows/ci.yml` ·
`scripts/check-back-office-colour.mjs` (NEW) · `scripts/back-office-colour-baseline.json` (NEW) · `tests/back-office-teal.test.mjs` (NEW) ·
`tests/ui-reports-fixes.test.mjs` · `docs/AUDIT-REGISTER.md` · `docs/WORKING-METHOD.md` · `docs/A329-back-office-colour-classification.md` ·
`docs/MANIFEST-2026-09-26-b.md` (this file, NEW).

## Verification (bench: Linux, Node 22 — the owner's Node 24 / Windows run of the one block is the real check for the scripts)
```
Chromium (/opt/pw-browsers) on the REAL compiled dashboard CSS, transitions off, dark → light (contrast of label on its fill):
  bg-swift + dark label        8.09 → 7.17      hover bg-swift-light   10.82 → 9.59
  bg-swift-strong + white      5.47 → 5.47      hover bg-swift-deep     7.58 → 7.58   (light was 3.26 / 2.35 before the white rule)
  text-swift-text on card      9.53 → 5.47      hover                  11.99 → 7.58
  logo tile "S"                4.77 → 4.77      focus ring in light mode: rgb(20,184,166) over the forced gray border
node tests/back-office-teal.test.mjs              → 18 passed, 0 failed
  mutations (each restored after): --swift-strong = teal 500 · light text switch removed · a white-label button → bg-swift
  (names EtimsSettingsPage.tsx:207) · focus rule inside @layer base · duplicate #0d9488 in the palette · the light white-label
  rule removed → each turns its named check red
node scripts/check-back-office-colour.mjs         → OK (397, baseline 397); --self-test OK; a Suppliers button back to green →
  exit 1, "pages/stock/SuppliersPage.tsx: 7 (baseline 5)" with its lines
node scripts/check-web-pos-green.mjs              → OK (web POS untouched)
tests/*.test.mjs (the CI loop)                    → 122 files, 0 failed (apps/server built first for the 3 that import its dist)
node scripts/typecheck-ratchet.mjs server dashboard admin → all 0 errors (baseline held)
apps/dashboard: npm run build                     → built
every "node scripts/…" step in ci.yml (46)        → exit 0, except test-maintenance / test-tech-db-console: "Cannot find module
  'better-sqlite3'" on this bench — identical on the untouched base 645c8f4 (bench has no native build); CI runs them
check-register-consistency / check-doc-refs / check-root-clean / check-test-registration / check-reference-names → OK
```
Not verified here: the real back-office pages logged in (needs the cloud + an account) — that is the owner's check below.

## Owed on target
Deploy the **dashboard** (from this commit). Check the back office in **dark AND light**: primary buttons teal (dark text on the lighter
teal, white text on the deeper teal — white must stay white in light mode), links and active tabs teal, toggles and ticks teal, input
focus rings teal; saved toasts, "Active" badges, prices, charts, zones unchanged; the browser-tab icon teal; Settings → Branding lists
"SwiftPOS Teal" first and "Blue" further along. Sign-in / onboarding: logo tile and buttons teal.

## Rollback
```bash
# before or after the commit (restores every path from the base, removes the new files):
git checkout 645c8f4 -- apps/dashboard/src apps/dashboard/tailwind.config.js .github/workflows/ci.yml tests/ui-reports-fixes.test.mjs docs/AUDIT-REGISTER.md docs/WORKING-METHOD.md docs/A329-back-office-colour-classification.md && git rm -q --ignore-unmatch scripts/check-back-office-colour.mjs scripts/back-office-colour-baseline.json tests/back-office-teal.test.mjs docs/MANIFEST-2026-09-26-b.md && rm -f scripts/check-back-office-colour.mjs scripts/back-office-colour-baseline.json tests/back-office-teal.test.mjs docs/MANIFEST-2026-09-26-b.md
```
