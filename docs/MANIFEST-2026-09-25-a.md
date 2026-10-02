# MANIFEST 2026-09-25-a — Phase 2 slice 4b-1: the web POS + shared components follow the theme (A328) · A326 + A327 closed

**Base commit:** `15bb4d3` (origin/dev, delivery 2026-09-24-l; CI #398 green). Dashboard `68f65c9` deployed; desktop 0.6.6 on mamangina.
**Register:** A328 NEW → FIX BUILT (P3); A327 → CLOSED; A326 gains its brand-colour evidence; tracker; header; changelog.
**Deploy:** the **dashboard only**. No cloud, database or desktop change.
**Visible change:** only for a business with themes ON. With themes OFF the web POS and the dashboard sidebar are unchanged.

## What
- **Classified first** (`docs/A328-web-pos-green-classification.md`): 81 greens in `pages/pos`, `components`, `layouts` → 67 action,
  10 status, 4 money; owner approved the calls incl. (a) the dashboard sidebar's active section takes the theme.
- **Applied by script** (67 = 67). **Tokens:** Tailwind `action-400/500/600` → CSS variables, defaults = Tailwind green (both modes).
- **Shade rule** (labels are fixed per button): 500 fills (dark text) → theme 500; 600 fills (white text) → theme 700; links → 400
  dark / 700 light. Proven ≥ 4.5 for all seven themes in both modes.
- **`lib/themeVars.ts`** (pure) + **`components/ThemeLayer.tsx`** in `BusinessProvider`; Branding fires `swiftpos:branding-saved`.
- **Gate** `scripts/check-web-pos-green.mjs` + `scripts/web-pos-green-baseline.json` (14) + CI step.

## Files (25)
- `.github/workflows/ci.yml`
- `apps/dashboard/src/App.tsx`
- `apps/dashboard/src/components/BranchSelector.tsx`
- `apps/dashboard/src/components/DashboardLayout.tsx`
- `apps/dashboard/src/components/ErrorBoundary.tsx`
- `apps/dashboard/src/components/ProtectedRoute.tsx`
- `apps/dashboard/src/components/ThemeLayer.tsx`
- `apps/dashboard/src/index.css`
- `apps/dashboard/src/lib/themeVars.ts`
- `apps/dashboard/src/pages/pos/ByItemSplitPanel.tsx`
- `apps/dashboard/src/pages/pos/DiscountPanel.tsx`
- `apps/dashboard/src/pages/pos/EvenSplitPanel.tsx`
- `apps/dashboard/src/pages/pos/LoyaltyPanel.tsx`
- `apps/dashboard/src/pages/pos/PaymentModal.tsx`
- `apps/dashboard/src/pages/pos/PrinterSettingsModal.tsx`
- `apps/dashboard/src/pages/pos/TableTurnoverPage.tsx`
- `apps/dashboard/src/pages/settings/BrandingTab.tsx`
- `apps/dashboard/tailwind.config.js`
- `docs/A328-web-pos-green-classification.md`
- `docs/AUDIT-REGISTER.md`
- `docs/MANIFEST-2026-09-25-a.md`
- `docs/VERIFY-LOG-2026-09-25.md`
- `scripts/check-web-pos-green.mjs`
- `scripts/web-pos-green-baseline.json`
- `tests/web-pos-theme.test.mjs`

## Verification (rule 7)
```
BENCH — Chromium, the dashboard's REAL compiled CSS (transitions disabled in the test page):
  themes OFF: 9/9 action utilities identical to their green originals — DARK and LIGHT
  7 themes × 2 modes: dark labels on 500 fills worst 4.75 · white labels on 600 fills worst 5.36 · links worst 5.36
  Ocean: dark fill #3b82f6 / white-label fill #1d4ed8 / links #60a5fa · light the same with links #1d4ed8
  status text-green-400 unmoved with a theme on · themes_enabled false → green again
  (first pass read colours mid-fade — the dashboard's global transition; the measurement was fixed, not the page)
rewrite: 67 classified = 67 rewritten · scope green 81 → 14 · dashboard total 687 → 620
node tests/web-pos-theme.test.mjs 13/13 — mutations: white-label fills → 600 (worst 3.68) · light links 400 (worst 1.73) ·
  vars with themes off · a changed default → each bites
node scripts/check-web-pos-green.mjs OK (14) · --self-test OK · a reverted button → FAIL (PaymentModal 7 vs 5)
branding-theme-picker / branding-web-page / branding-web-contrast → pass · dashboard tsc 0 + build 0 · ratchet OK
node scripts/run-all.mjs GREEN 121/121 · all 26 apps/desktop/test pass (desktop untouched; run anyway — CI #394 lesson)
```

## Not verified here (rule 16) — owner, after the dashboard deploy
1. Web POS (browser) with themes ON: **Charge / Confirm**, the **selected payment method**, split and tip options in the theme;
   discount and tip **amounts** and the **"applied"** state stay green.
2. The dashboard's **sidebar active section** in the theme.
3. Switch the dashboard to **light mode**: the same, links a darker shade and readable.
4. A business with themes OFF: unchanged.

## Rollback
```bash
git checkout 15bb4d3 -- . && rm -f apps/dashboard/src/lib/themeVars.ts apps/dashboard/src/components/ThemeLayer.tsx \
  scripts/check-web-pos-green.mjs scripts/web-pos-green-baseline.json tests/web-pos-theme.test.mjs \
  docs/A328-web-pos-green-classification.md docs/VERIFY-LOG-2026-09-25.md docs/MANIFEST-2026-09-25-a.md
```
