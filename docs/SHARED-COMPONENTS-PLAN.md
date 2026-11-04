# Shared components — plan (branch `shared-components`)

Owner-approved direction: one copy of each rule and, later, of each POS screen piece, instead of files copied into
every app and kept identical by `scripts/check-shared-sync.mjs`. Work happens on the branch `shared-components`
(from `dev` 7f8684c), goes to `dev` only when fully tested, then to `main`.

**Rules for the whole refactor:** no behaviour change; receipts byte-identical (`shared/printing` byte checks); the
desktop POS main chunk must not grow (`apps/desktop/test/lazy-load-a517.test.mjs`, limit 450 kB, 434.5 kB today); the
full CI step set after every step; before/after screenshots for every UI move; `dev` merged into the branch weekly; no
features on the branch. Printing (`shared/printing`), the desktop main process's own code and the server's internals
stay where they are.

Status: **steps 1 and 2 done and committed on the branch (37ffe35, d639d40; `dev` merged in 859329a); batch E
(section 8d) committed (51d83a4) — the last copies moved: 42 modules in `packages/core`, and step 3 started with
`packages/ui`. Batch F (section 8e) done, not committed: `MethodDot` and `Pager` moved to `packages/ui` (5 pieces);
`WeightModal`, `NoteModal` and `KitchenVoidModal` left as they are, with the reasons. Batch G (section 8g) done, not
committed: the category panel, menu bar, ☰, chip and Later button moved (6 pieces); the forecourt, the fuel keypad and
the product tile left, with the reasons; the desktop main chunk +611 bytes, for the owner to accept or undo. No copy
paths left (`SHARED` is empty). Batches F and G committed (db04710). `dev` c2ab634 (v1.0.23, A611–A620) merged in
(section 8h): `platformPrices` is the 43rd core module; the money field / tender keypad and the cart lines were looked
at and left (the two POS differ in behaviour); `check-shared-sync` is a CI step. After the merge the desktop POS main
chunk is 450.4 kB against the 450 kB budget — an owner decision (section 8h). Not merged into `dev`. Merging needs the
one Render change in section 4 first.**

---

## 1. The package mechanism (decision)

**Chosen: a plain folder package `packages/core` (`@zaptill/core`), consumed by each app as a `file:` dependency
(`"@zaptill/core": "file:../../packages/core"`). No npm workspaces, no root lockfile; each app keeps its own
`package.json` and `package-lock.json`.**

This is the mechanism the desktop installer already ships with: `apps/desktop` has consumed `@swiftpos/printing` as
`file:../../shared/printing` since printing became a package, and `release.yml` builds it on GitHub Actions. Step 1
extends the same idea to the cloud and the web.

How each kind of consumer resolves `@zaptill/core/<name>` (one `package.json`, `packages/core/package.json`):

