# MANIFEST — 2026-08-23-n

**Batch:** A151 investigated — server behaviour pinned, fix plan corrected. **Docs-only — no zip** (rule 18).
**Cumulative:** follows -a…-m. Apply after -m.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-m.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | Appended an `INVESTIGATED 2026-08-23` note to A151: refined severity + corrected fix plan. Stays **OPEN** (P1); counts unchanged. | Rule 7 / 14 — a source read of `/pay` + `PaymentModal` + `SplitPaymentPanel` changed both the severity picture and the fix mechanism. |
| `docs/MANIFEST-2026-08-23-n.md` | New (this file). | Rule 2. |

## What the source read established

1. **`POST /:id/pay` recomputes `amountDue` from the order's own `subtotal` and rejects legs that don't reconcile** (`|legSum − amountDue| > 0.01` → 400, no partial write, order stays open). So partial payment against a *sent* order errors — it is NOT silently closed. A151's silent-loss case is therefore **pay-first only** (sub-cart → standalone paid order → remaining guests dropped). Severity stays **P1** (P0 avoided).
2. **Split-tender already works**: `PaymentModal.splitMode` → `SplitPaymentPanel` (legs must sum to total) → `handleSplitCharge` → `/pay` with N legs. "N payments, one bill, paid in full" is proven.
3. **`SplitPaymentPanel` is one-leg-per-method, capped at 4** (`availableMethods` filters used methods) — correct for tender-splitting, wrong for people-splitting. So "reuse SplitPaymentPanel for even-split" (my earlier phrasing) does NOT fit.

## Corrected fix (Option B, refined) — for the NEXT patch

- Add a small **even-split collector**: pick N → N equal legs (total/N, remainder on leg 1), each method-selectable, summing to the full total → reuse the proven `handleSplitCharge` → `/pay`. One order, paid in full, no sub-orders. Do NOT modify `SplitPaymentPanel`.
- Neutralise the broken by-guest sub-cart pay (repoint at the even-split collector now; true by-item split = Option A, later).

## Why this is docs-only (no code yet)

Money-critical POS logic, and the investigation twice disproved a design assumption (server-close worst case; SplitPaymentPanel reuse). Writing payment UI on a just-corrected design, with no live test available on the bench, is exactly the case rule 20 guards. The corrected plan is locked here; the code lands as its own build-green patch with a required live test before A151 closes.

## Verification (rule 7)

- `/pay` reconcile guard read at `apps/server/src/routes/orders.ts` (recomputes from `order.subtotal`, 400 on mismatch).
- `PaymentModal` `splitMode` + `handleSplitCharge` + `existingOrderId` branching read.
- `SplitPaymentPanel` `availableMethods` (one-per-method) + `canCharge` (sum==total) read.
- `node scripts/check-register-consistency.mjs` → green (A151 still OPEN P1).

## Rollback

```
git apply -R A151-investigation.patch
```
