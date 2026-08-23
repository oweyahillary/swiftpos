# MANIFEST — 2026-08-23-m

**Batch:** A151 opened — Split Bill (by-guest) under-collects. **Docs-only — no zip** (rule 18).
**Cumulative:** follows -a…-l. Apply after -l.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-l.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | Added `### A151 · P1 · OPEN` at the top of §A; bumped `\| Open \|` A-P1 10→11; prepended A151 to the `\| Counts \|` row; changelog note; "Next free ID" → A152. | Rule 14 — a real revenue bug found while evaluating A8 gets an ID and an entry. |
| `docs/MANIFEST-2026-08-23-m.md` | New (this file). | Rule 2. |

## The finding

Restaurant "Split Bill" (by-guest) in `CashierScreen` is half-implemented:

- The **pay loop never advances** — `setSplitPayingGuest` is only ever called with `0`; grep finds no increment and no `useEffect` watching it.
- On payment, `onSuccess` frees the table and clears the order without looping to the remaining guests. A code comment claims it restores remaining items "via splitPayingGuest" — it does not.
- Each guest's sub-cart is paid with `existingOrderId` = the whole table's order.
- Net: one guest's portion is collected, the table shows paid, the rest are dropped → **silent revenue under-collection.**
- Also: **no even/equal-split mode** (only by-item). `SplitPaymentPanel` is split-*tender*, not split-among-guests.

Client-confirmed. Not yet checked: whether the server `/pay` against the full order id also closes the order on the first leg (would make the rest uncollectable, not just UI-dropped).

## Not fixed here (rule 16/20)

Money-critical POS logic — needs a design pick and a live test, not a bench edit. Two fix shapes in the entry: **A** (make by-guest work: advance the loop, partial payments, close only after the last guest) or **B, recommended** (even-split via the existing `SplitPaymentPanel` — N payments for one total, no sub-orders).

## Verification (rule 7)

- `setSplitPayingGuest` calls: only the initial `useState(0)` and one `setSplitPayingGuest(0)` on entering the pay step — never incremented.
- `onSuccess` (CashierScreen ~1983–2050): frees table, clears cart/order, returns to table view; no `splitPayingGuest`/`splitGuests` reference.
- `SplitPaymentPanel` header confirms it is multi-leg tender, not guest split.
- `node scripts/check-register-consistency.mjs` → green (A151 OPEN P1; A: 11 P1 / 14 P2 / 6 P3).

## Rollback

```
git apply -R A151-split-bill-bug.patch
```
