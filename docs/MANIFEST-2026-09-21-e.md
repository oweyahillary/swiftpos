# MANIFEST 2026-09-21-e — desktop: A302 tech-gated branding FEED (accent + PNG/JPEG)

**Supersedes 2026-09-21-d** (Rule 3). Code + its register entry ship together (Rule 14).

**Base commit:** `587e32b` (`dev` tip — the A301 register entry). If `dev` has moved, do NOT
extract the full register over it — apply the four register edits (below) by hand.
**Scope:** `apps/desktop` renderer + one root test + the register entry. No main-process code
(the write path + guard shipped in A301), no migration, no version bump (Rules 15, 22).
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.
**Register ID:** A302 (entered in this delivery — Rule 14).

## Why

The "minimal way to feed it" the write path (A301) was built for: a technician-gated editor that
writes a real accent/logo through `branding:set`, so the lock screen finally changes on a till —
HANDOFF-2026-09-20 §6 "Next". Branch/brand changes live behind the tech gate.

## What changed and why

| File | New? | Change | ID |
|---|---|---|---|
| `apps/desktop/src/renderer/pages/BrandingEditor.tsx` | **new** | Tech-gated editor: accent picker (colour + hex) with a live `resolveBranding` legibility preview; PNG/JPEG upload routed through `prepareRasterLogo` (raster shrink; SVG rejected); Save/Reset call `posApi.branding.set`; `businessId` read from the owner session; every write audited via `tech.logAction`; Save guarded on a known businessId. Matches TechPage's dark-console styling. | A302 |
| `apps/desktop/src/renderer/pages/TechPage.tsx` | edit | Import + mount `<BrandingEditor/>` as a section (before the destructive reset). | A302 |
| `tests/branding-feed-wiring.test.mjs` | **new** | Source-guard (8 checks, mutation-checked): set call, session-derived businessId, prepareRasterLogo, audit, PNG/JPEG-only input, businessId guard, legibility preview, TechPage mount. Auto-registered by the CI `tests/*.test.mjs` glob. | A302 |
| `docs/AUDIT-REGISTER.md` | edit | A302 entry + Open `16 P3`->`17 P3` + Counts `…A301 A302` + a `2026-09-21 (feed)` changelog line. | A302 |

Register edits, for hand-apply if `dev` moved: (1) new `### A302 …` between A301 and A276;
(2) Open `17 P2 · 16 P3` -> `17 P2 · 17 P3`; (3) Counts `A301 — D-P0` -> `A301 A302 — D-P0`;
(4) prepend the `2026-09-21 (feed)` changelog entry. Tree row untouched (v0.5.49 = package.json).

## Verification (Rule 7 — what was run)

Bench, Linux/Node 22 (weak green, Rule 9):
- **`node tests/branding-feed-wiring.test.mjs` -> 8/8.** Two mutations confirmed to bite:
  breaking the `branding.set` call and widening `accept` to `image/*` each turn the named
  assertion red; restored -> green (rules 10, 23).
- **Renderer type-check (`tsc -p tsconfig.json`) -> 0 errors** across the whole renderer,
  including `BrandingEditor.tsx`, `TechPage.tsx`, and `prepareRasterLogo.ts` (which A301 could
  not type-check in isolation — it now compiles against the real DOM lib types).
- **19/19 static gates green**, incl. `check-test-registration` (128 files — the new test picked
  up by the glob), `check-register-consistency` (A302 added, P3 re-derives to 17), `check-doc-refs`.

**Could NOT verify here (target-only, Rule 16):** the on-screen editor itself and — the whole
point — the lock screen rendering a written accent/logo; `prepareRasterLogo`'s Canvas resize at
runtime (needs a DOM). These need Electron on the till.

## Rollback (Rule 2)

```bash
git checkout 587e32b -- apps/desktop/src/renderer/pages/TechPage.tsx docs/AUDIT-REGISTER.md
rm -f apps/desktop/src/renderer/pages/BrandingEditor.tsx tests/branding-feed-wiring.test.mjs
```

## Commit (direct to dev, explicit paths — never `git add -A`)

```bash
git checkout dev && git pull                    # confirm 587e32b; else re-apply the 4 register edits
git add apps/desktop/src/renderer/pages/BrandingEditor.tsx \
        apps/desktop/src/renderer/pages/TechPage.tsx \
        tests/branding-feed-wiring.test.mjs \
        docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-e.md
git status --short                              # expect exactly these five
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs && node tests/branding-feed-wiring.test.mjs
git commit -m "feat(desktop): A302 tech-gated branding feed (accent + PNG/JPEG) + register"
git push
```

Then verify CI on `dev` is green. TARGET verification owed before A302 closes: open Technician mode
on a real till, set an accent + upload a logo, and confirm the lock screen shows them.
