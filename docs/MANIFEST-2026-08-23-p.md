# MANIFEST — 2026-08-23-p

**Batch (all three A151/A8 follow-ups in one):** Option A (by-item split) + remove dead by-guest UI + retire A8. **Money-critical; build-green, LIVE TEST REQUIRED before A151/A8 close.**
**Cumulative:** follows -a…-o. Apply after -o.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-o.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/dashboard/src/pages/pos/ByItemSplitPanel.tsx` | New. Assign each line to a guest (2–6); per-guest raw totals scaled proportionally to reconcile to the FULL order total; one method per guest → N legs summing to total; `onConfirm(legs)`. | **A151 Option A** — true by-item split, feeding the proven `/pay` path. |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | Added a third split mode "Split by item (per guest)" (toggle + `ByItemSplitPanel`, fed `cart` line items); guarded the other blocks with `!byItemMode`; on confirm reuses `handleSplitCharge`. | Wire by-item beside by-method and evenly — all splits now live here. |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | Removed the dead by-guest split block (~130 lines) and its state (`showSplitBill`/`splitGuests`/`splitStep`/`splitPayingGuest`). | Cleanup — it was unreachable since -o repointed the button. |
| `apps/dashboard/src/pages/pos/SplitBillModal.tsx` | **Deleted.** | **A8** — dead component, never mounted. |
| `apps/server/src/routes/orders.ts` | Removed `PATCH /:id/split`; left a tombstone. | **A8** — dead endpoint (only caller was `SplitBillModal`; `sub_bill` has no reader). |
| `docs/AUDIT-REGISTER.md` | A8 `RETIRED` note (OPEN pending promote + prod 404); A151 `OPTION A SHIPPED + CLEANUP` note (OPEN pending live test). Counts unchanged. | Rule 14 / 16. |
| `docs/MANIFEST-2026-08-23-p.md` | New (this file). | Rule 2. |

## Design notes

- **All bill-splitting now lives in `PaymentModal`** (single / by method / evenly / by item). Each split mode collects N legs that sum to the full order total and posts them to `/pay` (or creates one order via `/orders`) — **one order, paid in full, no sub-orders.**
- **By-item allocation:** a guest's share = sum of their assigned line totals, then **scaled proportionally so the legs reconcile to the order total** (VAT/discount/tip aware). The server's guard (`|legSum − total| > 0.01` → 400, no partial write) means a mis-allocation **fails safe** — it errors, never under-collects. The chosen policy is "proportional to line-item value"; flag if a different VAT/tip split is wanted.
- **A8:** `sub_bill` column left in the schema (now write-nowhere and read-nowhere); drop via a migration if desired — kept out of this patch to avoid a prod-migrate.
- `SplitPaymentPanel` untouched throughout.

## Verification (rule 7, 8, 9)

- `apps/dashboard` `tsc --noEmit` → 0; `vite build` → exit 0.
- `apps/server` `tsc --noEmit` → 0 errors; `npm run build` → exit 0.
- `check-permission-parity` → green; `check-table-usage` → green.
- `check-register-consistency` → green (A8 P2 OPEN, A151 P1 OPEN; counts unchanged).
- `/split` confirmed to have no remaining caller; `SplitBillModal` no remaining reference (bar the server tombstone comment); dead by-guest state fully removed (no dangling refs).
- Environment: Linux bench. **NOT executed against a live node + DB (rule 16).**

## REQUIRED live tests before close

1. **By item:** dine-in check, Split by item, assign lines to ≥2 guests with mixed methods → one order paid in full; try a bill WITH VAT/discount/tip → legs reconcile, sale accepted.
2. **Even split** (from -o) and **by method** still work.
3. **A8:** after promote, confirm `PATCH /api/orders/:id/split` returns 404.

## Rollback

```
git apply -R A151-A8-followups.patch
```
