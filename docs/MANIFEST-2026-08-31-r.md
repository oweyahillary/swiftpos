# MANIFEST 2026-08-31-r — A184: name terminals from the Terminals screen

**Base commit:** `189bfc2` (dev). Dashboard only, additive. No DB, no server change.

## What
A184 was mostly already built: the rename endpoint `PATCH /api/devices/:id/label` (A72)
and per-till telemetry (user / last-seen / last-sync / versions) already existed and show
on FleetPage. The gap was a UI to SET the name — so all tills read the same and couldn't
be told apart. Added an inline rename control on the Terminals screen.

| File | Change |
|---|---|
| `apps/dashboard/src/pages/FleetPage.tsx` | Hover-✎ inline rename on the terminal label → `PATCH /api/devices/:id/label` (optimistic). |
| `docs/AUDIT-REGISTER.md` | A184: rename control wired. |
| `docs/MANIFEST-2026-08-31-r.md` | This file. |

## Verification (rule 7)
```
cd apps/dashboard && npm run build   → exit 0
node scripts/check-api-routes.mjs    → OK (287; the /:id/label call matches the endpoint)
node scripts/check-register-consistency.mjs / doc-refs → OK
```
No server change — the endpoint pre-existed (gated on devices.approve OR settings.manage).

## Browser-confirm (rule 16)
Settings → Devices and printers → Terminals → hover a row → ✎ → type a name (e.g.
"Front counter") → Enter → the label persists and distinct tills show distinct names.
→ A184 closes.

## Rollback
`git restore apps/dashboard/src/pages/FleetPage.tsx docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-08-31-r.md`
