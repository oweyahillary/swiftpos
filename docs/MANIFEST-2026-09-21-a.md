# MANIFEST 2026-09-21-a — desktop: A301 branding WRITE path (accent + raster logo)

**Base commit:** `932a4da` (`dev` — the 2026-09-20 A295 read-path handoff).
**Scope:** `apps/desktop` only. No server, no migration, no cloud. Additive — the `branding`
table, the read seam (`PinPage` / `branding:get`), and every other channel are untouched.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0` (24 standing rules).
**Register ID:** **A301 (PROPOSED)** — highest in the register is A300; confirm the next free
number against `AUDIT-REGISTER.md` before committing (rule 14). All new code cites A301.

Continues the A295 branding work: `HANDOFF-2026-09-20.md §6` "Next" = *"a `branding:set` (+ a
minimal way to feed it) so a real client accent/logo can be written to the local table and seen
flowing through the seam."* This is that write path. SVG upload + the sanitiser stay their own
later slice (see corrections below).

## What changed and why

| File | New? | Change | ID |
|---|---|---|---|
| `apps/desktop/src/main/brandingGuard.ts` | **new** | Pure guard (no db/electron/DOM, like `contrast.ts`): `validateBrandingWrite` (accent must be hex; logo must be a PNG/JPEG data-URI under 250 KB; **SVG rejected**) + `base64Bytes` + `MAX_LOGO_BYTES`. Throws verbatim on invalid (rules 7/11). | A301 |
| `apps/desktop/src/main/localDb.ts` | edit | Import the guard; add `setBranding(businessId, {accentHex?, logoPng?})` — validates, then a **one-transaction read-merge-write** UPSERT (undefined = leave, null = clear, value = set), so accent-only never wipes a logo. | A301 |
| `apps/desktop/src/main/ipcHandlers.ts` | edit | Import `setBranding`; add `handle('branding:set', …)`. Guard runs here too — persist-boundary check, the renderer is not trusted. | A301 |
| `apps/desktop/src/main/ipcSchemas.ts` | edit | `branding:set` payload schema (structure only; value rules live in the guard); added to `NEEDS_LIVE_TEST`. | A301 |
| `apps/desktop/src/main/preload.ts` | edit | Bridge `branding.set`. | A301 |
| `apps/desktop/src/renderer/lib/posApi.ts` | edit | `branding.set` type. | A301 |
| `apps/desktop/src/renderer/lib/prepareRasterLogo.ts` | **new** | Renderer Canvas resize: **shrink, never crop** (card is `object-fit: contain`). PNG/JPEG in → transparent PNG out, ≤1024px longest edge, steps 1024→256 until under 250 KB, else clear reject; blur/oversize warnings. No native dep (avoids the `sharp`/ABI wall). | A301 |
| `apps/desktop/test/branding-set.test.mjs` | **new** | Drives the REAL compiled `dist/main/brandingGuard.js` (accept/reject/size/hex/SVG-by-message) + a real-driver UPSERT/merge section mirroring `setBranding`'s SQL. Mutation list in header. | A301 |

## Verification (rule 7 — what was run, and what was NOT)

**Environment:** Linux, Node 22, **in-sandbox — NOT the till target.** Per rule 9 this is a
**weak green**: the tills run Windows / Electron 43.4.0 / Node 20, and none of the SQLite, IPC,
or renderer-Canvas paths here were exercised on that ABI.

Run on the bench:
- **Pure guard logic — real code, PASS.** `brandingGuard.ts` transpiled with `tsc` and driven
  through 14 assertions: `base64Bytes` (incl. padding), hex accept/lowercase/reject, null-vs-
  undefined, PNG accepted, SVG/non-raster/bare/oversize rejected → **14/14**.
- **Two mutations confirmed to bite (rule 10):** removing the 250 KB throw → oversize accepted
  (assertion goes red); dropping the SVG-reject branch → the SVG-specific *message* is lost
  (the `throwsMsg(/svg/i)` assertion goes red). **The SVG input still throws** via the raster
  allow-list even with its branch removed — defence in depth — which is why the test matches the
  message, not just that it threw (rule 24). Restored → green.

**Could NOT verify here (rules 7/9/16 — target-only):**
- No `dist/` build and no Electron run, so `branding-set.test.mjs` has **not** run against the
  real compiled module, and the **UPSERT/merge section and all remaining mutations are unrun.**
- **The IPC gates did not run** — `check-ipc-parity` and `check-ipc-validation` need deps/build.
  The change touches all four layers (schema, handler, preload, posApi) so it *should* stay
  green, but that is a claim, not a result.
- `apps/desktop` `tsc` (`tsconfig.main.json` + renderer) **not run** — no full type-check.
- `prepareRasterLogo.ts` is **completely unexercised** (needs a DOM/Canvas; the repo has no
  jsdom+canvas harness). Its resize/step-down behaviour is reasoned, not tested.
- Nothing visual: the actual lock screen rendering a written accent/logo is unproven.

## Rollback (rule 2)

Additive; undo by restoring the four edited files and deleting the three new ones:
```bash
git checkout 932a4da -- apps/desktop/src/main/localDb.ts \
  apps/desktop/src/main/ipcHandlers.ts apps/desktop/src/main/ipcSchemas.ts \
  apps/desktop/src/main/preload.ts apps/desktop/src/renderer/lib/posApi.ts
rm -f apps/desktop/src/main/brandingGuard.ts \
  apps/desktop/src/renderer/lib/prepareRasterLogo.ts \
  apps/desktop/test/branding-set.test.mjs
```
No version bump shipped (rule 22): bump `apps/desktop/package.json` and tag **after** the build
that ships this (rule 15), batched with the feed UI below.

## What the next session MUST do on target (rule 16)

1. `apps/desktop`: `npx tsc -b tsconfig.main.json --force` then
   `ELECTRON_RUN_AS_NODE=1 npx electron test/branding-set.test.mjs` → expect green; then
   **mutation-check every item in the test header** and confirm each bites.
2. Run the gates: `check-ipc-parity`, `check-ipc-validation`, `check-table-usage`,
   `check-register-consistency`, `check-doc-refs`, `check-root-clean`.
3. Build the **feed** (the "minimal way" from §6): a tech-gated affordance that calls
   `posApi.branding.set` — accent picker (safe now) and a PNG/JPEG file input routed through
   `prepareRasterLogo`. Then the **visual** check: write an accent → lock-screen divider/Enter/
   active-dot change colour; write a logo → it renders on the white logo-card.

## Corrections to the spec found while building (worth recording under A301)

- `docs/A295-SLICE1C-UPLOAD-VALIDATION.md` says *"add the SVG sanitiser as a small shared helper
  (same synced-copies pattern as `contrast.ts`)."* That is misleading. `contrast.ts` is pure and
  zero-dependency; a correct SVG sanitiser must **parse-and-rebuild against an allow-list**
  (DOMPurify-class), which **needs a DOM** — trivial in the renderer, but server-side needs jsdom
  kept current, and DOMPurify is actively CVE-tracked. It is **not** a small pure synced helper and
  must be its own slice (renderer + server), not this one. `prepareRasterLogo.ts` is also DOM-bound
  and therefore renderer-only, not a synced helper — a second place that phrasing does not hold.
- The spec's logo rules read as a *strip-these-tags denylist*; the correct model for the sanitiser
  slice is an **allow-list** (drop everything not known-safe). Note for when that slice is written.
