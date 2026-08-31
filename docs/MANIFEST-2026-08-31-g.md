# MANIFEST 2026-08-31-g — A188: cloud restaurant POS table view (stacked → grid fallback)

**Base commit:** `189bfc2` (dev). **Cumulative** over `-b`..`-f`. Register is a
full-file replace (idempotent).

## What changed
The cloud restaurant POS floor plan absolute-positioned every table at
`pos_x ?? 40, pos_y ?? 40`; a branch with no saved floor layout stacked all tables at
(40,40) — one box ("T1") instead of the 11 the desktop shows. Fix mirrors the desktop
`TablesView`: use the floor plan only when a layout exists, else a grid of all tables.

| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | Add `hasLayout`; render floor plan only when `floorMode && hasLayout` (else grid); hide the Floor/Grid toggle until a layout exists. |
| `docs/AUDIT-REGISTER.md` | A188 added (P2); header Open A-P2 17→18; Counts + Next-free-ID → A189. |
| `docs/MANIFEST-2026-08-31-g.md` | This file. |
| (carried) `OrdersPage.tsx`, `orders.ts`, `owner-void-refund.test.mjs`, `App.tsx`, `DashboardLayout.tsx`, MANIFEST-b..f | From A186/reconciliation/A187. |

## Verification (rule 7)
```
cd apps/dashboard && npm run build   → exit 0, "✓ built in 12.55s"
node scripts/check-register-consistency.mjs → OK
node scripts/check-doc-refs.mjs             → OK
```
No data, endpoint, or logic change — pure render guard. Env: Linux/browser build (on-target).

## Could NOT be verified here (rule 16 — browser)
- Restaurant POS on a branch with **no** floor layout → all tables show as a
  selectable grid (not one stacked box).
- A branch **with** a saved layout → floor plan still renders positioned tiles.
- The Floor/Grid toggle appears only when a layout exists.

## Rollback
Before commit: `git restore apps/dashboard/src/pages/pos/CashierScreen.tsx docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-08-31-g.md`
After push: `git revert <sha> && git push origin dev`.
