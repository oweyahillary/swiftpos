# MANIFEST — 2026-08-23-o

**Batch:** A151 fix — even-split collector (Option B). **Money-critical; build-green, LIVE TEST REQUIRED before close.**
**Cumulative:** follows -a…-n. Apply after -n.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-n.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/dashboard/src/pages/pos/EvenSplitPanel.tsx` | New. Per-person even split: pick N (2–12) → N equal legs (total/N, remainder on person 1), each leg cash/M-Pesa/card, summing to the full total; calls `onConfirm(legs)`. | A151 — the collector that replaces the broken by-guest pay. |
| `apps/dashboard/src/pages/pos/PaymentModal.tsx` | Import + render `EvenSplitPanel` behind a new "Split evenly (per person)" toggle and an `initialEvenSplit` prop; guard the by-method split and single-payment blocks (incl. footer charge button) with `!evenSplitMode`. On confirm it uses the existing `handleSplitCharge` → `/pay`. | Wire the collector into the proven payment path without touching `SplitPaymentPanel`. |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | Repoint the restaurant "Split Bill" button to open `PaymentModal` in even-split mode (`setPaymentEvenSplit(true); setShowPayment(true)`); keep the two charge buttons in normal mode; pass `initialEvenSplit` and reset it on close. | Make the under-collection path unreachable; route splits through the collector. |
| `docs/AUDIT-REGISTER.md` | A151 `FIX SHIPPED` note. Stays **OPEN** (P1) pending a live split-payment test; counts unchanged. | Rule 14 / 16. |
| `docs/MANIFEST-2026-08-23-o.md` | New (this file). | Rule 2. |

## How it works (and why it's safe)

- The collector builds **N legs summing to the full order total** and calls the existing `handleSplitCharge`, which POSTs `{ payments }` to `/api/orders/:id/pay` (sent order) or creates one order via `/api/orders` (pay-first). Either way it's **one order, paid in full** — no sub-carts, no sub-orders. The server's own guard (`|legSum − amountDue| > 0.01` → 400, no partial write) still applies, so a mis-summed set can't slip through.
- This is mechanically identical to the already-working split-tender path (`SplitPaymentPanel`), so it inherits its behavior; it does not modify `SplitPaymentPanel`.
- The broken by-guest sub-cart pay (which under-collected in pay-first mode) is now **unreachable** — `setShowSplitBill(true)` has zero call sites. The old by-guest UI block is left inert (removal deferred to the Option A follow-up to keep this money patch minimal).
- Credit legs are intentionally excluded from an even split (a credit leg is tied to one customer account).

## Verification (rule 7, 8, 9)

- `apps/dashboard` `npx tsc --noEmit` → **exit 0** (no errors in `EvenSplitPanel`, `PaymentModal`, `CashierScreen`).
- `apps/dashboard` `npx vite build` → **exit 0**.
- `node scripts/check-register-consistency.mjs` → green (A151 still OPEN P1).
- Environment: Linux bench. **NOT executed against a live node + DB (rule 16).**

## REQUIRED before A151 closes (live test — cannot be done on the bench)

1. Dine-in check → **Split Bill** → set N ways with **mixed methods** → confirm **one order is paid in full**, the payments breakdown shows the N legs, and the table frees only after the full amount is collected.
2. Repeat with a rounding case (e.g. 1000 / 3) → confirm person 1 absorbs the cent and the sale is accepted.
3. Pay-first branch (no sent order) → confirm a single order is created and paid in full (no dropped items).

## Follow-ups (not in this patch)

- Option A: true by-item (per-guest) split, if wanted.
- Remove the now-dead `showSplitBill` by-guest UI block + its state in `CashierScreen`.
- A8 retirement (dead `SplitBillModal`/`/split`/`sub_bill`).

## Rollback

```
git apply -R A151-even-split-fix.patch
```
