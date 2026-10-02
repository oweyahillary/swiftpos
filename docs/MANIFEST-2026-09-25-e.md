# MANIFEST 2026-09-25-e — A329 step 2: SwiftPOS teal is the standard look (tills + web POS) · A331 · desktop v0.6.7 row

**Base commit:** `2c163d5` (origin/dev, delivery 2026-09-25-d; CI #402 green). **Deploy:** dashboard **and** desktop **0.6.7**
(`npm version 0.6.7` is in Block 3; tag after CI is green). No cloud / database change.

**What changes for every client with themes OFF:** the till and the web POS move from green to **SwiftPOS teal** (owner decision
A329): Charge / Add to Order / Open Table / selected chips and tabs / links / the lock curtain / the SwiftPOS wordmark. Green now
means **success only** (paid, free table, saved, online); prices and M-Pesa unchanged. Clients WITH a theme see no change.
**A331** (a defect in slice 3): on themed tills, white labels on the 600 shade fell below 4.5:1 for 5 of 7 themes — now the
theme's 700 (worst 5.36).

## Files (10)
- `apps/dashboard/src/index.css`
- `apps/desktop/src/renderer/index.css`
- `apps/desktop/src/renderer/lib/themeVars.ts`
- `apps/desktop/src/renderer/pages/InstallPage.tsx`
- `apps/desktop/src/renderer/pages/POSPage.tsx`
- `apps/desktop/test/theme-vars.test.mjs`
- `docs/AUDIT-REGISTER.md`
- `docs/MANIFEST-2026-09-25-e.md`
- `scripts/till-green-baseline.json`
- `tests/web-pos-theme.test.mjs`

## Verification (rule 7)
```
BENCH, real compiled CSS:
  till OFF: fills #14b8a6 · white-label fills + lock-curtain Enter #0f766e (white 5.47) · links #2dd4bf · status green unmoved ·
    wordmark teal · till ON (Ocean): 500 Ocean, 600 → Ocean 700 (A331)
  web OFF: all 94 inline uses teal by role in dashboard dark / light and POS dark / light · class tokens teal · status green unmoved ·
    web ON (Blossom) still wins
apps/desktop/test/theme-vars 20/20 — A331 mapping reverted → worst 3.68, FAIL · tests/web-pos-theme 21/21
check-till-green OK (baseline 68 → 66: the wordmark) · check-web-pos-green OK
check-register-consistency: red until `npm version 0.6.7` is in the same commit (by design)
run-all 122 passed, 1 failed: check-register-consistency ONLY (Tree line — until npm version 0.6.7) · all 26 apps/desktop/test pass ·
  dashboard build 0 · ratchet OK
```

## Not verified here (rule 16) — owner
1. Till on **0.6.7**, B Foods themes **OFF**: Charge, Start selling, selected chips, links, Lock-till curtain in **teal**; Paid / Shift
   open / prices still green; the "SwiftPOS" wordmark teal.
2. Web POS, themes OFF: the same — green and blue primaries now teal.
3. Themes ON (any theme): unchanged from today (except white-label buttons on themed tills now a deeper shade — A331).
4. Slice 5 B1 (Teal vs "paid" in shop light) — if too close, say so; the default moves deeper.

## Rollback (before tagging)
```bash
git checkout 2c163d5 -- . && rm -f docs/MANIFEST-2026-09-25-e.md
```
After a tag is pushed, do not move it — cut v0.6.8 instead.
