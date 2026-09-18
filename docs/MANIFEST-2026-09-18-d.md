# Delivery manifest — 2026-09-18 (-d) · release 0.5.46 (A298 build provenance)

**Base commit:** `e97e67a` (branch `dev`, i.e. after v0.5.45 / A297).
**Scope:** the build-provenance stamp (A298) that was meant to fold into 0.5.45 but was missed
(the A297-only patch was applied instead). A298 rides its own 0.5.46. Includes the version bump.

> TAG ONLY AFTER 0.5.45 IS CONFIRMED ON THE TILL. One desktop release at a time — don't stack
> 0.5.46 on top of an unconfirmed 0.5.45. Apply + build now if you like, but hold the tag until
> the Overview is confirmed populated on 0.5.45.

## Files

| File | Change |
|---|---|
| `apps/desktop/scripts/gen-build-info.mjs` | New — writes `dist/main/build-info.json` (SHA + time) after build:main; never exits non-zero. |
| `apps/desktop/src/main/buildInfo.ts` | New — runtime reader, 'unknown' fallback, never throws. |
| `apps/desktop/src/main/index.ts` | Launch log `[startup] SwiftPOS <v> build <sha> @ <time>` + import. |
| `apps/desktop/src/main/ipcHandlers.ts` | `tech:status` returns a `build` field + import. |
| `apps/desktop/src/renderer/lib/posApi.ts` | `TechStatus.build?: { sha; time }`. |
| `apps/desktop/src/renderer/pages/TechPage.tsx` | Build row on the Device section. |
| `apps/desktop/package.json` | `version` 0.5.45 → **0.5.46**; `gen:buildinfo` script; `build:all` runs gen after build:main. |
| `docs/AUDIT-REGISTER.md` | A298 added (P3 FIX BUILT); header P3 12→13. |
| `docs/MANIFEST-2026-09-18-d.md` | This file. |

## Rollback

```
git checkout e97e67a -- apps/desktop/src/main/index.ts apps/desktop/src/main/ipcHandlers.ts \
  apps/desktop/src/renderer/lib/posApi.ts apps/desktop/src/renderer/pages/TechPage.tsx \
  apps/desktop/package.json docs/AUDIT-REGISTER.md
git rm apps/desktop/scripts/gen-build-info.mjs apps/desktop/src/main/buildInfo.ts docs/MANIFEST-2026-09-18-d.md
# if tagged:  git push --delete origin v0.5.46 ; git tag -d v0.5.46
```

## Cut the release (rule 15 — tag AFTER a verified build, AND after 0.5.45 is confirmed on the till)

```bash
# from /c/swiftpos/pos
git apply --check "../patch files/swiftpos-0.5.46-A298-provenance.patch"
git apply "../patch files/swiftpos-0.5.46-A298-provenance.patch"
git add -A
git commit -m "0.5.46: build provenance stamp — git SHA + build time on Tech screen + launch log (A298)"
git push origin dev

cd apps/desktop
npm ci
npm run build:all         # runs gen:buildinfo; watch for its "[gen-build-info] <sha> @ <time>" line
npm run assert:built
cd ../..

# only after 0.5.45 is confirmed on the till AND this build is green:
git tag v0.5.46 && git push origin v0.5.46
```

## Verified on the bench (Linux, Node 22, no app node_modules — rule 9)

`check-register-consistency`, `check-doc-refs`, `check-root-clean`, `check-ipc-parity`,
`check-ipc-validation`, `check-test-registration` re-run green; `gen-build-info.mjs` runs and writes a
valid stamp (`{"sha":"…","time":"…"}`); syntax-checked.

## NOT verified — target/CI only (rules 9, 16)

- Desktop `tsc`/`build:all` and on-screen render — run on Windows before tagging.
- A298 closes when TechPage → Device shows a real SHA + time matching `v0.5.46`'s commit, and the
  launch log prints the build line. From then on, "which build is this till running?" is a glance.
