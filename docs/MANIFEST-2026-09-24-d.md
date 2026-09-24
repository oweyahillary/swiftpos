# MANIFEST 2026-09-24-d — Phase 2 slice 1: the theme registry (A324); Phase 2 tracker opened (A323)

**Base commit:** `d49cefb` (origin/dev, delivery 2026-09-24-c; 3/3 checksums on the tip, gates exit 0, CI #391 green).
**No visible change. No deploy needed** (nothing imports the registry yet; it is compiled into both apps' source trees only).

**What.** The owner approved the revised Phase 2 proposal and the five-slice plan. Slice 1 is the foundation every later slice
uses: `themes.ts`, one registry for the till and the web.
- Seven action themes (Ocean, Violet, Lagoon, Orchid, Sky; Teal and Blossom marked `tillCheck`) as colour families with the fixed
  shade per job; default `ocean`; the real surfaces and status colours; the rules as numbers.
- `checkTheme` — the proposal's table as code; `resolveTheme` / `isThemeId`; `themeTokens`; `suggestThemeFor` (complementary hue);
  `resolveBrandLayer` (any visible hue; null when too dark or invalid).
- Self-contained (no imports), three byte-identical copies under `check-shared-sync` (the cloud's joins in slice 2).

## Files (7)
| File | Change |
|---|---|
| `shared/themes.ts` | **NEW** (canonical). |
| `apps/desktop/src/shared/themes.ts` | **NEW** copy (the till). |
| `apps/dashboard/src/lib/themes.ts` | **NEW** copy (the web). |
| `scripts/check-shared-sync.mjs` | `themes.ts` entry (3 copies). |
| `tests/themes-registry.test.mjs` | **NEW.** 27 checks; run by CI's `tests/*.test.mjs` loop and run-all. |
| `docs/AUDIT-REGISTER.md` | NEW A323 (tracker) + A324 (slice 1, FIX BUILT); Counts; Open A 18/16/18 → **18 P1 · 17 P2 · 19 P3**; header; changelog. |
| `docs/MANIFEST-2026-09-24-d.md` | This file. |

## Verification (rule 7)
```
node tests/themes-registry.test.mjs                                   27 passed, 0 failed (Node 22 via strip-types; Node 24 native)
  every theme passes every check · tillCheck exactly Teal + Blossom · pairwise >= 10
  REFUSED: emerald (paid 7.3) · rose (void) · amber (warning) · yellow (warning) · Iris beside Violet (7.2)
  pairing: yellow → sky · red → lagoon · green → orchid · brand: navy / invalid → null
  mutations: Ocean 500 too dark (2 FAIL) · Teal flag off (1) · Emerald added (3) · "most different" pairing (2) · no visibility rule (1)
node scripts/check-shared-sync.mjs    OK — 10 copies agree (themes.ts ×3) · one-word divergence in the dashboard copy → FAIL naming it
apps/dashboard tsc --noEmit 0 · apps/desktop tsc -b tsconfig.main.json 0 · the till copy under the renderer's settings 0
node scripts/run-all.mjs GREEN 118/118 · check-test-registration / check-reference-names / check-doc-refs / check-root-clean / check-register-consistency OK
```

## After push
A324 closes when CI is green on the pushed commit. Next: slice 2 (`theme_id`, migration 106, cloud validation, sync, the `themes` flag).

## Rollback
```bash
git checkout d49cefb -- scripts/check-shared-sync.mjs docs/AUDIT-REGISTER.md && rm -f shared/themes.ts apps/desktop/src/shared/themes.ts apps/dashboard/src/lib/themes.ts tests/themes-registry.test.mjs docs/MANIFEST-2026-09-24-d.md && git rm -q --cached --ignore-unmatch shared/themes.ts apps/desktop/src/shared/themes.ts apps/dashboard/src/lib/themes.ts tests/themes-registry.test.mjs docs/MANIFEST-2026-09-24-d.md
```
