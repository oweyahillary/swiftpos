# MANIFEST 2026-08-31-a — A185: cloud POS restyled to the desktop till (restaurant, slice 1)

**Base commit:** `e1acb92` (dev).
**Register:** A185 (P2, OPEN). Entry added in this same change (rule 14).
**Kind:** dashboard (web) only. No desktop change → no version bump (rule 15 N/A).
No migration, no DB, no server, no `shared/` (rule 13: additive, UI values only).

## Files

| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | Restyle only — no logic touched. (1) Dark `--pos-*` token block remapped slate→desktop gray. (2) `s.header` slate→gray. (3) blue `#3b82f6`/`rgba(59,130,246,*)` accents → green `#22c55e`/`rgba(34,197,94,*)` on: spinner, mode badge, parked-active, active-table pill, covers pill, active product card, cart badge, category-chip fallback, variant-modal selection. (4) layout: `s.rightPanel` 300→320px, `s.productGrid` gap 10→12 & min 110→120px, `s.productCard` centre→left align, `s.productImage` 64×64→full-width×76. |
| `docs/AUDIT-REGISTER.md` | A185 entry added above A184; header Open A-P2 21→22; Counts A-P2 gains A185. |
| `docs/MANIFEST-2026-08-31-a.md` | This file. |

## Verification (rule 7 — what ran and what it printed)

```
cd apps/dashboard && npm install   # 159 packages
cd apps/dashboard && npm run build  # vite
  → exit 0 · "✓ built in 11.40s" · POSEntryPage bundle emitted
```

Environment: Linux, Node 22.22 (repo targets Node 24 — engine warning only). The
dashboard's real target is the Linux/browser build, so this is an on-target green,
not a weak Linux-vs-Windows claim (contrast rule 9's desktop note).

Build script is `vite build` with no `tsc` step; the edit is value-only inside a
typed `React.CSSProperties` map + a CSS template string, so type risk is nil.

## Could NOT be verified here (rule 16 — target-only)

- The **visual + interaction result** in a browser on the live restaurant POS.
  This is the whole point of the change and needs an eye. Open `/pos` → restaurant
  cashier, dark mode, and confirm: near-black gray surfaces, green accents/badges,
  full-width product-card images, 320px cart, green Charge button.
- Full `tsc` type-check across the app (deps for it not run here; build passed).

## Residual (rule 7 — deliberately out of this slice, to keep the diff contained)

Blue accents still present, to mop up in the layout/polish slice:
- Table-Transfer modal — `CashierScreen.tsx:2066,2067,2115`
- Parking bill box — `:2501` (parking mode only, not restaurant)
- Room-charge modal — `:2567,2583`

`MinimartPOS.tsx` is a separate component that does not use these tokens, so its
inner grid is unchanged; parking/petrol share CashierScreen's chrome and are
re-skinned incidentally (no extra risk).

## Rollback

```
git checkout e1acb92 -- apps/dashboard/src/pages/pos/CashierScreen.tsx \
                        docs/AUDIT-REGISTER.md docs/MANIFEST-2026-08-31-a.md
```

(or, before commit: `git restore apps/dashboard/src/pages/pos/CashierScreen.tsx`).

## Before you commit (rule 20 — run the gates on your box)

```
node scripts/run-all.mjs      # or at least:
node scripts/check-register-consistency.mjs
node scripts/check-doc-refs.mjs
```
Both were run in the delivery sandbox and were green (see session notes).
