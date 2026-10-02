# Delivery manifest — 2026-09-18 (-b) · release 0.5.44

**Base commit:** `e71e5e8` (branch `dev`, i.e. after -a / A296).
**Scope:** cut the desktop **0.5.44** release so the till auto-updates off the stale 0.5.43
build (A297), plus correct the A297 register entry. This is the actual fix for the blank
Overview / Item Mix — **the source is already correct; the running artifact was not.**

Unlike -a, this delivery **intentionally includes the version bump** (`apps/desktop/package.json`):
a release must carry its version so `latest.yml` / electron-updater see a newer build. (Rule 22's
"a zip carries the change, never the version" is for in-place fix deliveries, not a release cut.)

---

## Files

| File | Change | Why |
|---|---|---|
| `apps/desktop/package.json` | `version` 0.5.43 → **0.5.44** | Rule 15 — the release version electron-updater compares against. |
| `docs/AUDIT-REGISTER.md` | Rewrote **A297** in place (same ID) to the verified finding: installed 0.5.43 artifact predates the A290/A293 Overview fix; DB + current source both proven correct. Status stays P1 · OPEN (until 0.5.44 confirmed on-till), so open counts are unchanged. | The earlier A297 text ("ingested orders lack line items") was disproven by the tech-console reads; leaving it standing would mislead. Rule 14 / A60 — edit the entry, don't append. |
| `docs/MANIFEST-2026-09-18-b.md` | This file. | Rule 2. |

## Rollback

```
git checkout e71e5e8 -- apps/desktop/package.json docs/AUDIT-REGISTER.md
git rm docs/MANIFEST-2026-09-18-b.md
# and delete the tag if already pushed:  git push --delete origin v0.5.44 ; git tag -d v0.5.44
```

## How to cut the release (rule 15 — tag AFTER a verified build)

`release.yml` triggers on a `v*` tag, builds the prod desktop on Windows, and runs
`electron-builder --publish always` → uploads installer + `.blockmap` + `latest.yml` to the
GitHub Release (`oweyahillary/swiftpos`). Tills poll that feed on launch + every 6h and install
on next quit (D3).

```bash
# from /c/swiftpos/pos
git add -A
git commit -m "0.5.44: release desktop (A297 stale-build fix via auto-update; A297 register corrected)"
git push origin dev

# VERIFY THE BUILD BEFORE TAGGING (rule 15) — a bad build must not get a tag/release:
cd apps/desktop
npm ci
npm run build:all          # clean + build main + renderer (prod path CI also runs)
npm run assert:built       # fails if any artefact is missing
cd ../..

# Only if the build is clean, tag to fire the release:
git tag v0.5.44
git push origin v0.5.44
```

Then watch **Actions → Release desktop** go green and confirm the GitHub Release has the
`.exe`, `.exe.blockmap`, and `latest.yml`. The till converges within ~6h (or on next launch),
and installs on next quit.

## Verified on the bench (Linux, Node 22, no app node_modules — rule 9)

`check-register-consistency`, `check-doc-refs`, `check-root-clean` re-run green after the edits.

## NOT verified — target/CI only (rules 9, 16)

- The desktop **build itself** — run `build:all` + `assert:built` on Windows before tagging
  (the bench can't build Electron). CI's `release.yml` also builds it, but rule 15 wants a
  known-good build before the tag, not after.
- The end-to-end auto-update on the till, and the actual fix: **after the till reports 0.5.44,
  Overview must show KES 650 / 1 order / cash.** That confirmation closes A297.
- If Overview is STILL 0 on a freshly-built, confirmed-0.5.44 till, the stale-build conclusion
  is wrong — capture the DevTools console error next (`[Overview] salesSummary failed` /
  `[managerReports] …`; it's `console.warn`, not in `swiftpos.log`).
