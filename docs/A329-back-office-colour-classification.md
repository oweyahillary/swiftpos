# A329 step 3 — the back office's green AND blue colours, classified (owner review before any screen changes)

**Base:** `bad4492` (origin/dev; CI #404 green). **Scope** (owner, 2026-09-26): the back office = dashboard `apps/dashboard/src` minus
`pages/pos` and `components` (A328's scope; there is no `layouts/`). **Blue primaries move too** (owner: "yes move backoffice too");
**the admin portal (`apps/admin`) stays out** (owner). Standing decision (A323 4b-2): the back office stays **SwiftPOS-branded** — its
action colour is a FIXED SwiftPOS teal, never the client's theme. **No screen changes in this delivery** — this is the list you review.

## Owner answers (2026-09-26) and applied (delivery 2026-09-26-b)
- (1) **(a)** — the preset is now **"SwiftPOS Teal" `#0d9488`**. The palette already held a "Teal" `#0d9488` (swatches are keyed by
  hex, and a test pins 8 accents), so that slot became **"Blue" `#3b82f6`** — the same 8 colours, renamed and re-ordered.
- (2) accents OK · (3) pairs OK · (4) logged as **A333**.
- **Applied** to every "→ teal" row below, at its position (610 by script + 9 by hand = 619), with fixed `swift-*` tokens — see A329
  in `docs/AUDIT-REGISTER.md` for the token table, the proofs and two light-mode defects found on the way. The "Status" and "Money"
  rows name what the gate `scripts/check-back-office-colour.mjs` still allows (baseline 397).

## How it was made
- **Sweep, every form** (WORKING-METHOD §9): Tailwind classes (`green|emerald|lime|blue|sky|indigo`, every prefix — `hover:`,
  `focus:`, `dark:`, `file:`, `group-hover:`, `accent-`, `border-t-`…), hex (`#rgb`/`#rrggbb`), `rgb()`/`rgba()`, and named colour
  strings (`'green'`, `"blue"`). Hex and rgb are judged by HUE (green 75–165°, blue 195–250° with saturation ≥ 0.6 — so slate greys like
  `#1e293b` are not counted as blue). **106 files scanned, 62 with hits, 1016 uses on 676 lines** (649 green, 367 blue).
  Every scanned file and its count is listed at the end. The SCREENS with 0 were opened and read (`OpenShiftsPage`,
  `manager/ManagerShiftTab`, `manager/RemoteDayClose`, `manager/ManagerMenuTab`, `settings/StationsPage`: red/amber only;
  `settings/UsersAccessPage`, `settings/BusinessPage`, `settings/DevicesPrintersPage`: wrappers with no colour of their own) — none
  hides colour in another form. The other 0-hit files are `context/`, `hooks/`, `lib/` and types (no UI).
- The 2026-09-25 sweep said 641 greens (606 classes + 35 hex/rgba) in 104 files; this one finds 649: 609 classes (prefixes such as
  `file:` and `border-t-` now matched) + 34 hex + 1 rgba + **5 named `'green'` strings** (not matched before), and `index.css`
  is now in the file list. (`lib/themes.ts` and `lib/contrast.ts` — the theme registry and its contrast maths — are excluded: they
  define the colours, they do not paint the back office.)
- **Classified by rules first, keep-colours before action**, so a status can only become "action" through a rule that can be audited;
  then **every remaining line by hand** (184 uses), then two audits:
  - **status → action (the risky direction):** the 532 rule-made actions sit on 362
    lines; 157 carry only focus rings (always an action); **the other 205 were read one by one**. **3 corrected** — the KDS status counts
    (`kds/KDSPage.tsx:267`, matched `===`), a printer's "enabled" dot (`settings/PrintersPage.tsx:484`, matched `enabled`) and the restock
    movement colour (`inventory/MovementsDrawer.tsx:73`, matched `===`). Every other auto-action is a real control.
  - **action → keep (a button left green):** keep-rules that fired on a clickable element. **13 Save / Create buttons (26 uses) corrected** —
    the money rule's word `saving` matched `disabled={saving}`; plus 2 filter tabs (`filterStatus ===` had matched the status rule) and
    3 by hand (a Save link, a "+ stock" button, RecipeDrawer's un-saved button text).

| Category | Uses | green | blue | by rule | by hand |
|---|---|---|---|---|---|
| Action → SwiftPOS teal (fixed, never the client theme) | 592 | 369 | 223 | 532 | 60 |
| SwiftPOS wordmark → teal | 6 | 3 | 3 | 5 | 1 |
| SwiftPOS brand backdrop → teal | 6 | 0 | 6 | 6 | 0 |
| SwiftPOS accent → teal (hand-picked — please check) | 15 | 2 | 13 | 0 | 15 |
| Status — keeps its colour | 217 | 194 | 23 | 148 | 69 |
| Money — keeps its colour | 28 | 28 | 0 | 21 | 7 |
| Data / identity colour — keeps its colour | 108 | 53 | 55 | 78 | 30 |
| Info (blue) — keeps its colour | 41 | 0 | 41 | 40 | 1 |
| Owner decision needed | 1 | 0 | 1 | 0 | 1 |
| Not a hue colour — dropped from the count | 2 | 0 | 2 | 2 | 0 |
| **Total** | **1016** | **649** | **367** | **832** | **184** |

**Goes teal: 619. Keeps its colour: 394.** Decision: 1. Dropped: 2.

## Please decide / check
1. **The Branding page's colour preset "SwiftPOS Blue" `#3b82f6`** (`settings/BrandingTab.tsx:28`) — a preset in the list a client picks
   THEIR brand colour from. With SwiftPOS now teal its name is wrong. Options: **(a)** rename it "SwiftPOS Teal" with `#0d9488` (the
   logo's colour) — clients who already chose `#3b82f6` keep it, the value is stored; **(b)** keep the colour, rename it "Blue";
   **(c)** leave it. Lead-dev recommendation: **(a)**.
2. **The 15 "accent" uses** (below) are hand calls: they are SwiftPOS decoration, not status or data, so they go teal. Say if any should stay.
3. **Blue and green buttons side by side become the same teal** in 9 files: `SettingsPage`, `manager/ManagerDashboard`,
   `manager/ManagerReceivingTab`, `settings/BusinessProfileTab`, `settings/PetrolSettingsPage`, `settings/PrintersPage`,
   `settings/ReportSchedulerTab`, `stock/PurchaseOrdersPage` ("Mark as Ordered" blue beside "Receive Goods" green),
   `stock/StockTransfersPage`. The blue/green difference carried no meaning in the code (both are primary buttons), and A328 made the
   same call for the web POS. Say if any pair should keep a difference.
4. **Status greens in light mode are pre-existing ~1.8:1 on white** (`text-green-400` has no light-mode override in `index.css`). Out of
   scope here (they keep their colour); logged as a follow-up.

## How the teal will be applied (next delivery, after your review)
A fixed `swift-*` token set (not `action-*`, which follows the client theme): the SAME Teal-family shades A329 chose, by job —
fills carrying **dark** labels → teal 500 `#14b8a6`; fills carrying **white** labels → teal 700 `#0f766e` (white on teal 500 fails);
text and links → teal 400 `#2dd4bf` on dark, **teal 700 on white** (light mode); tints (`/10`, `/20`) keep their alpha on the 500. The
shade is chosen per use from the label the element already has, applied by script (count in = count out), a ratchet gate over the
back office (extending `check-web-pos-green.mjs`), and checked in the browser in dark AND light. If slice 5's B1 says teal is too close
to "paid" green, the token values move — one place.

## Action → SwiftPOS teal (fixed, never the client theme) (592)

Pressed, selected, linked, focused, toggled on, ticked, spinners.

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `index.css:147` | `border-green-500` | light-mode rule for the focus:border-green-500 class (moves with it) | hand |
| `index.css:147` | `#22c55e` | light-mode rule for the focus:border-green-500 class (moves with it) | hand |
| `pages/BranchesPage.tsx:119` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/BranchesPage.tsx:119` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/BranchesPage.tsx:156` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/BranchesPage.tsx:165` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/BranchesPage.tsx:174` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/BranchesPage.tsx:183` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/BranchesPage.tsx:183` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/crm/CustomersPage.tsx:263` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/crm/CustomersPage.tsx:272` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/crm/CustomersPage.tsx:272` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/crm/CustomersPage.tsx:619` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/crm/CustomersPage.tsx:624` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/crm/CustomersPage.tsx:624` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/crm/CustomersPage.tsx:673` | `group-hover:text-green-400` | hover/press state on a control | rule |
| `pages/crm/CustomersPage.tsx:747` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/crm/CustomersPage.tsx:756` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/crm/CustomersPage.tsx:756` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/customers/CreditAccountsPage.tsx:152` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/customers/CreditAccountsPage.tsx:152` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/customers/CreditAccountsPage.tsx:190` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/customers/CreditAccountsPage.tsx:190` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/customers/CreditAccountsPage.tsx:206` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/customers/CreditAccountsPage.tsx:206` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/DiscountsPage.tsx:154` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/DiscountsPage.tsx:154` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/DiscountsPage.tsx:168` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/DiscountsPage.tsx:168` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/DiscountsPage.tsx:230` | `hover:bg-green-500/10` | hover/press state on a control | rule |
| `pages/DiscountsPage.tsx:230` | `hover:text-green-400` | hover/press state on a control | rule |
| `pages/DiscountsPage.tsx:230` | `hover:border-green-500/20` | hover/press state on a control | rule |
| `pages/DiscountsPage.tsx:266` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/DiscountsPage.tsx:277` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/DiscountsPage.tsx:292` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/DiscountsPage.tsx:303` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/DiscountsPage.tsx:317` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/DiscountsPage.tsx:331` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/DiscountsPage.tsx:342` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/DiscountsPage.tsx:354` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/DiscountsPage.tsx:363` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/DiscountsPage.tsx:363` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/expenses/ExpensesPage.tsx:279` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/expenses/ExpensesPage.tsx:279` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/expenses/ExpensesPage.tsx:296` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/expenses/ExpensesPage.tsx:296` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/expenses/ExpensesPage.tsx:307` | `text-green-400` | selected filter | hand |
| `pages/expenses/ExpensesPage.tsx:307` | `bg-green-500/10` | selected filter | hand |
| `pages/expenses/ExpensesPage.tsx:319` | `text-green-400` | selected filter | hand |
| `pages/expenses/ExpensesPage.tsx:319` | `bg-green-500/10` | selected filter | hand |
| `pages/expenses/ExpensesPage.tsx:414` | `text-green-500` | text link | hand |
| `pages/expenses/ExpensesPage.tsx:482` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/expenses/ExpensesPage.tsx:492` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/expenses/ExpensesPage.tsx:507` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/expenses/ExpensesPage.tsx:524` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/expenses/ExpensesPage.tsx:538` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/expenses/ExpensesPage.tsx:548` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/expenses/ExpensesPage.tsx:565` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/expenses/ExpensesPage.tsx:584` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/expenses/ExpensesPage.tsx:584` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/expenses/ExpensesPage.tsx:610` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/expenses/ExpensesPage.tsx:625` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/expenses/ExpensesPage.tsx:625` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/FleetPage.tsx:250` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/FleetPage.tsx:252` | `text-green-500` | Save link button | hand |
| `pages/FleetPage.tsx:252` | `hover:text-green-400` | Save link button | hand |
| `pages/FleetPage.tsx:335` | `text-green-600` | button whose className starts on the next line | rule |
| `pages/FleetPage.tsx:335` | `hover:text-green-500` | hover/press state on a control | rule |
| `pages/ForcePasswordChangePage.tsx:49` | `#3b82f6` | input focus border | hand |
| `pages/ForcePasswordChangePage.tsx:49` | `#3b82f6` | input focus border | hand |
| `pages/ForcePasswordChangePage.tsx:154` | `#22c55e` | button whose className starts on the next line | rule |
| `pages/ForcePasswordChangePage.tsx:154` | `#16a34a` | button whose className starts on the next line | rule |
| `pages/inventory/AdjustmentModal.tsx:119` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/inventory/AdjustmentModal.tsx:142` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/inventory/AdjustmentModal.tsx:155` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/inventory/AdjustmentModal.tsx:155` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/inventory/InventoryPage.tsx:188` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/inventory/InventoryPage.tsx:271` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/inventory/InventoryPage.tsx:296` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/inventory/InventoryPage.tsx:296` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/inventory/MovementsDrawer.tsx:58` | `border-green-400` | spinner | rule |
| `pages/kds/KDSPage.tsx:209` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/kds/KDSPage.tsx:219` | `bg-green-500` | link / button colour paired with its own hover colour | rule |
| `pages/kds/KDSPage.tsx:219` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/kds/KDSPage.tsx:233` | `text-green-400` | text link | hand |
| `pages/LoginPage.tsx:41` | `#3b82f6` | input focus border | hand |
| `pages/LoginPage.tsx:41` | `#3b82f6` | input focus border | hand |
| `pages/LoginPage.tsx:159` | `bg-green-600` | link / button colour paired with its own hover colour | rule |
| `pages/LoginPage.tsx:159` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/LoginPage.tsx:214` | `#22c55e` | button whose className starts on the next line | rule |
| `pages/LoginPage.tsx:275` | `#3b82f6` | button whose className starts on the next line | rule |
| `pages/LoginPage.tsx:275` | `#2563eb` | button whose className starts on the next line | rule |
| `pages/manager/ManagerDashboard.tsx:884` | `bg-blue-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerDashboard.tsx:884` | `hover:bg-blue-500` | hover/press state on a control | rule |
| `pages/manager/ManagerDashboard.tsx:894` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerDashboard.tsx:933` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerDashboard.tsx:939` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerDashboard.tsx:944` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerDashboard.tsx:951` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerDashboard.tsx:962` | `bg-blue-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerDashboard.tsx:962` | `hover:bg-blue-500` | hover/press state on a control | rule |
| `pages/manager/ManagerDashboard.tsx:978` | `border-t-blue-500` | spinner | rule |
| `pages/manager/ManagerDashboard.tsx:1090` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/manager/ManagerDashboard.tsx:1090` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/manager/ManagerDashboard.tsx:1116` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerDashboard.tsx:1116` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/manager/ManagerDashboard.tsx:1125` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerDashboard.tsx:1125` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/manager/ManagerDashboard.tsx:1195` | `bg-green-600` | selected / on state of an option or toggle | rule |
| `pages/manager/ManagerDashboard.tsx:1196` | `bg-green-600` | selected / on state of an option or toggle | rule |
| `pages/manager/ManagerDashboard.tsx:1341` | `bg-blue-600/20` | manager sidebar active item | hand |
| `pages/manager/ManagerDashboard.tsx:1341` | `text-blue-400` | manager sidebar active item | hand |
| `pages/manager/ManagerDashboard.tsx:1341` | `border-blue-500/30` | manager sidebar active item | hand |
| `pages/manager/ManagerMenuTab.tsx:65` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:302` | `bg-blue-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerReceivingTab.tsx:302` | `hover:bg-blue-500` | hover/press state on a control | rule |
| `pages/manager/ManagerReceivingTab.tsx:316` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:325` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:338` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:348` | `bg-blue-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerReceivingTab.tsx:348` | `hover:bg-blue-500` | hover/press state on a control | rule |
| `pages/manager/ManagerReceivingTab.tsx:405` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerReceivingTab.tsx:405` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/manager/ManagerReceivingTab.tsx:433` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:440` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:452` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerReceivingTab.tsx:452` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/manager/ManagerReceivingTab.tsx:471` | `bg-blue-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerReceivingTab.tsx:471` | `hover:bg-blue-500` | hover/press state on a control | rule |
| `pages/manager/ManagerReceivingTab.tsx:489` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerReceivingTab.tsx:489` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/manager/ManagerReceivingTab.tsx:511` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:519` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:526` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:538` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:541` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:548` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:555` | `bg-blue-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerReceivingTab.tsx:555` | `hover:bg-blue-500` | hover/press state on a control | rule |
| `pages/manager/ManagerReceivingTab.tsx:580` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:587` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/manager/ManagerReceivingTab.tsx:595` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/manager/ManagerReceivingTab.tsx:595` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/manager/ManagerReportsPage.tsx:98` | `border-t-blue-500` | spinner | rule |
| `pages/manager/ManagerReportsPage.tsx:140` | `bg-blue-600` | button whose className starts on the next line | rule |
| `pages/manager/ManagerReportsPage.tsx:149` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReportsPage.tsx:359` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/manager/ManagerReportsPage.tsx:895` | `bg-blue-600` | selected / on state of an option or toggle | rule |
| `pages/manager/ManagerShiftTab.tsx:100` | `border-blue-500/50` | outline button | hand |
| `pages/manager/ManagerShiftTab.tsx:100` | `text-blue-400` | outline button | hand |
| `pages/manager/ManagerShiftTab.tsx:100` | `hover:bg-blue-500/10` | outline button | hand |
| `pages/OnboardingPage.tsx:200` | `#3b82f6` | input focus border | hand |
| `pages/OnboardingPage.tsx:200` | `#3b82f6` | input focus border | hand |
| `pages/OnboardingPage.tsx:238` | `#3b82f6` | current step | hand |
| `pages/OnboardingPage.tsx:238` | `#3b82f6` | current step | hand |
| `pages/OnboardingPage.tsx:246` | `#93c5fd` | current step label = action (#93c5fd); completed = status (#22c55e) | hand |
| `pages/OnboardingPage.tsx:330` | `#3b82f6` | selected business type | hand |
| `pages/OnboardingPage.tsx:330` | `#3b82f6` | selected business type | hand |
| `pages/OnboardingPage.tsx:336` | `#93c5fd` | selected business type label | hand |
| `pages/OnboardingPage.tsx:408` | `#3b82f6` | button whose className starts on the next line | rule |
| `pages/OnboardingPage.tsx:408` | `#2563eb` | button whose className starts on the next line | rule |
| `pages/OnboardingPage.tsx:502` | `#3b82f6` | button whose className starts on the next line | rule |
| `pages/OnboardingPage.tsx:502` | `#2563eb` | button whose className starts on the next line | rule |
| `pages/OnboardingPage.tsx:628` | `#22c55e` | button whose className starts on the next line | rule |
| `pages/OnboardingPage.tsx:628` | `#16a34a` | button whose className starts on the next line | rule |
| `pages/OrdersPage.tsx:158` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/OrdersPage.tsx:163` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/OrdersPage.tsx:266` | `border-blue-500/40` | outline button | hand |
| `pages/OrdersPage.tsx:266` | `text-blue-400` | outline button | hand |
| `pages/OrdersPage.tsx:266` | `hover:bg-blue-500/10` | outline button | hand |
| `pages/OrdersPage.tsx:320` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/PaymentMethodsPage.tsx:98` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/PaymentMethodsPage.tsx:103` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/PaymentMethodsPage.tsx:103` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/PaymentMethodsPage.tsx:125` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/BulkImageUpload.tsx:148` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/products/BulkImageUpload.tsx:148` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/products/BulkPriceEditor.tsx:174` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/BulkPriceEditor.tsx:174` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/BulkProductImport.tsx:81` | `text-blue-400` | link / button colour paired with its own hover colour | rule |
| `pages/products/BulkProductImport.tsx:81` | `hover:text-blue-300` | hover/press state on a control | rule |
| `pages/products/BulkProductImport.tsx:155` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/products/BulkProductImport.tsx:155` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/products/CategoriesPage.tsx:104` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/CategoriesPage.tsx:104` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/CategoriesPage.tsx:111` | `border-green-400` | spinner | rule |
| `pages/products/CategoriesPage.tsx:162` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/CategoriesPage.tsx:186` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/CategoriesPage.tsx:186` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/CombosPage.tsx:176` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/products/CombosPage.tsx:176` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/products/CombosPage.tsx:184` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/products/CombosPage.tsx:238` | `text-blue-400` | button whose className starts on the next line | rule |
| `pages/products/CombosPage.tsx:270` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/products/CombosPage.tsx:277` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/products/CombosPage.tsx:284` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/products/CombosPage.tsx:296` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/products/CombosPage.tsx:364` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/products/CombosPage.tsx:364` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/products/MenuUpload.tsx:191` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/products/MenuUpload.tsx:191` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/products/MenuUpload.tsx:198` | `hover:border-green-500` | hover/press state on a control | rule |
| `pages/products/MenuUpload.tsx:263` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/MenuUpload.tsx:263` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/ProductsPage.tsx:311` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/ProductsPage.tsx:311` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/ProductsPage.tsx:318` | `bg-green-500/10` | selection bar ("N selected") | hand |
| `pages/products/ProductsPage.tsx:318` | `border-green-500/30` | selection bar ("N selected") | hand |
| `pages/products/ProductsPage.tsx:319` | `text-green-300` | selection bar label | hand |
| `pages/products/ProductsPage.tsx:322` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/ProductsPage.tsx:322` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/ProductsPage.tsx:346` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:351` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:437` | `border-green-500` | inline price editor border (editing = focus) | hand |
| `pages/products/ProductsPage.tsx:443` | `hover:text-green-400` | hover/press state on a control | rule |
| `pages/products/ProductsPage.tsx:467` | `text-blue-400` | button whose className starts on the next line | rule |
| `pages/products/ProductsPage.tsx:467` | `hover:text-blue-300` | hover/press state on a control | rule |
| `pages/products/ProductsPage.tsx:476` | `text-green-400` | link / button colour paired with its own hover colour | rule |
| `pages/products/ProductsPage.tsx:476` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/products/ProductsPage.tsx:528` | `hover:border-green-500` | hover/press state on a control | rule |
| `pages/products/ProductsPage.tsx:549` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:560` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:575` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:588` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:601` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:616` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:632` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:640` | `bg-green-500` | toggle switch (on) | rule |
| `pages/products/ProductsPage.tsx:656` | `bg-green-500` | toggle switch (on) | rule |
| `pages/products/ProductsPage.tsx:668` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:687` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/ProductsPage.tsx:687` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/ProductsPage.tsx:744` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/ProductsPage.tsx:761` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/ProductsPage.tsx:761` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/RecipeDrawer.tsx:293` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/RecipeDrawer.tsx:334` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/RecipeDrawer.tsx:360` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/products/RecipeDrawer.tsx:360` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/products/RecipeDrawer.tsx:440` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/RecipeDrawer.tsx:451` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/RecipeDrawer.tsx:464` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/products/RecipeDrawer.tsx:464` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/products/RecipeDrawer.tsx:476` | `text-green-400` | button text before saving | hand |
| `pages/products/RecipeDrawer.tsx:514` | `bg-green-500` | link / button colour paired with its own hover colour | rule |
| `pages/products/RecipeDrawer.tsx:514` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/VariantsDrawer.tsx:64` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/VariantsDrawer.tsx:202` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/products/VariantsDrawer.tsx:301` | `accent-green-500` | form accent (checkbox / range) | rule |
| `pages/products/VariantsDrawer.tsx:334` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/products/VariantsDrawer.tsx:334` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/products/VariantsDrawer.tsx:344` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/VariantsDrawer.tsx:353` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/VariantsDrawer.tsx:381` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/VariantsDrawer.tsx:381` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/VariantsDrawer.tsx:441` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/VariantsDrawer.tsx:458` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/products/VariantsDrawer.tsx:458` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/products/VariantsDrawer.tsx:626` | `border-green-400` | spinner | rule |
| `pages/products/VariantsDrawer.tsx:675` | `hover:text-green-400` | hover/press state on a control | rule |
| `pages/products/VariantsDrawer.tsx:744` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/VariantsDrawer.tsx:751` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/products/VariantsDrawer.tsx:753` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/products/VariantsDrawer.tsx:753` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/products/VariantsDrawer.tsx:759` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/products/VariantsDrawer.tsx:759` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/PromotionsPage.tsx:213` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/PromotionsPage.tsx:213` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/PromotionsPage.tsx:334` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/PromotionsPage.tsx:346` | `border-blue-500` | selected / on state of an option or toggle | rule |
| `pages/PromotionsPage.tsx:346` | `bg-blue-500/10` | selected / on state of an option or toggle | rule |
| `pages/PromotionsPage.tsx:349` | `text-blue-400` | selected / on state of an option or toggle | rule |
| `pages/PromotionsPage.tsx:366` | `bg-blue-600` | selected day | hand |
| `pages/PromotionsPage.tsx:366` | `border-blue-500` | selected day | hand |
| `pages/PromotionsPage.tsx:381` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/PromotionsPage.tsx:386` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/PromotionsPage.tsx:396` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/PromotionsPage.tsx:401` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/PromotionsPage.tsx:414` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/PromotionsPage.tsx:421` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/PromotionsPage.tsx:445` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/PromotionsPage.tsx:458` | `border-blue-500` | selected option | hand |
| `pages/PromotionsPage.tsx:458` | `bg-blue-500/10` | selected option | hand |
| `pages/PromotionsPage.tsx:458` | `text-blue-400` | selected option | hand |
| `pages/PromotionsPage.tsx:480` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/PromotionsPage.tsx:480` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/QRMenuPage.tsx:109` | `border-t-green-500` | spinner | rule |
| `pages/QRMenuPage.tsx:133` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/QRMenuPage.tsx:133` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/QRMenuPage.tsx:153` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/QRMenuPage.tsx:153` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/QRMenuPage.tsx:168` | `bg-green-600` | selected / on state of an option or toggle | rule |
| `pages/QRMenuPage.tsx:197` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/QRMenuPage.tsx:197` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/QRMenuPage.tsx:206` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/QRMenuPage.tsx:206` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/QRMenuPage.tsx:220` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/QRMenuPage.tsx:220` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/QRMenuPage.tsx:221` | `bg-green-800/50` | count chip inside the green cart button | hand |
| `pages/QRMenuPage.tsx:262` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/QRMenuPage.tsx:267` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/QRMenuPage.tsx:267` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/ReportsPage.tsx:192` | `bg-blue-600` | button whose className starts on the next line | rule |
| `pages/ReportsPage.tsx:1942` | `border-blue-600` | active tab | hand |
| `pages/ReportsPage.tsx:1942` | `text-blue-600` | active tab | hand |
| `pages/ReportsPage.tsx:1942` | `dark:text-blue-400` | active tab | hand |
| `pages/ReservationsPage.tsx:182` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/ReservationsPage.tsx:197` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:197` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/ReservationsPage.tsx:209` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/ReservationsPage.tsx:239` | `bg-green-600/20` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:239` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:239` | `border-green-500/30` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:239` | `hover:bg-green-600/30` | hover/press state on a control | rule |
| `pages/ReservationsPage.tsx:250` | `bg-blue-500/10` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:250` | `text-blue-400` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:250` | `border-blue-500/20` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:250` | `hover:bg-blue-500/20` | hover/press state on a control | rule |
| `pages/ReservationsPage.tsx:291` | `bg-green-600/20` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:291` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:291` | `border-green-500/30` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:291` | `hover:bg-green-600/30` | hover/press state on a control | rule |
| `pages/ReservationsPage.tsx:355` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/ReservationsPage.tsx:355` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/BranchReceiptOverrides.tsx:87` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/settings/BranchReceiptOverrides.tsx:110` | `bg-green-500` | toggle switch (on) | rule |
| `pages/settings/BulkItemCodeModal.tsx:127` | `bg-green-600` | selected / on state of an option or toggle | rule |
| `pages/settings/BulkItemCodeModal.tsx:131` | `bg-green-600` | selected / on state of an option or toggle | rule |
| `pages/settings/BulkItemCodeModal.tsx:174` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/settings/BulkItemCodeModal.tsx:174` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/settings/BulkItemCodeModal.tsx:192` | `file:bg-green-600` | hover/press state on a control | rule |
| `pages/settings/BulkItemCodeModal.tsx:192` | `hover:file:bg-green-500` | hover/press state on a control | rule |
| `pages/settings/BusinessProfileTab.tsx:112` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/settings/BusinessProfileTab.tsx:122` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/settings/BusinessProfileTab.tsx:129` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/BusinessProfileTab.tsx:129` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/BusinessProfileTab.tsx:153` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/settings/BusinessProfileTab.tsx:171` | `bg-green-500` | toggle switch (on) | rule |
| `pages/settings/DevicesTab.tsx:190` | `bg-green-500` | toggle switch (on) | rule |
| `pages/settings/DevicesTab.tsx:228` | `bg-green-400` | button whose className starts on the next line | rule |
| `pages/settings/DevicesTab.tsx:228` | `hover:bg-green-300` | hover/press state on a control | rule |
| `pages/settings/DevicesTab.tsx:246` | `border-green-400` | active filter tab | hand |
| `pages/settings/DevicesTab.tsx:305` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/settings/DevicesTab.tsx:305` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/settings/DevicesTab.tsx:356` | `bg-green-400` | button whose className starts on the next line | rule |
| `pages/settings/DevicesTab.tsx:356` | `hover:bg-green-300` | hover/press state on a control | rule |
| `pages/settings/EtimsSettingsPage.tsx:168` | `bg-green-500` | selected / on state of an option or toggle | rule |
| `pages/settings/EtimsSettingsPage.tsx:207` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/settings/EtimsSettingsPage.tsx:207` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/settings/FloorPlanTab.tsx:204` | `bg-blue-600` | toggle switch (on) | rule |
| `pages/settings/FloorPlanTab.tsx:226` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/FloorPlanTab.tsx:226` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/KitchenDisplayTab.tsx:57` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/KitchenDisplayTab.tsx:66` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/settings/KitchenDisplayTab.tsx:66` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/settings/KitchenDisplayTab.tsx:80` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/MinimartSettingsPage.tsx:48` | `bg-blue-600` | selected / on state of an option or toggle | rule |
| `pages/settings/MinimartSettingsPage.tsx:140` | `border-blue-500` | active tab | hand |
| `pages/settings/MinimartSettingsPage.tsx:140` | `text-blue-400` | active tab | hand |
| `pages/settings/MinimartSettingsPage.tsx:232` | `text-blue-400` | button whose className starts on the next line | rule |
| `pages/settings/MinimartSettingsPage.tsx:232` | `hover:border-blue-500/50` | hover/press state on a control | rule |
| `pages/settings/MinimartSettingsPage.tsx:232` | `hover:bg-blue-500/5` | hover/press state on a control | rule |
| `pages/settings/MinimartSettingsPage.tsx:284` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/MinimartSettingsPage.tsx:284` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/ParkingSettingsPage.tsx:50` | `bg-blue-600` | selected / on state of an option or toggle | rule |
| `pages/settings/ParkingSettingsPage.tsx:166` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/ParkingSettingsPage.tsx:166` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/ParkingSettingsPage.tsx:194` | `border-blue-500` | selected / on state of an option or toggle | rule |
| `pages/settings/ParkingSettingsPage.tsx:194` | `text-blue-400` | selected / on state of an option or toggle | rule |
| `pages/settings/ParkingSettingsPage.tsx:213` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/ParkingSettingsPage.tsx:213` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/ParkingSettingsPage.tsx:236` | `text-blue-400` | button whose className starts on the next line | rule |
| `pages/settings/ParkingSettingsPage.tsx:236` | `hover:border-blue-500/50` | hover/press state on a control | rule |
| `pages/settings/ParkingSettingsPage.tsx:236` | `hover:bg-blue-500/5` | hover/press state on a control | rule |
| `pages/settings/ParkingSettingsPage.tsx:433` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/ParkingSettingsPage.tsx:433` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/PetrolSettingsPage.tsx:54` | `bg-blue-600` | selected / on state of an option or toggle | rule |
| `pages/settings/PetrolSettingsPage.tsx:218` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/PetrolSettingsPage.tsx:218` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/PetrolSettingsPage.tsx:226` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/PetrolSettingsPage.tsx:226` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/PetrolSettingsPage.tsx:264` | `border-blue-500` | selected / on state of an option or toggle | rule |
| `pages/settings/PetrolSettingsPage.tsx:264` | `text-blue-400` | selected / on state of an option or toggle | rule |
| `pages/settings/PetrolSettingsPage.tsx:306` | `text-blue-400` | button whose className starts on the next line | rule |
| `pages/settings/PetrolSettingsPage.tsx:306` | `hover:border-blue-500/50` | hover/press state on a control | rule |
| `pages/settings/PetrolSettingsPage.tsx:376` | `text-blue-400` | button whose className starts on the next line | rule |
| `pages/settings/PetrolSettingsPage.tsx:376` | `hover:border-blue-500/50` | hover/press state on a control | rule |
| `pages/settings/PetrolSettingsPage.tsx:377` | `text-green-400` | "+ stock" button | hand |
| `pages/settings/PetrolSettingsPage.tsx:377` | `border-green-500/20` | "+ stock" button | hand |
| `pages/settings/PetrolSettingsPage.tsx:377` | `hover:bg-green-500/5` | "+ stock" button | hand |
| `pages/settings/PetrolSettingsPage.tsx:421` | `text-blue-400` | link / button colour paired with its own hover colour | rule |
| `pages/settings/PetrolSettingsPage.tsx:421` | `hover:text-blue-300` | hover/press state on a control | rule |
| `pages/settings/PetrolSettingsPage.tsx:582` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/PetrolSettingsPage.tsx:582` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/PetrolSettingsPage.tsx:635` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/PetrolSettingsPage.tsx:635` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/PetrolSettingsPage.tsx:668` | `bg-green-700` | button whose className starts on the next line | rule |
| `pages/settings/PetrolSettingsPage.tsx:668` | `hover:bg-green-600` | hover/press state on a control | rule |
| `pages/settings/PrintersPage.tsx:61` | `bg-green-500` | selected / on state of an option or toggle | rule |
| `pages/settings/PrintersPage.tsx:99` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/settings/PrintersPage.tsx:112` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/settings/PrintersPage.tsx:130` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/PrintersPage.tsx:137` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/PrintersPage.tsx:420` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/PrintersPage.tsx:428` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/PrintersPage.tsx:437` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/PrintersPage.tsx:488` | `text-blue-400` | "Click to edit →" | hand |
| `pages/settings/PrintersPage.tsx:510` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/PrintersPage.tsx:510` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/PrintersPage.tsx:521` | `text-blue-400` | button whose className starts on the next line | rule |
| `pages/settings/PrintersPage.tsx:521` | `hover:text-blue-300` | hover/press state on a control | rule |
| `pages/settings/PrintersPage.tsx:627` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/PrintersPage.tsx:627` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/PrintersPage.tsx:659` | `border-blue-500` | selected station type | hand |
| `pages/settings/PrintersPage.tsx:659` | `bg-blue-500/10` | selected station type | hand |
| `pages/settings/PrintersPage.tsx:664` | `text-blue-400` | selected / on state of an option or toggle | rule |
| `pages/settings/PrintersPage.tsx:678` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/settings/PrintersPage.tsx:694` | `bg-blue-500/15` | selected category | hand |
| `pages/settings/PrintersPage.tsx:694` | `border-blue-500` | selected category | hand |
| `pages/settings/PrintersPage.tsx:694` | `text-blue-400` | selected category | hand |
| `pages/settings/PrintersPage.tsx:729` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/PrintersPage.tsx:729` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/ReportSchedulerTab.tsx:96` | `bg-green-500` | toggle switch (on) | rule |
| `pages/settings/ReportSchedulerTab.tsx:107` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/settings/ReportSchedulerTab.tsx:116` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/settings/ReportSchedulerTab.tsx:118` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/ReportSchedulerTab.tsx:118` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/ReportSchedulerTab.tsx:144` | `bg-blue-600` | checkbox / permission tick (selected) | rule |
| `pages/settings/ReportSchedulerTab.tsx:144` | `border-blue-600` | checkbox / permission tick (selected) | rule |
| `pages/settings/ReportSchedulerTab.tsx:160` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/ReportSchedulerTab.tsx:160` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/RestaurantSettingsPage.tsx:47` | `bg-blue-600` | selected / on state of an option or toggle | rule |
| `pages/settings/RestaurantSettingsPage.tsx:222` | `hover:border-blue-500/50` | hover/press state on a control | rule |
| `pages/settings/RestaurantSettingsPage.tsx:228` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/RestaurantSettingsPage.tsx:228` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/RestaurantSettingsPage.tsx:272` | `border-blue-500` | selected / on state of an option or toggle | rule |
| `pages/settings/RestaurantSettingsPage.tsx:272` | `text-blue-400` | selected / on state of an option or toggle | rule |
| `pages/settings/RestaurantSettingsPage.tsx:292` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/RestaurantSettingsPage.tsx:292` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/RestaurantSettingsPage.tsx:298` | `hover:border-blue-500/50` | hover/press state on a control | rule |
| `pages/settings/RestaurantSettingsPage.tsx:327` | `text-blue-400` | button whose className starts on the next line | rule |
| `pages/settings/RestaurantSettingsPage.tsx:327` | `hover:border-blue-500/50` | hover/press state on a control | rule |
| `pages/settings/RestaurantSettingsPage.tsx:359` | `border-blue-500` | button whose className starts on the next line | rule |
| `pages/settings/RestaurantSettingsPage.tsx:359` | `bg-blue-500/10` | button whose className starts on the next line | rule |
| `pages/settings/RestaurantSettingsPage.tsx:361` | `text-blue-400` | selected order mode | hand |
| `pages/settings/RestaurantSettingsPage.tsx:480` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/settings/RestaurantSettingsPage.tsx:485` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/RestaurantSettingsPage.tsx:485` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/RestaurantSettingsPage.tsx:529` | `border-blue-500` | selected / on state of an option or toggle | rule |
| `pages/settings/RestaurantSettingsPage.tsx:529` | `bg-blue-500/10` | selected / on state of an option or toggle | rule |
| `pages/settings/RestaurantSettingsPage.tsx:529` | `text-blue-400` | selected / on state of an option or toggle | rule |
| `pages/settings/RestaurantSettingsPage.tsx:546` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/RestaurantSettingsPage.tsx:546` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/RolesTab.tsx:109` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/settings/RolesTab.tsx:109` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/settings/RolesTab.tsx:123` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/RolesTab.tsx:129` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/RolesTab.tsx:156` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/settings/RolesTab.tsx:156` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/settings/RolesTab.tsx:201` | `bg-green-500` | link / button colour paired with its own hover colour | rule |
| `pages/settings/RolesTab.tsx:201` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/settings/RolesTab.tsx:238` | `bg-green-500` | checkbox / permission tick (selected) | rule |
| `pages/settings/RolesTab.tsx:238` | `border-green-500` | checkbox / permission tick (selected) | rule |
| `pages/settings/RolesTab.tsx:238` | `bg-green-500/30` | checkbox / permission tick (selected) | rule |
| `pages/settings/RolesTab.tsx:238` | `border-green-500/50` | checkbox / permission tick (selected) | rule |
| `pages/settings/RolesTab.tsx:249` | `border-green-500/40` | ticked permission | hand |
| `pages/settings/RolesTab.tsx:249` | `bg-green-500/8` | ticked permission | hand |
| `pages/settings/RolesTab.tsx:254` | `bg-green-500` | checkbox / permission tick (selected) | rule |
| `pages/settings/RolesTab.tsx:254` | `border-green-500` | checkbox / permission tick (selected) | rule |
| `pages/settings/StaffTab.tsx:88` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/settings/StaffTab.tsx:88` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/settings/StaffTab.tsx:142` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/settings/StaffTab.tsx:142` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/settings/StaffTab.tsx:142` | `hover:bg-green-500/10` | hover/press state on a control | rule |
| `pages/settings/StaffTab.tsx:322` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:327` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:335` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:345` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:355` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:363` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:373` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:389` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:413` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:425` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/settings/StaffTab.tsx:490` | `bg-green-500` | checkbox / permission tick (selected) | rule |
| `pages/settings/StaffTab.tsx:490` | `border-green-500` | checkbox / permission tick (selected) | rule |
| `pages/settings/StaffTab.tsx:491` | `bg-green-500/30` | checkbox / permission tick (selected) | rule |
| `pages/settings/StaffTab.tsx:491` | `border-green-500/50` | checkbox / permission tick (selected) | rule |
| `pages/settings/StaffTab.tsx:504` | `border-green-500/40` | checkbox / permission tick (selected) | rule |
| `pages/settings/StaffTab.tsx:504` | `bg-green-500/8` | checkbox / permission tick (selected) | rule |
| `pages/settings/StaffTab.tsx:507` | `bg-green-500` | checkbox / permission tick (selected) | rule |
| `pages/settings/StaffTab.tsx:507` | `border-green-500` | checkbox / permission tick (selected) | rule |
| `pages/settings/StaffTab.tsx:530` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/settings/StaffTab.tsx:530` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/settings/WebhooksTab.tsx:124` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/WebhooksTab.tsx:124` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/settings/WebhooksTab.tsx:228` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/settings/WebhooksTab.tsx:236` | `accent-blue-600` | form accent (checkbox / range) | rule |
| `pages/settings/WebhooksTab.tsx:246` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/settings/WebhooksTab.tsx:246` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/SettingsPage.tsx:85` | `bg-green-500` | toggle switch (on) | rule |
| `pages/SettingsPage.tsx:96` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/SettingsPage.tsx:105` | `focus:border-blue-500` | focus ring = active state | rule |
| `pages/SettingsPage.tsx:107` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/SettingsPage.tsx:107` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/SettingsPage.tsx:133` | `bg-blue-600` | checkbox / permission tick (selected) | rule |
| `pages/SettingsPage.tsx:133` | `border-blue-600` | checkbox / permission tick (selected) | rule |
| `pages/SettingsPage.tsx:149` | `bg-blue-700` | button whose className starts on the next line | rule |
| `pages/SettingsPage.tsx:149` | `hover:bg-blue-600` | hover/press state on a control | rule |
| `pages/stock/BulkIngredientImport.tsx:90` | `text-blue-400` | link / button colour paired with its own hover colour | rule |
| `pages/stock/BulkIngredientImport.tsx:90` | `hover:text-blue-300` | hover/press state on a control | rule |
| `pages/stock/BulkIngredientImport.tsx:162` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/stock/BulkIngredientImport.tsx:162` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/stock/IngredientsPage.tsx:253` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/IngredientsPage.tsx:253` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/IngredientsPage.tsx:266` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:271` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:280` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/IngredientsPage.tsx:345` | `hover:text-blue-400` | hover/press state on a control | rule |
| `pages/stock/IngredientsPage.tsx:380` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:388` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:398` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:408` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:417` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:427` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:439` | `accent-green-500` | form accent (checkbox / range) | rule |
| `pages/stock/IngredientsPage.tsx:453` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:465` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/IngredientsPage.tsx:465` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/IngredientsPage.tsx:486` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/IngredientsPage.tsx:499` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:506` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:516` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/IngredientsPage.tsx:523` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/IngredientsPage.tsx:523` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/PurchaseOrdersPage.tsx:260` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:260` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/PurchaseOrdersPage.tsx:265` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:287` | `bg-green-500/5` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:287` | `border-l-green-500` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:302` | `bg-green-500/10` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:302` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:302` | `hover:bg-green-500/20` | hover/press state on a control | rule |
| `pages/stock/PurchaseOrdersPage.tsx:332` | `bg-blue-500` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:332` | `hover:bg-blue-400` | hover/press state on a control | rule |
| `pages/stock/PurchaseOrdersPage.tsx:338` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:338` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/PurchaseOrdersPage.tsx:431` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:439` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:447` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:452` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:459` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:459` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/stock/PurchaseOrdersPage.tsx:488` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:514` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:523` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:549` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:549` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/PurchaseOrdersPage.tsx:590` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:598` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:609` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/PurchaseOrdersPage.tsx:620` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/PurchaseOrdersPage.tsx:620` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/StockTransfersPage.tsx:194` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/StockTransfersPage.tsx:194` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/StockTransfersPage.tsx:279` | `bg-blue-600` | button whose className starts on the next line | rule |
| `pages/stock/StockTransfersPage.tsx:279` | `hover:bg-blue-500` | hover/press state on a control | rule |
| `pages/stock/StockTransfersPage.tsx:286` | `bg-green-600` | button whose className starts on the next line | rule |
| `pages/stock/StockTransfersPage.tsx:286` | `hover:bg-green-500` | hover/press state on a control | rule |
| `pages/stock/StockTransfersPage.tsx:322` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/StockTransfersPage.tsx:333` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/StockTransfersPage.tsx:349` | `text-green-400` | button whose className starts on the next line | rule |
| `pages/stock/StockTransfersPage.tsx:349` | `hover:text-green-300` | hover/press state on a control | rule |
| `pages/stock/StockTransfersPage.tsx:362` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/StockTransfersPage.tsx:374` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/StockTransfersPage.tsx:393` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/StockTransfersPage.tsx:413` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/StockTransfersPage.tsx:413` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/StockTransfersPage.tsx:433` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/StockTransfersPage.tsx:433` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/SuppliersPage.tsx:99` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/SuppliersPage.tsx:99` | `hover:bg-green-400` | hover/press state on a control | rule |
| `pages/stock/SuppliersPage.tsx:112` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/SuppliersPage.tsx:195` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/SuppliersPage.tsx:207` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/SuppliersPage.tsx:216` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/SuppliersPage.tsx:228` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/SuppliersPage.tsx:238` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/SuppliersPage.tsx:248` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/SuppliersPage.tsx:260` | `focus:border-green-500` | focus ring = active state | rule |
| `pages/stock/SuppliersPage.tsx:283` | `bg-green-500` | button whose className starts on the next line | rule |
| `pages/stock/SuppliersPage.tsx:283` | `hover:bg-green-400` | hover/press state on a control | rule |

## SwiftPOS wordmark → teal (6)

The "S" logo tile, the prod favicon, the logo icon.

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `lib/appFlavor.ts:11` | `#3b82f6` | comment naming the favicon colour | hand |
| `lib/appFlavor.ts:17` | `#3b82f6` | SwiftPOS favicon tile (prod) | rule |
| `pages/ForcePasswordChangePage.tsx:69` | `#22c55e` | SwiftPOS logo tile (the "S") | rule |
| `pages/LoginPage.tsx:188` | `#22c55e` | SwiftPOS logo tile (the "S") | rule |
| `pages/manager/ManagerDashboard.tsx:1318` | `text-blue-400` | SwiftPOS logo icon | rule |
| `pages/OnboardingPage.tsx:222` | `#22c55e` | SwiftPOS logo tile (the "S") | rule |

## SwiftPOS brand backdrop → teal (6)

The faint grid on the sign-in / onboarding / password screens.

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `pages/ForcePasswordChangePage.tsx:58` | `rgba(59,130,246,0.03)` | SwiftPOS sign-in backdrop texture (blue grid) | rule |
| `pages/ForcePasswordChangePage.tsx:59` | `rgba(59,130,246,0.03)` | SwiftPOS sign-in backdrop texture (blue grid) | rule |
| `pages/LoginPage.tsx:177` | `rgba(59,130,246,0.03)` | SwiftPOS sign-in backdrop texture (blue grid) | rule |
| `pages/LoginPage.tsx:178` | `rgba(59,130,246,0.03)` | SwiftPOS sign-in backdrop texture (blue grid) | rule |
| `pages/OnboardingPage.tsx:211` | `rgba(59,130,246,0.03)` | SwiftPOS sign-in backdrop texture (blue grid) | rule |
| `pages/OnboardingPage.tsx:212` | `rgba(59,130,246,0.03)` | SwiftPOS sign-in backdrop texture (blue grid) | rule |

## SwiftPOS accent → teal (hand-picked — please check) (15)

Highlighted KPI cards, staff-initial avatars, code highlights.

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `pages/manager/ManagerDashboard.tsx:1381` | `bg-blue-600/20` | staff-initial avatar (SwiftPOS accent) | hand |
| `pages/manager/ManagerDashboard.tsx:1381` | `border-blue-500/30` | staff-initial avatar (SwiftPOS accent) | hand |
| `pages/manager/ManagerDashboard.tsx:1381` | `text-blue-400` | staff-initial avatar (SwiftPOS accent) | hand |
| `pages/manager/ManagerReportsPage.tsx:519` | `bg-blue-600/20` | staff-initial avatar (SwiftPOS accent) | hand |
| `pages/manager/ManagerReportsPage.tsx:519` | `border-blue-500/30` | staff-initial avatar (SwiftPOS accent) | hand |
| `pages/manager/ManagerReportsPage.tsx:519` | `text-blue-400` | staff-initial avatar (SwiftPOS accent) | hand |
| `pages/OverviewPage.tsx:70` | `bg-blue-600` | highlighted KPI card (SwiftPOS accent) | hand |
| `pages/OverviewPage.tsx:70` | `border-blue-500` | highlighted KPI card (SwiftPOS accent) | hand |
| `pages/OverviewPage.tsx:73` | `text-blue-100` | highlighted KPI card label | hand |
| `pages/ReportsPage.tsx:144` | `bg-blue-600` | highlighted KPI card (SwiftPOS accent) | hand |
| `pages/ReportsPage.tsx:144` | `border-blue-700` | highlighted KPI card (SwiftPOS accent) | hand |
| `pages/ReportsPage.tsx:146` | `text-blue-100` | highlighted KPI card label | hand |
| `pages/ReportsPage.tsx:148` | `text-blue-100` | highlighted KPI card sub-label | hand |
| `pages/settings/KitchenDisplayTab.tsx:45` | `text-green-400` | code highlight (/kds) | hand |
| `pages/settings/WebhooksTab.tsx:132` | `text-green-400` | code highlight (secret) | hand |

## Status — keeps its colour (217)

Saved, active, received, OK, live, open, thresholds, completed steps.

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `pages/BranchDetailPage.tsx:87` | `bg-green-500/10` | "Main" branch label | hand |
| `pages/BranchDetailPage.tsx:87` | `text-green-400` | "Main" branch label | hand |
| `pages/BranchDetailPage.tsx:87` | `border-green-500/20` | "Main" branch label | hand |
| `pages/BranchDetailPage.tsx:94` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/BranchDetailPage.tsx:94` | `text-green-400` | status map or status comparison | rule |
| `pages/BranchDetailPage.tsx:161` | `text-green-400` | status map or status comparison | rule |
| `pages/BranchDetailPage.tsx:203` | `text-green-400` | "OK" | hand |
| `pages/BranchesPage.tsx:102` | `bg-green-500/10` | "Main" branch label | hand |
| `pages/BranchesPage.tsx:102` | `text-green-400` | "Main" branch label | hand |
| `pages/BranchesPage.tsx:102` | `border-green-500/20` | "Main" branch label | hand |
| `pages/BranchesPage.tsx:107` | `text-green-400` | status map or status comparison | rule |
| `pages/crm/CustomersPage.tsx:136` | `bg-green-500/10` | "active" badge | hand |
| `pages/crm/CustomersPage.tsx:136` | `text-green-400` | "active" badge | hand |
| `pages/crm/CustomersPage.tsx:136` | `border-green-500/20` | "active" badge | hand |
| `pages/crm/CustomersPage.tsx:403` | `bg-blue-500/60` | status map or status comparison | rule |
| `pages/crm/CustomersPage.tsx:436` | `text-green-400` | status map or status comparison | rule |
| `pages/customers/CreditAccountsPage.tsx:128` | `bg-green-500/10` | success / saved / done message | rule |
| `pages/customers/CreditAccountsPage.tsx:128` | `text-green-400` | success / saved / done message | rule |
| `pages/customers/CreditAccountsPage.tsx:174` | `bg-green-500/10` | success / saved / done message | rule |
| `pages/customers/CreditAccountsPage.tsx:174` | `text-green-400` | success / saved / done message | rule |
| `pages/DiscountsPage.tsx:229` | `bg-green-500/10` | "Active" state badge (hover turns red to deactivate) | hand |
| `pages/DiscountsPage.tsx:229` | `text-green-400` | "Active" state badge (hover turns red to deactivate) | hand |
| `pages/DiscountsPage.tsx:229` | `border-green-500/20` | "Active" state badge (hover turns red to deactivate) | hand |
| `pages/FleetPage.tsx:80` | `text-green-600` | status map or status comparison | rule |
| `pages/FleetPage.tsx:80` | `dark:text-green-400` | status map or status comparison | rule |
| `pages/FleetPage.tsx:294` | `bg-green-500` | shift-open dot | hand |
| `pages/ForcePasswordChangePage.tsx:18` | `#3b82f6` | password-strength meter | hand |
| `pages/ForcePasswordChangePage.tsx:18` | `#22c55e` | password-strength meter | hand |
| `pages/inventory/InventoryPage.tsx:37` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/inventory/InventoryPage.tsx:37` | `text-green-400` | status map or status comparison | rule |
| `pages/inventory/InventoryPage.tsx:165` | `border-green-500/30` | success / saved / done message | rule |
| `pages/inventory/InventoryPage.tsx:165` | `bg-green-500/5` | success / saved / done message | rule |
| `pages/inventory/MovementsDrawer.tsx:23` | `text-blue-400` | status map or status comparison | rule |
| `pages/inventory/MovementsDrawer.tsx:82` | `text-green-400` | status map or status comparison | rule |
| `pages/kds/KDSPage.tsx:24` | `border-blue-500` | status map or status comparison | rule |
| `pages/kds/KDSPage.tsx:24` | `bg-blue-500/10` | status map or status comparison | rule |
| `pages/kds/KDSPage.tsx:24` | `bg-blue-500` | status map or status comparison | rule |
| `pages/kds/KDSPage.tsx:25` | `border-green-500` | success / saved / done message | rule |
| `pages/kds/KDSPage.tsx:25` | `bg-green-500/10` | success / saved / done message | rule |
| `pages/kds/KDSPage.tsx:25` | `bg-green-500` | success / saved / done message | rule |
| `pages/kds/KDSPage.tsx:250` | `bg-green-500` | live / free / complete indicator | rule |
| `pages/kds/KDSPage.tsx:267` | `text-blue-400` | KDS status counts (audit: was auto-action) | hand |
| `pages/kds/KDSPage.tsx:267` | `text-green-400` | KDS status counts (audit: was auto-action) | hand |
| `pages/manager/ManagerDashboard.tsx:197` | `#22c55e` | live / free / complete indicator | rule |
| `pages/manager/ManagerDashboard.tsx:370` | `bg-green-500/5` | idle pumps | hand |
| `pages/manager/ManagerDashboard.tsx:370` | `border-green-500/20` | idle pumps | hand |
| `pages/manager/ManagerDashboard.tsx:371` | `text-green-400` | idle pumps count | hand |
| `pages/manager/ManagerDashboard.tsx:480` | `text-green-400` | status map or status comparison | rule |
| `pages/manager/ManagerDashboard.tsx:496` | `bg-green-500` | status map or status comparison | rule |
| `pages/manager/ManagerDashboard.tsx:507` | `bg-blue-500/15` | status map or status comparison | rule |
| `pages/manager/ManagerDashboard.tsx:507` | `text-blue-400` | status map or status comparison | rule |
| `pages/manager/ManagerDashboard.tsx:508` | `bg-green-500/15` | status map or status comparison | rule |
| `pages/manager/ManagerDashboard.tsx:508` | `text-green-400` | status map or status comparison | rule |
| `pages/manager/ManagerDashboard.tsx:717` | `text-green-400` | status map or status comparison | rule |
| `pages/manager/ManagerDashboard.tsx:730` | `text-green-400` | status map or status comparison | rule |
| `pages/manager/ManagerDashboard.tsx:1071` | `bg-green-500/10` | success / saved / done message | rule |
| `pages/manager/ManagerDashboard.tsx:1071` | `text-green-400` | success / saved / done message | rule |
| `pages/manager/ManagerDashboard.tsx:1105` | `bg-green-500/10` | success / saved / done message | rule |
| `pages/manager/ManagerDashboard.tsx:1105` | `text-green-400` | success / saved / done message | rule |
| `pages/manager/ManagerHistoryTab.tsx:30` | `bg-green-500/15` | status map or status comparison | rule |
| `pages/manager/ManagerHistoryTab.tsx:30` | `text-green-400` | status map or status comparison | rule |
| `pages/manager/ManagerReportsPage.tsx:531` | `text-green-500` | success / saved / done message | rule |
| `pages/manager/ManagerReportsPage.tsx:622` | `border-green-500/30` | status map or status comparison | rule |
| `pages/manager/ManagerReportsPage.tsx:622` | `bg-green-500/5` | status map or status comparison | rule |
| `pages/manager/ManagerReportsPage.tsx:627` | `text-green-400` | status map or status comparison | rule |
| `pages/manager/ManagerReportsPage.tsx:627` | `border-green-500/30` | status map or status comparison | rule |
| `pages/manager/ManagerReportsPage.tsx:655` | `text-green-400` | status map or status comparison | rule |
| `pages/OnboardingPage.tsx:236` | `#22c55e` | completed step | hand |
| `pages/OnboardingPage.tsx:246` | `#22c55e` | current step label = action (#93c5fd); completed = status (#22c55e) | hand |
| `pages/OnboardingPage.tsx:255` | `#22c55e` | completed-step connector | hand |
| `pages/OnboardingPage.tsx:486` | `#22c55e` | success / saved / done message | rule |
| `pages/OnboardingPage.tsx:587` | `#22c55e` | password-length meter | hand |
| `pages/OrdersPage.tsx:62` | `text-green-400` | status map or status comparison | rule |
| `pages/OverviewPage.tsx:76` | `text-green-400` | status map or status comparison | rule |
| `pages/OverviewPage.tsx:95` | `text-green-400` | "live" indicator | hand |
| `pages/OverviewPage.tsx:96` | `bg-green-400` | live / free / complete indicator | rule |
| `pages/OverviewPage.tsx:312` | `text-green-400` | "live" indicator | hand |
| `pages/OverviewPage.tsx:312` | `bg-green-400/10` | "live" indicator | hand |
| `pages/OverviewPage.tsx:312` | `border-green-400/20` | "live" indicator | hand |
| `pages/OverviewPage.tsx:313` | `bg-green-400` | live / free / complete indicator | rule |
| `pages/OverviewPage.tsx:341` | `text-green-400` | "live" indicator | hand |
| `pages/OverviewPage.tsx:342` | `bg-green-400` | live / free / complete indicator | rule |
| `pages/OverviewPage.tsx:368` | `text-green-400` | status map or status comparison | rule |
| `pages/OverviewPage.tsx:399` | `bg-blue-500/15` | status map or status comparison | rule |
| `pages/OverviewPage.tsx:399` | `text-blue-400` | status map or status comparison | rule |
| `pages/OverviewPage.tsx:400` | `bg-green-500/15` | status map or status comparison | rule |
| `pages/OverviewPage.tsx:400` | `text-green-400` | status map or status comparison | rule |
| `pages/OverviewPage.tsx:448` | `text-green-400` | "live" indicator | hand |
| `pages/OverviewPage.tsx:449` | `bg-green-400` | live / free / complete indicator | rule |
| `pages/OverviewPage.tsx:471` | `bg-green-500/10` | open-shifts count badge | hand |
| `pages/OverviewPage.tsx:471` | `text-green-400` | open-shifts count badge | hand |
| `pages/OverviewPage.tsx:471` | `border-green-500/20` | open-shifts count badge | hand |
| `pages/OverviewPage.tsx:483` | `bg-green-400` | open-shift dot | hand |
| `pages/OverviewPage.tsx:559` | `text-green-400` | success / saved / done message | rule |
| `pages/PaymentMethodsPage.tsx:141` | `text-green-400` | "Active" state of a payment method (toggle shows state) | hand |
| `pages/PaymentMethodsPage.tsx:141` | `border-green-500/30` | "Active" state of a payment method (toggle shows state) | hand |
| `pages/PaymentMethodsPage.tsx:141` | `hover:border-green-500/60` | "Active" state of a payment method (toggle shows state) | hand |
| `pages/products/BulkImageUpload.tsx:123` | `text-green-400` | success / saved / done message | rule |
| `pages/products/BulkImageUpload.tsx:132` | `bg-green-500/8` | "Upload complete" panel | hand |
| `pages/products/BulkImageUpload.tsx:132` | `border-green-500/30` | "Upload complete" panel | hand |
| `pages/products/BulkImageUpload.tsx:133` | `text-green-300` | live / free / complete indicator | rule |
| `pages/products/BulkPriceEditor.tsx:153` | `text-green-400` | status map or status comparison | rule |
| `pages/products/BulkProductImport.tsx:141` | `bg-green-500/8` | "Import complete" panel | hand |
| `pages/products/BulkProductImport.tsx:141` | `border-green-500/30` | "Import complete" panel | hand |
| `pages/products/BulkProductImport.tsx:142` | `text-green-300` | live / free / complete indicator | rule |
| `pages/products/BulkProductImport.tsx:143` | `text-green-400` | success / saved / done message | rule |
| `pages/products/BulkProductImport.tsx:144` | `text-green-400` | success / saved / done message | rule |
| `pages/products/CategoriesPage.tsx:128` | `text-green-400` | status map or status comparison | rule |
| `pages/products/CombosPage.tsx:211` | `text-green-400` | status map or status comparison | rule |
| `pages/products/MenuUpload.tsx:219` | `text-green-400` | "ok" | hand |
| `pages/products/MenuUpload.tsx:246` | `text-green-400` | "N saved" count | hand |
| `pages/products/ProductsPage.tsx:455` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/products/ProductsPage.tsx:455` | `text-green-400` | status map or status comparison | rule |
| `pages/products/ProductsPage.tsx:732` | `text-green-400` | status map or status comparison | rule |
| `pages/products/RecipeDrawer.tsx:403` | `text-green-400` | status map or status comparison | rule |
| `pages/products/RecipeDrawer.tsx:476` | `bg-green-600` | "saved" state of the button | hand |
| `pages/products/RecipeDrawer.tsx:513` | `bg-green-600` | "saved" state | hand |
| `pages/PromotionsPage.tsx:251` | `text-green-400` | status map or status comparison | rule |
| `pages/PromotionsPage.tsx:287` | `text-blue-400` | "Scheduled" state | hand |
| `pages/PromotionsPage.tsx:287` | `border-blue-500/30` | "Scheduled" state | hand |
| `pages/PromotionsPage.tsx:295` | `border-green-500/30` | "Active" state of a promotion (toggle shows state) | hand |
| `pages/PromotionsPage.tsx:295` | `text-green-400` | "Active" state of a promotion (toggle shows state) | hand |
| `pages/PromotionsPage.tsx:295` | `hover:bg-green-500/10` | "Active" state of a promotion (toggle shows state) | hand |
| `pages/ReportsPage.tsx:546` | `text-green-600` | status map or status comparison | rule |
| `pages/ReportsPage.tsx:1092` | `text-green-600` | status map or status comparison | rule |
| `pages/ReportsPage.tsx:1106` | `bg-green-500` | status map or status comparison | rule |
| `pages/ReportsPage.tsx:1117` | `text-green-600` | "good" band legend | hand |
| `pages/ReportsPage.tsx:1166` | `text-green-600` | status map or status comparison | rule |
| `pages/ReportsPage.tsx:1221` | `text-green-600` | status map or status comparison | rule |
| `pages/ReportsPage.tsx:1226` | `text-green-600` | status map or status comparison | rule |
| `pages/ReportsPage.tsx:1286` | `text-green-600` | threshold colouring | hand |
| `pages/ReportsPage.tsx:1289` | `text-green-600` | threshold colouring | hand |
| `pages/ReportsPage.tsx:1669` | `text-green-600` | tank level OK | hand |
| `pages/ReportsPage.tsx:1669` | `dark:text-green-400` | tank level OK | hand |
| `pages/ReportsPage.tsx:1818` | `bg-green-500` | status map or status comparison | rule |
| `pages/ReportsPage.tsx:1819` | `text-green-600` | status map or status comparison | rule |
| `pages/ReportsPage.tsx:1819` | `dark:text-green-400` | status map or status comparison | rule |
| `pages/ReservationsPage.tsx:50` | `text-blue-400` | status map or status comparison | rule |
| `pages/ReservationsPage.tsx:50` | `bg-blue-500/10` | status map or status comparison | rule |
| `pages/ReservationsPage.tsx:50` | `border-blue-500/20` | status map or status comparison | rule |
| `pages/ReservationsPage.tsx:51` | `text-green-400` | status map or status comparison | rule |
| `pages/ReservationsPage.tsx:51` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/ReservationsPage.tsx:51` | `border-green-500/20` | status map or status comparison | rule |
| `pages/settings/BranchReceiptOverrides.tsx:60` | `bg-green-500` | saved toast (fixed bottom-6 … text-white) | rule |
| `pages/settings/BrandingTab.tsx:207` | `text-green-600` | success / saved / done message | rule |
| `pages/settings/BulkItemCodeModal.tsx:137` | `bg-green-500/10` | success / saved / done message | rule |
| `pages/settings/BulkItemCodeModal.tsx:137` | `text-green-400` | success / saved / done message | rule |
| `pages/settings/BusinessProfileTab.tsx:97` | `bg-green-500` | saved toast (fixed bottom-6 … text-white) | rule |
| `pages/settings/DevicesTab.tsx:63` | `bg-green-500/15` | status map or status comparison | rule |
| `pages/settings/DevicesTab.tsx:63` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/DevicesTab.tsx:63` | `border-green-500/30` | status map or status comparison | rule |
| `pages/settings/EtimsSettingsPage.tsx:48` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/EtimsSettingsPage.tsx:50` | `text-blue-400` | status map or status comparison | rule |
| `pages/settings/EtimsSettingsPage.tsx:148` | `bg-green-500/10` | success / saved / done message | rule |
| `pages/settings/EtimsSettingsPage.tsx:148` | `text-green-400` | success / saved / done message | rule |
| `pages/settings/EtimsSettingsPage.tsx:214` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/FloorPlanTab.tsx:192` | `bg-green-500` | saved toast (fixed bottom-6 … text-white) | rule |
| `pages/settings/MinimartSettingsPage.tsx:121` | `bg-green-500` | saved toast (fixed bottom-6 … text-white) | rule |
| `pages/settings/ParkingSettingsPage.tsx:24` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/settings/ParkingSettingsPage.tsx:24` | `border-green-500/30` | status map or status comparison | rule |
| `pages/settings/ParkingSettingsPage.tsx:24` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/ParkingSettingsPage.tsx:30` | `border-green-500/30` | status map or status comparison | rule |
| `pages/settings/ParkingSettingsPage.tsx:30` | `bg-green-500/5` | status map or status comparison | rule |
| `pages/settings/ParkingSettingsPage.tsx:153` | `bg-green-500` | saved toast (fixed bottom-6 … text-white) | rule |
| `pages/settings/PetrolSettingsPage.tsx:62` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/settings/PetrolSettingsPage.tsx:62` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/PetrolSettingsPage.tsx:63` | `bg-blue-500/10` | status map or status comparison | rule |
| `pages/settings/PetrolSettingsPage.tsx:63` | `text-blue-400` | status map or status comparison | rule |
| `pages/settings/PetrolSettingsPage.tsx:203` | `bg-green-500` | saved toast (fixed bottom-6 … text-white) | rule |
| `pages/settings/PetrolSettingsPage.tsx:416` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/settings/PetrolSettingsPage.tsx:416` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/PetrolSettingsPage.tsx:471` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/settings/PetrolSettingsPage.tsx:471` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/PetrolSettingsPage.tsx:476` | `text-green-400` | stock direction (delivery in) | hand |
| `pages/settings/PetrolSettingsPage.tsx:661` | `text-green-400` | new level after delivery | hand |
| `pages/settings/PrintersPage.tsx:49` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/PrintersPage.tsx:49` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/settings/PrintersPage.tsx:49` | `border-green-500/20` | status map or status comparison | rule |
| `pages/settings/PrintersPage.tsx:370` | `bg-green-500` | saved toast (fixed bottom-6 … text-white) | rule |
| `pages/settings/PrintersPage.tsx:471` | `border-green-500/40` | enabled printer slot | hand |
| `pages/settings/PrintersPage.tsx:471` | `bg-green-500/5` | enabled printer slot | hand |
| `pages/settings/PrintersPage.tsx:484` | `bg-green-400` | printer "enabled" dot (audit: was auto-action) | hand |
| `pages/settings/PrintersPage.tsx:608` | `bg-green-500/5` | "✓ Prints all order items" | hand |
| `pages/settings/PrintersPage.tsx:608` | `border-green-500/20` | "✓ Prints all order items" | hand |
| `pages/settings/PrintersPage.tsx:609` | `text-green-400` | success / saved / done message | rule |
| `pages/settings/PrintersPage.tsx:708` | `text-green-400/80` | "✓ Items … will print here" | hand |
| `pages/settings/ReportSchedulerTab.tsx:157` | `text-green-400` | success / saved / done message | rule |
| `pages/settings/RestaurantSettingsPage.tsx:208` | `bg-green-500` | saved toast (fixed bottom-6 … text-white) | rule |
| `pages/settings/RolesTab.tsx:200` | `bg-green-500/20` | "saved" state | hand |
| `pages/settings/RolesTab.tsx:200` | `text-green-400` | "saved" state | hand |
| `pages/settings/RolesTab.tsx:200` | `border-green-500/30` | "saved" state | hand |
| `pages/settings/StaffTab.tsx:27` | `bg-green-500/15` | status map or status comparison | rule |
| `pages/settings/StaffTab.tsx:27` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/StaffTab.tsx:454` | `text-green-400` | success / saved / done message | rule |
| `pages/settings/WebhooksTab.tsx:153` | `text-green-400` | status map or status comparison | rule |
| `pages/settings/WebhooksTab.tsx:176` | `text-green-400` | success / saved / done message | rule |
| `pages/settings/WebhooksTab.tsx:205` | `text-green-400` | success / saved / done message | rule |
| `pages/SettingsPage.tsx:146` | `text-green-400` | success / saved / done message | rule |
| `pages/stock/BulkIngredientImport.tsx:146` | `bg-green-500/8` | "Import complete" panel | hand |
| `pages/stock/BulkIngredientImport.tsx:146` | `border-green-500/30` | "Import complete" panel | hand |
| `pages/stock/BulkIngredientImport.tsx:147` | `text-green-300` | live / free / complete indicator | rule |
| `pages/stock/IngredientsPage.tsx:339` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/stock/IngredientsPage.tsx:339` | `text-green-400` | status map or status comparison | rule |
| `pages/stock/IngredientsPage.tsx:566` | `text-green-400` | status map or status comparison | rule |
| `pages/stock/PurchaseOrdersPage.tsx:21` | `text-blue-400` | status map or status comparison | rule |
| `pages/stock/PurchaseOrdersPage.tsx:21` | `bg-blue-500/10` | status map or status comparison | rule |
| `pages/stock/PurchaseOrdersPage.tsx:23` | `text-green-400` | status map or status comparison | rule |
| `pages/stock/PurchaseOrdersPage.tsx:23` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/stock/PurchaseOrdersPage.tsx:373` | `text-green-400` | status map or status comparison | rule |
| `pages/stock/PurchaseOrdersPage.tsx:580` | `text-green-400` | success / saved / done message | rule |
| `pages/stock/PurchaseOrdersPage.tsx:580` | `bg-green-500/10` | success / saved / done message | rule |
| `pages/stock/StockTransfersPage.tsx:36` | `bg-blue-500/10` | status map or status comparison | rule |
| `pages/stock/StockTransfersPage.tsx:36` | `text-blue-400` | status map or status comparison | rule |
| `pages/stock/StockTransfersPage.tsx:37` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/stock/StockTransfersPage.tsx:37` | `text-green-400` | status map or status comparison | rule |
| `pages/stock/SuppliersPage.tsx:150` | `bg-green-500/10` | status map or status comparison | rule |
| `pages/stock/SuppliersPage.tsx:150` | `text-green-400` | status map or status comparison | rule |

## Money — keeps its colour (28)

Amounts, prices, revenue.

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `pages/customers/CreditAccountsPage.tsx:180` | `text-green-400` | an amount / price / revenue | rule |
| `pages/customers/CreditAccountsPage.tsx:232` | `text-green-400` | an amount / price / revenue | rule |
| `pages/DiscountsPage.tsx:199` | `text-green-400` | discount value | hand |
| `pages/manager/ManagerDashboard.tsx:224` | `text-green-400` | an amount / price / revenue | rule |
| `pages/manager/ManagerDashboard.tsx:270` | `text-green-400` | an amount / price / revenue | rule |
| `pages/manager/ManagerDashboard.tsx:394` | `text-green-400` | an amount / price / revenue | rule |
| `pages/manager/ManagerDashboard.tsx:503` | `text-green-400` | an amount / price / revenue | rule |
| `pages/manager/ManagerDashboard.tsx:604` | `#22c55e` | an amount / price / revenue | rule |
| `pages/manager/ManagerDashboard.tsx:1109` | `text-green-400` | an amount / price / revenue | rule |
| `pages/manager/ManagerDashboard.tsx:1147` | `text-green-400` | an amount / price / revenue | rule |
| `pages/manager/ManagerReportsPage.tsx:635` | `text-green-400` | an amount / price / revenue | rule |
| `pages/manager/ManagerReportsPage.tsx:838` | `text-green-500` | an amount / price / revenue | rule |
| `pages/manager/ManagerReportsPage.tsx:856` | `text-green-400` | an amount / price / revenue | rule |
| `pages/OverviewPage.tsx:393` | `text-green-400` | revenue today | hand |
| `pages/OverviewPage.tsx:416` | `text-green-400` | revenue figure | hand |
| `pages/products/CombosPage.tsx:227` | `text-green-400` | an amount / price / revenue | rule |
| `pages/products/CombosPage.tsx:286` | `text-green-400` | an amount / price / revenue | rule |
| `pages/products/VariantsDrawer.tsx:670` | `text-green-400/80` | price badge | hand |
| `pages/products/VariantsDrawer.tsx:670` | `bg-green-400/10` | price badge | hand |
| `pages/QRMenuPage.tsx:194` | `text-green-400` | an amount / price / revenue | rule |
| `pages/ReportsPage.tsx:1353` | `text-green-600` | an amount / price / revenue | rule |
| `pages/ReportsPage.tsx:1898` | `text-green-600` | an amount / price / revenue | rule |
| `pages/ReportsPage.tsx:1898` | `dark:text-green-400` | an amount / price / revenue | rule |
| `pages/settings/BrandingTab.tsx:342` | `#4ade80` | an amount / price / revenue | rule |
| `pages/settings/BrandingTab.tsx:348` | `#4ade80` | till preview: price colour | hand |
| `pages/settings/BrandingTab.tsx:348` | `rgba(34,197,94,.14)` | till preview: price colour | hand |
| `pages/settings/MinimartSettingsPage.tsx:217` | `text-green-400` | an amount / price / revenue | rule |
| `pages/settings/PetrolSettingsPage.tsx:413` | `text-green-400` | an amount / price / revenue | rule |

## Data / identity colour — keeps its colour (108)

Charts, zones, fuel grades, segments, movement and promotion types, KPI colours, category palette, printed documents.

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `lib/printDocument.ts:37` | `#4f46e5` | printed purchase-order colour (paper, not screen) | hand |
| `lib/printDocument.ts:38` | `#16a34a` | zone / movement-type / tone identity colour | rule |
| `pages/crm/CustomersPage.tsx:83` | `#16a34a` | customer-segment colour | hand |
| `pages/crm/CustomersPage.tsx:83` | `#EAF3DE` | customer-segment colour | hand |
| `pages/crm/CustomersPage.tsx:84` | `#2563eb` | customer-segment colour | hand |
| `pages/crm/CustomersPage.tsx:84` | `#E6F1FB` | customer-segment colour | hand |
| `pages/crm/CustomersPage.tsx:87` | `#EEEDFE` | customer-segment colour | hand |
| `pages/crm/CustomersPage.tsx:384` | `bg-green-500/70` | chart bar / peak / today marker / progress width | rule |
| `pages/inventory/AdjustmentModal.tsx:19` | `'green'` | zone / movement-type / tone identity colour | rule |
| `pages/inventory/AdjustmentModal.tsx:21` | `'blue'` | zone / movement-type / tone identity colour | rule |
| `pages/inventory/AdjustmentModal.tsx:89` | `'green'` | zone / movement-type / tone identity colour | rule |
| `pages/inventory/AdjustmentModal.tsx:90` | `border-green-500` | selected adjustment type in ITS identity colour (restock green) | hand |
| `pages/inventory/AdjustmentModal.tsx:90` | `bg-green-500/10` | selected adjustment type in ITS identity colour (restock green) | hand |
| `pages/inventory/AdjustmentModal.tsx:93` | `border-blue-500` | selected adjustment type in ITS identity colour | hand |
| `pages/inventory/AdjustmentModal.tsx:93` | `bg-blue-500/10` | selected adjustment type in ITS identity colour | hand |
| `pages/inventory/AdjustmentModal.tsx:99` | `'green'` | zone / movement-type / tone identity colour | rule |
| `pages/inventory/AdjustmentModal.tsx:99` | `text-green-400` | zone / movement-type / tone identity colour | rule |
| `pages/inventory/AdjustmentModal.tsx:99` | `text-blue-400` | zone / movement-type / tone identity colour | rule |
| `pages/inventory/MovementsDrawer.tsx:21` | `text-green-400` | zone / movement-type / tone identity colour | rule |
| `pages/inventory/MovementsDrawer.tsx:73` | `bg-green-500/10` | restock movement-type colour (audit: was auto-action) | hand |
| `pages/inventory/MovementsDrawer.tsx:73` | `text-green-400` | restock movement-type colour (audit: was auto-action) | hand |
| `pages/inventory/MovementsDrawer.tsx:75` | `bg-blue-500/10` | movement-type colour | hand |
| `pages/inventory/MovementsDrawer.tsx:75` | `text-blue-400` | movement-type colour | hand |
| `pages/manager/ManagerDashboard.tsx:198` | `#3b82f6` | KPI / grade / category / badge identity colour | rule |
| `pages/manager/ManagerDashboard.tsx:215` | `#22c55e` | chart bar / peak / today marker / progress width | rule |
| `pages/manager/ManagerDashboard.tsx:228` | `text-blue-400` | orders KPI colour | hand |
| `pages/manager/ManagerDashboard.tsx:330` | `#22c55e` | KPI / grade / category / badge identity colour | rule |
| `pages/manager/ManagerDashboard.tsx:605` | `#3b82f6` | KPI / grade / category / badge identity colour | rule |
| `pages/manager/ManagerDashboard.tsx:755` | `#3b82f6` | current-hour bar in a chart | hand |
| `pages/manager/ManagerDashboard.tsx:803` | `bg-blue-500` | chart bar / peak / today marker / progress width | rule |
| `pages/manager/ManagerReportsPage.tsx:180` | `#22c55e` | KPI / grade / category / badge identity colour | rule |
| `pages/manager/ManagerReportsPage.tsx:181` | `#3b82f6` | KPI / grade / category / badge identity colour | rule |
| `pages/manager/ManagerReportsPage.tsx:215` | `bg-blue-500` | chart bar / peak / today marker / progress width | rule |
| `pages/manager/ManagerReportsPage.tsx:235` | `bg-green-500` | chart bar / peak / today marker / progress width | rule |
| `pages/manager/ManagerReportsPage.tsx:294` | `text-green-400` | chart bar / peak / today marker / progress width | rule |
| `pages/manager/ManagerReportsPage.tsx:315` | `bg-blue-500` | chart bar / peak / today marker / progress width | rule |
| `pages/manager/ManagerReportsPage.tsx:385` | `bg-green-500` | chart bar / peak / today marker / progress width | rule |
| `pages/manager/ManagerReportsPage.tsx:695` | `#22c55e` | KPI / grade / category / badge identity colour | rule |
| `pages/manager/ManagerReportsPage.tsx:716` | `#22c55e` | KPI / grade / category / badge identity colour | rule |
| `pages/manager/ManagerReportsPage.tsx:717` | `#3b82f6` | KPI / grade / category / badge identity colour | rule |
| `pages/manager/ManagerReportsPage.tsx:807` | `#22c55e` | KPI / grade / category / badge identity colour | rule |
| `pages/OverviewPage.tsx:127` | `bg-blue-500` | chart bar / peak / today marker / progress width | rule |
| `pages/OverviewPage.tsx:140` | `text-blue-400` | chart bar / peak / today marker / progress width | rule |
| `pages/OverviewPage.tsx:387` | `bg-green-500` | chart bar / peak / today marker / progress width | rule |
| `pages/OverviewPage.tsx:512` | `bg-blue-500` | chart bar / peak / today marker / progress width | rule |
| `pages/OverviewPage.tsx:606` | `bg-blue-500` | chart bar / peak / today marker / progress width | rule |
| `pages/products/CategoriesPage.tsx:8` | `#22c55e` | KPI / grade / category / badge identity colour | rule |
| `pages/products/CategoriesPage.tsx:8` | `#3b82f6` | KPI / grade / category / badge identity colour | rule |
| `pages/PromotionsPage.tsx:36` | `text-blue-400` | promotion-type identity colour (BOGO) | hand |
| `pages/PromotionsPage.tsx:36` | `bg-blue-500/10` | promotion-type identity colour (BOGO) | hand |
| `pages/PromotionsPage.tsx:36` | `border-blue-500/20` | promotion-type identity colour (BOGO) | hand |
| `pages/ReportsPage.tsx:118` | `bg-blue-500` | order-type colour in a chart | hand |
| `pages/ReportsPage.tsx:406` | `bg-blue-600` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:406` | `bg-blue-200` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:406` | `dark:bg-blue-900` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:406` | `hover:bg-blue-400` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:441` | `bg-blue-50` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:441` | `dark:bg-blue-900/20` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:536` | `bg-blue-500` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:802` | `text-green-600` | restocked quantity (stock in) | hand |
| `pages/ReportsPage.tsx:802` | `dark:text-green-400` | restocked quantity (stock in) | hand |
| `pages/ReportsPage.tsx:1099` | `bg-green-100` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:1099` | `dark:bg-green-900/30` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:1341` | `bg-green-100` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:1341` | `dark:bg-green-900/20` | chart bar / peak / today marker / progress width | rule |
| `pages/ReportsPage.tsx:1524` | `'green'` | zone / movement-type / tone identity colour | rule |
| `pages/ReportsPage.tsx:1524` | `'blue'` | zone / movement-type / tone identity colour | rule |
| `pages/ReportsPage.tsx:1527` | `border-green-500/40` | insight-card tone | hand |
| `pages/ReportsPage.tsx:1527` | `bg-green-500/5` | insight-card tone | hand |
| `pages/ReportsPage.tsx:1529` | `border-blue-500/40` | KPI / grade / category / badge identity colour | rule |
| `pages/ReportsPage.tsx:1529` | `bg-blue-500/5` | KPI / grade / category / badge identity colour | rule |
| `pages/ReportsPage.tsx:1532` | `bg-green-500` | zone / movement-type / tone identity colour | rule |
| `pages/ReportsPage.tsx:1532` | `bg-blue-500` | zone / movement-type / tone identity colour | rule |
| `pages/ReportsPage.tsx:1580` | `"green"` | zone / movement-type / tone identity colour | rule |
| `pages/ReportsPage.tsx:1581` | `"blue"` | zone / movement-type / tone identity colour | rule |
| `pages/ReportsPage.tsx:1835` | `text-green-600` | litres delivered (stock in) | hand |
| `pages/ReportsPage.tsx:1835` | `dark:text-green-400` | litres delivered (stock in) | hand |
| `pages/ReportsPage.tsx:1863` | `text-green-600` | litres delivered (stock in) | hand |
| `pages/ReportsPage.tsx:1863` | `dark:text-green-400` | litres delivered (stock in) | hand |
| `pages/settings/BrandingTab.tsx:29` | `#6366f1` | client brand-colour preset (Indigo) | hand |
| `pages/settings/BrandingTab.tsx:31` | `#059669` | client brand-colour preset (Emerald) | hand |
| `pages/settings/FloorPlanTab.tsx:37` | `#2563eb` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/FloorPlanTab.tsx:37` | `#93c5fd` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/FloorPlanTab.tsx:38` | `#14532d` | zone / movement-type / tone identity colour | rule |
| `pages/settings/FloorPlanTab.tsx:38` | `#16a34a` | zone / movement-type / tone identity colour | rule |
| `pages/settings/FloorPlanTab.tsx:38` | `#86efac` | zone / movement-type / tone identity colour | rule |
| `pages/settings/MinimartSettingsPage.tsx:26` | `'blue'` | zone / movement-type / tone identity colour | rule |
| `pages/settings/MinimartSettingsPage.tsx:28` | `bg-blue-500/10` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/MinimartSettingsPage.tsx:28` | `border-blue-500/30` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/MinimartSettingsPage.tsx:28` | `text-blue-400` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/MinimartSettingsPage.tsx:219` | `"blue"` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/ParkingSettingsPage.tsx:176` | `text-green-400` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/PetrolSettingsPage.tsx:40` | `#22c55e` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/PetrolSettingsPage.tsx:238` | `text-green-400` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/PetrolSettingsPage.tsx:240` | `text-green-400` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/PetrolSettingsPage.tsx:324` | `#3b82f6` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:24` | `text-blue-400` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:24` | `border-blue-500/30` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:24` | `bg-blue-500/5` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:25` | `text-green-400` | zone / movement-type / tone identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:25` | `border-green-500/30` | zone / movement-type / tone identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:25` | `bg-green-500/5` | zone / movement-type / tone identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:31` | `bg-blue-400` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:32` | `bg-green-400` | zone / movement-type / tone identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:240` | `text-blue-400` | KPI / grade / category / badge identity colour | rule |
| `pages/settings/RestaurantSettingsPage.tsx:242` | `text-green-400` | KPI / grade / category / badge identity colour | rule |
| `pages/stock/IngredientsPage.tsx:550` | `text-green-400` | zone / movement-type / tone identity colour | rule |
| `pages/stock/IngredientsPage.tsx:550` | `text-blue-400` | zone / movement-type / tone identity colour | rule |

## Info (blue) — keeps its colour (41)

Info panels, header tags, badges and labels (the blue STATUS of ordered / in transit / scheduled is counted under Status).

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `pages/crm/CustomersPage.tsx:586` | `text-blue-400` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/crm/CustomersPage.tsx:586` | `bg-blue-500/10` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/crm/CustomersPage.tsx:586` | `border-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/DiscountsPage.tsx:149` | `text-blue-400` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/DiscountsPage.tsx:149` | `bg-blue-500/10` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/DiscountsPage.tsx:149` | `border-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/manager/ManagerDashboard.tsx:712` | `bg-blue-500/5` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/manager/ManagerDashboard.tsx:712` | `border-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/manager/ManagerDashboard.tsx:714` | `text-blue-400` | active-shift panel heading (blue info panel) | hand |
| `pages/products/CategoriesPage.tsx:102` | `text-blue-400/70` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/products/ProductsPage.tsx:295` | `text-blue-400` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/products/ProductsPage.tsx:295` | `bg-blue-500/10` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/products/ProductsPage.tsx:295` | `border-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/products/ProductsPage.tsx:408` | `bg-blue-500/10` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/products/ProductsPage.tsx:408` | `text-blue-400` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/products/ProductsPage.tsx:408` | `border-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/ReportsPage.tsx:444` | `bg-blue-100` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/ReportsPage.tsx:444` | `dark:bg-blue-800` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/ReportsPage.tsx:444` | `text-blue-700` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/ReportsPage.tsx:444` | `dark:text-blue-200` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/PrintersPage.tsx:392` | `bg-blue-500/5` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/PrintersPage.tsx:392` | `border-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/PrintersPage.tsx:395` | `text-blue-300` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/PrintersPage.tsx:396` | `text-blue-400/60` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/PrintersPage.tsx:397` | `text-blue-300` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/PrintersPage.tsx:397` | `text-blue-300` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/PrintersPage.tsx:550` | `bg-blue-500/10` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/PrintersPage.tsx:550` | `text-blue-400` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/PrintersPage.tsx:550` | `border-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/RestaurantSettingsPage.tsx:363` | `bg-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/RestaurantSettingsPage.tsx:363` | `text-blue-400` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/StaffTab.tsx:112` | `bg-blue-500/15` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/settings/StaffTab.tsx:112` | `text-blue-300` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/stock/IngredientsPage.tsx:235` | `text-blue-400` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/stock/IngredientsPage.tsx:235` | `bg-blue-500/10` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/stock/IngredientsPage.tsx:235` | `border-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/stock/IngredientsPage.tsx:314` | `text-blue-400` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/stock/IngredientsPage.tsx:314` | `bg-blue-400/10` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/stock/SuppliersPage.tsx:94` | `text-blue-400` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/stock/SuppliersPage.tsx:94` | `bg-blue-500/10` | info label / panel / tag (blue info, keeps its colour) | rule |
| `pages/stock/SuppliersPage.tsx:94` | `border-blue-500/20` | info label / panel / tag (blue info, keeps its colour) | rule |

## Owner decision needed (1)

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `pages/settings/BrandingTab.tsx:28` | `#3b82f6` | colour preset named "SwiftPOS Blue" — owner decision | hand |

## Not a hue colour — dropped from the count (2)

Near-black / navy surfaces the hue filter caught.

| File:line (at `bad4492`) | Colour | Why | By |
|---|---|---|---|
| `pages/LoginPage.tsx:138` | `#0a1628` | near-black / navy surface, not a hue colour | rule |
| `pages/settings/BrandingTab.tsx:326` | `#030712` | near-black / navy surface, not a hue colour | rule |

## Every file scanned (106) — uses per file

| File | Uses | File | Uses |
|---|---|---|---|
| `pages/manager/ManagerDashboard.tsx` | 58 | `pages/settings/KitchenDisplayTab.tsx` | 5 |
| `pages/ReportsPage.tsx` | 57 | `pages/manager/ManagerShiftTab.tsx` | 3 |
| `pages/settings/PrintersPage.tsx` | 44 | `pages/products/BulkPriceEditor.tsx` | 3 |
| `pages/products/ProductsPage.tsx` | 40 | `pages/settings/BranchReceiptOverrides.tsx` | 3 |
| `pages/settings/PetrolSettingsPage.tsx` | 38 | `index.css` | 2 |
| `pages/settings/RestaurantSettingsPage.tsx` | 35 | `lib/appFlavor.ts` | 2 |
| `pages/stock/PurchaseOrdersPage.tsx` | 35 | `lib/printDocument.ts` | 2 |
| `pages/stock/IngredientsPage.tsx` | 32 | `pages/manager/ManagerHistoryTab.tsx` | 2 |
| `pages/OverviewPage.tsx` | 31 | `pages/manager/ManagerMenuTab.tsx` | 1 |
| `pages/settings/StaffTab.tsx` | 30 | `App.tsx` | 0 |
| `pages/manager/ManagerReceivingTab.tsx` | 29 | `context/AuthContext.tsx` | 0 |
| `pages/PromotionsPage.tsx` | 29 | `context/BranchContext.tsx` | 0 |
| `pages/manager/ManagerReportsPage.tsx` | 28 | `context/BusinessContext.tsx` | 0 |
| `pages/crm/CustomersPage.tsx` | 24 | `context/PermissionsContext.tsx` | 0 |
| `pages/DiscountsPage.tsx` | 24 | `context/POSAuthContext.tsx` | 0 |
| `pages/ReservationsPage.tsx` | 24 | `context/ThemeContext.tsx` | 0 |
| `pages/OnboardingPage.tsx` | 22 | `hooks/usePrinterSettings.ts` | 0 |
| `pages/products/VariantsDrawer.tsx` | 22 | `hooks/useToast.ts` | 0 |
| `pages/expenses/ExpensesPage.tsx` | 21 | `lib/api.ts` | 0 |
| `pages/stock/StockTransfersPage.tsx` | 21 | `lib/buildReceiptOrder.ts` | 0 |
| `pages/settings/ParkingSettingsPage.tsx` | 19 | `lib/cart.ts` | 0 |
| `pages/settings/RolesTab.tsx` | 19 | `lib/config.ts` | 0 |
| `pages/QRMenuPage.tsx` | 17 | `lib/contrast.ts` | 0 |
| `pages/stock/SuppliersPage.tsx` | 17 | `lib/deviceFingerprint.ts` | 0 |
| `pages/settings/MinimartSettingsPage.tsx` | 15 | `lib/documentSpecs.ts` | 0 |
| `pages/inventory/AdjustmentModal.tsx` | 14 | `lib/escposRenderer.d.ts` | 0 |
| `pages/products/RecipeDrawer.tsx` | 14 | `lib/escposRenderer.js` | 0 |
| `pages/kds/KDSPage.tsx` | 13 | `lib/localDate.ts` | 0 |
| `pages/products/CombosPage.tsx` | 13 | `lib/localPrintServer.ts` | 0 |
| `pages/customers/CreditAccountsPage.tsx` | 12 | `lib/posRouting.ts` | 0 |
| `pages/BranchesPage.tsx` | 11 | `lib/posTerminal.ts` | 0 |
| `pages/LoginPage.tsx` | 11 | `lib/printKOT.ts` | 0 |
| `pages/settings/DevicesTab.tsx` | 11 | `lib/printReceipt.ts` | 0 |
| `pages/products/CategoriesPage.tsx` | 10 | `lib/printRouted.ts` | 0 |
| `pages/settings/ReportSchedulerTab.tsx` | 10 | `lib/printShiftReport.ts` | 0 |
| `pages/settings/WebhooksTab.tsx` | 10 | `lib/reprintReceipt.ts` | 0 |
| `pages/SettingsPage.tsx` | 10 | `lib/supabase.ts` | 0 |
| `pages/ForcePasswordChangePage.tsx` | 9 | `lib/terminology.ts` | 0 |
| `pages/products/BulkProductImport.tsx` | 9 | `lib/themes.ts` | 0 |
| `pages/settings/FloorPlanTab.tsx` | 9 | `lib/themeVars.ts` | 0 |
| `pages/FleetPage.tsx` | 8 | `lib/upload.ts` | 0 |
| `pages/inventory/InventoryPage.tsx` | 8 | `main.tsx` | 0 |
| `pages/inventory/MovementsDrawer.tsx` | 8 | `pages/kds/kdsConn.ts` | 0 |
| `pages/settings/BrandingTab.tsx` | 8 | `pages/manager/RemoteDayClose.tsx` | 0 |
| `pages/settings/BulkItemCodeModal.tsx` | 8 | `pages/OpenShiftsPage.tsx` | 0 |
| `pages/settings/EtimsSettingsPage.tsx` | 8 | `pages/orderRefund.ts` | 0 |
| `pages/BranchDetailPage.tsx` | 7 | `pages/settings/BusinessPage.tsx` | 0 |
| `pages/OrdersPage.tsx` | 7 | `pages/settings/DevicesPrintersPage.tsx` | 0 |
| `pages/PaymentMethodsPage.tsx` | 7 | `pages/settings/SettingsSection.tsx` | 0 |
| `pages/products/MenuUpload.tsx` | 7 | `pages/settings/StationsPage.tsx` | 0 |
| `pages/settings/BusinessProfileTab.tsx` | 7 | `pages/settings/UsersAccessPage.tsx` | 0 |
| `pages/stock/BulkIngredientImport.tsx` | 7 | `types/index.ts` | 0 |
| `pages/products/BulkImageUpload.tsx` | 6 | `vite-env.d.ts` | 0 |
