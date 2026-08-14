# MANIFEST 2026-08-14-c — complete delivery (supersedes -a and -b)

**Corrects a delivery error in -a/-b:** those withheld `apps/desktop/package.json`
and asked for a hand-edit. Rule 22 permits shipping a version-carrying file for a
real change *with the version called out* — it does not mean withhold it. So this
zip contains **every** changed file. Extract once over the repo root; no hand-edits.

**Base commit:** `c474cf2` (dev). Files are shipped whole against that base
(rule 4). Before extracting, run `git status` — if it shows local edits to any
file below (most likely `AUDIT-REGISTER.md` or `src/main/index.ts`), reconcile
that one by hand instead of blind-overwriting; the rest are safe.

**Register:** A68 + D17 (rule 14). Both OPEN.

---

## Every file in this zip (extract over `C:\swiftpos\pos`)

| File | New/edit | What |
|---|---|---|
| `apps/dashboard/src/lib/appFlavor.ts` | new | A68 favicon+title from `VITE_APP_ENV`. |
| `apps/dashboard/src/main.tsx` | edit | calls `applyAppFlavor()` before render. |
| `apps/admin/src/lib/appFlavor.ts` | new | A68, admin portal. |
| `apps/admin/src/main.tsx` | edit | calls `applyAppFlavor()`. |
| `apps/desktop/electron-builder.config.js` | new | D17 build identity from `SWIFTPOS_ENV`. |
| `apps/desktop/scripts/release-flavour.mjs` | new | D17 zero-dep flavoured-release wrapper. |
| `apps/desktop/resources/icon.dev.ico` | new | amber DEV icon, 7 sizes. |
| `apps/desktop/resources/icon.dev.png` | new | PNG source. |
| `apps/desktop/src/main/index.ts` | edit | runtime cloud-host window title (D17). |
| **`apps/desktop/package.json`** | **edit — now INCLUDED** | build block removed; pack scripts use `--config electron-builder.config.js`; `release:*:dev` added. **Version pinned to 0.5.29 to match your tree** (see below). |
| `docs/AUDIT-REGISTER.md` | edit | A68 + D17 entries; header P3 counts. |
| `docs/DESKTOP-AUTOUPDATE.md` | edit | §8 dev/prod update-channel separation. |
| `docs/MANIFEST-2026-08-14-a.md` | new | earlier manifest (kept). |
| `docs/MANIFEST-2026-08-14-b.md` | new | earlier manifest (kept). |
| `docs/MANIFEST-2026-08-14-c.md` | new | this file. |

**Not shipped, on purpose:** `apps/desktop/package-lock.json` — no dependency was
added, so it is unchanged; rule 22 says never ship a lockfile.

## The one thing to know about `package.json` (rule 22)

It is shipped at **version 0.5.29**, matching your tree after the build in your
last log. Extracting therefore does **not** move your version. If you have run
another `release:*` since (so your tree is at 0.5.30+), set it back after
extracting: `npm version <your-version> --no-git-tag-version`. Your next
`release:patch:dev` bumps from wherever you are.

---

## Rollback

```bash
cd /c/swiftpos/pos
git checkout c474cf2 -- apps/dashboard/src/main.tsx apps/admin/src/main.tsx \
  apps/desktop/src/main/index.ts apps/desktop/package.json \
  docs/AUDIT-REGISTER.md docs/DESKTOP-AUTOUPDATE.md
rm apps/dashboard/src/lib/appFlavor.ts apps/admin/src/lib/appFlavor.ts \
  apps/desktop/electron-builder.config.js apps/desktop/scripts/release-flavour.mjs \
  apps/desktop/resources/icon.dev.ico apps/desktop/resources/icon.dev.png \
  docs/MANIFEST-2026-08-14-a.md docs/MANIFEST-2026-08-14-b.md docs/MANIFEST-2026-08-14-c.md
```
(`git checkout c474cf2 -- apps/desktop/package.json` restores version 0.5.27 —
re-bump to your real version afterward.)

---

## Apply + build

```bash
cd /c/swiftpos/pos
git status                                   # reconcile any locally-edited file first
unzip -o ~/Downloads/swiftpos-2026-08-14-c.zip

cd apps/desktop
node -e "console.log('build field:', !!require('./package.json').build)"   # want: false
npm run release:patch:dev                     # → SwiftPOS Dev, icon.dev.ico, com.swiftpos.desktop.dev
```

Watch the build log for `loaded configuration file=electron-builder.config.js`
(not `package.json ("build" field)`) and artifact `SwiftPOS Dev-0.5.30-x64.exe`.

## Vercel (unchanged from -b)
Set `VITE_APP_ENV=dev` on dev projects, `=prod` on prod projects, redeploy.
Render: nothing.

---

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- `package.json`: build field removed, pack scripts repointed, three `release:*:dev`
  present, version 0.5.29, valid JSON.
- `electron-builder.config.js` run under `SWIFTPOS_ENV` unset/=dev → correct
  prod/dev identity + icon.
- `release-flavour.mjs` dry-run: correct env+bump routing; rejects bad input (exit 2).
- `icon.dev.ico`: 7 embedded sizes. `tsc --noEmit` clean for all new/edited files.
- Gates `check-register-consistency` (mutation-checked) + `check-doc-refs`: green.

## NOT verified here — target only (rules 9, 16)
- Favicon/title render in each Vercel tab after the var is set.
- A real installer: `electron-builder` can't run on this Linux bench vs Electron's
  Windows ABI. On Windows confirm the DEV icon at 16/32px, `%APPDATA%\SwiftPOS Dev`,
  and a prod build still installs clean beside it.
- Runtime title survives the renderer setting `document.title`.
- `node scripts/run-all.mjs` before shipping.
