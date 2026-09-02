# MANIFEST — 2026-08-23-k

**Batch:** A8 re-scoped after source re-verification — it's a dead feature, not an unmounted modal to wire. **Docs-only — no zip** (rule 18).
**Cumulative:** follows -a…-j. Apply after -j.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-j.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | Appended a `RE-SCOPED 2026-08-23` note to A8 with the verified finding + a three-way decision. Stays **OPEN** (P2); counts unchanged. | Rule 14 / 17 / 7 — the "wire the modal" framing was wrong; nothing built. |
| `docs/MANIFEST-2026-08-23-k.md` | New (this file). | Rule 2. |

## What re-verification found (rule 5, 17)

1. **The pay-split capability already exists.** `CashierScreen` has a working split-by-guest flow (`showSplitBill`/`splitGuests`) that assigns items to guests, builds a per-guest sub-cart, and charges each via `PaymentModal`. It does not use `SplitBillModal`.
2. **`SplitBillModal` + `PATCH /api/orders/:id/split` + `order_items.sub_bill` are a dead triad.** `sub_bill` is written only (by `/split`) and **read nowhere** — confirmed by grep across `apps/server`, `apps/dashboard`, `shared`, and specifically receipts / KDS / kitchen tickets / reports. Persisting a by-item split therefore changes nothing observable. `SplitBillModal`'s even-split mode is a pure (non-persisted) calculator.

So mounting `SplitBillModal` would add a "Save split" action that writes to a column nothing reads — a control that silently does nothing (rule 20). Not built.

## Decision needed (I'll execute whichever you pick)

- **Retire** (default): delete `SplitBillModal`, retire `PATCH /:id/split`, optionally drop `sub_bill`. Clean, matches A145's retire pattern. A small server+client patch.
- **Complete**: define what a persisted per-item split should DO (separate itemised receipts per sub-bill? grouped kitchen tickets?), build that consumer, then mount the modal and reconcile with the guest-split flow. A real feature with a spec.
- **Salvage** the even-split calculator only (no persistence) — marginal given the guest-split already divides a check.

## Verification (rule 7)

- No caller of `/api/orders/:id/split` anywhere in `apps/dashboard` (grep, excluding the modal itself).
- `SplitBillModal` imported/mounted nowhere.
- `sub_bill` has no reader in server/client/shared.
- CashierScreen's guest-split confirmed to build sub-carts → `PaymentModal` (payment-time, in-memory; no `/split`, no `sub_bill`).
- `node scripts/check-register-consistency.mjs` → green (A8 still P2 OPEN).

## Rollback

```
git apply -R A8-rescope.patch
```
