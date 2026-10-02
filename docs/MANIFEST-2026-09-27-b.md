# MANIFEST 2026-09-27-b — A333: light mode that reads (coloured and pale text, row lines)

**Base commit:** `0b11d2a` (origin/dev = 2026-09-27-a + desktop v0.6.9; CI #408 green). One commit on `claude/modest-cray-f21ll5`;
the owner fast-forwards `dev`. **Deploy: dashboard only.** No desktop change, no version bump.

Why (owner, 2026-09-27, Ingredients screenshots dark vs light): "we need to work on the color balancing on the light mode".

## What changed
- NEW `scripts/build-light-colours.mjs` — generates ONE block in `apps/dashboard/src/index.css` (between BEGIN/END markers):
  a light rule for every coloured / pale text class and translucent gray line the dashboard source uses (52 rules).
  Coloured text 300–500 → the same colour's 700, or 800 where the 700 fails on the colour's own denser tint; pale gray text
  (100/200) → slate; translucent gray borders/dividers/fills → the light theme's grays. Scoped to light mode, NOT inside a web POS
  set to dark, NOT inside the always-dark screens. Outside `@layer base`. `--check` for CI.
- `LoginPage`, `OnboardingPage`, `ForcePasswordChangePage` — `data-theme-lock="dark"` on their 4 always-dark layouts. Inside it the
  block also restores `text-white` (light mode had turned it slate on navy: 1.10:1).
- NEW `tests/light-colours.test.mjs`; CI step "Light-mode colours are current".
- `scripts/back-office-colour-baseline.json` — `index.css` 0 → 14 (the block's light status/info shades; reviewed, nothing else moved).
- `docs/AUDIT-REGISTER.md` — A333 FIX BUILT; header; changelog.

## Files (10)
| File | Change |
|---|---|
| `scripts/build-light-colours.mjs` | NEW — the generator. |
| `apps/dashboard/src/index.css` | The generated light-colours block (52 rules). |
| `apps/dashboard/src/pages/LoginPage.tsx` | Marker on 2 layouts. |
| `apps/dashboard/src/pages/OnboardingPage.tsx` | Marker. |
| `apps/dashboard/src/pages/ForcePasswordChangePage.tsx` | Marker. |
| `tests/light-colours.test.mjs` | NEW. |
| `.github/workflows/ci.yml` | Step "Light-mode colours are current". |
| `scripts/back-office-colour-baseline.json` | `index.css` 14. |
| `docs/AUDIT-REGISTER.md` | A333. |
| `docs/MANIFEST-2026-09-27-b.md` | This file (NEW). |

## Verification (bench: Linux, Node 22)
```
Chromium on the compiled dashboard CSS — the owner's Ingredients screen rebuilt from its real classes, LIGHT mode, before → after:
  "active" badge 1.60 → 6.54 · low/out-of-stock pill 1.49 → 6.31 · Import CSV 1.13 → 9.45 · "0 pc" 2.77 → 6.47 · OUT 3.76 → 6.47
  "All branches" 2.17 → 5.73 · row lines rgba(31,41,55,.5) → rgba(226,232,240,.6)
  controls: web POS set to dark — unchanged (10.74) · sign-in text-white 1.10 → 19.57 · teal accent card labels unchanged
node tests/light-colours.test.mjs → 9 passed (every mapped colour ≥ 4.5 on the 3 light surfaces and its own /10 /15 /20 tint)
  mutations: amber back to 700 · dark-POS exclusion dropped · pale labels darkened · a sign-in layout loses its marker → each
  reddens its named check (two first survived — a broken mutation, and a check one of LoginPage's two layouts satisfied — fixed)
node scripts/build-light-colours.mjs --check → OK · check-back-office-colour → OK (411 = baseline)
tests/*.test.mjs → 126, 0 failed · typecheck-ratchet apps/server, dashboard, admin → 0 · dashboard build OK
every "node scripts/…" CI step → 0, except test-maintenance / test-tech-db-console (no better-sqlite3 on this bench; CI runs them)
```
Before/after screenshots were sent in the session. Not verified here (rule 16): every screen of the real app in light mode.

## Owed on target
Deploy the dashboard. Light mode: Ingredients, Purchase orders, Stock transfers, Staff, Reports, Overview — badges, OUT/low, amber
pills, blue tags, links readable; row lines faint; dark mode unchanged; the sign-in page in light mode shows white text on navy.
Anything still hard to read → a screenshot; the generator makes the fix one rule.

## Rollback
```bash
git checkout 0b11d2a -- apps/dashboard/src/index.css apps/dashboard/src/pages/LoginPage.tsx apps/dashboard/src/pages/OnboardingPage.tsx apps/dashboard/src/pages/ForcePasswordChangePage.tsx .github/workflows/ci.yml scripts/back-office-colour-baseline.json docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch scripts/build-light-colours.mjs tests/light-colours.test.mjs docs/MANIFEST-2026-09-27-b.md && rm -f scripts/build-light-colours.mjs tests/light-colours.test.mjs docs/MANIFEST-2026-09-27-b.md
```
