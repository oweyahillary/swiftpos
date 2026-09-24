# MANIFEST 2026-09-24-k — A327 fix: the selected theme is clearly marked in dark mode

**Re-issue of delivery 2026-09-24-j, which never landed.** On the owner's Windows run all 16 picker checks PASSED, then Node crashed
while exiting — `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` — a known, intermittent
Node-on-Windows race when `process.exit()` runs while stdout is still closing (the same test ran clean in the owner's -i run). The chain
stopped; nothing was committed. -k: the test sets `process.exitCode` and lets Node exit on its own (all pass → 0; a forced failure → 1,
so the gate still stops the chain). 56 other tests still end with `process.exit(...)` — recorded as a follow-up, not widened here.
Everything else is -j unchanged.

**Base commit:** `26f88a3` (origin/dev, delivery 2026-09-24-i; CI #396 green; dashboard deployed by the owner).
**Deploy:** the **dashboard only**. No cloud, database or desktop change.

**Why.** The owner's run proved web → cloud → till (Blossom picked and saved → the till's PIN screen turned Blossom). It also found a
defect: in **dark mode** — the dashboard's default — the **selected** theme tile was the *faintest* one, and the names looked disabled.
Cause: the dashboard is dark-first (its classes are written for dark; light mode overrides them in `index.css`), but the picker was
written light-first — `ring-gray-900` is near-invisible on the dark page while the unselected `border-gray-200` renders bright. My
bench run had used light mode only.

**Fix** (`BrandingTab.tsx`, the picker only): selected = the theme's OWN colour as border + a 2-px ring + a ✓ (mode-independent);
unselected `border-gray-700` (hover `border-gray-500`); names `text-gray-300`; "Suggested" and the suggestion line `text-gray-400`.

## Files (5)
| File | Change |
|---|---|
| `apps/dashboard/src/pages/settings/BrandingTab.tsx` | Picker styling as above. Nothing else. |
| `tests/branding-theme-picker.test.mjs` | +3 checks (selection mode-independent; no grey ring; readable names). 13 → 16. Ends with `process.exitCode` (Windows exit race). |
| `docs/AUDIT-REGISTER.md` | A327 target note + fix; header; changelog. |
| `docs/WORKING-METHOD.md` | §9: check dashboard UI in dark AND light mode. |
| `docs/MANIFEST-2026-09-24-k.md` | This file. |

## Verification
```
Chromium, the REAL BrandingTab, theme_id "blossom", DARK and LIGHT:
  dark : one tile selected (Blossom) · border rgb(236,72,153) + 2-px ring + ✓ · no other tile ringed · names worst 13.66:1
  light: the same · names worst 7.24:1
  original flow (off/on/Violet/Save/Reset/yellow + Sky) 15/15
node tests/branding-theme-picker.test.mjs 16/16 — mutation: selected back to ring-gray-900 → 2 FAIL
dashboard tsc 0 · check-register-consistency / check-doc-refs / check-root-clean → OK
```

## Owner, after the dashboard deploy
Branding → the selected theme has a coloured ring and ✓ in dark mode (and light). Then the one check still owed for A326/A327: set a
**brand colour** → Save → the till's brand strip, Lock-till curtain and Manager sidebar take it; buttons stay in the theme.

## Rollback
```bash
git checkout 26f88a3 -- apps/dashboard/src/pages/settings/BrandingTab.tsx tests/branding-theme-picker.test.mjs docs/AUDIT-REGISTER.md docs/WORKING-METHOD.md && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-24-k.md && rm -f docs/MANIFEST-2026-09-24-k.md
```
