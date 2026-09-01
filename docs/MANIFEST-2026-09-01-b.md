# MANIFEST 2026-09-01-b — A191 root-cause fix + A190 density

**Base:** dev @ 27aa75f. Dashboard only, additive.

## A191 — owner logged out by /kds (real fix)
The 2026-09-01 re-test reproduced the logout a 5th time even with the token-based /kds,
disproving the "A3 rewrite fixes it" hypothesis. Real cause: KDS realtime ran on the
SHARED `supabase` client, whose GoTrue auth-state changes drive `AuthContext` → a
realtime-triggered sign-out nulled the owner session app-wide. Fix: a dedicated
session-less realtime client for /kds.

| File | Change |
|---|---|
| `apps/dashboard/src/lib/kdsRealtime.ts` | **NEW.** Anon client, `persistSession:false, autoRefreshToken:false`. |
| `apps/dashboard/src/pages/kds/KDSPage.tsx` | Realtime channel now uses `kdsRealtime`, not the shared `supabase`. |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | A190: table `slotGrid` minmax 140→100px (re-test showed 5/row). |
| `docs/AUDIT-REGISTER.md` | A191 root-cause+fix; A190 density note. |
| `docs/MANIFEST-2026-09-01-b.md` | This file. |

## Verification (rule 7)
```
cd apps/dashboard && npm run build   → exit 0
check-register-consistency / doc-refs → OK
```

## Browser-confirm
- A191: open /kds, use it, return to a dashboard tab → STILL LOGGED IN (no redirect to /login).
- A190: restaurant tables → ~7–8 tiles per row.

## NOT fixed here (see chat)
- A187 void/refund + A184 rename: on dev, just need a DASHBOARD REDEPLOY.
- A146 email: infra — Render blocks outbound SMTP (25/465/587); this is the A50/A54 root
  cause. Fix on the hosting side (plan/instance type, or an HTTP mail API), not in code.
- A3 ticket delivery: the test order (paid cash takeaway) likely creates no kitchen ticket;
  needs a dine-in / sent-to-kitchen order to test. Realtime (fault 3) still separate.
- A144: needs a "mark an existing product tracked" control (threshold editor is useless
  while all 67 products are untracked with no retro-tracking path).
- Three stranded orders still need reversal.

## Rollback
`git restore apps/dashboard/src/pages/kds/KDSPage.tsx apps/dashboard/src/pages/pos/CashierScreen.tsx docs/AUDIT-REGISTER.md && rm apps/dashboard/src/lib/kdsRealtime.ts docs/MANIFEST-2026-09-01-b.md`
