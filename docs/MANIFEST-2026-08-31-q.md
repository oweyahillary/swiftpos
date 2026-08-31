# MANIFEST 2026-08-31-q — A146 (notifications half) + A144 (threshold setter)

**Base commit:** `189bfc2` (dev). Dashboard only, additive. No DB, no server change
(both endpoints already existed).

## A146 — notifications half (both halves now wired)
"Send test email" button in Settings → Business → **Report scheduler** →
`POST /api/notifications/test-email` (owner-only; sends to the owner's account email).
With the earlier webhook-delivery fix (`-p`), both halves of A146 are wired. The button
also doubles as a live diagnostic for the A50/A54 mail issue.

## A144 — threshold setter (1 of 3 actions)
Product low-stock threshold is now editable inline in the **POS Inventory** tab →
`PATCH /api/inventory/:product_id/threshold`. The other two A144 endpoints (transfer
approve/complete, direct branch-stock set) remain unwired — A144 stays OPEN.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/settings/ReportSchedulerTab.tsx` | Test-email card + `sendTest` handler. |
| `apps/dashboard/src/pages/pos/POSInventoryTab.tsx` | Editable threshold input per row + `updateThreshold` (optimistic). |
| `docs/AUDIT-REGISTER.md` | A146 notifications-half wired; A144 threshold wired. |
| `docs/MANIFEST-2026-08-31-q.md` | This file. |

## Verification (rule 7)
```
cd apps/dashboard && npm run build          → exit 0
node scripts/check-api-routes.mjs           → OK (286 calls; both new calls match)
node scripts/check-register-consistency.mjs / doc-refs → OK
```
Both endpoints pre-existed and are `requireAuth` (test-email owner-only) — no server change.

## Browser-confirm (rule 16)
- **A146:** Settings → Business → Report scheduler → **Send test email** → arrives in
  your inbox (this also tells us if A50/A54 mail works). And send a test webhook → it
  now shows in the Deliveries log. → A146 closes.
- **A144:** POS drawer → Inventory → edit a product's **min** value → the low-stock
  badge recomputes and the value persists on reload. → the threshold action closes
  (2 of 3 remain open).

## Rollback
```
git restore apps/dashboard/src/pages/settings/ReportSchedulerTab.tsx apps/dashboard/src/pages/pos/POSInventoryTab.tsx docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-31-q.md
```
