# MANIFEST 2026-08-31-m — A190: smaller cloud POS table tiles (~7–8 per row)

**Base commit:** `189bfc2` (dev). Dashboard-only, values-only. No logic, no DB.

## Change
Restaurant table grid tiles were fixed 220px×190px (name 24px) → ~5 per row. Now ~7–8:

| Style key | Was | Now |
|---|---|---|
| `s.slotGrid` cols | `repeat(auto-fill, 220px)` | `repeat(auto-fill, minmax(140px, 1fr))` |
| `s.slotGrid` gap | 10 | 8 |
| `s.slotCard` height | 190 | 130 |
| `s.slotCard` padding | 22/18/20 | 14/10/12 |
| `s.slotCard` radius | 16 | 12 |
| `slotName` font | 24 | 18 |
| `slotSub` font | 15 | 13 |

`minmax(…,1fr)` makes tiles fill the row and reflow responsively (~7 on a laptop, ~8 on
a wide screen), rather than a fixed count.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | The 3 style edits above. |
| `docs/AUDIT-REGISTER.md` | A190 added (P3); header + Counts. |
| `docs/MANIFEST-2026-08-31-m.md` | This file. |

## Verification (rule 7)
```
cd apps/dashboard && npm run build          → exit 0
node scripts/check-register-consistency.mjs → OK
node scripts/check-doc-refs.mjs             → OK
```
Target-only (rule 16): eyeball the grid — 7–8 per row, names still legible.

## Rollback
`git restore apps/dashboard/src/pages/pos/CashierScreen.tsx docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-08-31-m.md`