| Consumer | How it builds | What it gets | Needs `packages/core/dist`? |
|---|---|---|---|
| Web dashboard + web POS, admin portal, desktop screens (Vite) | `vite build` | `exports["./*"].import` → `src/<name>.ts`, bundled like the app's own code (tree-shaken) | no |
| Their type-checks (`tsc --noEmit`, `moduleResolution: bundler`) | — | `exports["./*"].types` → `src/<name>.ts` | no |
| Server type-check (`moduleResolution: node`) | — | `typesVersions` → `src/<name>.ts` (not emitted into the server's `dist`) | no |
| Server runtime (`node dist/index.js`, CommonJS) | `npm run build` = `tsc -p ../../packages/core && tsc` | `exports["./*"].require` → `dist/<name>.js` | yes — built by the server's own build |
| Desktop main process (CommonJS in `app.asar`) | `tsc -b tsconfig.main.json` (project reference to `packages/core`) | `exports["./*"].require` → `node_modules/@zaptill/core/dist/<name>.js` inside `app.asar` | yes — built by `tsc -b` |

`packages/core` has no dependencies and no `node_modules`; it is compiled by the consumer's own TypeScript (5.9), so
no extra `npm ci` is needed anywhere. `dist/` and `*.tsbuildinfo` are git-ignored (root `.gitignore`).

### Options considered

| Option | Verdict | Why |
|---|---|---|
| **npm workspaces at the root** (`@zaptill/core` as a workspace) | rejected for now | Replaces the five per-app lockfiles with one root lockfile; `npm install` inside `apps/server` walks up to the root; Render and Vercel would install from the root (both hosting setups change, and every CI `npm ci` step and its cache key). Biggest blast radius for the same result. Can be revisited after the refactor. |
| **TS path aliases + bundler aliases only** (Vite `resolve.alias`, `tsc paths`, no package) | rejected | Works for Vite apps, but `tsc` does not rewrite `paths` in emitted code: the server's and the desktop main's compiled `require('../../packages/core/...')` would point outside the app — not in `app.asar`, not inside the server's folder — and pulling the files into the server's program changes its `dist` layout (`rootDir`). Would need a bundler for the server and the main process (a behaviour change of its own). |
| **`file:` dependency** (chosen) | chosen | Already proven in the installer (`@swiftpos/printing`); per-app lockfiles stay (each gains a 4-line link entry); runtime code is resolved through `node_modules`, which electron-builder packs into `app.asar`; Vite consumes source. |
| Keep copies, generate them from `packages/core` | fallback only | Needs no hosting change, but keeps 130+ copies in git — the thing the owner asked to remove. Use only if the Render change in section 4 cannot be made. |

---

## 2. Inventory — every `shared/*` file and its copies (from `check-shared-sync.mjs`, before step 1)

41 entries, 174 paths (41 canonical files + 133 copies). "Importers" = files in that app's `src` importing that copy.
"Tests/scripts" = test or script files that read a copy's path or pin its text (they change with the move). Every file
is pure TypeScript (no React, no DOM, no Node API), so every one is a `packages/core` candidate. No `shared/*.ts` file
is a React UI component; the UI candidates are in section 3.

| # | File (shared/) | Lines | Depends on | Copies (importers) | Tests/scripts reading a copy path | Class | Step-2 batch |
|---|---|---:|---|---|---:|---|---|
| 1 | `parkingTariff.ts` | 211 | — | `apps/server/src/shared/parkingTariff.ts` (0)<br>`apps/desktop/src/shared/parkingTariff.ts` (0) | 1 | core (pure TS) | C (money) |
| 2 | `paymentColours.ts` | 81 | — | `apps/desktop/src/shared/paymentColours.ts` (3)<br>`apps/dashboard/src/lib/paymentColours.ts` (5) | 1 | core (pure TS) | B |
| 3 | `tillChanges.ts` | 220 | — | `apps/server/src/lib/tillChanges.ts` (2)<br>`apps/desktop/src/main/tillChanges.ts` (2)<br>`apps/desktop/src/shared/tillChanges.ts` (0) | 7 | core (pure TS) | B |
| 4 | `syncTopics.ts` | 147 | — | `apps/server/src/lib/syncTopics.ts` (1)<br>`apps/desktop/src/main/syncTopics.ts` (2) | 2 | core (pure TS) | A |
| 5 | `logRedact.ts` | 61 | — | `apps/desktop/src/main/logRedact.ts` (1)<br>`apps/server/src/lib/logRedact.ts` (1) | 2 | core (pure TS) | A |
| 6 | `menuFilter.ts` | 190 | — | `apps/desktop/src/shared/menuFilter.ts` (2)<br>`apps/dashboard/src/lib/menuFilter.ts` (3) | 10 | core (pure TS) | B |
| 7 | `menuHours.ts` | 313 | — | `apps/desktop/src/shared/menuHours.ts` (2)<br>`apps/dashboard/src/lib/menuHours.ts` (4)<br>`apps/server/src/lib/menuHours.ts` (2) | 5 | core (pure TS) | B |
| 8 | `businessTerms.ts` | 236 | — | `apps/dashboard/src/lib/businessTerms.ts` (15)<br>`apps/desktop/src/shared/businessTerms.ts` (5)<br>`apps/server/src/lib/businessTerms.ts` (2) | 8 | core (pure TS) | B |
| 9 | `forecourt.ts` | 135 | — | `apps/desktop/src/shared/forecourt.ts` (1)<br>`apps/dashboard/src/lib/forecourt.ts` (2) | 5 | core (pure TS) | B |
| 10 | `analyticsTerms.ts` | 125 | `./businessTerms` | `apps/dashboard/src/lib/analyticsTerms.ts` (2)<br>`apps/server/src/lib/analyticsTerms.ts` (1) | 1 | core (pure TS) | B (with businessTerms) |
| 11 | `barcode.ts` | 443 | — | `apps/server/src/lib/barcode.ts` (1)<br>`apps/dashboard/src/lib/barcode.ts` (3)<br>`apps/desktop/src/shared/barcode.ts` (2)<br>`apps/desktop/src/main/barcode.ts` (1) | 18 (heavy) | core (pure TS) | C |
| 12 | `scaleBarcode.ts` | 325 | — | `apps/server/src/lib/scaleBarcode.ts` (3)<br>`apps/dashboard/src/lib/scaleBarcode.ts` (6)<br>`apps/desktop/src/shared/scaleBarcode.ts` (2)<br>`apps/desktop/src/main/scaleBarcode.ts` (2) | 2 | core (pure TS) | C (receipt/scale) |
| 13 | `labels.ts` | 662 | — | `apps/server/src/lib/labels.ts` (1)<br>`apps/dashboard/src/lib/labels.ts` (1)<br>`apps/desktop/src/shared/labels.ts` (2)<br>`apps/desktop/src/main/labels.ts` (1) | 24 (heavy) | core (pure TS) | C (label print) |
| 14 | `offers.ts` | 307 | — | `apps/server/src/lib/offers.ts` (3)<br>`apps/desktop/src/shared/offers.ts` (5)<br>`apps/desktop/src/main/offers.ts` (4)<br>`apps/dashboard/src/lib/offers.ts` (4) | 73 (heavy) | core (pure TS) | C (money) |
| 15 | `orderDetail.ts` | 168 | — | `apps/desktop/src/shared/orderDetail.ts` (2)<br>`apps/desktop/src/main/orderDetail.ts` (4)<br>`apps/dashboard/src/lib/orderDetail.ts` (1) | 1 | core (pure TS) | A |
| 16 | `paymentCatalogue.ts` | 108 | — | `apps/server/src/lib/paymentCatalogue.ts` (5)<br>`apps/desktop/src/shared/paymentCatalogue.ts` (8)<br>`apps/dashboard/src/lib/paymentCatalogue.ts` (4) | 1 | core (pure TS) | A |
| 17 | `numberInputs.ts` | 18 | — | `apps/desktop/src/shared/numberInputs.ts` (1)<br>`apps/dashboard/src/lib/numberInputs.ts` (1) | 1 | core (pure TS) | A |
| 18 | `orderNotes.ts` | 81 | — | `apps/desktop/src/shared/orderNotes.ts` (2)<br>`apps/desktop/src/main/orderNotes.ts` (4)<br>`apps/dashboard/src/lib/orderNotes.ts` (4)<br>`apps/server/src/lib/orderNotes.ts` (2) | 2 | core (pure TS) | C (receipt) |
| 19 | `confirmReasons.ts` | 45 | — | `apps/desktop/src/shared/confirmReasons.ts` (1)<br>`apps/desktop/src/main/confirmReasons.ts` (1)<br>`apps/dashboard/src/lib/confirmReasons.ts` (2)<br>`apps/server/src/lib/confirmReasons.ts` (1) | 1 | core (pure TS) | 0 (pilot) |
| 20 | `release.ts` | 27 | — | `apps/dashboard/src/lib/release.ts` (2)<br>`apps/server/src/lib/release.ts` (1)<br>`apps/admin/src/lib/release.ts` (1) | 36 (heavy) | core (pure TS) | D (version source) |
| 21 | `kitchenLines.ts` | 145 | — | `apps/desktop/src/shared/kitchenLines.ts` (4)<br>`apps/desktop/src/main/kitchenLines.ts` (4)<br>`apps/dashboard/src/lib/kitchenLines.ts` (2)<br>`apps/server/src/lib/kitchenLines.ts` (3) | 2 | core (pure TS) | C (receipt) |
| 22 | `businessDay.ts` | 95 | — | `apps/server/src/lib/businessDay.ts` (13)<br>`apps/desktop/src/main/businessDay.ts` (3)<br>`apps/dashboard/src/lib/businessDay.ts` (4) | 14 | core (pure TS) | B |
| 23 | `cashierHistory.ts` | 90 | — | `apps/server/src/lib/cashierHistory.ts` (5)<br>`apps/desktop/src/main/cashierHistory.ts` (4)<br>`apps/desktop/src/shared/cashierHistory.ts` (0)<br>`apps/dashboard/src/lib/cashierHistory.ts` (2) | 3 | core (pure TS) | A |
| 24 | `stockCountFreeze.ts` | 51 | — | `apps/desktop/src/main/stockCountFreeze.ts` (2)<br>`apps/desktop/src/shared/stockCountFreeze.ts` (2) | 2 | core (pure TS) | A |
| 25 | `stockGate.ts` | 180 | — | `apps/server/src/lib/stockGate.ts` (2)<br>`apps/desktop/src/main/stockGate.ts` (1)<br>`apps/desktop/src/shared/stockGate.ts` (2)<br>`apps/dashboard/src/lib/stockGate.ts` (3) | 2 | core (pure TS) | B |
| 26 | `support.ts` | 65 | — | `apps/server/src/lib/support.ts` (2)<br>`apps/desktop/src/main/support.ts` (2)<br>`apps/desktop/src/shared/support.ts` (1)<br>`apps/dashboard/src/lib/support.ts` (2)<br>`apps/admin/src/lib/support.ts` (1) | 22 (heavy) | core (pure TS) | B |
| 27 | `helpTopics.ts` | 201 | — | `apps/desktop/src/shared/helpTopics.ts` (1)<br>`apps/dashboard/src/lib/helpTopics.ts` (1) | 4 | core (pure TS) | A |
| 28 | `tenantHost.ts` | 94 | — | `apps/server/src/lib/tenantHost.ts` (3)<br>`apps/dashboard/src/lib/tenantHost.ts` (2)<br>`apps/admin/src/lib/tenantHost.ts` (1) | 3 | core (pure TS) | A |
| 29 | `productDays.ts` | 76 | — | `apps/desktop/src/shared/productDays.ts` (1)<br>`apps/desktop/src/main/productDays.ts` (3)<br>`apps/dashboard/src/lib/productDays.ts` (2)<br>`apps/server/src/lib/productDays.ts` (3) | 2 | core (pure TS) | A |
| 30 | `reversalRules.ts` | 196 | — | `apps/desktop/src/shared/reversalRules.ts` (3)<br>`apps/desktop/src/main/reversalRules.ts` (4)<br>`apps/dashboard/src/lib/reversalRules.ts` (4)<br>`apps/server/src/lib/reversalRules.ts` (4) | 4 | core (pure TS) | B |
| 31 | `expenseMethod.ts` | 59 | — | `apps/desktop/src/shared/expenseMethod.ts` (1)<br>`apps/desktop/src/main/expenseMethod.ts` (1)<br>`apps/dashboard/src/lib/expenseMethod.ts` (0)<br>`apps/server/src/lib/expenseMethod.ts` (3) | 1 | core (pure TS) | A |
| 32 | `historyView.ts` | 130 | — | `apps/desktop/src/shared/historyView.ts` (1)<br>`apps/dashboard/src/lib/historyView.ts` (1) | 3 | core (pure TS) | A |
| 33 | `delivery.ts` | 112 | — | `apps/desktop/src/shared/delivery.ts` (2)<br>`apps/desktop/src/main/delivery.ts` (3)<br>`apps/dashboard/src/lib/delivery.ts` (2)<br>`apps/server/src/lib/delivery.ts` (2) | 60 (heavy) | core (pure TS) | C (receipt) |
| 34 | `posFeatures.ts` | 232 | — | `apps/desktop/src/shared/posFeatures.ts` (4)<br>`apps/desktop/src/main/posFeatures.ts` (6)<br>`apps/dashboard/src/lib/posFeatures.ts` (4)<br>`apps/server/src/lib/posFeatures.ts` (6)<br>`apps/admin/src/lib/posFeatures.ts` (1) | 15 (heavy) | core (pure TS) | D |
| 35 | `mpesaReceive.ts` | 77 | — | `apps/server/src/lib/mpesaReceive.ts` (2)<br>`apps/dashboard/src/lib/mpesaReceive.ts` (2)<br>`apps/desktop/src/main/mpesaReceive.ts` (1)<br>`apps/desktop/src/shared/mpesaReceive.ts` (1) | 3 | core (pure TS) | A |
| 36 | `permissions.ts` | 518 | — | `apps/server/src/lib/permissions.ts` (19)<br>`apps/dashboard/src/lib/permissions.ts` (8)<br>`apps/admin/src/lib/permissions.ts` (0)<br>`apps/desktop/src/shared/permissions.ts` (2)<br>`apps/desktop/src/main/permissions.ts` (3) | 189 (heavy) | core (pure TS) | D (frozen catalogue) |
| 37 | `shiftConfirm.ts` | 238 | `./permissions` | `apps/desktop/src/shared/shiftConfirm.ts` (7)<br>`apps/dashboard/src/lib/shiftConfirm.ts` (5) | 7 | core (pure TS) | D (with permissions) |
| 38 | `themes.ts` | 187 | — | `apps/desktop/src/shared/themes.ts` (3)<br>`apps/dashboard/src/lib/themes.ts` (3)<br>`apps/server/src/lib/themes.ts` (2)<br>`apps/desktop/src/main/themes.ts` (1) | 19 (heavy) | core (pure TS) | B |
| 39 | `branchBranding.ts` | 144 | `./themes` | `apps/server/src/lib/branchBranding.ts` (2)<br>`apps/desktop/src/main/branchBranding.ts` (1)<br>`apps/desktop/src/shared/branchBranding.ts` (0)<br>`apps/dashboard/src/lib/branchBranding.ts` (3) | 3 | core (pure TS) | B (with themes) |
| 40 | `contrast.ts` | 149 | — | `apps/desktop/src/shared/contrast.ts` (2)<br>`apps/desktop/src/main/contrast.ts` (0)<br>`apps/dashboard/src/lib/contrast.ts` (2) | 13 | core (pure TS) | B |
| 41 | `paginate.ts` | 105 | — | `apps/dashboard/src/lib/paginate.ts` (32)<br>`apps/desktop/src/shared/paginate.ts` (6)<br>`apps/admin/src/lib/paginate.ts` (3) | 7 | core (pure TS) | A |

Notes on the inventory:

- **Dependencies between shared files** move together: `analyticsTerms` needs `businessTerms`, `branchBranding` needs
  `themes`, `shiftConfirm` needs `permissions`. Inside `packages/core/src` they import each other relatively
  (`./businessTerms`), which is fine — the guard in `check-shared-sync.mjs` only forbids apps importing core by a path.
- **`parkingTariff.ts`**: the server and desktop copies have no importers (`scripts/test-parking-tariff.mjs` runs its
  vectors). Move it to core with its vectors; the copies can simply be deleted.
- **Desktop has two copies of many files** — `src/main/*` (main process, compiled by `tsconfig.main.json`) and
  `src/shared/*` (screens, bundled by Vite). With core both import the same module.
- **Receipt-affecting files** (batch C: `orderNotes`, `kitchenLines`, `delivery`, `scaleBarcode`, `labels`,
  `offers`, `parkingTariff`): `escposBridge.ts` and the web print path use them. Each move runs `shared/printing`'s
  byte check (`npm test` there) and the receipt tests, and compares a printed sample.
- **Heavily pinned files** (`permissions` 189 tests/scripts, `offers` 73, `delivery` 60, `release` 36, `labels` 24,
  `support` 22, `themes` 19, `barcode` 18, `posFeatures` 15, `businessDay` 14): most tests read the copy's source
  text; each move repoints those reads to `packages/core/src/<file>`. Done last, in their own commits.
- **Stays as it is:** `shared/printing` (a real package with its own build, tests, byte checks and the web bundle
  `apps/dashboard/src/lib/escposRenderer.js` from `scripts/build-escpos-renderer.mjs`). It could later move to
  `packages/printing` with the same `file:` mechanism, but it is out of scope (printing stays).

---

## 3. Duplicated POS UI — web POS (`apps/dashboard/src/pages/pos`) vs desktop POS (`apps/desktop/src/renderer`)

"Changed lines" = lines added + removed by `git diff --no-index` between the two files (0 = identical).

**The two sides are styled differently**: the desktop screens use Tailwind classes (`POSPage.tsx` 240 `className`,
1 `style`), the web POS uses inline style objects and CSS variables (`CashierScreen.tsx` 341 `style={…}`, 33
`className`; `cashier/CategoryPanel.tsx` 0 `className`). A shared component must pick one; inline styles with the
POS CSS variables (`--pos-*`, `--act-strong`) work in both apps without Tailwind config changes, Tailwind would need
`packages/ui/src/**` in both `tailwind.config.js` `content` lists. Decide per component; screenshots before/after.

| Piece | Desktop | Web | Size (D / W lines) | Changed lines | Notes |
|---|---|---|---:|---:|---|
| Payment-method dot | `components/MethodDot.tsx` | `components/MethodDot.tsx` | 9 / 9 | 2 | near-identical — the first UI pilot. **Moved (8e): `@zaptill/ui/MethodDot`** |
| Weighed item (scale) modal | `components/WeightModal.tsx` | `pages/pos/WeightModal.tsx` | 88 / 88 | 68 | same logic (`scaleBarcode`), Tailwind vs inline. **Left (8e)** |
| List pager | `components/Pager.tsx` | `components/Pager.tsx` | 73 / 78 | 53 | used by manager lists too. **Moved (8e): `@zaptill/ui/Pager`, each app's look in its own `components/Pager.tsx`** |
| Note modal | `components/NoteModal.tsx` | `pages/pos/NoteModal.tsx` | 74 / 66 | 66 | uses `orderNotes`. **Left (8e)** |
| Kitchen void modal | `components/KitchenVoidModal.tsx` | `pages/pos/KitchenVoidModal.tsx` | 126 / 106 | 158 | **Left (8e): different behaviour** |
| Category side panel + menu bar (A537) | `components/CategoryPanel.tsx` | `pages/pos/cashier/CategoryPanel.tsx` | 257 / 271 | 200 | uses `menuFilter`/`menuHours`; the menu bar lives in both. **Moved (8g): `@zaptill/ui/CategoryPanel`, each app's look in its own `CategoryPanel.tsx`** |
| Forecourt: pumps / grades / gauges (A588) | `components/PumpsView.tsx` (`GradeGauge`, `Dispenser`), `POSPage.tsx` `ForecourtTabs` | `pages/pos/cashier/Forecourt.tsx` (`FuelStrip`, `PumpGrade`), `CashierScreen.tsx` | 306 / 79 | 361 | desktop has dispensers + gauges; web has strips + tank gauges. **Left (8g): different pieces** |
| Fuel keypad (KES / litres, quick amounts) | in `components/PumpsView.tsx` (since A588) | inline in `pages/pos/CashierScreen.tsx` (two number fields, no keypad) / `PetrolPOS.tsx` presets | — | — | **Left (8g): the web has no keypad; different behaviour** |
| Product tile | `POSPage.tsx` `ProductTile` (memo) | inline in `CashierScreen.tsx` | — | — | extract web side first. **Left (8g): both in A619-changed files; the badges' wording differs** |
| Cart lines | inline in `POSPage.tsx` | inline in `CashierScreen.tsx` (`cashier/useCart.ts` logic) | — | — | **Left (8h): different lines (kitchen mark, add-ons, courses, note button)** |
| Payment modal | `components/PaymentModal.tsx` | `pages/pos/PaymentModal.tsx` (+ split/discount/loyalty/M-Pesa panels) | 540 / 1116 | 1524 | large; only shared pieces (method buttons, tender keypad), late. **Money field / tender keypad left (8h): no keypad on either side, different fields** |
| M-Pesa panel | `components/MpesaPanel.tsx` | `pages/pos/MpesaStkPanel.tsx` | 111 / 331 | 418 | different flows (till vs STK push) |
| Shift confirm | `components/ConfirmShiftModal.tsx` | `components/ShiftConfirmations.tsx`, `pages/pos/ShiftModal.tsx` | 213 / 257 | 352 | both use `confirmReasons` (now core) |
| Z report | `components/ZReportView.tsx` | `pages/pos/ZReportModal.tsx` | 219 / 527 | 714 | printing stays; only the view could share |
| Printer settings | `components/PrinterSettingsModal.tsx` | `pages/pos/PrinterSettingsModal.tsx` | 299 / 159 | 414 | different printers (USB/network vs local print server) — keep separate |
| Wastage | `components/TillWastage.tsx` | `components/Wastage.tsx` | 161 / 250 | 339 | manager-side; low priority |
| Monthly pack | `components/MonthlyPackTab.tsx` | `pages/reports/MonthlyPackTab.tsx` | 267 / 306 | 341 | reports, not POS; out of scope for `packages/ui` v1 |
| The POS screen | `pages/POSPage.tsx` | `pages/pos/CashierScreen.tsx` (`POSPage.tsx` is a 12-line redirect) | 2574 / 3275 | 5437 | never shared whole — pieces only |

No shared money input / numeric keypad / badge component exists as a file today on either side (money fields and
keypads are inline; the web's `ReleaseBadge` is not POS). Those are extracted on both sides first, compared, then
moved — "simple first" in the owner's order.

---

## 4. Hosting — what the owner must change (and what not)

The documentation of both hosts is explicit (checked 2026-10-25):

- **Render:** "Files outside your service's root directory are not available to the service at build time or at
  runtime." `render.yaml` sets `rootDir: apps/server`, so `../../packages/core` is invisible there. **This must
  change before the branch reaches `dev`** (dev auto-deploys the dev API). Proven locally: a copy of `apps/server`
  alone fails with `error TS5058: The specified path does not exist: '../../packages/core'`; a copy of `apps/server` +
  `packages/` builds and the compiled route loads core.
- **Vercel:** projects created after 2020-08-27 have "Include source files outside of the Root Directory in the Build
  Step" **on by default**; the four projects (dashboard prod + dev, admin prod + dev) were created in 2026, so nothing
  should need changing — but it must be **checked** on each project.
- **GitHub Actions (`ci.yml`, `release.yml`, `security-scan.yml`, `nightly-e2e.yml`):** full checkout; no change needed
  (`release.yml` already builds `shared/printing` first; `tsc -b tsconfig.main.json` builds `packages/core` itself).

### Render — exact change (both API services: development and production)

Settings → Build & Deploy:

| Setting | Today | New |
|---|---|---|
| Root Directory | `apps/server` | *(empty — the repository root)* |
| Build Command | `npm install && npm run build` | `cd apps/server && npm install && npm run build` |
| Start Command | `node dist/index.js` | `cd apps/server && node dist/index.js` |
| Build Filters → Included Paths | *(none; the root directory did this)* | `apps/server/**` and `packages/core/**` |

The new commands work with today's `dev` code as well (they only `cd` first), so the change can be made and verified
with one ordinary deploy **before** the branch is merged; the process still starts in `apps/server` (same working
directory as today). The build filter keeps today's behaviour of not redeploying the API for dashboard, desktop or
website changes, and adds `packages/core/**` so a rule change redeploys it. If the services are synced from
`render.yaml` (Blueprint), the same change there:

```yaml
    # rootDir: apps/server   ← removed
    buildCommand: cd apps/server && npm install && npm run build
    startCommand: cd apps/server && node dist/index.js
    buildFilter:
      paths:
        - apps/server/**
        - packages/core/**
```

(`render.yaml` is **not** changed on the branch: whether the services follow the Blueprint lives in Render's
dashboard, not in the repository.)

### Vercel — check only (four projects)

Settings → Build and Deployment → Root Directory: keep `apps/dashboard` / `apps/admin`; confirm **"Include files
outside the root directory in the Build Step" is Enabled**. If an "Ignored Build Step" command exists that only
looks at `apps/dashboard` (or `apps/admin`), add `packages/` to it. Nothing else.

---

## 5. Steps and the checks for each

Every step: its own commit(s) on the branch; then **the full CI step set** locally (every `run:` step of `ci.yml`),
`shared/printing` `npm test` when a receipt-affecting file moves, `lazy-load-a517` main chunk size compared with the
previous step, and — for desktop-affecting steps — a real installer build (`electron-builder --win nsis --x64 --ia32
--publish never` into `apps/desktop/release-test`) with `app.asar` extracted and its require graph checked.

### Step 1 — the package, proven on every build (done on the branch)

- `packages/core` (`package.json`, `tsconfig.json`, `src/confirmReasons.ts` — moved from `shared/`).
- `"@zaptill/core": "file:../../packages/core"` in `apps/server`, `apps/dashboard`, `apps/desktop` (dependencies;
  lockfiles gain the link entry only). Admin does not use the pilot file; it gets the dependency with its first module.
- `apps/server` `build`/`dev` build core first; `apps/desktop/tsconfig.main.json` references `packages/core`; desktop
  `dev` watches with `tsc -b` (a plain `tsc -p` would stop at TS6305 until core is built).
- The four copies deleted; five imports repointed; `tests/prospect-features.test.mjs` reads the core file.
- `scripts/check-shared-sync.mjs`: entry removed; **new guards** — a core module may not reappear as a copy in
  `shared/` or an app's `lib/`, `shared/`, `main/` folder, may not stay listed in `SHARED`, and apps may not import
  `packages/core` by a relative path.
- `check-no-till-wording`, `check-header-keys`, `check-doc-refs`, `check-reference-names` now also scan `packages/`.
- Results: section 7.

### Step 2 — pure logic into `packages/core` (copies deleted), in batches

One batch per commit, smallest blast radius first (batch letters in the inventory):

1. **A — small, few readers** (14 files): `numberInputs`, `expenseMethod`, `productDays`, `orderDetail`,
   `paymentCatalogue`, `historyView`, `stockCountFreeze`, `mpesaReceive`, `cashierHistory`, `tenantHost`, `logRedact`,
   `syncTopics`, `paginate`, `helpTopics`.
2. **B — screens and setup rules** (14): `menuHours`, `menuFilter`, `forecourt`, `businessTerms` + `analyticsTerms`,
   `paymentColours`, `contrast`, `themes` + `branchBranding`, `stockGate`, `reversalRules`, `businessDay`,
   `tillChanges`, `support`.
3. **C — money and print** (8, one commit each, printing byte check + receipt tests each): `orderNotes`,
   `kitchenLines`, `delivery`, `scaleBarcode`, `barcode`, `labels`, `offers`, `parkingTariff` (+ its vectors).
4. **D — the most pinned** (4): `posFeatures`, `release` (moves with `apps/desktop`'s version — keep the bump script
   and `check-*` that read it in step), `permissions` + `shiftConfirm` (frozen permission catalogue,
   `check-permission-catalogue` / `-parity`).

Per file: `git mv shared/X.ts packages/core/src/X.ts`; delete every copy listed in `SHARED`; repoint imports to
`@zaptill/core/X`; add the dependency to any consumer app that lacks it (`npm install --save
@zaptill/core@file:../../packages/core` — check the lockfile diff is the link entry only); repoint tests/scripts that
read the copy (inventory column); remove the `SHARED` entry. When `SHARED` is empty, `check-shared-sync.mjs` keeps
only the core guards (and its "found nothing" safety check must be adjusted then).

### Step 3 — POS UI into `packages/ui` (`@zaptill/ui`), simple first

Same mechanism (`file:` dependency, source consumed by Vite; never imported by the server or the main process).
`react` stays a peer of the apps (no copy in `packages/ui`); the package must not pull its own React. Order:
`MethodDot` → `WeightModal` → `Pager` → `NoteModal` → `KitchenVoidModal` → money field / tender keypad (extracted
first) → fuel keypad → product tile → `CategoryPanel` + menu bar → cart lines → forecourt pieces. Each: screenshots
of the desktop POS and the web POS before/after (light and dark, a narrow and a wide screen), the main chunk size
(must not grow), the A517 test (the piece must not pull manager screens into the main chunk).

---

## 6. Risks and how each is handled

| Risk | Handling |
|---|---|
| **Electron packaging / `app.asar`** — a runtime path outside the app, a missing `dist`, src `.ts` shipped | Core reaches the main process only through `node_modules/@zaptill/core` (electron-builder copies the linked folder into `app.asar`; `files` excludes `*.ts`). Verified per step by extracting `app.asar` and walking every `require` of `dist/main` (section 7). `assert:built` and `tsc -b` ordering unchanged. |
| **Render root directory** | Section 4 — must be changed before merging to `dev`; verified with a clean copy of `apps/server` + `packages/`. |
| **Vercel root directory** | Default on; owner checks the toggle on four projects. Clean-copy builds of dashboard and admin pass. |
| **Vite resolution** | `exports["./*"].import` → TS source; Vite treats a linked package outside `node_modules` as source (transformed, tree-shaken). The dev server serves it (checked: `/@fs/…/packages/core/src/confirmReasons.ts` → 200, no `server.fs.allow` change needed). |
| **TS resolution** | `bundler` (dashboard, admin, desktop screens) uses `exports.types`; `node` (server, desktop main) uses `typesVersions`; both point at `src` so type-checks never need a build. The desktop main project reference needs `tsc -b` (CI and `build` already use it; `dev` switched to `tsc -b --watch`). |
| **Server Node ESM/CJS** | Core compiles to CommonJS (`module: commonjs`, ES2020) — same as the server and the main process today; `require` condition → `dist`. `tsx` (server `dev`, scripts) uses the `import` condition → source. |
| **Tests that read file paths or pin source text** | Inventory column; each move repoints them. Tests that type-strip a shared file (`node --experimental-strip-types`) read `packages/core/src/X.ts` directly (works: it is outside `node_modules`). |
| **`check-*` scripts that scan app `src` dirs** | `packages` added to the four scanners that listed `shared`. Others that scan only `apps/*/src` for app-specific patterns (routes, Supabase calls, IPC) are unaffected because core has none of those; re-check when a file with such patterns moves. |
| **CI caching** | `actions/setup-node` caches by the app lockfiles; core has no lockfile and no dependencies. No change. |
| **Desktop main chunk size** | Core is bundled exactly like the copy was; step 1 renderer output is byte-identical to before (section 7). Measured every step. |
| **A missing `dist` at runtime** (someone runs `node dist/index.js` after `tsc` only) | `npm run build` / `tsc -b` always build core first; `require` fails loudly (`MODULE_NOT_FOUND`), not silently. |
| **Merge conflicts with `dev`** (copies edited on `dev` after a move) | Weekly `dev` merge; `check-shared-sync` fails when a moved file's copy comes back, pointing at the core file. |

## 7. Step 1 results (2026-10-25/26, worktree `C:\swiftpos\pos-shared`)

Pilot: **`shared/confirmReasons.ts` → `packages/core/src/confirmReasons.ts`** (45 lines, pure; the manager's reason
where their count differs from the cashier's). Chosen because it is small, has no dependencies, is not on the receipt
path, has 4 consumers in 3 apps — the cloud (`routes/shifts.ts`), the web (`ShiftConfirmations.tsx`,
`pos/ShiftModal.tsx`), the desktop main process (`shiftService.ts`) and the desktop screens
(`ConfirmShiftModal.tsx`) — and only one test reading its path. Four copies deleted.

| Check | Result |
|---|---|
| Server `tsc` (type-check) | pass; `@zaptill/core/confirmReasons` resolves to `packages/core/src/confirmReasons.ts` (trace) — no build of core needed to type-check |
| Server `npm run build` | pass; `dist/` file list identical to before except `lib/confirmReasons.js(.map)` gone; `routes/shifts.js` requires `@zaptill/core/confirmReasons` → `packages/core/dist/confirmReasons.js`; the route module loads |
| Dashboard `tsc --noEmit` + `vite build` | pass (chunk hashes differ on every build because of the `__WEB_BUILD_TIME__` stamp) |
| Admin `vite build` | pass (admin does not use the pilot) |
| Desktop `tsc -p tsconfig.json` (screens) | pass |
| Desktop `build:all` (`tsc -b tsconfig.main.json` builds `packages/core` via the reference, then Vite) | pass; **renderer output byte-identical to before** (`diff -r` of `dist/renderer`: no difference); `dist/main` differs only by the moved file and one `require` line in `shiftService.js` |
| `lazy-load-a517` main chunk | **434.5 kB before, 434.5 kB after** (445,575 bytes, same file `index-QxmSppua.js`); 44 passed |
| Installer: `electron-builder --win nsis --x64 --ia32 --config electron-builder.config.js --config.directories.output=release-test --publish never` (no version bump) | pass — `release-test/ZapTill-1.0.20.exe` (212,763,481 bytes, combined 64/32-bit NSIS) + blockmap + `latest.yml` |
| `app.asar` extracted (`npx @electron/asar extract`, x64 and ia32) | `node_modules/@zaptill/core/{package.json, dist/confirmReasons.js}` present (no `.ts` sources, no `.d.ts`; a 9 kB `tsconfig.tsbuildinfo` rides along, as it does for `@swiftpos/printing`); no `dist/main/confirmReasons.js`; identical in both arches |
| Require graph of the packaged main process (every `require` in `dist/main` resolved from its own file, transitively) | 137 files, 763 requires — **every one resolves inside the app**; the only core edge `dist/main/shiftService.js → node_modules/@zaptill/core/dist/confirmReasons.js`; no `../packages` path anywhere |
| Packaged exe, node mode (`ELECTRON_RUN_AS_NODE=1 ZapTill.exe`): require from inside `app.asar` | `@zaptill/core/confirmReasons` resolves to `…\resources\app.asar\node_modules\@zaptill\core\dist\confirmReasons.js`; `reasonsNeeded`/`cleanReasons` give the expected answers |
| Packaged exe (x64): the WHOLE main-process start from `app.asar` (the A517 harness — Electron API stubbed, throw-away user data folder, no network) | start ran (timing line logged), **250 IPC handlers registered**, `@zaptill/core` among the modules loaded at start next to `better-sqlite3` and `@swiftpos/printing` |
| Hosted-build simulation — Render (clean copy of `apps/server` + `packages/`, `npm install && npm run build`) | pass; compiled route loads core from the copy's `packages/core/dist` |
| Hosted-build simulation — Render as configured today (clean copy of `apps/server` only) | **fails**: `error TS5058: The specified path does not exist: '../../packages/core'` — hence section 4 |
| Hosted-build simulation — Vercel (clean copies of `apps/dashboard` + `packages/`, `apps/admin` + `packages/`, `npm install && npm run build`) | both pass |
| Vite dev server (dashboard) | serves `/@fs/…/packages/core/src/confirmReasons.ts` (200) with no `server.fs.allow` change |
| `check-shared-sync` guards | pass on the tree; fail as intended on a re-grown copy (`apps/server/src/lib/confirmReasons.ts`, `apps/dashboard/src/lib/confirmReasons.ts`) and on a relative import/require of `packages/core` |
| **Full CI step set** (`cisteps.py`: every `run:` step of `ci.yml`, after `npm ci` in every app) | **237 steps run, 9 "failed" — all known Windows noise, none from this change**: schema audit (`python3` not on this PC); `money-reports` (the local-hour case, TZ); and 7 steps that exit 127 with libuv's `Assertion failed … async.c` **after every case passed** (migration tests: 89 files, the one flagged `test-migrations-41-42.mjs` 29/0; offline suites: `petrol-pos-web-a588` 17/0, `report-collected` 5/0, `void-owner-row` 5/0; desktop `server-setup-a503` 30/0, `a534-small-items` 30/0, `a554-log-fixes`, `monthly-pack-till` 19/0). `check-register-consistency` and `check-test-registration` pass (no new test files, so no register entry). |

**Found on the way (not caused by this change, present on `dev` 7f8684c):** in the locally built installer the
**32-bit** app cannot load its database driver: `better-sqlite3` 13 ships prebuilt binaries only for x64 and arm64
(`prebuilds/win32-x64.node`, `win32-arm64.node`), its loader looks for `prebuilds/win32-ia32.node` and then
`build/Release/better_sqlite3.node`, and neither is in `win-ia32-unpacked` (`@electron/rebuild` reports "finished"
with `buildFromSource=false` but builds nothing). The x64 start runs; the ia32 start stops at `MODULE_NOT_FOUND` in
`better-sqlite3/lib/binding.js`. Locally npm 11's install-script policy also skipped `better-sqlite3`'s
`node-gyp rebuild`, so the GitHub release runner may differ — **the owner should check the published 1.0.20
installer's 32-bit app (`resources\app.asar.unpacked\node_modules\better-sqlite3`) or a 32-bit till before
releasing** (a client runs Windows 10 32-bit).

## 8. Step 2 progress (2026-10-26/27, worktree `C:\swiftpos\pos-shared`, not committed)

Batches A and B done except two files, `numberInputs` and `forecourt` (below). **26 files moved** into `packages/core/src` (27 with the pilot);
`check-shared-sync.mjs` now guards **63 copy paths, down from 174** (169 after step 1): 26 canonical `shared/*.ts`
files and 80 app copies deleted tonight (106 paths), 111 with step 1.

Only files that `dev` had **not** changed since 7f8684c were moved (checked per file against every copy path:
`git -C C:\swiftpos\pos diff --name-only 7f8684c origin/dev -- <copies>`; on `origin/dev` acc00db only
`release.ts` differs, which is batch D). Every core file is **byte-identical** to the `shared/` file it replaces
(including its header comment — kept so git's rename detection carries any later `dev` edit of `shared/X.ts` into
`packages/core/src/X.ts` at the merge; the comments are refreshed after the merge).

| Batch | Moved (copies deleted) |
|---|---|
| A (13 of 14) | `expenseMethod` (5), `productDays` (5), `orderDetail` (4), `paymentCatalogue` (4), `historyView` (3), `stockCountFreeze` (3), `mpesaReceive` (5), `cashierHistory` (5), `logRedact` (3), `syncTopics` (3), `tenantHost` (4), `paginate` (4), `helpTopics` (3) |
| B (13 of 14) | `paymentColours` (3), `contrast` (4), `stockGate` (5), `businessDay` (4), `reversalRules` (5), `tillChanges` (4), `menuHours` (4), `menuFilter` (3), `businessTerms` (4) + `analyticsTerms` (3), `themes` (5) + `branchBranding` (5), `support` (6) |

Inside core the two pairs import each other relatively (`./businessTerms`, `./themes`), as before.

**Skipped (stay as copies, still in `SHARED`):**

| File | Why |
|---|---|
| `numberInputs.ts` (A) | Not pure: a DOM helper (`Document`, `Event`, `HTMLInputElement`). Core compiles without the DOM library on purpose (server and main process must not reach for `document`), so its own build fails (TS2304). It belongs with the screen pieces (`packages/ui`, step 3), or core gets a `dom` sub-entry later. |
| `forecourt.ts` (B) | Name clash: the till has its **own, different** `apps/desktop/src/main/forecourt.ts` (A588 pump counters, reads SQLite). The core guard treats any same-named file in an app's `main/` folder as a re-grown copy and fails. **Decided and done in batch C (section 8b):** a documented "different module" exception in the guard, no rename. |
| `release.ts` (D) | Changed on `dev` since 7f8684c (the version bumps) — moves after the `dev` merge, with batch D as planned. **Moved in batch D before the merge, on the owner's instruction (section 8c, with the merge notes there).** |

**Mechanism changes (small):**

- `apps/admin` now depends on `@zaptill/core` (`file:../../packages/core`, lockfile diff = the link entry only)
  — needed for `tenantHost` and `paginate`.
- `packages/core/types/url.d.ts` (new) + `"include": ["src/**/*.ts", "types/*.d.ts"]` in `packages/core/tsconfig.json`:
  `tenantHost.ts` uses `new URL()`, a global in Node, Electron and browsers but not in lib ES2020. The declaration
  covers only the properties core uses; only core's own build sees it (the apps type-check core with their own
  DOM / Node types). No emitted JavaScript changes.

**Importers:** every app import of a moved file now reads `'@zaptill/core/<name>'` — 234 import lines in ~150 app files,
**one line per imported module, nothing else on the line changed** (checked: every added line in `apps/*/src`
contains `@zaptill/core/`). Tests and scripts that read a copy's path, required `dist/main/<name>.js` /
`dist/lib/<name>.js`, or pinned an import line were repointed (≈60 files); the "copies are byte-identical" cases now
assert "one file in `packages/core`, no copy left".

**Verification (after each of 9 groups, and at the end):**

| Check | Result |
|---|---|
| Server `tsc --noEmit` + `npm run build` (from a clean `dist`) | pass (one native crash 134 of `tsc` on the very first cold run of the night, gone on rerun; not reproducible) |
| Dashboard `tsc --noEmit` + `vite build` | pass |
| Admin `tsc --noEmit` + `vite build` | pass; **`dist` byte-identical to before** |
| Desktop `tsc -p tsconfig.json`, `tsc -b tsconfig.main.json --force`, `build:all` | pass; **`dist/renderer` byte-identical to before** after every group; `dist/main` differs only by the moved files and `require` lines |
| `lazy-load-a517` main chunk | **445,575 bytes (434.5 kB), unchanged** — same file `index-QxmSppua.js` after every group |
| Every `scripts/check-*.mjs` (31) | pass |
| Tests reading the moved files (~75 suites, root + desktop) | pass (desktop `a554-log-fixes` 41/0 then the known libuv exit 127) |
| **Full CI step set** (`cisteps.py`, every `run:` step of `ci.yml`, after its own `npm ci` steps) | **237 steps run, 10 "failed" — all known Windows noise, none from this change**: schema audit (`python3` not on this PC); desktop `money-reports` (the local-hour case, TZ); and 8 steps that exit 127/1 with libuv's `Assertion failed … async.c` **after every case passed** (migrations: 89 files, the flagged one `test-migration-41-42` "all green"; offline suites: `cashier-money-switch` 10/0, `old-till-compat-a505` 10/0, `report-collected` 5/0, `staff-roster-cloud` 7/0, `void-owner-row` 5/0; `petrol-pos-web-a588` 17/0; desktop `server-join` 37/0, `server-setup-a503`, `a534-small-items` 30/0, `a554-log-fixes` 41/0, `monthly-pack-till` 19/0). Which suites hit the libuv crash varies run to run. |
| **Installer** (`electron-builder --win nsis --x64 --ia32 … --config.directories.output=release-test --publish never`, no version bump) | pass — `ZapTill-1.0.20.exe` 212,809,053 bytes + blockmap + `latest.yml`; deleted afterwards |
| `app.asar` (x64, extracted) | `node_modules/@zaptill/core/{package.json, dist/*.js}` — **all 27 modules**, no `.ts`, no `types/`; no moved file left in `dist/main`; require graph: 135 files, 763 requires, **every one resolves inside the app**, 30 edges into `@zaptill/core`, no `packages/` path anywhere |
| Packaged exe (x64, node mode, from inside `app.asar`) | all 27 core modules load from `…\resources\app.asar\node_modules\@zaptill\core\dist`; `tenantHost.isTenantOrigin` answers as before (true / false for the look-alike); the WHOLE main-process start (A517 harness) ran, **250 IPC handlers**, `@zaptill/core` loaded at start. ia32 not checked — the branch predates the A590 32-bit driver fix (expected). |

**Merge with `dev` (simulated read-only with `git merge-file`, base 7f8684c / branch / `origin/dev`):** 14 importers
changed on both sides; 10 merge cleanly, **4 conflict in their import block only** (`apps/server/src/jobs/ownerAlerts.ts`,
`jobs/watchdog.ts`, `lib/dayCutoff.ts` — `businessDay`; `routes/admin.ts` — `support`): take `dev`'s block and change
the one specifier to `@zaptill/core/<name>`. `dev` adds no new importer of a moved file (same 162 importing files).

**What remains** (updated after batch D, section 8c):

1. The owner commits batch C and batch D on the branch.
2. Merge `dev` into the branch: the 4 import-block conflicts above, the batch C importers `dev` changed, and batch D's
   merge notes (section 8c: 13 modify/delete conflicts on app copies `dev` edited, 2 new `dev` importers). Then rerun
   everything.
3. `numberInputs.ts` — step 3 (`packages/ui`, or a DOM entry in core); stays a copy until then.
4. Refresh the "ONE file: shared/X.ts, copied to …" header comments inside the moved core files (after the merge), and
   the few comments/strings that still name a `shared/` path (sections 8b, 8c).
5. Render change (section 4) before any of this reaches `dev`.
6. Step 3 — POS UI into `packages/ui`.

## 8b. Step 2 batch C (2026-10-29, worktree `C:\swiftpos\pos-shared`, not committed)

Batch C (money and print) and `forecourt` done: **9 files moved** into `packages/core/src` — `orderNotes` (5 paths),
`kitchenLines` (5), `delivery` (5), `scaleBarcode` (5), `barcode` (5), `labels` (5), `offers` (5), `parkingTariff` (3,
with its vectors `scripts/test-parking-tariff.mjs`), `forecourt` (3). 9 canonical files (`git mv`, **byte-identical**,
header comments kept, `git diff --cached -M`: R100 each) and **32 app copies deleted**; `apps/server/src/shared/` is
empty and gone. `packages/core` now holds **36 modules**; `check-shared-sync.mjs` guards **22 copy paths** (63 before,
174 at the start): `numberInputs` (3, step 3) and batch D — `release` (4), `posFeatures` (6), `permissions` (6),
`shiftConfirm` (3). Skipped: none (all nine are pure — no imports, no DOM, fs, SQLite or Electron).

None of the nine, nor any of their copies, had changed on `dev` since 7f8684c (checked by the owner's session,
including `dev`'s uncommitted work).

**Importers:** 78 import lines in 47 app files now read `'@zaptill/core/<name>'`, one line per module, nothing else on
the line changed (every added line in `apps/*/src` contains `@zaptill/core/`). The desktop main process's own
`'../forecourt'` (`ipc/catalogue.ts` → `main/forecourt.ts`) and `'./ipc/labels'` (its IPC handler) are not copies and
stay. **Tests and scripts repointed (17 files):** `tests/` `order-notes`, `kitchen-voids`, `free-delivery`,
`prospect-features`, `scale-barcode-a577`, `barcode-labels-a571`, `offers`, `promotions-scope-a518`,
`petrol-pos-web-a588`, `format`; `apps/desktop/test/` `order-notes`, `kitchen-voids`, `weighed-items-a577`,
`petrol-pos-a588`; `scripts/test-parking-tariff.mjs`; `apps/website/scripts/render-labels.mjs` (reads core; the
generated `labels.generated.json` and its `note` text unchanged, so the site's label test still matches); and
`check-shared-sync.mjs`. Type-stripped imports read `packages/core/src/<name>.ts`; `require(dist/…/kitchenLines.js)` →
`require('@zaptill/core/kitchenLines')`; the "server built?" probes that looked for `dist/lib/scaleBarcode.js` /
`barcode.js` now look for `dist/routes/pos.js` / `products.js`; the petrol chunk check looks for
`/packages/core/src/forecourt.ts` in the main chunk (still absent). Left as text for the header refresh: comments in
`ci.yml`, `apps/website` (README, `LabelSamples.astro`, `parking.astro`), `shared/printing/README.md` and the `source`
string in `scripts/push-domain-producers.json`.

**`forecourt` — the "different module" exception (decided: an exception, not a rename).** `check-shared-sync.mjs` has a
`DIFFERENT_MODULE` table with one entry, `apps/desktop/src/main/forecourt.ts` (the till's A588 pump counters, read from
its SQLite). The core guard skips that path only while it is **not a copy**: it must not equal the core file (line
endings normalised), must not define any name `packages/core/src/forecourt.ts` exports, and must still import
`getLocalDb` from `'./localDb'` and call it. Mutations checked, each fails the guard: the core file pasted over it; the
file plus an `export function gradeColour`; plus an `export const QUICK_AMOUNTS`; its `localDb` import changed; an
empty `apps/desktop/src/shared/forecourt.ts`. The OK line names the exception. The dashboard's `lib/forecourt.ts` was a
copy (identical) and is deleted; `tests/format.test.mjs`'s allow-list entry for `lib/forecourt.ts` `moneyText` is
removed (the file is gone; core is outside that scan) with a comment, and its "allow-list still needed" case passes.

**Verification** (after each of the 9 files: builds, byte checks, every `check-*`, printing, parking, 31 receipt /
label / module suites; then all of it again at the end, then the CI set and the installer):

| Check | Result |
|---|---|
| Server `tsc --noEmit` + `npm run build` (from a clean `dist`) | pass |
| Dashboard `tsc --noEmit` + `vite build` | pass |
| Admin `tsc --noEmit` + `vite build` | pass; **`dist` byte-identical to before** after every file |
| Desktop `tsc -p tsconfig.json`, `tsc -b tsconfig.main.json --force`, `build:all` | pass; **`dist/renderer` byte-identical to before** after every file (and after the installer's own `build:all`); `dist/main`: the 8 moved modules' `.js`/`.d.ts` gone, 24 changed files whose every changed line is a `require` (or a `.d.ts` `import … from`) line |
| Compiled moved modules (receipt bytes) | `packages/core/dist/<name>.js` **byte-identical** to the old `dist/main/<name>.js` for all 8 the till compiled (the receipt path: `escposBridge` uses `orderNotes`, `scaleBarcode`); the server's old `dist/lib` copies equal it except ES2022 → ES2020 syntax only (`100_000` → `100000` in `delivery`, `barcode`, `parkingTariff`; `??=` written out in `labels`) — the same values (core targets ES2020, as the till always did) |
| `lazy-load-a517` main chunk | **445,575 bytes (434.5 kB), unchanged** — same file `index-QxmSppua.js` after every file; 44/0 |
| Every `scripts/check-*.mjs` (31) | pass |
| `shared/printing` `npm test` (byte check + sample check) | 13/0 after every file |
| Parking tariff vectors (`npx tsx scripts/test-parking-tariff.mjs`, now on core) | 30/0 |
| Receipt / print suites | `receipt-compact-a530` 7/0, `receipt-escpos-format`, `receipt-payment-block` 6/0, `receipt-permission` 22/0, `reprint-history`, `web-receipt-money` 6/0, `print-documents`, `tiny-bridge-printing`, `a534-update-state-receipt` 18/0; desktop `receipt-copies` 9/0, `test-print-business-name` 11/0, `zreport-print-live` 5/0 — pass |
| Suites reading the moved files | `order-notes` 16/0 + desktop 34/0, `kitchen-voids` 16/0 + desktop 31/0, desktop `kitchen-extras-a559` 9/0, `free-delivery` 17/0 + desktop 13/0, `prospect-features` 19/0, `scale-barcode-a577` 26/0, desktop `weighed-items-a577` 36/0, `barcode-labels-a571` 46/0, desktop `labels-a571` 67/0, website `labels.test.mjs`, `offers` 26/0, `offers-cloud` 16/0, `promotions-scope-a518` 12/0, `format` 25/0, desktop `petrol-pos-a588` 49/0, `petrol-pos-web-a588` 17/0 (then the libuv exit 127) |
| **Full CI step set** (`cisteps.py`) | **237 steps run, 9 "failed" — all known Windows noise, none from this change** (rerun alone to confirm): schema audit (`python3` not on this PC); desktop `money-reports` 17/1 (the local-hour case, TZ); 7 steps exiting with libuv's `Assertion failed … async.c` after every case passed — migrations (alone: 89 files, only `test-migrations-41-42` flagged, 29/0), offline suites (alone, 302 files: `cashier-money-switch` 10/0, `old-till-compat-a505` 10/0, `petrol-pos-web-a588` 17/0, `report-collected` 5/0, `scale-barcode-a577` 26/0, `staff-roster-cloud` 7/0, `void-owner-row` 5/0), `petrol-pos-web-a588`, desktop `server-join` 37/0, `server-setup-a503` 30/0, `a554-log-fixes` 41/0, `monthly-pack-till` 19/0. (An earlier full run the same night showed 10, with 54 migration files crashing under load; alone they pass.) |
| **Installer** (`npm run build:all`, then `electron-builder --win nsis --x64 --ia32 --config electron-builder.config.js --config.directories.output=release-test --publish never`, no version bump) | pass — `ZapTill-1.0.20.exe` 212,816,189 bytes + blockmap + `latest.yml`; `release-test` deleted afterwards |
| `app.asar` (x64 extracted; ia32 identical in `dist/` and `@zaptill`) | `node_modules/@zaptill/core/{package.json, dist/*.js}` — **all 36 modules** incl. the 9 new ones, no `.ts`; none of the moved files left in `dist/main` (its `forecourt.js` is the till's own module, byte-identical to before); require graph: 135 files, 763 requires, **every one resolves inside the app**, 48 edges into `@zaptill/core`, no `packages/` path |
| Packaged exe (x64, node mode, from inside `app.asar`) | all 36 core modules load from `…\resources\app.asar\node_modules\@zaptill\core\dist`; parking 2 h at the mall tariff = 150, `barcode.nextInStoreCodes`, `orderNotes.noteLines` answer as in the source tree; the WHOLE main-process start (A517 harness) ran, **250 IPC handlers**, `@zaptill/core` loaded at start |

Also fixed in passing: the section 8 table row for the packaged exe had a Windows path whose backslashes had turned
into control characters (`\r`, `\a`, `\n`); restored.

## 8c. Step 2 batch D (2026-10-30, worktree `C:\swiftpos\pos-shared`, on top of batch C, not committed)

Batch D done on the owner's instruction, before the `dev` merge: **4 files moved** into `packages/core/src` —
`posFeatures` (6 paths), `release` (4), `permissions` (6), `shiftConfirm` (3; it imports `./permissions`, so the two
moved together). 4 canonical files (`git mv`, **byte-identical**, R100 each, header comments kept) and **15 app copies
deleted**. `packages/core` now holds **40 modules**; `check-shared-sync.mjs` guards **3 copy paths** (`numberInputs`,
step 3, untouched). Skipped: none. All four are pure (no DOM, fs, SQLite or Electron), and on the branch every copy was
identical to its canonical file.

(The move script also rewrote `shared/shiftConfirm.ts`'s own `./permissions` import while `permissions` was being moved
first. That one line was put back from `HEAD` before verification, so the core file is byte-identical to the canonical.)

**Importers:** 67 import lines in 59 app files now read `'@zaptill/core/<name>'`, one line per module, nothing else on
the line changed. **Tests and scripts repointed (40 files):**
- type-stripped imports and source pins now read `packages/core/src/<name>.ts` (24 files had `shared/permissions.ts`,
  among them the migration tests 134, 142, 143, 147, 159 and 169, `test-permission-catalogue` and
  `check-permission-catalogue`);
- `require(dist/lib/{posFeatures,permissions,release}.js)` and `dist/main/permissions.js` became
  `require('@zaptill/core/<name>')`;
- `kitchen-font-a543` and `permissions-web-a490` now pin the import line `'@zaptill/core/…'`;
- `partner-roles-a550`'s "the copies are identical" case now asserts "one catalogue in `packages/core`, no copy left";
- the role-name allow-lists in `permissions-web-a490` and desktop `a490-permissions` dropped the deleted copies;
- `check-permission-catalogue` now also scans `packages/core/src`. The rules that moved there were scanned as their app
  copies before; it still passes with the same keys (727 files; the catalogue may still name broad keys).

**`release`:** no script writes it (the version is bumped by hand with `apps/desktop/package.json`). Its readers:
- the cloud's `/api/version` route, the dashboard's `ReleaseBadge` and the admin portal, all now importing
  `@zaptill/core/release`;
- `tests/release-version.test.mjs`, which asserts `RELEASE` = `apps/desktop/package.json`'s version (now
  `require('@zaptill/core/release')`).

`ci.yml`, `release.yml`, `scripts/*` and `electron-builder.config.js` do not read it. Its only `release` is the output
folder name.

**`shiftConfirm` — a second "different module" exception.** `apps/server/src/lib/shiftConfirm.ts` is the cloud's own
rules (who may confirm, from `./approver` and `./effectiveKeys`; the confirm view's lines). It is not a copy (it was never
in `SHARED`), but the core guard saw it as a regrown copy. `DIFFERENT_MODULE` is now a table of per-file rules:
- **forecourt:** no name in common with core, and it must still be the SQLite reader;
- **server `shiftConfirm`:** no core *value* in common (the two share one type name, `CashBreakdown`), and it must
  still import `./approver` and `keysForRow` from `./effectiveKeys`.

Each rule fails a real copy. Mutations checked: the core file pasted over it; an added
`export function maySignedInConfirm`; its `./approver` import changed; forecourt's paste again; an empty
`apps/dashboard/src/lib/permissions.ts`. The server's own importers of `./shiftConfirm` stay as they are; its
`./permissions` import became `@zaptill/core/permissions`.

**Merge notes for `dev`** (checked read-only against `dev` 4f7ba62):
- `dev` changed all four modules since 7f8684c: `permissions` +225 lines, `posFeatures` +47, `release` the version, and
  the server's own `shiftConfirm.ts`. `shared/X.ts` edits follow the 100 % rename into `packages/core/src/X.ts`.
- **13 modify/delete conflicts** are expected on the app copies `dev` edited (5 `permissions`, 5 `posFeatures`,
  3 `release`). On `dev` those copies were identical to their `shared/` file, so resolve each by deleting the copy.
- `dev` adds **2 new importers** (`apps/desktop/src/main/ipc/dayClose.ts`, `apps/server/src/lib/webPosSignIn.ts`), each
  to be switched to `@zaptill/core/<name>` at the merge.

**Verification** (after each of 3 groups — `posFeatures`; `release`; `permissions` + `shiftConfirm` — then the CI set
and the installer):

| Check | Result |
|---|---|
| Server `tsc --noEmit` + `npm run build` (clean `dist`), dashboard `tsc` + `vite build`, admin `tsc` + build, desktop `tsc -p`, `tsc -b --force`, `build:all` | pass after every group |
| Admin `dist` | **byte-identical** to before after every group |
| Desktop `dist/renderer` | **byte-identical after `posFeatures` and `release`.** After `permissions` + `shiftConfirm`, **one dead CSS rule left the stylesheet**: `.lowercase{text-transform:lowercase}`. Tailwind had generated it from the word "lowercase" in a *comment* of the deleted `apps/desktop/src/shared/permissions.ts` (`content: ./src/**/*.{ts,tsx}`); no screen uses the class (no other file in `apps/desktop/src` names it). The CSS is 36 bytes shorter, so its hash changed, and with it every chunk's file name. Every JS chunk is otherwise byte-identical (compared with the hashes normalised). No behaviour change; recorded for the owner. |
| `dist/main` and server `dist` | moved modules gone; every other changed line is a `require` line (or a `.d.ts` `import`); `packages/core/dist/permissions.js` and `posFeatures.js` are **byte-identical** to the old `dist/main` and server `dist/lib` copies (sourcemap line aside), and `release.js` to the server's; the server's own `lib/shiftConfirm.js` changed only in its `permissions` require |
| `lazy-load-a517` main chunk | **445,575 bytes, unchanged** (44/0); renamed `index-BQSuSMoH.js` only because the CSS hash changed |
| `petrol-pos-a588` (main chunk budget) | 49/0 |
| `check-permission-parity` | pass, **same result** ("58 keys enforced, 76 registered, 47 named; unregistered 0, ungated 16, phantom 0 — all at baseline"); only the scanned-file counts fell by the deleted copies |
| `check-permission-catalogue` | pass, same keys (68 fine keys) |
| Every `scripts/check-*.mjs` (31) | pass |
| `shared/printing` `npm test` | 13/0 |
| Parking vectors | 30/0 |
| Suites reading the moved files | all pass: e.g. `permissions-a490-routes` 130/0, `permissions-a490-api` 28/0, `permissions-web-a490` 19/0, desktop `a490-permissions` 93/0, `shift-confirm` 28/0 + desktop 50/0, `manager-cash-lines-a527` 15/0, desktop `close-branch-a520` 45/0, `partner-roles-a550` 12/0, `partner-login-a550` 33/0, `release-version` 8/0, `staff-a562` 24/0, `cashier-money-switch` 10/0, `kitchen-font-a543` 5/0, `receipt-compact-a530` 7/0, `login-otp` 24/0, migration tests 134/142/143/147/159/169, `test-permission-catalogue` 6/0 |
| **Full CI step set** (`cisteps.py`) | **237 steps run, 9 "failed"; none come from this change** (each rerun alone): schema audit (`python3`); desktop `money-reports` 17/1 (TZ); libuv `async.c` after all passed (migrations: only `41-42` flagged, 29/0; offline suites: `petrol-pos-web-a588` 17/0, `report-collected` 5/0, `void-owner-row` 5/0; desktop `server-setup-a503` 30/0, `a554-log-fixes` 41/0, `monthly-pack-till` 19/0). **New:** `partner-my-branches-a582` 19/2 — its fixtures are dated 2026-10-20/22 and `/api/loss-alerts` shows "the last 7 days", so it started failing on 2026-10-30. With the clock set back to 2026-10-23 (a preload) it passes 21/0. It fails on the batch C tree as well (baseline). A test that ages out; for the owner, not this branch. |
| **Installer** (`build:all`, then `electron-builder --win nsis --x64 --ia32 … --config.directories.output=release-test --publish never`, version 1.0.20, not bumped) | pass — `ZapTill-1.0.20.exe` 212,821,093 bytes; `release-test` and the extracted asars deleted afterwards |
| `app.asar` (x64; ia32 identical in `dist/` and `@zaptill`) | **all 40 core modules** in `node_modules/@zaptill/core/dist`, no `.ts`; no moved file left in `dist/main`; require graph: 135 files, 763 requires, every one inside the app, 57 edges into `@zaptill/core` |
| Packaged exe (x64, node mode) | all 40 core modules load from inside `app.asar`. `permissions` gives 68 catalogue keys, 11 cashier default keys, and `hasPermission` true; `posFeatures` 15 keys; `RELEASE` 1.0.20 (`v1.0.20 · abcdef1`); `shiftConfirm` loads. All the same as the source tree. The WHOLE main-process start (A517 harness) ran, 250 IPC handlers |

## 8d. Batch E — the last copies, and step 3 begins (2026-10-30, worktree `C:\swiftpos\pos-shared`, not committed)

Done overnight on the owner's instruction, on top of the `dev` merge (859329a). `check-shared-sync.mjs` listed 17 copy
paths in five groups after the merge. All five moved; **`SHARED` is now empty.**

**Into `packages/core` (step 2's recipe):** `customerScreen` (A606) and `customerDetails` (A607), both pure (no imports
at all). Two `git mv` (R100) and **8 app copies deleted**: server `lib/`, dashboard `lib/`, desktop `main/` and
`shared/`. 25 app files had their import line switched to `'@zaptill/core/<name>'`. `packages/core` holds **42
modules**.

**Step 3 starts: `packages/ui` (`@zaptill/ui`).** The screen pieces the web POS and the desktop POS share:
- `CustomerScreenView.tsx` and `CustomerAskForm.tsx` (the customer screen's view and form, A606 / A607, copied between
  `apps/desktop/src/shared` and `apps/dashboard/src/lib`);
- `numberInputs.ts` (the mouse-wheel guard, a DOM helper, so it never fitted core).

Three `git mv` and **4 app copies deleted**. `apps/desktop/src/shared` is now empty and gone. 7 app files import
`'@zaptill/ui/<name>'`.

How the package is wired:
- **Shape:** `package.json` with an `exports` entry per piece, pointing at the source (`./src/<name>.tsx`). Vite builds
  it with the app, so there is no build step and no `dist`. React is a **peer** (the app's own React; never a copy in
  the package).
- **Links:** both apps have `"@zaptill/ui": "file:../../packages/ui"`. Each lockfile diff is the 13-line link entry only.
- **Resolution:** the pieces import `react` and `@zaptill/core`, but `packages/ui` has no `node_modules`. So both apps
  resolve through the link's own path: `preserveSymlinks` in the dashboard's and the desktop's `tsconfig.json` and Vite
  config. React and core then come from the app's own `node_modules`, so there is one React.
- **Dashboard chunking:** with `preserveSymlinks`, `@zaptill/*` modules sit under `node_modules`, and the dashboard's
  `manualChunks` would have put them all in the eager `vendor` chunk. `@zaptill` is now excluded from that rule, so the
  pieces chunk with the pages that use them, as before.
- **Never server-side:** the cloud and the desktop main process (tsc, no React, no bundler) never import it. The sync
  check now fails if they do.

**`check-shared-sync.mjs`:**
- `SHARED` is empty.
- The "no copy grows back" guard covers `packages/ui` as well as `packages/core`.
- A relative import of either package fails.
- `@zaptill/ui` in `apps/server/src` or `apps/desktop/src/main` fails.
- The "found nothing" safety check counts packaged modules (45), not copies.
- Mutations checked: a view copied back into `apps/dashboard/src/lib` fails; a server file importing `@zaptill/ui`
  fails.

**Tests repointed:**
- the cloud's `customer-details-a607` and `customer-screen-a606`: core by name, views bundled from `packages/ui/src`;
- the desktop's `customer-details-a607`, `customer-display-a606` and `shift-confirm`: the same; the main-chunk checks
  match the file name, wherever it lives;
- `format` dropped its three `lib/` allow entries (the files are outside its scan now).

**Verification:**

| Check | Result |
|---|---|
| `tsc` — server, dashboard, admin, desktop `tsconfig.json` and `tsconfig.main.json` | pass |
| Builds — server, desktop main and renderer, dashboard, admin | pass |
| Desktop `dist/renderer` against a build of 859329a | **byte-identical** (21 files) |
| Dashboard `dist` against a build of 859329a | **identical** apart from the build timestamp (`index`, `ReleaseBadge`); 106 JS files, same bytes. Before the `manualChunks` fix it was not: 90 files, the shared pieces folded into `vendor` |
| Desktop POS main chunk (`lazy-load-a517`, `petrol-pos-a588`) | 446.4 kB, the same as 859329a (44/0, 49/0) |
| Suites on the moved files | `customer-details-a607` 29/0, `customer-screen-a606` 17/0, `format` 25/0, `petrol-pos-web-a588` 17/0; desktop `customer-details-a607` 84/0, `customer-display-a606` 66/0, `shift-confirm` 50/0 |
| `check-shared-sync` | pass: "45 modules live in packages/core and packages/ui with no copies" |
| **Full CI step set** (`cisteps.py`) | 265 steps, 11 "failed". Nine are the known Windows noise: the schema audit (`python3`), the migrations install, libuv `async.c` exit 127 after every case passed (offline suites, desktop `server-join`, `server-setup-a503`, `a534-small-items`, `a554-log-fixes`, `monthly-pack-till`), desktop `money-reports` (TZ). Two were real, from the `dev` merge rather than batch E: see below |
| Every test, migration script and desktop test run on its own | no real failure after the fixes below (only desktop `money-reports`, the TZ case) |

**Found and fixed during the checks:**
- **From the `dev` merge (859329a), missed then:** migration tests 175, 176 and 177 (A594 / A595) and `brand-polish-a609`
  still read `shared/permissions.ts` and `shared/themes.ts`. They now read `packages/core/src`. These two CI steps
  failed on the merge commit too.
- **From this batch:** `till-scope-enforce-a545` scanned `apps/desktop/src/shared` for the POS's own writes, and the
  folder is gone. It and `desktop-writes-allowed`, which skipped the missing folder silently, now scan
  `packages/core/src` and `packages/ui/src` (`.ts` and `.tsx`).

## 8e. Batch F — step 3 continues (2026-11-01, not committed)

Done overnight on the owner's instruction, on top of batch E (51d83a4). The next five pieces in step 3's order were
looked at: `MethodDot`, `WeightModal`, `Pager`, `NoteModal`, `KitchenVoidModal`. The rule for each: the shared piece
renders exactly what each app renders today, or the pair is left. **Two moved, three left.** `packages/ui` now holds
**5 pieces** (plus `numberInputs`).

**Moved:**
- **`MethodDot`** — the two copies were byte-identical (inline styles only, no class names). One `git mv` from the
  dashboard (R100), the desktop copy deleted. 11 app files import `'@zaptill/ui/MethodDot'` (8 desktop, 3 web).
- **`Pager`** (and `usePageSize`) — the JavaScript was the same in both; the copies differed in class names only, plus
  the web's phone layout (the short range `51–100 of 1,234`, "Per page" in a span that is `sr-only` on a phone, the
  numbered pages in a span hidden below `sm`). `packages/ui/src/Pager.tsx` draws the one structure and takes a
  **`look`**: every class name, and the web's three phone-only parts as optional fields (left out, the node is not
  drawn, which is the desktop's pager as before). Each app's `components/Pager.tsx` is now its look and a one-line
  wrapper (`<SharedPager {...props} look={LOOK} />`) that also re-exports `usePageSize`, so the **27 importers did not
  change**.

How the class names are handled (new in this batch — batch E's pieces had no Tailwind classes):
- Tailwind builds each app's stylesheet from that app's `src/**` only (`tailwind.config.js` `content`). The shared
  `Pager.tsx` holds **no class names at all**; they stay in each app's own `components/Pager.tsx`, where its build finds
  them. Neither `content` list changed, and both stylesheets are byte-identical.
- The web's short range text comes with its look (`rangeShort: { className, text: rangeShort }`), not from an import in
  the shared file. A first version imported `rangeShort` in `Pager.tsx`: the desktop's main chunk, which holds the page
  maths, then exported one more name for the lazy `ManagerPage` chunk (+9 bytes). Passing it through the look keeps
  the desktop from ever referencing it; the main chunk is the same size as before.

**Left as they are, and why:**
- **`WeightModal`** — the keypad logic (`typeKey`, the keyboard handler) is the same, but the two differ in more than
  style: the amount is formatted with the device's locale on the desktop (`toLocaleString(undefined, …)`) and with
  `'en-KE'` on the web, so on a desktop whose Windows locale is not English the text differs; and the markup differs in
  its elements (desktop `h3` / `p` in a wrapper `div`, web two bare `div`s; desktop `p` for the grams line, web `div`),
  not only in classes. One component would need a look that switches element types — two markups in one file, nothing
  shared. Next step if wanted: move the pure `typeKey` (identical, exported in both) to `packages/core`, leave the views.
- **`NoteModal`** — the same element differences (`h3` / `p` vs `div`), and the order note's placeholder text differs
  ("Customer will collect at 1pm" on the desktop, "Collect at 1pm" on the web): a visible difference, not style. To
  share it, the owner first decides one wording and one markup (a visible change, needs the before/after screenshots
  of step 3), then it moves.
- **`KitchenVoidModal`** — **different behaviour**: the desktop modal calls `posApi.kitchen.void` itself, asks
  `posApi.shift.canConfirm()` whether the signed-in person is a manager, takes the till's `KitchenLinePayload` lines
  and closes only from its ✕; the web modal gets `signedInManager` and an `onSubmit` from the cashier screen, takes
  `{ order_item_id, name, qty, amount }` lines, closes on a click outside, has a Cancel button and no spinner, and
  formats money with the device's locale (desktop `'en-KE'`). Merging would change one app or the other.

**`check-shared-sync.mjs`:**
- For `packages/ui` pieces the "no copy grows back" search now covers the whole of `apps/dashboard/src`,
  `apps/desktop/src/renderer` and `apps/admin/src` by file name (the screen pieces lived in `components/` and
  `pages/pos/`, which the old `lib/` / `shared/` / `main/` list did not cover).
- `LOOK_WRAPPERS`: the two `components/Pager.tsx` files are allowed under the piece's name only while each stays a look
  — it imports the piece from `'@zaptill/ui/Pager'`, has no React import and draws no element of its own (no lowercase
  JSX tag outside comments).
- Mutations checked: `MethodDot.tsx` copied into `apps/dashboard/src/pages/pos` fails; the old desktop pager pasted
  over the desktop's `components/Pager.tsx` fails ("delete apps/desktop/src/renderer/components/Pager.tsx").
- Output: "47 modules live in packages/core and packages/ui with no copies".

**Tests repointed:** `tests/paginate.test.mjs` and the desktop's `menu-pages.test.mjs` read the shared
`packages/ui/src/Pager.tsx` together with the app's look; the class pins (teal / theme current page, the phone layout,
the wrap) now pin the look's fields and the shared file's use of them; the desktop pin also checks that its look has no
phone-only parts. `payment-colours`, `pages-everywhere` and `paginate-everywhere` needed no change (they pin the
importers, which did not change).

**Verification:**

| Check | Result |
|---|---|
| `tsc` — server, dashboard, admin, desktop `tsconfig.json` and `tsconfig.main.json` | pass |
| Builds — server, desktop main (`tsc -b tsconfig.main.json --force`) and renderer (`vite build`), dashboard, admin | pass |
| Rendered markup, old against new (`react-dom/server`, both apps' pagers at 0–5,000 rows × 3 sizes × 7 pages × 2 nouns, `MethodDot` for six methods) | **762 renders, 0 differ** (the same harness with the apps swapped finds 182 differences, so it does detect them) |
| Desktop `dist/renderer` against a build of 51d83a4 (file-name hashes normalised) | 37 of 39 files the same (`index.html` included). **`index-*.js` (main chunk): same size, 457,681 bytes**; the only change is two export letters swapped (`d` / `e`, the same two functions) because `ManagerPage` now imports them in another order. **`ManagerPage-*.js`: +497 characters** — the shared pager with its `look` and the desktop's look object in place of the old pager, plus the minifier's renamed locals. Stylesheet byte-identical |
| Dashboard `dist` against a build of 51d83a4 (hashes normalised) | 124 of 126 files the same. `ReleaseBadge`: the build timestamp only. **`index-*.js`: +370 characters** — the pager is in the dashboard's main chunk; it is now the shared pager reading its `look` plus the web's look object, and the minifier's renamed locals. Stylesheet byte-identical |
| Desktop POS main chunk (`lazy-load-a517`, `petrol-pos-a588`) | **446.4 kB, unchanged** (44/0, 49/0) |
| Suites on the moved pieces | `paginate` 28/0, `paginate-everywhere` 148/0, `payment-colours` 8/0; desktop `menu-pages` 14/0, `pages-everywhere` 21/0 |
| Other suites run (they scan the component folders or the POS screen) | `pos-cart-parity` 9/0, `web-feel` 47/0, `web-pos-theme` 22/0, `branding-web-contrast` 11/0, `scale-barcode-a577` 26/0, `format` 25/0, `till-scope-enforce-a545` 7/0, `desktop-writes-allowed` 3/0, `customer-details-a607` 29/0, `customer-screen-a606` 17/0, `petrol-pos-web-a588` 17/0 and 11 more; desktop `till-feel` 24/0, `order-notes` 34/0, `weighed-items-a577` 36/0, `a519-till-items` 69/0, `a490-permissions` 93/0, `customer-display-a606` 66/0, `customer-details-a607` 84/0, `shift-confirm` 50/0 and 5 more (`a554-log-fixes` 41/0, then the known libuv `async.c` exit 127) |
| `check-shared-sync` | pass: 47 modules, no copies |
| `check-doc-refs`, `check-no-till-wording` | pass |
| **Full CI step set** (`cisteps.py`) | **not run in this batch** — left to the coordinator |
| Screenshots before/after | **not taken** (overnight, no display); the rendered-markup comparison above stands in for the DOM, and both stylesheets are byte-identical |

## 8f. Clean-code pass (2026-11-01, not committed)

The owner's request, overnight: "clean out the code in shared component ensure their is human readability and functions
do not intertwin. clean code is what we want". Done in the worktree on top of batch F, on `packages/core/src` and
`packages/ui/src` only — no app file changed, no import path changed. **Zero behaviour change**: every exported name,
its signature and its results are the same; receipts and labels are byte-identical.

**Principles applied:**
- A long function doing several jobs is split into small, named private helpers in the same module (one job each,
  inputs passed in, results returned — no shared mutable state, no helper reaching into another's locals).
- One rule, one place: logic repeated inside a module is factored into one helper only where it is the same rule.
- Private helpers stay private: nothing new is exported, nothing is removed (every export is still there, with the same
  arity).
- Early returns instead of nesting; readable names instead of one-letter ones (outside tiny lambdas).
- Every comment that records an owner decision, a date, a reason or an incident is kept. Comments that were **wrong**
  are fixed: 39 `packages/core` headers and 3 in `packages/ui` still said the file was copied into each app and kept identical by
  `scripts/check-shared-sync.mjs`, or listed `shared/…` / `apps/…/lib` copies — since batch E there are no copies;
  each header now names the package (`@zaptill/core/<name>`, `@zaptill/ui`) and who uses it. Sibling references to the
  old `shared/x.ts` folder now read `x.ts`.
- Fewer, safe changes: a module that was already clear was left alone (apart from its header comment).

**Per module (code changed):**
- **`labels.ts`** (the label layout and the four printer paths) — `layoutLabel` was one 90-line function: it now reads
  as the steps it always took — `labelPriceText` (the price line), `barsSizing` (module width in whole dots, with its
  warning), `planRows` (the text rows at one name height), `chooseRows` (text shrinks, then the business name goes, then
  the name keeps one line — the same order of tries and the same warnings) and `placeRows` (top to bottom, the bars
  above the digits). `cleanLabelSettings` reads the stored value through `storedObject` and the sheet through
  `cleanSheet`. The "EAN / UPC body without its check digit" rule, written three times (TSPL, ZPL, ESC/POS GS k), is one
  helper `gs1Body`; ZPL's barcode field is `zplBarcode`. `escposLabel` is the slip loop only; the text block
  (`escposItemText`), the printer-drawn bars (`escposPrinterBars`) and the raster bars (`escposRasterBars`) are its
  helpers, and the ESC / GS / LF bytes are named once for the section.
- **`offers.ts`** — `applyOffers` was one 100-line function with five closures over shared state. It is now the four
  steps in order, each a function: `applyMeals` (with `pickMeal`, `spreadSaving`), `applyBuyGet`, `applyPerItem` (with
  `itemOffEach`), `applySpend`; the cart becomes units in `cartUnits`, and what has been taken off is one explicit
  `Tally` passed to each step (`give`). `cleanOffer`'s per-kind checks are `offerKindError`; its refusals use `refuse`.
- **`barcode.ts`** — EAN-13 and EAN-8 share `withCheckDigit` (add the check digit, or refuse a wrong one — the same
  message), `rightHalf` and `eanModules` (the guards). `nextInStoreCodes` and `nextNumberedCodes` had the same "codes
  taken, and the highest number among them" loop: now `scanTaken`.
- **`menuHours.ts`** — the cut-off clamp (0–360 minutes), written three times, is `clampCutoff`. `checkAvailability`
  reads its days (`checkDays`) and its windows (`checkWindows`) in their own functions; the errors and their order are
  the same.
- **`customerScreen.ts`** — a slide's address (`"url"` or `{ url }`) was read two ways in two functions: `slideUrlOf`.
  One sale line's whitelist is `sanitiseLine`.
- **`themes.ts`** — the hue angle (`hue`, `oklch`) is `hueDegrees`; the 0–1 clamp written seven times is `clamp01`
  (the same expression, so the same floating-point results).
- **`permissions.ts`** — `expandMap`'s one-line "push into granted, denied or nowhere" is an `if / else if` with a
  comment.

**Comment-only** (the transpiled code is identical, checked below): `analyticsTerms`, `branchBranding`, `businessDay`,
`businessTerms`, `cashierHistory`, `contrast`, `customerDetails`, `delivery`, `expenseMethod`, `forecourt`,
`helpTopics`, `historyView`, `kitchenLines`, `logRedact`, `menuFilter`, `mpesaReceive`, `orderDetail`, `orderNotes`,
`paginate`, `parkingTariff`, `paymentCatalogue`, `paymentColours`, `posFeatures`, `productDays`, `release`,
`reversalRules`, `scaleBarcode`, `shiftConfirm`, `stockGate`, `support`, `syncTopics`, `tenantHost`, `tillChanges`;
in `packages/ui`: `CustomerScreenView`, `CustomerAskForm`, `numberInputs`.

**Left alone on purpose:** `posFeatures`, `customerDetails`, `businessTerms`, `scaleBarcode` and the other modules —
mostly data tables and short, single-purpose functions; splitting them further would add names without making them
clearer. `permissions.ts` is 700 lines, mostly catalogue and role data with small functions — only `expandMap` changed.
`themes.ts`'s colour maths (`deltaE`, `modeTokens`) is a published formula written densely on purpose; renaming its
letters would make it harder to check against the formula. `Pager.tsx` and `MethodDot.tsx` (moved in batch F) as they
are. `scaleBarcode.ts`'s `eanCheckDigit` repeats `barcode.ts`'s `gs1CheckDigit` but does not refuse non-digits (its
callers test the digits first); merging them would change what it returns for such input and add an import into the
desktop POS's main chunk, so both stay.

**Import graph** (`packages/core/src`): three edges, no cycles — `analyticsTerms → businessTerms`,
`branchBranding → themes`, `shiftConfirm → permissions`. Every other module imports nothing; `packages/ui` imports only
`@zaptill/core/*` and React. No module has a side effect when loaded (the module-level values are constants computed
from constants). This pass added no import.

**Verification:**

| Check | Result |
|---|---|
| Differential test, old against new (each module bundled from the snapshot and from the worktree, every export called with generated inputs — normal, edge, empty, null / undefined, wrong types, boundary numbers, real-looking data from the existing tests — results compared deeply, key order and `Map` / `Set` order included, errors by message; exports and arities compared) | **385,742 cases, 0 differ**: `labels` 49,253 (every renderer: SVG, HTML roll and sheet, TSPL, ZPL, ESC/POS GS k and raster, byte arrays compared byte for byte), `barcode` 86,144, `offers` 22,418, `menuHours` 90,070, `customerScreen` 33,319, `permissions` 51,130, `themes` 53,408. Every exported function of the seven is called |
| The harness detects changes | mutation runs (one changed constant or condition each, then restored): 35–2,100 differences each — e.g. two label warnings in the other order 43, a meal's rounding left to its first item 40, an EAN right half one digit short 2,100, the cut-off clamp at 300 instead of 360 minutes 35 |
| Comment-only modules | transpiled (esbuild, comments and whitespace dropped) **identical** for all 33 core modules and the 3 `packages/ui` files |
| `tsc` — `packages/core` (its own build), server, dashboard, admin, desktop `tsconfig.json` and `tsconfig.main.json` | pass |
| Builds — server, desktop main (`tsc -b tsconfig.main.json --force`) and renderer (`vite build`), dashboard, admin | pass |
| Desktop POS main chunk (`index-*.js`), against a build of the snapshot | **457,681 → 457,654 bytes (−27)**. The first version of this pass was +101 (mostly the `offers.ts` split, whose helpers are in the main chunk); `cartUnits`' two copies of the unit literal became one, `cleanOffer`'s refusals one `refuse`, and `hasPermission` kept its inner function, which brought it under. Lazy chunks: `ManagerPage` +660 (the labels helpers), `CustomerDisplayPage` +13 |
| `lazy-load-a517`, `petrol-pos-a588` | 44/0, 49/0 (main chunk 446.3 kB; batch F 446.4 kB) |
| Suites on the changed modules (`tests/`) | **34 suites, 745 passed, 0 failed**: `barcode-labels-a571` 46, `offers` 26, `offers-cloud` 16, `promotions-scope-a518` 12, `menu-hours-a578` 36, `owner-decisions-a580` 23, `customer-screen-a606` 17, `customer-details-a607` 29, `permissions-split-a595` 92, `permissions-web-a490` 15, `built-in-roles-a514` 13, `cashier-not-back-office` 6, `partner-roles-a550` 12, `themes-registry` 27, `brand-palette-a605` 32, `brand-polish-a609` 22, `brand-colours-a597` 30, `branch-branding-a544` 24, `branding-theme-picker` 16, `branding-web-contrast` 11, `shift-confirm` 28, `scale-barcode-a577` 26, `manager-receiving` 2, `owner-permissions-wildcard` 3, `staff-role-ceiling` 13, `light-colours` 13, `back-office-teal` 18, `web-pos-theme` 22, `paginate` 28, `menus-a537` 15, `menus-top-a566` 10, `business-terms-a573` 22, `stock-zero-a563` 23, `petrol-pos-web-a588` 17 |
| Desktop suites (`apps/desktop/test`, run from `apps/desktop`) | **18 suites, 716 passed, 0 failed**: `lazy-load-a517` 44, `petrol-pos-a588` 49, `labels-a571` 67, `menu-hours-a578` 30, `customer-display-a606` 66, `customer-details-a607` 84, `a490-permissions` 93, `shift-confirm` 50, `brand-colours-a597` 19, `branch-branding-a544` 22, `theme-vars` 20, `owner-decisions-a580` 17, `weighed-items-a577` 36, `menus-a537` 26, `menus-top-a566` 26, `stock-zero-a563` 32, `menu-pages` 14, `pages-everywhere` 21. (`theme-vars` fails two Tailwind checks when run from the repository root — it builds the CSS with paths relative to `apps/desktop`; CI runs it there, and there it passes.) |
| `check-shared-sync`, `check-doc-refs`, `check-no-till-wording` | pass (47 modules, no copies) |
| **Full CI step set** (`cisteps.py`) | **not run in this pass** — left to the coordinator |

**Possible bugs found, not changed** (for the owner; each is today's behaviour, kept exactly):
- `offers.ts` `applyOffers` with `ignoreTiming` (the cloud re-checking a sale) and **no `branchId`** accepts an offer
  limited to chosen branches (`!opts.branchId` lets it through). If the cloud ever re-checks without the sale's branch,
  a branch-only offer would count for any branch. Worth confirming the cloud always passes the branch.
- `offers.ts` `offerWhenLabel`: Saturday and Sunday read "Sun, Sat" (the week starts on Sunday there), while
  `menuHours.ts` `daysLabel` says "Sat, Sun" (Monday first). A wording difference between two screens, not a fault.
- `customerScreen.ts` `cleanDisplayChoice` reads a stored `displayId: true` as screen id 1 and `"  "` as id 0
  (`Number()`), where an unreadable value would be expected to mean "none". Harmless while the Tech page stores numbers.
- `scaleBarcode.ts` `eanCheckDigit` and `barcode.ts` `gs1CheckDigit` are two copies of the GS1 mod-10 rule (see "Left
  alone"). They agree on every digit string; only `gs1CheckDigit` refuses other input.

## 8g. Batch G — step 3: the category panel (2026-11-02, not committed)

In plain words: the category panel on the sale screen — the ☰ button by the search, the "Burgers ✕" chip, the menus
across the top of the grid ("All", "Food", "Drinks" …), the "Later" button for closed menus and the slide-out list of
categories — is now **one piece of code used by both the web POS and the desktop POS**. Each POS still looks exactly
as it did (checked on about 52,000 drawn screens, no difference) and works exactly as it did, for every business type
(the words "Menus" / "Departments" / "Groups" come from the business's terms, as before). A fix to the panel is now made
once. The pumps screen, the fuel keypad and the product tiles were looked at and **left as they are**: the two POS draw
them differently (reasons below). One cost: the desktop POS's start-up code is **611 bytes bigger** (0.13 %); see
"Main chunk" — the owner decides whether that is acceptable or the move is undone.

Done overnight on the coordinator's instruction, on top of batch F and the clean-code pass (both uncommitted), only in
files `dev` has not changed since the branch's merge base (9c6efc6). `dev`'s A619 rewrote both PaymentModals,
`CashierScreen.tsx`, `POSPage.tsx`, `cashier/types.ts`, `usePOSData.ts`, the desktop's `lib/payment.ts` and
`posApi.ts`; **none of them was touched** in this batch (not even an import line).

**Moved: the category panel and its pieces** (`packages/ui/src/CategoryPanel.tsx`, `@zaptill/ui/CategoryPanel`):
`useCategoryPanel` (open, the session-only pin, the remembered menu — A537 / A554), `PanelToggle` (☰), `CategoryChip`,
`MenuBar` (A566; hints and the trailing "Show all" A578; greyed closed menus A580), `LaterButton` (A580) and the panel
itself. The two copies had the same JavaScript, the same elements in the same order with the same attributes and the
same words; they differed only in how each element is painted — the desktop with Tailwind class names, the web with
inline styles on its theme tokens (`--act-strong`, `--pos-*`).
- The shared file holds the structure and the behaviour, and **no class names and no colours**. It takes a **look**
  (`CategoryPanelLook`): one entry per element, a `Paint` — a class-name string (the desktop), or `{ className?, style? }`
  (the web's styles; the desktop's colour dot, whose colour is the category's own). An entry that depends on the state
  is a function of it (`barTab(on, later)`, `pin(pinned)`, `row(on)`, `dot(colour)` …).
- Each app's `CategoryPanel.tsx` keeps its file name and is now its look plus five one-line exports, e.g.
  `export const MenuBar = withLook<MenuBarProps>(SharedMenuBar, LOOK);` (`withLook` calls the piece with the look, so
  the app's export is the piece itself — the same React tree as before). `useCategoryPanel` and `CategoryPanelState` are
  re-exported. So **`CashierScreen`, `MinimartPOS` and `POSPage` did not change**.
- The desktop's `useNarrowWindow` / `NARROW_WINDOW_PX` (the panel lies over the grid in a window under 1,100 px) moved,
  unchanged, to `apps/desktop/src/renderer/lib/useNarrowWindow.ts` and is re-exported from `components/CategoryPanel.tsx`
  (a look file may hold no React import of its own — `check-shared-sync`).
- The class names stay in each app's own file, where its Tailwind build finds them (as `Pager`, 8e): both stylesheets
  are **byte-identical**. A few repeated desktop strings became named constants in the look (`LABEL`, `HEAD_BUTTON`,
  `GREY_ON`, `ARROW`); the class strings they build are the same, letter for letter.
- **One unused prop dropped:** the web's `PanelToggle` accepted a `style` to merge over its own; nothing ever passed one
  (both callers are `<PanelToggle panel={catPanel} />`). Dropped to keep the main chunk smaller; nothing shown changes.

**Left as they are, and why:**
- **Forecourt / pumps** — not the same pieces. The desktop's `PumpsView.tsx` draws a semicircle SVG gauge per grade
  (`GradeGauge`: the tank level, or today's litres against yesterday's), each pump as a dispenser card (`Dispenser`:
  colour band, last sale on a display, price, "Today x L", state badge) and its own keypad; it reads the forecourt from
  the desktop's own store (`posApi.pos.forecourt()`, every 60 s). The web's `cashier/Forecourt.tsx` draws a strip of
  fuel-grade buttons above the shop grid (`FuelStrip`) and a pump card's grade name with a thin tank bar (`PumpGrade`).
  The only common part is the logic, which is already shared (`@zaptill/core/forecourt`: `gradeColour`, `gradeGauge`,
  `LOW_PCT`). Sharing the views would mean the owner first picks one forecourt design for both.
- **Fuel keypad** — the web has **no keypad**: its fuel entry is two number fields (amount, litres) with quick amounts
  and "Full tank", inline in `CashierScreen.tsx` (A619-changed — not touched tonight); the old `PetrolPOS.tsx` has its
  own preset buttons. The desktop's is an on-screen keypad (1–9, ".", 0, ⌫, the keyboard too) inside `PumpsView.tsx`,
  with amount / litres tabs and the conversion shown live. Different behaviour and wording ("Add to sale · KES 1,000.00"
  against "Add to sale"). Section 3's note that the desktop keypad is inline in `POSPage.tsx` was out of date — it is in
  `PumpsView.tsx` since A588 (corrected).
- **Product tile** — lives inside `POSPage.tsx` (`ProductTile`) and inline in `CashierScreen.tsx`, both A619-changed, so
  it could not be extracted tonight. It would also not render the same: "Later" / "Sold out" badges (desktop) against
  "LATER" / "SOLD OUT" (web), ⚙ against "options", the web's ⛽ badge and "/L" for fuel, the desktop's long press "Check
  other branches" (A566), `effectivePrice` against `base_price`, a lazy image against a plain one. The owner would first
  choose one tile.

**Main chunk** (`index-*.js`, the desktop POS's start-up code): **457,654 → 458,265 bytes (+611)**; `lazy-load-a517`
reports 446.3 → 446.9 kB (its budget: under 450 kB; `petrol-pos-a588`'s: 452 kB). Batch F's pager sat in a lazy chunk;
the category panel is part of the sale screen, so it is in the main chunk, and the look costs bytes: each element's
look-up (`...q(M.row(on))`) and each entry's name in the look object, which the minifier cannot shorten. The first
version was +999; strings for class-only paints (instead of `{ className }`), `withLook` instead of five wrapper
components and the dropped `style` prop brought it to +611. Going lower would mean short cryptic look names or cutting
code that has nothing to do with this batch. **This does not meet step 3's "must not grow" rule.** Options for the
owner: accept +0.6 kB (the panel then has one copy), or undo the move (restore the two app files and the eight tests
from `git`, delete `packages/ui/src/CategoryPanel.tsx` and `lib/useNarrowWindow.ts`, and remove the `exports` line and
the two `LOOK_WRAPPERS` entries). No manager screen came into the main chunk (`lazy-load-a517` checks it).

**`check-shared-sync.mjs`:** `LOOK_WRAPPERS` lists the two `CategoryPanel.tsx` files (each must import the piece from
`'@zaptill/ui/CategoryPanel'`, have no React import and draw no element of its own). Mutations checked: the old desktop
panel pasted over its look fails ("delete apps/desktop/src/renderer/components/CategoryPanel.tsx"); a copy of the
shared file under `apps/dashboard/src/pages/pos/x/` fails. Output: "48 modules live in packages/core and packages/ui
with no copies". **Note:** `check-shared-sync` is not a step of `ci.yml` on this branch — it runs only by hand; adding
it to CI before the merge is recommended.

**Tests repointed:**
- The eight suites that bundle the panel with esbuild (`business-terms-a573`, `menu-hours-a578`, `menus-top-a566`,
  `owner-decisions-a580`, web and desktop each) bundle with `preserveSymlinks: true`, so `@zaptill/ui` finds
  `@zaptill/core` through the app's `node_modules`, as Vite does.
- `menus-a537` (web and desktop) and the desktop's `menus-top-a566` read the shared file together with the app's look;
  the class / size pins (48 px rows, 40 px pin / close / tabs, `bg-action-500`, `minHeight: 44`) read the look, and a
  new pin checks that the look imports the shared panel and exports it with `withLook`. The desktop's `a554-log-fixes`
  reads the hook in the shared file and checks both apps re-export it. `web-pos-theme` (the web's `ACT` constant) and
  `web-mobile` needed no change.

**Verification:**

| Check | Result |
|---|---|
| Rendered markup, old against new (`react-dom/server`, each app's old file against its look + the shared piece, each app with its own React): ☰ open / closed; the chip (none, empty, short, long); Later on / off × 4 words; the menu bar × 3 menu sets × 3 category sets × 3 tab lists × 5 chosen menus × 2 words × 3 hint sets × 4 greyed sets × with / without "Show all", twice — the second pass with the ‹ › arrows forced on (in a real window an effect shows them); the panel open / closed × pinned × 6 menus × 5 categories × over / beside the grid × `menuBar` absent / false / true × 2 word sets | **web 25,948 and desktop 25,948 renders, 0 differ** (3,720 each with the arrows) |
| The harness detects differences | each app's old file against the other app's look: 13,948 / 13,944 differ (the rest render nothing — a closed panel, no chip); one desktop hint class changed: 80 differ; the web row's `minHeight` 44 → 45: 6,480 differ (both restored) |
| Light / dark | nothing in the markup depends on the theme: the web paints with CSS variables (`--pos-*`, `--act-strong`), the desktop with the same Tailwind classes as before; both stylesheets byte-identical |
| Desktop `dist/renderer` against a build of the worktree before this batch (hashes normalised) | 38 of 39 files the same, **stylesheet byte-identical**; `index-*.js` (main chunk) +611 bytes (above) |
| Dashboard `dist` against the same (hashes normalised) | 123 of 126 the same, **stylesheet byte-identical**; `index` and `ReleaseBadge`: the build timestamp only; `POSEntryPage-*.js` (lazy, the web POS) +840 characters |
| `lazy-load-a517`, `petrol-pos-a588` | 44/0, 49/0 (main chunk 446.9 kB) |
| `tsc` — desktop renderer (`tsconfig.json`), desktop main (`tsc -b tsconfig.main.json --force`), `typecheck-ratchet server dashboard admin` | pass (0 errors, baselines held) |
| Suites on the moved piece (`tests/`) | `menus-a537` 15/0, `menus-top-a566` 10/0, `menu-hours-a578` 36/0, `business-terms-a573` 22/0, `owner-decisions-a580` 23/0, `web-pos-theme` 22/0, `web-mobile` 41/0 |
| Desktop suites on the moved piece | `menus-a537` 26/0, `menus-top-a566` 26/0, `menu-hours-a578` 30/0, `business-terms-a573` 9/0, `owner-decisions-a580` 17/0, `a554-log-fixes` 41/0 (then the known libuv `async.c` exit) |
| Other suites run | `petrol-pos-web-a588` 17/0, `web-feel` 47/0, `pos-cart-parity` 9/0, `branding-web-contrast` 11/0, `stock-zero-a563` 23/0, `scale-barcode-a577` 26/0, `paginate` 28/0, `format` 25/0, `till-scope-enforce-a545` 7/0, `desktop-writes-allowed` 3/0, `customer-details-a607` 29/0, `customer-screen-a606` 17/0; desktop `low-impact-start-a513` 55/0, `menu-pages` 14/0, `pages-everywhere` 21/0, `till-feel` 24/0, `weighed-items-a577` 36/0, `stock-zero-a563` 32/0, `theme-vars` 20/0, `a519-till-items` 69/0, `customer-details-a607` 84/0, `customer-display-a606` 66/0, `shift-confirm` 50/0 |
| `check-shared-sync` | pass: 48 modules, no copies |
| Every `scripts/check-*.mjs` step of `ci.yml` (39 runs, `--self-test` included) | all exit 0 |
| **Full CI step set** (`cisteps.py`) | **not run in this batch** — left to the coordinator |
| Screenshots before/after | **not taken** (overnight, no display); the rendered-markup comparison stands in for the DOM, and both stylesheets are byte-identical |

**Step 3 — what is left:**
- **Money field / tender keypad** and **cart lines**: wait until `dev`'s A611–A620 (A619 rewrote both PaymentModals,
  `CashierScreen.tsx`, `POSPage.tsx` and the cart's types) are merged into the branch; then extract on both sides and
  compare, as here.
- **Product tile** and **fuel keypad**: after that merge too (both sit in A619-changed files), and only once the owner
  picks one tile / one fuel entry (the differences above are visible).
- **Forecourt pieces**: the owner picks one forecourt design first.
- **WeightModal**, **NoteModal**, **KitchenVoidModal**: as 8e says (wording and behaviour differ).

## 8h. `dev` merged (v1.0.23, A611–A620) and the rest of step 3 (2026-11-03, not committed)

In plain words: the branch now has everything `dev` has up to v1.0.23 — per-branch billing and prices, M-Pesa per
branch, delivery platform prices (A619), attendance shifts, the Settings › Business menu and the day's desktop fixes —
with `dev`'s behaviour and the branch's structure: the new shared rule (`platformPrices`) lives once in
`packages/core`, like every other. The two step-3 pieces that waited for A619 — the money field with the tender keypad,
and the cart lines — were looked at and **left**: the two POS do different things there, so sharing them would change
what a cashier sees. `check-shared-sync` now runs in CI. **One open point:** after the merge the desktop POS's start-up
code is 0.4 kB over its 450 kB budget (below).

The merge and step 3 are kept apart: the merge resolution is staged (the owner commits it as the merge commit), and the
CI step and this section are left unstaged on top, for a second commit.

### The merge (`git merge --no-commit --no-ff origin/dev`, `dev` at c2ab634, merge base 9c6efc6)

`dev` brought 15 commits (179 files). Its shared-rule changes since the merge base: `customerScreen` (A617
`themesPremium`), `offers` (the branch rule and the days' words, owner 2026-11-01), `release` (1.0.23), `syncTopics`
(`platformPrices` in the money topic), `themes` (A617 `FREE_THEME_IDS`, `isFreeThemeId`) and the new `platformPrices`
(A619), each changed in `shared/` and in every app copy alike (every copy was byte-identical to its `shared/` file on
`dev`).

| Conflict | Files | Resolution |
|---|---|---|
| modify/delete — `dev` edited a file the branch had moved | `shared/{customerScreen,offers,release,syncTopics,themes}.ts` and 12 app copies (dashboard `lib/` ×3, desktop `main/` ×2 and `shared/` ×2, server `lib/` ×5) | deleted; `dev`'s change is in the `packages/core` file (git's rename detection carried four; `offers` below). Checked: for each module the lines `dev` changed (`git diff 9c6efc6 origin/dev -- shared/X.ts`) are exactly the lines the merge changed in `packages/core/src/X.ts` |
| content — `packages/core/src/offers.ts` | 1 | the clean-code pass (8f) had split `applyOffers` into steps; `dev` changed its first line (`live`: an offer for some branches needs the sale's branch even when the cloud re-checks a sale). `dev`'s line in the branch's structure |
| new module — `platformPrices` (A619) | `shared/` + 4 app copies | one file, `packages/core/src/platformPrices.ts` (pure, no imports); the 5 paths removed; its header names the package instead of "copied verbatim" |
| content — import blocks only | 21 app files: both `PaymentModal.tsx`, `CashierScreen.tsx`, `POSPage.tsx`, `cashier/usePOSData.ts`, `ReportsPage.tsx`, `themeVars.ts`, `BrandingTab.tsx`, `BranchReceiptOverrides.tsx`, `RestaurantSettingsPage.tsx`; desktop `deviceConfig.ts`, `syncEngine.ts`, `ipc/branchSettings.ts`; server `lib/themeRules.ts`, `routes/{admin,branches,business,orders,pos,products,reports}.ts` | `dev`'s block, each moved module's specifier changed to `@zaptill/core/<name>` (`@zaptill/ui/MethodDot` for the method dot). Nothing else on the lines changed |
| relative imports in lines that merged cleanly | 10 files `dev` added or changed: server `lib/branchMpesa.ts`, `lib/platformPricing.ts`, `routes/mpesaSettings.ts`; dashboard `products/PlatformPriceFields.tsx`, `settings/{KitchenTicketSettings,PlatformPrices,PrintersPage}.tsx`; desktop `main/platformSale.ts`, `main/ipc/sale.ts`, and `POSPage.tsx`'s on-demand `import('@zaptill/core/platformPrices')` | specifier switched to `@zaptill/core/<name>` (found by a scan of every relative import in `apps/*/src` that names a packaged module and no app file) |
| `scripts/check-shared-sync.mjs` | 1 | `dev` re-listed every copy, with a `platformPrices` entry; the branch's empty `SHARED` kept (the module is in `packages/core`) |
| tests | `tests/offers.test.mjs` (conflict); `tests/platform-prices-a619`, `apps/desktop/test/platform-prices-a619`, `tests/a617-themes-basic-and-own-prices`, `tests/platform-prices-cloud-a619` (new on `dev`) | read `packages/core/src/<name>.ts` / `require('@zaptill/core/<name>')`; A619's "five identical copies" case now asserts one file and no copy left; its desktop pins expect `import('@zaptill/core/platformPrices')` |

`packages/core` holds **43 modules**; `check-shared-sync`: "49 modules live in packages/core and packages/ui with no
copies". The 8f "possible bugs" on `offers` (a branch-only offer with no branch; "Sun, Sat") were fixed on `dev` by the
owner's 2026-11-01 decision and now hold in core.

**Proof that the merge keeps `dev`'s behaviour:**

| Check | Result |
|---|---|
| The changed modules, `dev`'s `shared/X.ts` against the merged `packages/core/src/X.ts` (8f's differential harness, generated inputs) | `offers` 22,418, `customerScreen` 33,319, `themes` 53,408 cases — **0 differ**; `release`, `syncTopics`: constants, the changed lines identical |
| Desktop `dist/main` against a build of `origin/dev` | every file the two builds share is identical apart from `require` lines; the 29 modules `dev` compiles into `dist/main` come from `@zaptill/core` instead |
| Desktop stylesheet against `origin/dev` | identical apart from the dead `.lowercase` rule batch D dropped (8c) |
| `tsc` — server, dashboard, admin, desktop `tsconfig.json` and `build:main` (`tsc -b --force`) | pass |
| Builds — server (`npm run build`, clean `dist`), desktop `build:all`, dashboard and admin `vite build` | pass; `platformPrices` is its own on-demand chunk on the desktop, as on `dev` |
| `check-shared-sync`, `check-test-registration` (488 files), `check-no-till-wording`, `check-register-consistency`, `check-doc-refs` | pass |
| Root suites (`TZ=UTC`) | `quiet-refusals-a611` 7, `branch-cloud-a612` 32, `branch-billing-a612` 22, `a617-themes-basic-and-own-prices` 25, `a618-branch-mpesa` 20, `platform-prices-a619` 26, `platform-prices-cloud-a619` 22, `business-settings-menu-a620` 7, `offers` 27, `customer-details-a607` 29, `customer-screen-a606` 17, `no-global-buffer` 3, `brand-colours-a597` 30, `branch-branding-a544` 24, `branding-theme-picker` 18, `theme-access` 21, `web-pos-theme` 22, `order-notes` 16, `attendance-a599` 52, `partner-my-branches-a582` 29, `partner-my-branches-picker-a582` 23, `billing-a584` 27, `polling-cost-a528` 27, `supabase-calls-a593` 29, `supabase-calls-a598` 8, `format` 25, `pos-cart-parity` 9, `petrol-pos-web-a588` 17, `till-scope-enforce-a545` 7, `desktop-writes-allowed` 3, `release-version` 8, `kitchen-font-a543` 5, `permissions-web-a490` 15, `prospect-features` 19, `themes-registry` 27, `brand-palette-a605` 32, `brand-polish-a609` 22, `menus-a537` 15, `menus-top-a566` 10, `menu-hours-a578` 36, `business-terms-a573` 22, `owner-decisions-a580` 23, `web-feel` 47, `web-mobile` 41, `paginate` 28, `offers-cloud` 16, `promotions-scope-a518` 12 — **all pass, 0 failed** (`petrol-pos-web-a588` then the known libuv `async.c` exit) |
| Desktop suites | `live-sync-a531` 29, `platform-prices-a619` 26, `catalogue-refresh-signal` 18, `credit-approval-a585` 25, `petrol-pos-a588` 49, `menus-a537` 26, `menus-top-a566` 26, `a554-log-fixes` 41, `brand-colours-a597` 19, `branch-branding-a544` 22, `theme-vars` 20 — pass. **`lazy-load-a517` 43/1, `customer-details-a607` 86/1, `customer-display-a606` 65/1: the one main-chunk budget case, below** |

**The main chunk budget.** `lazy-load-a517` (and the same case in `customer-details-a607` and `customer-display-a606`)
requires the desktop POS's main chunk under 450 kB (characters). `dev` itself is at **449.8 kB** (460,592 characters;
461,194 bytes) — A619 kept it there by loading `platformPrices` on demand. The merged branch is **450.4 kB** (461,185;
461,787 bytes): +593 characters, which is batch G's category panel (+611, 8g) less the clean-code pass (−27) and
minifier noise. Nothing in the merge itself added to it. Making the shared panel smaller would take cryptic look names
(each look entry's name stays in the minified code), against the owner's clean-code rule. **For the owner:**
1. accept the panel's cost and set the budget to 451 kB in the three suites (the forecourt suite `petrol-pos-a588`
   already allows 452 kB); or
2. undo batch G's move (8g's steps): the main chunk goes back to `dev`'s 449.8 kB, the panel to two copies.

### Step 3 — the two pieces that waited for A619

Compared on the merged files (both payment screens and both cart lists as A619 left them). Neither moved: each differs
in behaviour, not only in look.

- **Money field / tender keypad** — neither payment screen has a keypad. The web's cash payment is one "Amount tendered
  (KES)" field with quick-tender buttons above it (Exact, the next notes up — 50, 100, 200, 500, 1,000 — and the next
  100 / 1,000), and the change below. The desktop's is a split payment: every leg has an "Amount" field and, for cash,
  a "Tendered" field (or a "Reference" field), with no quick tenders. A shared field would put quick tenders on the
  desktop or take them from the web. To share it the owner first picks one cash entry for both.
- **Cart lines** — the desktop's line shows the kitchen mark (🍳 "2 sent") for a restaurant, the variants and the
  add-ons as small chips, "KES 350 each" / "/L" / "/kg", the money with the device's locale, a note button hidden once
  the line went to the kitchen, and the line total under the line. The web's shows the variants as one text line, no
  add-ons, the price through its own `fmt`, a course picker and Held / Fires now for a restaurant, the note button
  always (fuel aside), minus through `changeQty` (a line already sent to the kitchen asks for a kitchen void first) and
  the total beside the controls. Sharing them would
  change one POS or the other.

Nothing was extracted, so no file in either app changed for step 3, both bundles are as after the merge and no size
changed.

**`check-shared-sync` in CI:** `ci.yml` has the step "Shared code lives once (packages/core, packages/ui)" next to
"Cited documents exist". It had only been run by hand (8g).

**Step 3 — what is left** (all wait on an owner decision): the product tile and the fuel entry (8g), the forecourt
pieces (8g), the cash entry and the cart line (above), `WeightModal`, `NoteModal`, `KitchenVoidModal` (8e).

## 8i. `dev` merged (A621, font, A622) (2026-11-04, not committed)

In plain words: the branch now has everything `dev` has up to df80142 — M-Pesa payment notifications (A621, migration
188), one body font for every screen (Source Sans 3), install-first at every start with the updater's reason and the
support-log sections (A622), and the gitleaks allowlist entry — with `dev`'s behaviour and the branch's structure. The
one new shared rule (`mpesaPayments`) lives once in `packages/core`. After the merge the desktop POS's main chunk is
**444.5 kB**, back under the old 450 kB budget (A621 moved the order detail panel out of it), so 8h's open point is
gone.

### The merge (`git merge --no-commit --no-ff origin/dev`, `dev` at df80142, merge base c2ab634)

`dev` brought 4 commits (92 files). Its shared-code changes since the merge base: the new `mpesaPayments` (A621: in
`shared/` and two app copies, all byte-identical) and the font line in the customer screen's two views
(`CustomerAskForm`, `CustomerScreenView`: the font family is `var(--font-body, …)`, in every copy alike).

| Conflict | Files | Resolution |
|---|---|---|
| new module — `mpesaPayments` (A621) | `shared/` + `apps/dashboard/src/lib/` + `apps/desktop/src/shared/` | one file, `packages/core/src/mpesaPayments.ts`; the three paths removed; its header names the package instead of the copies; imports are `@zaptill/core/mpesaPayments` (the desktop's on-demand chunk stays its own, as on `dev`). `diff` against `dev`'s `shared/mpesaPayments.ts`: the header line only |
| modify/delete — the customer screen's views | `apps/{dashboard/src/lib,desktop/src/shared}/{CustomerAskForm,CustomerScreenView}.tsx` | deleted; `dev`'s font lines are in `packages/ui/src/` (the same three lines, checked by diff) |
| content — `apps/desktop/src/renderer/pages/POSPage.tsx` | 1 (import block only) | `dev`'s lazy `MpesaArrivedNotice` line kept; `scaleBarcode` from `@zaptill/core/scaleBarcode`. Against `origin/dev` the merged file differs in import specifiers only |
| content — imports | desktop `main/supportLogs.ts`, `renderer/lib/posApi.ts` | `dev`'s lines, `@zaptill/core/<name>` specifiers |
| package files | admin `package.json` / lock | both dependencies kept (`@zaptill/core` and `@fontsource-variable/source-sans-3`) |
| `scripts/check-shared-sync.mjs` | 1 | the branch's empty `SHARED` kept (`dev` added the `mpesaPayments` copies) |
| relative import in a line that merged cleanly | server `routes/c2b.ts` (`../lib/businessDay`) | `@zaptill/core/businessDay` (found by resolving every relative import in the 92 files `dev` changed: this was the only one naming a module that is no longer in the app) |
| tests | `apps/desktop/test/mpesa-c2b-a621.test.mjs` (builds the rule from `packages/core/src/mpesaPayments.ts`); `tests/font-global.test.mjs` | the font suite's screen folders: `packages/ui/src` added (the shared screens), the desktop's `src/shared` (empty on the branch; absent in a fresh checkout, where reading it would throw) dropped |

`packages/core` holds **44 modules**; `check-shared-sync`: "50 modules live in packages/core and packages/ui with no
copies".

**Proof:**

| Check | Result |
|---|---|
| `tsc` — server (with `packages/core`), dashboard, admin, desktop `tsconfig.json` and `build:main` (`tsc -b --force`) | pass |
| Builds — server (clean `dist`), desktop `build:all`, dashboard and admin `vite build` | pass |
| `check-shared-sync`, `check-test-registration`, `check-no-till-wording`, `check-register-consistency`, `check-doc-refs` | pass |
| A621 / A622 / font suites | `tests/mpesa-c2b-a621` 44, `scripts/test-migration-188` 16, `tests/a622-install-error` 4, `tests/font-global` 4; desktop `mpesa-c2b-a621` 17, `a622-install-first` 29, `update-stuck-a541` 53, `update-open-a546` 46 — all pass |
| Main chunk budget | `lazy-load-a517` 44/0 (**444.5 kB**, 455,122 characters; `dev`: 443.9 kB), `customer-details-a607` 87/0, `customer-display-a606` 66/0 |
| Full local CI (every `ci.yml` step, `TZ=UTC`) | 286 steps, 8 "failed", all known local noise: schema audit (no `python3`), the `${{ matrix.part }}` shard step (both shards run by hand: all pass), the libuv `async.c` exit after all cases passed (`petrol-pos-web-a588`, `server-setup-a503`, `a554-log-fixes`, `monthly-pack-till`; re-run: 0 failed), `money-reports`' local-hour case under `TZ=UTC`, and the offline-suites loop failing on those same exits |
| Every root suite (`tests/*.test.mjs`) | 327 ok; 3 "FAIL(127)" = the `async.c` exit after "0 failed" (`petrol-pos-web-a588`, `report-collected`, `void-owner-row`) |
| Migration tests | shard 1/2: all pass (one file's exit is the `async.c` crash after "all green"); shard 2/2: all 52 pass |

## 8j. One design for both POS screens (owner decision 2026-11-04, not committed — unstaged, on top of 8i)

The owner's decisions are at the top of `docs/POS-SCREEN-COMPARISON.html`: the desktop POS is the base; the web's
quick cash, tip buttons, split evenly / by item and loyalty points come to it; the web gets the desktop's Discount box,
references and the M-Pesa prompt inside a split payment. Built screen by screen, each piece once in `packages/ui` with
its rules in `packages/core`; each app keeps its look (class names / inline styles) in its own file, as 8e–8g (the
shared `Paint` type is now `packages/ui/src/paint.ts`, used by `CategoryPanel` too). Small screens: the web keeps its
phone layout; a piece a business does not use stays out of sight.

**Budget (owner, 2026-11-04):** the desktop POS's main chunk may be up to **460 kB** (was 450; `petrol-pos-a588`'s 452
raised too — one number in `lazy-load-a517`, `customer-details-a607`, `customer-display-a606`, `petrol-pos-a588`).

### Screen 1 — the payment screen (done; desktop loyalty not done, below)

| Piece | Where | Desktop | Web |
|---|---|---|---|
| Quick cash (Exact, the next notes 50–1,000, the next round 100 / 1,000) | `@zaptill/ui/QuickCash`; `@zaptill/core/tender` `quickTenders` (the web's rule, proved equal on every amount 0.07–6,000) | new, under each cash payment's Tendered; the change shows as before | the same buttons (the base is now what is due, tip and fee included — the old base used the uncapped `total` prop) |
| Tip 5 / 10 / 15 %, typed, Clear | `@zaptill/ui/TipPicker`; `tipAt` / `tipPercentOf` | replaces the plain Tip field (the fold "Discount / tip" is now "Discount"); hidden, and not charged, while a payment is On account | the same piece |
| Discount box (amount / %, capped, "Ask a manager") | `@zaptill/ui/DiscountBox` | the same box as before | **new** (folded "▸ Discount", only with `sales.discount`): on what offers left, capped together with loyalty and a promo code (`capDiscountPct`, as the cloud); the receipt preview gets a "Discount" line only when there is one |
| Split the bill — evenly per person, by item per guest | `@zaptill/ui/BillSplit`; `evenShares` / `itemShares` (A151's rules) | new "Split the bill" beside "+ Split payment" (loaded on demand, `BillSplitPanel`, 3 kB): the shares become one payment per person ("Person 1"), each any method — the M-Pesa prompt and On account included | the toggles "Split evenly" and "Split by item" become one, "Split the bill (per person)", by item behind it (`SplitBillPanel` replaces `EvenSplitPanel` and `ByItemSplitPanel`) |
| A reference on every non-cash payment | — | as before | **new** on a card or another non-cash single payment (optional; M-Pesa keeps its code, a platform its order #) |
| The M-Pesa prompt inside a split payment | the web's `MpesaStkPanel` without an order → the cloud's `/api/mpesa/stk-push-pos` (A607's POS prompt) | as before | **new** "Send prompt" on a split's M-Pesa part (by method or per person); a paid prompt's leg goes to the cloud as `status: 'completed'` (as the desktop's, and A621's taken payments) |
| Double-charge guards | — | `placingRef` kept | `chargingRef` and the idempotency key kept |

Not added (owner): receipt preview / Print again on the desktop, a customer name box on the desktop.

**Loyalty on the desktop — not done.** The desktop POS holds no loyalty data (no points, tiers, earn rate or the
`loyalty_enabled` switch; the cloud credits points when the sale arrives). "Points earned / new balance" there needs a
new online look-up of the customer's points and tier (the tier rule is the server's `getTier`, not yet in core) —
online only. The web keeps its lines; its estimate now comes from `@zaptill/core/tender` `pointsEarned` (same formula).

Removed from the web (imported by nothing): `PetrolPOS.tsx` (the petrol station sells in `CashierScreen` since A588),
`DiscountPanel.tsx`, `LoyaltyPanel.tsx` (their two types moved to `cashier/types.ts`), `EvenSplitPanel.tsx`,
`ByItemSplitPanel.tsx`. Tests updated: `web-pos-theme` (90 → 85 themed uses: PetrolPOS's 5), `web-feel` (no
PetrolPOS), `permissions-web-a490` (the Discount box is `sales.discount`), `mpesa-c2b-a621` (`|| l.prompted`);
`web-pos-green-baseline.json` (the removed files; PaymentModal 5 → 4: the tip's amount is white on both POS). The dashboard's light-colours block regenerated (`scripts/build-light-colours.mjs`: one rule only a removed file used).
Main chunk: **444.5 → 448.9 kB**. Test: `tests/pos-payment-screen.test.mjs` (18 cases; CI step "One payment screen for
both POS").

### Screen 2 — cart lines (partial)

Done: a line's sizes and add-ons as chips on both POS (`@zaptill/ui/LineChips`; the web showed the sizes as text and
no add-ons); the desktop's **Split bill** under Charge for a restaurant (the payment screen opens on "Split the bill" —
offline, nothing new behind it). The desktop's kitchen mark, note rule, kitchen-void rules and Hold are unchanged.

**Stopped — each needs the owner (it changes how a POS behaves beyond the decisions, or its backend):**
- *Courses (a course per line, Held / Fires now, Fire course) on the desktop.* On the web a held course is a cloud
  order's `fire_status` (`POST /api/orders/:id/fire-course`; the cloud's KDS hides held lines). The desktop's kitchen is
  its own printed tickets and its open orders live in its SQLite: holding a course needs a new column on an open order's
  lines (a local migration), Send to kitchen printing only the fired courses and Fire printing the rest — a change to
  kitchen printing and to what an open order carries, which this work rules out. It could work offline once built.
- *Transfer table on the desktop.* The web moves a cart between tables in its own screen state; the desktop's open
  orders are rows in its SQLite (shared between POSs through a branch server) — moving one is a main-process change.
- *Print bill on the desktop.* A new printout (a guest check) through the desktop's printers — a printing change.
- *Charge to room.* The web shows 🏨 Room to **every restaurant**: there is no hotel business type (restaurant, cafe,
  retail, minimart, parking, petrol_station, other). "Room only for hotels" needs a way to know a hotel (a new type or
  a switch). The sale itself is an ordinary sale with an `other` payment ("Room 12 — guest") and would work offline on
  the desktop.

### Screen 3 — the product tile (done for the decided points)

"Later", "Sold out", "Options" in sentence case, the same words on both POS (`@zaptill/ui/TileBadges`): the desktop's
capitals (`uppercase`) and ⚙, and the web's "LATER", "SOLD OUT", "options", are gone. The desktop's tile is otherwise
as before (branch price with "from", long press, the sold-out rule, columns, paging); the web's tile keeps its own frame
(its phone layout) — giving it the desktop's frame was not done.

Main chunk after screens 2 and 3: **449.7 kB**. Test: `tests/pos-cart-and-tile.test.mjs` (CI step "One cart line and
product tile for both POS").

### Screen 4 — the forecourt (blocked)

*Activate pump on the desktop:* `PATCH /api/pumps/:id/activate` needs `fuel.manage` (a cashier rarely holds it — on the
web the call then fails quietly and the pump is marked only in that screen) and the cloud refuses every desktop write
not listed in `lib/terminalWrites.ts` (A159). Adding it is a server security change (which token may activate a pump,
and who) — an owner decision. The desktop's dispensers, gauges and fuel keypad on the web (the web's
`cashier/Forecourt.tsx` is a simpler strip) were not started.

### Proof (Task 2, after the four screens)

`tsc` (dashboard, desktop), desktop `build:all`, dashboard `vite build`: pass. `check-shared-sync` (58 modules, no
copies), `check-test-registration`, `check-no-till-wording`, `check-doc-refs`, `check-register-consistency`, both green
ratchets: pass. Full local CI (288 steps): only the known local noise (schema audit without `python3`, the
`${{ matrix.part }}` shard step, the libuv `async.c` exits after all cases passed, `money-reports`' local-hour case under
`TZ=UTC`) plus the stale light-colours block, regenerated. Every root suite: 329 ok, 3 `async.c` exits after "0 failed".

## 9. Rollback

- **Step 1:** revert the step's commit(s) — the copies come back with `check-shared-sync`'s entry; delete
  `packages/core`; remove the dependency line + lock entry from the three apps. If Render was already switched to
  the repository root, it can stay switched (the commands work for the old layout too) or be set back to
  `rootDir: apps/server` with the old commands.
- **Step 2 (per batch):** revert the batch's commit; the copies and `SHARED` entries return; other batches are
  independent unless they share a dependency pair (moved together).
- **Step 3 (per component):** revert the component's commit; the two app copies return; screenshots show the old look.
- On `dev`/`main`: revert the merge commit; the hosts keep working with the new Render settings (they are layout-agnostic).
