# MANIFEST 2026-09-23-p — A318 products table keeps Edit/Delete on screen · A319 web Branding uses the till's contrast rule

**Base commit:** `df84eaa` (origin/dev, delivery -o; 3/3 checksums on the pulled tip, gates exit 0, CI #378 green, owner's
Windows builder run OK with no DEP0190). No shipped file has moved since; all ship whole.
**Register:** A318 OPEN → FIX BUILT (P3); A319 OPEN → FIX BUILT (P2). Header, changelog. Counts unchanged (FIX BUILT stays open).
**Environment:** Linux, Node 22.22.2; A319's test also on Node 24.21.0. Both fixes were reproduced and re-measured in
**headless Chromium on the real components** (a bench harness: the dashboard's own Tailwind build, `BusinessContext`
stubbed, `/api` answered by Playwright) — the harness is NOT in this delivery. Still weaker than the owner's browser.
**Deploys needed:** **dashboard only.** No cloud change, no migration, no desktop build (the two desktop `contrast.ts`
copies change by one header comment line — see below — and ride the next bump).
**Byte-affecting:** no receipt bytes.

## Files (12)

| File | Change |
|---|---|
| `apps/dashboard/src/pages/products/ProductsPage.tsx` | A318: table in an inner `overflow-x-auto`; actions `<td>` and its `<th>` `sticky right-0 bg-gray-900`, actions `whitespace-nowrap`. |
| `tests/products-table-actions.test.mjs` | **NEW.** Pins scroller + pinned/opaque actions cell + pinned header + no-wrap. 7/7. |
| `apps/dashboard/src/pages/settings/BrandingTab.tsx` | A319: local `lum`/`ratio`/`isLegible` removed; verdict = `resolveBranding(accent, '#0d1424')`; preview accent + Enter text from the same rule; surface = the till's `#0d1424` (was `#0f172a`). |
| `apps/dashboard/src/lib/contrast.ts` | **NEW.** Byte-identical copy of `shared/contrast.ts` (vendored: Vercel builds `apps/dashboard` alone). |
| `shared/contrast.ts` | Header: lists the dashboard copy. No code change. |
| `apps/desktop/src/shared/contrast.ts` | Same one header line (copies must be byte-identical). |
| `apps/desktop/src/main/contrast.ts` | Same one header line. |
| `scripts/check-shared-sync.mjs` | `contrast.ts` entry gains `apps/dashboard/src/lib/contrast.ts` (4 copies). |
| `tests/branding-web-contrast.test.mjs` | **NEW.** Wiring pins + runs the DASHBOARD copy: #F5B800 accepted with black text; all 8 palette colours accepted; #1e293b falls back; web surface == PinPage == BrandingEditor. 11/11. |
| `tests/branding-web-page.test.mjs` | Its A308 assertion pinned `function isLegible` (the removed local copy) → now pins the shared rule. 26/26. |
| `docs/AUDIT-REGISTER.md` | A318, A319 → FIX BUILT with evidence; 11 sibling tables listed on A318 (not fixed); header; changelog. |
| `docs/MANIFEST-2026-09-23-p.md` | This file. |

## Verification (rule 7) — commands and what they printed

```
A318 — real browser (bench harness, real ProductsPage, owner's rows)
  tip, 1100px:  Family Meals  Edit visible 0/5 · user-scrollable container: False · UNREACHABLE: all 5
                Burgers       Edit visible 3/3                                      (the owner's report exactly)
  scroller only (intermediate): Edit reachable everywhere, but only by sideways scroll → not discoverable → added (2)
  -p, 900/1100/1280/1558/1920px × Family Meals / Burgers / All:  Edit visible as rendered in every row · RESULT: PASS
  -p, 1100px Family Meals: Edit + Delete hit-testable 5/5 each; click Edit → form opens with "12PCS Tender Family Meal"
  node tests/products-table-actions.test.mjs     7 passed, 0 failed
    no scroller / no sticky td / no opaque bg / no sticky th / wrap allowed → 1 FAIL each · tip file → 5 FAIL

A319 — real browser (bench harness, real BrandingTab), type into the custom hex box:
  tip:  #F5B800 → amber "isn't legible" warning, preview Enter TEAL  (tester's A5)
  -p:   #F5B800 → "Legible ✓", preview Enter rgb(245,184,0) with text rgb(0,0,0)
        #1e293b → warning, preview falls back to teal · palette #b45309 → no message, white text
  node tests/branding-web-contrast.test.mjs      11 passed, 0 failed  (Node 22 via --experimental-strip-types; Node 24 native)
    surface → #0f172a / verdict also demands white / illegible palette colour / preview text forced white → 1 FAIL each
    tip BrandingTab → 5 FAIL. (A first verdict pin let "also demand white" through; tightened to the exact three lines.)
  node tests/branding-web-page.test.mjs          26 passed, 0 failed
  node scripts/check-shared-sync.mjs             OK — 7 shared file copies all agree (contrast.ts: 4 copies identical)
  node apps/desktop/test/contrast.test.mjs       17 passed, 0 failed

Gates
  node scripts/run-all.mjs                       GREEN 117 passed, 0 skipped (115 + the two new tests)
  node scripts/typecheck-ratchet.mjs server dashboard admin   exit 0
  apps/dashboard npm run build                   exit 0
  apps/desktop tsc -b tsconfig.main.json --force / tsc -p tsconfig.json --noEmit   exit 0 / exit 0
  node scripts/test-print-resilience.mjs         55 passed, 0 failed
  check-register-consistency / check-doc-refs / check-root-clean / check-test-registration   OK
```

## Not verified here (rule 16) — owner, after the dashboard deploy
1. **A318:** Menu → filter Family Meals at the window width that hid Edit → Edit and Delete on every row; Edit opens the form.
2. **A319:** Business → Branding → type `#F5B800` → "Legible ✓", yellow preview, BLACK Enter text → Save → the till's lock
   screen shows the same yellow with black Enter. Then VERIFY-BRANDING-PHASE1 **A5**.

## Rollback
```bash
git checkout df84eaa -- apps/dashboard/src/pages/products/ProductsPage.tsx apps/dashboard/src/pages/settings/BrandingTab.tsx \
  shared/contrast.ts apps/desktop/src/shared/contrast.ts apps/desktop/src/main/contrast.ts scripts/check-shared-sync.mjs \
  tests/branding-web-page.test.mjs docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch apps/dashboard/src/lib/contrast.ts \
  tests/products-table-actions.test.mjs tests/branding-web-contrast.test.mjs docs/MANIFEST-2026-09-23-p.md && rm -f \
  apps/dashboard/src/lib/contrast.ts tests/products-table-actions.test.mjs tests/branding-web-contrast.test.mjs docs/MANIFEST-2026-09-23-p.md
```
