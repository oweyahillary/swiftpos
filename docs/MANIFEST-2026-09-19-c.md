# Delivery manifest — 2026-09-19 (-c) · A300 rule-21 rename + README count (end-of-day cleanup)

**Base:** `origin/dev` (9799cdb). Two minor items.

## Changes
| File | Change |
|---|---|
| `apps/desktop/src/main/{deviceConfig,syncEngine,index,techService,ipcHandlers}.ts` | Rule 21: rename `getServerUrl()` -> `getCloudUrl()` (function + all 20 call sites). `server_url` COLUMN kept, commented (rule 21). Pure rename, no behaviour change. |
| `apps/desktop/package.json` | version 0.5.48 -> **0.5.49** (rule 15). |
| `README.md` | "There are 77 migrations" -> "99" (actual file count; numbered to 103). |
| `docs/AUDIT-REGISTER.md` | A300 (P3 FIX BUILT); header P3 14->15; Tree line -> v0.5.49; changelog. |
| `docs/MANIFEST-2026-09-19-c.md` | This file. |

## Verified on the bench (rule 9)
0 `getServerUrl` references remain; 20 `getCloudUrl`. `check-register-consistency`, `check-doc-refs`,
`check-root-clean`, `check-ipc-parity`, `check-ipc-validation` green.

## NOT verified — must run before releasing (rules 9, 16)
Desktop `tsc`/`build:all` — Electron can't build on the bench AND **CI does not type-check the desktop**,
so a missed reference would only surface at build time. Run `cd apps/desktop && npm ci && npm run build:all`
and confirm it prints `Packaging v0.5.49` before any release/tag. (No urgency to release — pure rename;
rides the next desktop release.)

## Apply
```
git apply "../patch files/swiftpos-A300-rule21-readme.patch"
git add -A && git commit -m "A300: rule-21 getServerUrl->getCloudUrl rename; README migration count 77->99" && git push origin dev
```
