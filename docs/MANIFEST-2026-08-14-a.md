# MANIFEST 2026-08-14-a — deploy environment differentiation (A68, D17)

**Base commit:** `c474cf2` (dev). If your working tree is ahead of this (the
08-1x sessions were staged locally before commit), apply the *edits* below by
hand rather than overwriting — every edit is small and marked.

**What this delivers:** a dev-vs-prod visual differentiator for the three
frontends (dashboard + admin favicon/title, A68) and for the desktop build
(dev icon + flavoured installer + runtime cloud-host title, D17). Driven by
environment, never by branch, so `main` and `dev` stay identical in git.

**Register:** A68 and D17 opened in `AUDIT-REGISTER.md` (rule 14). Both **OPEN** —
they close on owner action + a Windows check, see "Not verified" below.

---

## Files — new (safe to drop in; zipped)

| File | What / why |
|---|---|
| `apps/dashboard/src/lib/appFlavor.ts` | A68. Generates favicon (SVG data-URI) + tab title from `VITE_APP_ENV`. |
| `apps/admin/src/lib/appFlavor.ts` | A68. Same, for the admin portal. |
| `apps/desktop/electron-builder.config.js` | D17. Env-driven build identity (icon/appId/productName/artifact) from `SWIFTPOS_ENV`. |
| `apps/desktop/resources/icon.dev.ico` | D17. Amber DEV-badged icon, 7 sizes (16–256). |
| `apps/desktop/resources/icon.dev.png` | D17. PNG source of the above. |

## Files — edited (small; hand-apply if your tree has moved — rule 4)

| File | Edit |
|---|---|
| `apps/dashboard/src/main.tsx` | `import { applyAppFlavor }` + one `applyAppFlavor();` call before render. |
| `apps/admin/src/main.tsx` | Same two lines. |
| `apps/desktop/src/main/index.ts` | Add `cloudBadgeTitle()` helper + `PROD_CLOUD_HOSTS`; use it as the window `title`; lock via `page-title-updated`. |
| `docs/AUDIT-REGISTER.md` | A68 + D17 entries; header P3 counts A 1→2, D 2→3; Last-updated line. |
| `docs/DESKTOP-AUTOUPDATE.md` | New §8: dev/prod update-channel separation. |

## Files — edited, DO NOT overwrite whole (carries version — rule 22)

| File | Edit — apply by hand |
|---|---|
| `apps/desktop/package.json` | (1) delete the whole `"build": { … }` block (now in `electron-builder.config.js`). (2) set `scripts.pack:installer` = `electron-builder --win nsis --config electron-builder.config.js --config.directories.output=release` and `scripts.pack:portable` = `electron-builder --win portable --config electron-builder.config.js --config.directories.output=release`. **Leave `version` at whatever your tree holds** — this change does not bump it; `release:patch` still owns the bump. |

---

## Rollback (per file)

```bash
# new files — just remove them
rm apps/dashboard/src/lib/appFlavor.ts
rm apps/admin/src/lib/appFlavor.ts
rm apps/desktop/electron-builder.config.js
rm apps/desktop/resources/icon.dev.ico apps/desktop/resources/icon.dev.png

# edited files — restore from the base commit
git checkout c474cf2 -- apps/dashboard/src/main.tsx
git checkout c474cf2 -- apps/admin/src/main.tsx
git checkout c474cf2 -- apps/desktop/src/main/index.ts
git checkout c474cf2 -- apps/desktop/package.json
git checkout c474cf2 -- docs/AUDIT-REGISTER.md
git checkout c474cf2 -- docs/DESKTOP-AUTOUPDATE.md
rm docs/MANIFEST-2026-08-14-a.md
```

Everything is additive and reverts to a clean tree with the above.

---

## Owner steps to activate

### 1. Vercel — set ONE variable per project (this is what turns the badge on)

The three frontends are separate Vercel projects. On each **dev** project, and
each **prod** project, set `VITE_APP_ENV` (Settings → Environment Variables), then
redeploy so the build picks it up. Absent = prod (safe default).

CLI (`npm i -g vercel`, `vercel login`, run from the app dir or pass `--cwd`):

```bash
# --- DEV projects ---
vercel link            # once per project dir, selects the dev project
printf 'dev'  | vercel env add VITE_APP_ENV production   # value: dev
printf 'dev'  | vercel env add VITE_APP_ENV preview
vercel --prod          # redeploy

# --- PROD projects ---
vercel link            # selects the prod project
printf 'prod' | vercel env add VITE_APP_ENV production   # value: prod
vercel --prod
```

Or in the dashboard: Project → Settings → Environment Variables → Add
`VITE_APP_ENV` = `dev` (on dev projects) / `prod` (on prod projects) → Redeploy.

Local dev: add `VITE_APP_ENV=dev` to `apps/dashboard/.env` and
`apps/admin/.env` so `npm run dev` shows the amber SD badge too.

### 2. Render — nothing to do

This task is entirely frontend + local build. The cloud API on Render needs **no
new variable**. (Noted explicitly so nobody hunts for one.)

### 3. Desktop — build the two flavours

```bash
cd apps/desktop
# prod (unchanged behaviour):
npm run release:patch
# dev-flavoured (amber DEV icon, separate appId + %APPDATA%):
SWIFTPOS_ENV=dev npm run release:patch      # PowerShell: $env:SWIFTPOS_ENV='dev'; npm run release:patch
```

Optionally set the prod host in `apps/desktop/src/main/index.ts`
(`PROD_CLOUD_HOSTS`) so prod tills show a clean `SwiftPOS` title while dev/other
tills show `SwiftPOS — {host}`.

---

## Verified on the bench (rule 7 — Linux, Node 20; state the environment, rule 9)

- `electron-builder.config.js` **run** under `SWIFTPOS_ENV` unset and `=dev`:
  resolves prod → `com.swiftpos.desktop` / `SwiftPOS` / `icon.ico`; dev →
  `com.swiftpos.desktop.dev` / `SwiftPOS Dev` / `icon.dev.ico`. Case-insensitive.
- `icon.dev.ico` written with 7 embedded resolutions (16/24/32/48/64/128/256).
- `package.json` still valid JSON after the edit; `version` untouched at 0.5.27.
- Dashboard `tsc` — see session log.

## NOT verified here — you must check on the target (rules 9, 16)

- **The favicon/title actually render** in a browser tab on each Vercel URL after
  the var is set — a browser check, not a bench one.
- **A real installer.** `electron-builder` cannot run on this Linux bench against
  Electron's Windows ABI. Build `SWIFTPOS_ENV=dev pack:installer` on Windows and
  confirm: the DEV icon shows in taskbar + Start menu at small sizes; the dev app
  writes to `%APPDATA%\SwiftPOS Dev`; a prod build still installs clean alongside.
- **The runtime title** (`SwiftPOS — {host}`) appears and survives the renderer
  setting `document.title` — Electron behaviour, target-only.
- Run `node scripts/run-all.mjs` before shipping (the full gate suite); I ran the
  two that guard these doc edits, not the infra-dependent ones.

## Rules touched
14 (IDs + entries in the same change), 22 (no version in the delivery), 4 (base
commit stated; risky whole-file overwrites turned into hand-edits), 9/16 (bench
greens marked as bench; target checklist explicit), 21 (node/cloud kept
distinct in the runtime-title reasoning).
