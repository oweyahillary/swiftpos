# MANIFEST 2026-09-03-a — dashboard: A192 (KDS auth-state) + A195 (Refunded badge)

**Base commit:** `67fdd63` (`dev`).
**Scope:** cloud/dashboard only. No server, migration, or endpoint change. Both items were
built on the bench and stay **OPEN pending a browser pass** (rule 16).
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0` (24 standing rules).

## What changed and why

| File | New? | Change | ID |
|---|---|---|---|
| `apps/dashboard/src/pages/kds/kdsConn.ts` | **new** | Pure `classifyKdsFetch(ok,status,isArray)` → `ok`/`auth`/`error`; the single decision point so a 401 can't read as an empty queue. | A192 |
| `apps/dashboard/src/pages/kds/KDSPage.tsx` | edit | Drive a `conn` state off the real fetch outcome; **return before `setTickets` on any non-ok fetch** (stops the blind wipe to `[]`); status dot green/red/amber off `conn`; a 401/403 renders a "not paired → Re-pair" panel; a network/`error` state keeps last tickets under an amber strip. | A192 |
| `apps/dashboard/src/pages/orderRefund.ts` | **new** | Pure `isRefunded(payments)` — detects a refund from a `status:'refunded'` payment leg (status stays `completed`). Client-only signal; no server change. | A195 |
| `apps/dashboard/src/pages/OrdersPage.tsx` | edit | Amber **"Refunded"** badge beside the status; suppress the Refund button once refunded (server 400s a double refund). | A195 |
| `tests/kds-conn-state.test.mjs` | **new** | 7 source-level guard checks (mutation-checked) for the A192 classifier + page wiring. | A192 |
| `tests/orders-refund-badge.test.mjs` | **new** | 4 source-level guard checks (mutation-checked) for the A195 detector, badge, and server producer pin. | A195 |
| `docs/AUDIT-REGISTER.md` | edit | FIX-BUILT notes on A192 + A195 (rule 14). No count change — nothing closed. | — |

## Verification (rule 7 — what was run, and what was not)

Environment: Linux, Node 22 in-sandbox. The dashboard's real target **is** the Linux/browser
Vite build, so this is on-target for these files, not a weak Linux green (per the A185 note).

- `apps/dashboard` `npx tsc --noEmit` → **exit 0, 0 errors**.
- `apps/dashboard` `npm run build` (vite) → **exit 0**, "✓ built in ~9.6s"; `POSEntryPage` +
  router/index chunks (KDSPage, OrdersPage) emitted.
- `node tests/kds-conn-state.test.mjs` → **7/7**; mutation A (classifier 401→`error`) and mutation
  B (drop the non-ok `return` guard) each go **red naming the file**, then restored → green.
- `node tests/orders-refund-badge.test.mjs` → **4/4**; mutation (detector keys off `completed`) goes
  **red**, then restored → green.
- Gates: `check-api-routes` (287, unchanged — no new calls), `check-doc-refs`,
  `check-register-consistency`, `check-test-registration`, `check-root-clean` → **all exit 0**.

**Could NOT verify here (rule 7/16):** the actual browser behaviour on a live/deployed dashboard
(the point of both fixes — a real 401 on `/kds`, and a real refunded order rendering the badge).
Three sibling suites (`order-error-classification`, `receipt-permission`, `role-tier`) require a
compiled `apps/server/dist` that a fresh clone lacks; they load server modules only and are
untouched by these dashboard-only changes.

## Rollback

Each item reverts by restoring/deleting its own files — additive, no migration, no shared edits.

```
# A192
git checkout 67fdd63 -- apps/dashboard/src/pages/kds/KDSPage.tsx
rm apps/dashboard/src/pages/kds/kdsConn.ts tests/kds-conn-state.test.mjs

# A195
git checkout 67fdd63 -- apps/dashboard/src/pages/OrdersPage.tsx
rm apps/dashboard/src/pages/orderRefund.ts tests/orders-refund-badge.test.mjs

# register note
git checkout 67fdd63 -- docs/AUDIT-REGISTER.md
```

## Not in this batch
- **A194** (customer-name at POS): scoped, deliberately not bundled. Capture lives in
  `PaymentModal.tsx` (money path); the server **already accepts + stores `customer_name`**
  (`orders.ts` 390/650/1510), so it's a client-thread-through — its own focused slice, not a
  ride-along on two unrelated defects (rule 12).
