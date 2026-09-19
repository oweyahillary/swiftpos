# Delivery manifest — 2026-09-19 (-a) · A281 Part B (web build stamp)

**Base:** `origin/dev` (e90ecb6). **Web/dashboard only** — deploys via Vercel on push, **no desktop
version bump, no tag.** Note: it only shows on the LIVE web once it reaches Vercel's branch (`main`).

## What it does
Stamps the web build with its commit so "is the front-end current?" is a glance (the A281 pain).
- `vite.config.ts` `define` injects `__WEB_BUILD_SHA__` / `__WEB_BUILD_REF__` / `__WEB_BUILD_TIME__`
  from Vercel's `VERCEL_GIT_COMMIT_SHA` / `VERCEL_GIT_COMMIT_REF` (falls back to `dev`/`local`).
- `main.tsx` logs `[web] SwiftPOS dashboard build <sha> (<ref>) @ <time>` on boot.
- `LoginPage.tsx` shows `web <sha> · <ref>` on the footer (title = build time).
- `vite-env.d.ts` declares the three globals so the dashboard type-check passes.

## Files
| File | Change |
|---|---|
| `apps/dashboard/vite.config.ts` | `define` for the three build globals. |
| `apps/dashboard/src/vite-env.d.ts` | `declare const __WEB_BUILD_*__`. |
| `apps/dashboard/src/main.tsx` | boot console stamp. |
| `apps/dashboard/src/pages/LoginPage.tsx` | login-footer stamp. |
| `docs/AUDIT-REGISTER.md` | A281 Part B note + changelog. |
| `docs/MANIFEST-2026-09-19-a.md` | this file. |

## NOT done — your decision (Part A)
Align the deploy branches so front-end and back-end move together. Both branches are **dashboard
settings** (Render tracks `dev`, Vercel tracks `main`); neither is in the repo. Options in the reply.

## Verified on the bench (rule 9)
`check-register-consistency`, `check-doc-refs`, `check-root-clean` green. Dashboard `tsc`/`vite build`
NOT run here (no node_modules) — CI's ratchet type-checks the dashboard; watch it green on push.

## Apply
```
git apply "../patch files/swiftpos-A281-webstamp.patch"
git add -A && git commit -m "A281 Part B: web build stamp (vite define + console + login footer)" && git push origin dev
```
