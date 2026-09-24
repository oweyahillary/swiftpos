# MANIFEST 2026-09-24-g — Phase 2 slice 3: the till's colours follow the theme (A326) · A325 closed · desktop v0.6.6 row

**Re-issue of delivery 2026-09-24-f, which never landed.** On the owner's Windows run, the new test stopped the Block-3 chain before
the commit: `spawnSync …\apps\desktop\node_modules\.bin\tailwindcss ENOENT` — on Windows that file is a `.cmd`, which Node cannot
spawn without a shell (the same trap as the bundle builder on 2026-09-23). -g runs Tailwind's JS entry point with `process.execPath`
instead (`require.resolve('tailwindcss/lib/cli.js')`): no `.cmd`, no shell, same on every OS. Swept: no other test or script spawns a
`node_modules/.bin` file. WORKING-METHOD §9 gains the rule. Everything else is -f unchanged.

**Base commit:** `b69eeca` (origin/dev, delivery 2026-09-24-e; tag `v0.6.5`, CI #393 and Release desktop #21 green; owner verified
ocean/null on mamangina → A325 CLOSED).
**Register:** A326 NEW → FIX BUILT (P3); A325 → CLOSED; A323 tracker; Tree row → desktop **v0.6.6**. Counts unchanged (18 · 17 · 19).
**Deploy:** desktop **0.6.6** only (`npm version 0.6.6` is in Block 3; tag after CI is green). No cloud, admin or migration change.
**Visible change:** only for a business with themes ON. With themes OFF the till is unchanged (proven pixel-identical below).

## What
- **Classified first** — `docs/A326-till-green-classification.md`: all 222 green classes on the till → 150 action, 4 brand (lock
  curtain), 68 stay green (59 status, 7 money, 2 SwiftPOS wordmark). Owner approved the four policy calls.
- **Applied by script** from that list: 154 classified = 154 rewritten, line-for-line, in 27 screen files.
- **Tokens** (`tailwind.config.js`): `action-*`, `brand-*`, `on-brand` read CSS variables; defaults in `index.css` = Tailwind's exact greens.
- **`lib/themeVars.ts`**: pure `computeThemeVars` + `applyThemeVars`; `App.tsx` applies on every screen and on every landed pull; brand
  strip on POS/Manager; Manager sidebar `var(--sidebar-tint, #111827)`; lock curtain `text-on-brand`; PIN screen uses the theme when there
  is no brand colour; `posApi.ts` types carry `themeId`.
- **Gate** `scripts/check-till-green.mjs` + `scripts/till-green-baseline.json` (68): no new raw green on the till.

## Files (41)
- `.github/workflows/ci.yml`
- `apps/desktop/package.json`
- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/renderer/components/ChoicesEditor.tsx`
- `apps/desktop/src/renderer/components/ExclusionsPanel.tsx`
- `apps/desktop/src/renderer/components/HeldOrdersModal.tsx`
- `apps/desktop/src/renderer/components/LockCurtain.tsx`
- `apps/desktop/src/renderer/components/OpenDrawerModal.tsx`
- `apps/desktop/src/renderer/components/PaperWidthControl.tsx`
- `apps/desktop/src/renderer/components/PaymentMethodsPanel.tsx`
- `apps/desktop/src/renderer/components/PaymentModal.tsx`
- `apps/desktop/src/renderer/components/PrinterSettingsModal.tsx`
- `apps/desktop/src/renderer/components/PumpsView.tsx`
- `apps/desktop/src/renderer/components/ReportRangeBar.tsx`
- `apps/desktop/src/renderer/components/SettingsPanel.tsx`
- `apps/desktop/src/renderer/components/StationsPanel.tsx`
- `apps/desktop/src/renderer/components/TablesView.tsx`
- `apps/desktop/src/renderer/components/VariantModal.tsx`
- `apps/desktop/src/renderer/index.css`
- `apps/desktop/src/renderer/lib/posApi.ts`
- `apps/desktop/src/renderer/lib/themeVars.ts`
- `apps/desktop/src/renderer/pages/DayCloseTab.tsx`
- `apps/desktop/src/renderer/pages/InstallPage.tsx`
- `apps/desktop/src/renderer/pages/ManageTabs.tsx`
- `apps/desktop/src/renderer/pages/ManagerPage.tsx`
- `apps/desktop/src/renderer/pages/MenuWorkbench.tsx`
- `apps/desktop/src/renderer/pages/POSPage.tsx`
- `apps/desktop/src/renderer/pages/PinPage.tsx`
- `apps/desktop/src/renderer/pages/PrintersTab.tsx`
- `apps/desktop/src/renderer/pages/ShiftPanel.tsx`
- `apps/desktop/src/renderer/pages/UpdateBanner.tsx`
- `apps/desktop/src/renderer/screens/PrinterSetupScreen.tsx`
- `apps/desktop/src/renderer/screens/PrintersScreen.tsx`
- `apps/desktop/tailwind.config.js`
- `apps/desktop/test/theme-vars.test.mjs`
- `docs/A326-till-green-classification.md`
- `docs/AUDIT-REGISTER.md`
- `docs/MANIFEST-2026-09-24-g.md`
- `docs/VERIFY-LOG-2026-09-24.md`
- `docs/WORKING-METHOD.md`
- `scripts/check-till-green.mjs`
- `scripts/till-green-baseline.json`

## Verification (rule 7)
```
BENCH (Chromium, the till's real compiled CSS):
  themes OFF: 23 distinct action/brand utilities vs their green originals → 0 differences (pixel-identical)
  themes ON (Ocean + #F5B800): bg-action-500 rgb(59,130,246) · text-action-400 rgb(96,165,250) · bg-action-500/10 rgba(59,130,246,0.1)
    · bg-brand-600 rgb(245,184,0) · status text-green-400 / bg-green-500 unchanged · OFF again → rgb(34,197,94)
node apps/desktop/test/theme-vars.test.mjs 19/19 — mutations: vars with themes off · changed default · fixed colour in config ·
  no brand fallback · no re-apply on pull → each bites
node scripts/check-till-green.mjs OK (68) · --self-test OK · Charge reverted to raw green → FAIL naming POSPage (11 vs 9)
rewrite: 154 classified = 154 rewritten (first run's boundary bug stopped by its own assertion; restored, re-run)
tests pinning a green class: kds-conn-state (dashboard, untouched) 7/7
renderer vite build 0 · renderer tsc 0 · main tsc 0 · check-test-registration OK
check-register-consistency: red until `npm version 0.6.6` is in the same commit (by design)
```

## Not verified here (rule 16) — owner, on desktop 0.6.6
1. Themes **OFF** (admin) → the till looks exactly as before.
2. Themes **ON** → Charge, selected category/item, links, focus rings in **Ocean blue**; Paid, "saved", the online dot and **prices stay green**.
3. If B Foods has a brand colour: brand strip, lock curtain and Manager sidebar in that colour; otherwise they follow Ocean.
4. Switch off again → back to green within ~20 s, no restart.

## Rollback (before tagging)
```bash
git checkout b69eeca -- . && rm -f apps/desktop/src/renderer/lib/themeVars.ts apps/desktop/test/theme-vars.test.mjs \
  scripts/check-till-green.mjs scripts/till-green-baseline.json docs/A326-till-green-classification.md docs/MANIFEST-2026-09-24-g.md
```
After a tag is pushed, do not move it — cut v0.6.7 instead.
