# MANIFEST 2026-09-03-b — dashboard: A192 + A195 + A194 (cumulative, supersedes -a)

**Cumulative (rule 3): this supersedes `MANIFEST-2026-09-03-a.md`.** Apply this one zip; it
carries A192, A195 **and** A194. `-a` (A192+A195 only) remains for history.
**Base commit:** `67fdd63` (`dev`). **Scope:** cloud/dashboard only — no migration, no endpoint,
no server code change. All three stay **OPEN pending a browser pass** (rule 16).
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## Files

| File | New? | Change | ID |
|---|---|---|---|
| `apps/dashboard/src/pages/kds/kdsConn.ts` | new | Pure `classifyKdsFetch(ok,status,isArray)` → `ok`/`auth`/`error`. | A192 |
| `apps/dashboard/src/pages/kds/KDSPage.tsx` | edit | Connection state off the real fetch; 401→re-pair panel; no blind wipe to `[]`; dot green/red/amber. | A192 |
| `apps/dashboard/src/pages/orderRefund.ts` | new | Pure `isRefunded(payments)` — refund = a `status:'refunded'` leg. | A195 |
| `apps/dashboard/src/pages/OrdersPage.tsx` | edit | Amber "Refunded" badge; hide Refund once refunded. | A195 |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | edit | Optional Customer-name input → `customer_name` payload + receipt. | A194 |
| `tests/kds-conn-state.test.mjs` | new | 7 mutation-checked guard checks. | A192 |
| `tests/orders-refund-badge.test.mjs` | new | 4 mutation-checked guard checks. | A195 |
| `tests/pos-customer-name.test.mjs` | new | 4 mutation-checked guard checks. | A194 |
| `docs/AUDIT-REGISTER.md` | edit | FIX-BUILT notes on A192/A195/A194 (rule 14). No count change — nothing closed. | — |
| `docs/MANIFEST-2026-09-03-a.md` | (from -a) | Prior manifest, carried for history. | — |

## Verification (rule 7)

Environment: Linux, Node 22 in-sandbox — on-target for the dashboard (its real build is
Linux/browser Vite), not a weak Linux green (per the A185 note).

- `apps/dashboard` `tsc --noEmit` → **exit 0, 0 errors**; `vite build` → **exit 0** (~10s), KDS/Orders/POS bundles emitted.
- `tests/kds-conn-state.test.mjs` **7/7**, `tests/orders-refund-badge.test.mjs` **4/4**, `tests/pos-customer-name.test.mjs` **4/4** — each **mutation-checked** (reintroduce the defect → red on the right assertion → restore → green).
- Gates: `check-api-routes` (287, unchanged), `check-doc-refs`, `check-register-consistency`, `check-test-registration`, `check-root-clean` → **all exit 0**.

**Could NOT verify here (rule 7/16):** live browser behaviour — a real 401 on `/kds`, a real
refunded row's badge, and a typed name printing on a receipt / showing on the Orders list. That is
the owner browser pass, on a redeployed dashboard.

## A194 — what's covered, what's deferred
- **Covered:** walk-in name on the **new-order** paths (cash / M-Pesa / split → `POST /api/orders`),
  persisted server-side (already), shown on the receipt and the Orders list.
- **Deferred (flagged, not built, rule 12):** the order-first `/pay` path (name set at table-open,
  not at pay-time) and the **KDS card** (kitchen `tickets` select omits `customer_name`). Small
  follow-ups; kept out to keep A194 a single file.

## Rollback

```
# A192
git checkout 67fdd63 -- apps/dashboard/src/pages/kds/KDSPage.tsx
rm apps/dashboard/src/pages/kds/kdsConn.ts tests/kds-conn-state.test.mjs
# A195
git checkout 67fdd63 -- apps/dashboard/src/pages/OrdersPage.tsx
rm apps/dashboard/src/pages/orderRefund.ts tests/orders-refund-badge.test.mjs
# A194
git checkout 67fdd63 -- apps/dashboard/src/pages/pos/PaymentModal.tsx
rm tests/pos-customer-name.test.mjs
# register note
git checkout 67fdd63 -- docs/AUDIT-REGISTER.md
```
