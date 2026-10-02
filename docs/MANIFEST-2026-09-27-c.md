# MANIFEST 2026-09-27-c — A332: the web POS's themed buttons read in light mode

**Base commit:** `3cd3629` (origin/dev = 2026-09-27-b; CI #409 green). One commit on `claude/modest-cray-f21ll5`; the owner
fast-forwards `dev`. **Deploy: dashboard only.** No desktop change, no version bump.

Why: A332 (found 2026-09-26 while building A329 step 3) — owner: "proceed with A332".

## What changed
- `scripts/build-light-colours.mjs` — three more generated light-mode rules (A333's generator, same block, same CI `--check`):
  1. **White labels stay white** on a solid fill where white beats the slate the light theme turns `.text-white` into — computed
     per fill the source pairs with `text-white`: `action-600` (the theme's 700) and `red-600` (the Delete confirm). Fills where slate
     reads better (green-500, red-500, amber-600, green-600, blue-500) are left to slate.
  2. **The action hover** `hover:bg-action-400` (dark-label buttons: Charge, Pay, Apply, Save …) = the theme's 400 FILL
     (`--action-d-400`) in light mode and in a light web POS — not the link-text shade (teal 700 / the theme's 700).
  3. **The themed focus ring** `focus:border-action-500` in light mode.
- `apps/dashboard/src/index.css` — the regenerated block (56 rules); A328's focus rule removed from `@layer base` (it never compiled).
- `tests/light-colours.test.mjs` — 4 more checks (13).
- `docs/AUDIT-REGISTER.md` — A332 FIX BUILT; header; changelog.

## Files (5)
| File | Change |
|---|---|
| `scripts/build-light-colours.mjs` | White-keeping fills, action hover, focus ring. |
| `apps/dashboard/src/index.css` | Regenerated block; dead focus rule removed from the layer. |
| `tests/light-colours.test.mjs` | A332 checks. |
| `docs/AUDIT-REGISTER.md` | A332. |
| `docs/MANIFEST-2026-09-27-c.md` | This file (NEW). |

## Verification (bench: Linux, Node 22)
```
Chromium, compiled dashboard CSS, LIGHT mode, worst case over themes OFF + all 7 themes (variables set as themeVars.ts sets them):
  action button hover (dark label)   2.51 → 6.56   (Violet)
  white label on bg-action-600       2.51 → 5.36   (Lagoon)
  red Delete (white on red-600)      3.70 → 4.83
  focus:border-action-500            forced light gray → the theme colour
node tests/light-colours.test.mjs → 13 passed
  A332 mutations: keep white on every fill · drop the hover rule · focus rule back inside @layer base → each reddens its check
node scripts/build-light-colours.mjs --check → OK (56 rules)
tests/*.test.mjs → 126, 0 failed · typecheck-ratchet apps/server, dashboard, admin → 0 · dashboard build OK
every "node scripts/…" CI step → 0, except test-maintenance / test-tech-db-console (no better-sqlite3 on this bench; CI runs them)
```
Not verified here (rule 16): the live web POS in light mode.

## Owed on target
Deploy the dashboard. Dashboard in LIGHT mode, open the web POS: hover Charge / Pay / Apply (the label stays readable), split and
tip buttons with white text, focus an input (theme-coloured ring); a Delete confirm shows white text. Themes OFF and one theme.

## Rollback
```bash
git checkout 3cd3629 -- scripts/build-light-colours.mjs apps/dashboard/src/index.css tests/light-colours.test.mjs docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-27-c.md && rm -f docs/MANIFEST-2026-09-27-c.md
```
