# MANIFEST 2026-09-01-c — owner-void-anytime (+ carries the A191/A190 fix)

**Base:** dev @ 27aa75f. **Cumulative** over `-b`: this zip also contains the A191 KDS
logout fix + A190 density, so apply this one and you have everything since 27aa75f.

## Owner-void-anytime (owner request)
Owners may void at any age; staff/supervisor voids stay window-limited (shrinkage
control). Reason still required + recorded either way.

| File | Change |
|---|---|
| `apps/server/src/routes/orders.ts` | Void window check → `orderAge > VOID_WINDOW_MINUTES && !req.isOwner` (owners exempt; staff still 403 VOID_WINDOW_EXPIRED). |
| `apps/dashboard/src/pages/OrdersPage.tsx` | `isOwner` from token; owners see **Void on every order + Refund** on completed; old owner-void shows a closed-period warning. Staff stay window-limited. |
| `tests/owner-void-refund.test.mjs` | New assertion: owner bypasses window, non-owner still limited (mutation-checked). |
| `apps/dashboard/src/lib/kdsRealtime.ts`, `pages/kds/KDSPage.tsx`, `pages/pos/CashierScreen.tsx` | Carried from `-b` (A191 logout fix + A190 density). |
| `docs/AUDIT-REGISTER.md` | A187 owner-void-anytime note (+ A191/A190 from -b). |
| `docs/MANIFEST-2026-09-01-b.md` + this file | Both included. |

## Verification (rule 7)
```
apps/dashboard: npm run build        → exit 0
apps/server: tsc --noEmit            → exit 0
node tests/owner-void-refund.test.mjs → 7/7; MUTATION (drop && !req.isOwner) → FAILED; restore → green
check-register-consistency / doc-refs → OK
```

## Browser-confirm
- Old order as owner → **Void** button present; clicking it shows the amber closed-period
  warning; voiding works with reason recorded. **Refund** also available (your choice).
- A staff/manager token past 30 min → Void hidden / 403; only Refund.
- (From -b) use /kds → return to dashboard → still logged in; tables ~7–8/row.

## Rollback
`git restore apps/server/src/routes/orders.ts apps/dashboard/src/pages/OrdersPage.tsx tests/owner-void-refund.test.mjs docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-09-01-c.md`
(and the -b files if reverting that too)
