# MANIFEST 2026-08-17-c — A110 recharts v2 deprecation resolved

**Base:** apply on top of A108 (`122dd9f`) and A109. Register ID **A110**.
Resolves the Vercel `npm warn deprecated recharts@2.x` line repo-wide. No new
charting library added (deliberate — see the entry).

`docs/AUDIT-REGISTER.md` here contains A108 + A109 + A110; it overwrites cleanly
only if -a and -b were already applied.

## Files (8)

| File | Change | Why |
|---|---|---|
| `apps/dashboard/package.json` | remove `recharts` | dashboard imports it **zero** times (charts are hand-rolled SVG). |
| `apps/dashboard/package-lock.json` | 37 packages dropped (recharts + d3) | resolved tree. |
| `apps/dashboard/vite.config.ts` | remove the dead `charts` `manualChunks` branch | recharts/d3/victory are no longer deps. |
| `apps/dashboard/src/App.tsx` | fix stale comment (drop "or recharts") | doc drift. |
| `apps/admin/package.json` | `recharts ^2.12.7 → ^3.10.1` | admin's one `BarChart` is the only real user; v3 is the supported major. |
| `apps/admin/package-lock.json` | recharts 3 tree | resolved. |
| `apps/admin/src/AdminPortal.tsx` | drop unused `LineChart, Line` imports | dead imports. |
| `docs/AUDIT-REGISTER.md` | A110 entry | rule 14. |

## Verified (Node 22)

- Dashboard: recharts gone (`npm ls recharts` empty), `vite build` clean, `npm audit` 0, deprecation warning gone.
- Admin: recharts 3.10.1, `vite build` clean (603→590 KB), `npm audit` 0. Checked the 3.0 migration guide against admin's exact usage — **no breaking change applies** (no `Customized`, `contentStyle` not custom `content`, default axis IDs, single Y axis, no Scatter/Area/Pie/Reference). tsc shows **zero** new or chart-related errors.

## NOT done (deliberate)

- **No new charting library** — one 7-bar chart doesn't justify swapping one big dep for another.
- **admin's ~59 pre-existing `tsc` errors** (inline-style `boxSizing` etc.) are unrelated, present on recharts 2 and 3, and don't block the esbuild `vite build`. Left untouched.
- **Visual check pending:** admin's `BarChart` should be eyeballed in a browser (no e2e covers AdminPortal).

## Rollback

Per file: `git checkout -- <path>`.
