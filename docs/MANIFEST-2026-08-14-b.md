# MANIFEST 2026-08-14-b — deploy env differentiation + flavoured release scripts

**Supersedes MANIFEST-2026-08-14-a.md** (rule 3 — cumulative; the latest wins).
Everything in -a is included below; -b adds only the named cross-platform
release scripts for the desktop dev flavour.

**Base commit:** `c474cf2` (dev). If your tree is ahead, hand-apply the edits.

**Register:** A68 + D17 (rule 14). D17's entry extended to note the wrapper.
Both still **OPEN** — close on owner action + a Windows check.

---

## Full file list (cumulative)

### New — safe to drop in (all in the zip)
| File | What / why |
|---|---|
| `apps/dashboard/src/lib/appFlavor.ts` | A68. Favicon + title from `VITE_APP_ENV`. |
| `apps/admin/src/lib/appFlavor.ts` | A68. Same, admin portal. |
| `apps/desktop/electron-builder.config.js` | D17. Build identity from `SWIFTPOS_ENV`. |
| `apps/desktop/resources/icon.dev.ico` | D17. Amber DEV icon, 7 sizes. |
| `apps/desktop/resources/icon.dev.png` | D17. PNG source. |
| `apps/desktop/scripts/release-flavour.mjs` | **NEW in -b.** D17. Zero-dep wrapper: sets `SWIFTPOS_ENV`, hands off to `release:<bump>`. |

### Edited — small, hand-apply if your tree moved (in the zip except where noted)
| File | Edit |
|---|---|
| `apps/dashboard/src/main.tsx` | import + `applyAppFlavor();` before render. |
| `apps/admin/src/main.tsx` | same two lines. |
| `apps/desktop/src/main/index.ts` | `cloudBadgeTitle()` + `PROD_CLOUD_HOSTS`; window title; `page-title-updated` lock. |
| `docs/AUDIT-REGISTER.md` | **not in zip (landmine, rule 4)** — A68 + D17 entries; header P3 counts A 1→2, D 2→3; D17 extended for the wrapper. Apply to your live register, then `node scripts/check-register-consistency.mjs`. |
| `docs/DESKTOP-AUTOUPDATE.md` | §8 dev/prod update-channel separation. |

### Edited — DO NOT overwrite whole (carries version — rule 22; hand-apply)
| File | Edit by hand |
|---|---|
| `apps/desktop/package.json` | (1) delete the whole `"build": {…}` block. (2) set `pack:installer` / `pack:portable` to `electron-builder --win <nsis\|portable> --config electron-builder.config.js --config.directories.output=release`. (3) **NEW in -b:** add three scripts after their prod siblings — `"release:patch:dev": "node scripts/release-flavour.mjs dev patch"`, `"release:minor:dev": "node scripts/release-flavour.mjs dev minor"`, `"release:major:dev": "node scripts/release-flavour.mjs dev major"`. **Leave `version` untouched** (release:patch owns the bump). No dependency is added, so `package-lock.json` does not change. |

---

## Rollback

```bash
rm apps/dashboard/src/lib/appFlavor.ts apps/admin/src/lib/appFlavor.ts
rm apps/desktop/electron-builder.config.js apps/desktop/scripts/release-flavour.mjs
rm apps/desktop/resources/icon.dev.ico apps/desktop/resources/icon.dev.png
git checkout c474cf2 -- apps/dashboard/src/main.tsx apps/admin/src/main.tsx \
  apps/desktop/src/main/index.ts apps/desktop/package.json \
  docs/AUDIT-REGISTER.md docs/DESKTOP-AUTOUPDATE.md
rm docs/MANIFEST-2026-08-14-a.md docs/MANIFEST-2026-08-14-b.md
```

---

## Owner steps to activate

### Vercel — one var per project (this turns the badge on)
On each **dev** project set `VITE_APP_ENV=dev`; on each **prod** project set
`VITE_APP_ENV=prod`; redeploy. Absent = prod (safe default).

```bash
# per project dir (npm i -g vercel; vercel login):
vercel link
printf 'dev'  | vercel env add VITE_APP_ENV production   # dev projects  (value: dev)
printf 'prod' | vercel env add VITE_APP_ENV production   # prod projects (value: prod)
vercel --prod
```
Local: add `VITE_APP_ENV=dev` to `apps/dashboard/.env` and `apps/admin/.env`.

### Render — nothing. Frontend + local build only; no cloud var.

### Desktop — build a flavour
```bash
cd /c/swiftpos/pos/shared/printing && npm install && npm run build && npm test
cd /c/swiftpos/pos/apps/desktop && npm install
npm run release:patch          # prod   → SwiftPOS,     icon.ico,     com.swiftpos.desktop
npm run release:patch:dev      # dev     → SwiftPOS Dev, icon.dev.ico, com.swiftpos.desktop.dev
```
`release:minor:dev` / `release:major:dev` exist too. Optionally set
`PROD_CLOUD_HOSTS` in `index.ts` so prod tills show a clean `SwiftPOS` title.

---

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- `electron-builder.config.js` **run** under `SWIFTPOS_ENV` unset / `=dev`: prod →
  `com.swiftpos.desktop`/`SwiftPOS`/`icon.ico`; dev → `.dev`/`SwiftPOS Dev`/`icon.dev.ico`.
- `release-flavour.mjs` dry-run: `dev patch`→`SWIFTPOS_ENV=dev npm run release:patch`,
  `prod`→prod, `dev minor`→minor; rejects bad flavour/bump with exit 2.
- `icon.dev.ico` has 7 embedded sizes (16–256). `package.json` valid JSON, version 0.5.27.
- `tsc --noEmit` clean for the new/edited files in dashboard, admin, desktop-main.
- Gates `check-register-consistency` (mutation-checked) and `check-doc-refs`: green.

## NOT verified here — check on the target (rules 9, 16)
- Favicon/title actually render in each Vercel tab after the var is set.
- A real installer — `electron-builder` can't run on this Linux bench against
  Electron's Windows ABI. On Windows: `npm run release:patch:dev` shows the DEV
  icon at 16/32px in taskbar + Start menu, writes to `%APPDATA%\SwiftPOS Dev`,
  and a prod build still installs clean beside it.
- The runtime title survives the renderer setting `document.title`.
- Run `node scripts/run-all.mjs` before shipping.
