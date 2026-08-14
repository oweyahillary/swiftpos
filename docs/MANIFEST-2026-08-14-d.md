# MANIFEST 2026-08-14-d — build both flavours at one version (supersedes -c)

**Adds** a single command that builds prod + dev at ONE version, fixing the
double-bump you saw (prod → 0.5.29, dev → 0.5.30). Cumulative; -d supersedes
-a/-b/-c. Everything from -c is still included.

**Base commit:** `c474cf2`. Shipped whole against that base (rule 4) — `git status`
first; reconcile any locally-edited file before overwriting.

**Register:** D17 extended (no new ID). Still OPEN.

---

## New/changed in -d (on top of -c)

| File | New/edit | What |
|---|---|---|
| `apps/desktop/scripts/release-both.mjs` | new | Bumps once (or not), builds the shared bundle once, packs prod + dev. |
| `apps/desktop/package.json` | edit | adds `release:both` and `pack:both`. **Version pinned to 0.5.30** to match your tree. |
| `docs/AUDIT-REGISTER.md` | edit | D17 entry notes `release:both`. |
| `docs/MANIFEST-2026-08-14-d.md` | new | this file. |

(-c's files — appFlavor ×2, electron-builder.config.js, release-flavour.mjs,
icon.dev.*, index.ts, the earlier manifests — are all still in the zip.)

## How to use it

Replace the two-command flow with one:

```bash
cd /c/swiftpos/pos/apps/desktop
npm run release:both     # bump patch ONCE → SwiftPOS + SwiftPOS Dev, same version
```

Both installers and both portables land in `release/` at the same number, e.g.:
```
SwiftPOS-0.5.31-x64.exe        SwiftPOS-0.5.31-portable.exe        (prod)
SwiftPOS Dev-0.5.31-x64.exe    SwiftPOS-Dev-0.5.31-portable.exe    (dev)
```

Other forms:
```bash
npm run release:both -- minor    # bump minor once, build both
npm run pack:both                # NO bump — rebuild both at the current version
```

**Stop running `release:patch` and `release:patch:dev` back-to-back** — that is
what double-bumped. `release:both` replaces both. The single-flavour scripts stay
for when you deliberately want only one.

## package.json version (rule 22)
Shipped at **0.5.30** (your tree after the last dev build). Extract won't move it.
If you've built again since, `npm version <your-version> --no-git-tag-version`
after extracting.

---

## Rollback (the -d additions)
```bash
cd /c/swiftpos/pos
rm apps/desktop/scripts/release-both.mjs docs/MANIFEST-2026-08-14-d.md
git checkout c474cf2 -- apps/desktop/package.json docs/AUDIT-REGISTER.md
# then re-apply -c, or re-bump the version to your real one
```

---

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- `release-both.mjs` dry-run: `patch`→ one `version:patch`, one `build:all`, one
  `assert:built`, then pack installer+portable for prod THEN dev; `none`→ same
  without the bump; `minor`→ `version:minor`; bad arg → exit 2.
- Renderer bundle is flavour-independent (identical hash across your own prod/dev
  build logs), so build-once-pack-twice is correct.
- `package.json`: `release:both`/`pack:both` present, version 0.5.30, valid JSON.
- Gates `check-register-consistency` (mutation-checked earlier) + `check-doc-refs`: green.

## NOT verified here — target only (rules 9, 16)
- The actual `npm run release:both` on Windows: four artifacts in `release/` at one
  version; the shared `win-unpacked/` staging dir ends as the last-packed (dev)
  flavour — expected, not a deliverable. Confirm all four `.exe` names + version.
- Everything in -c's target list (DEV icon at 16/32px, `%APPDATA%\SwiftPOS Dev`,
  runtime title) still applies.
