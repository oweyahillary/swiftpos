# MANIFEST 2026-09-07-ab — A265: fix Charge crash (receiptHeader not declared) + A264 (cart parity)

**Base:** origin/dev @ caabdc7. **Web-only (dashboard).** No server, no migration.
**Self-contained:** `CashierScreen.tsx` here includes A264 (cart parity) + A265 (crash fix) —
apply this whether or not delivery `-aa` (A264) is already in; it supersedes it.

## A265 — the fix (P1)
Charge crashed the web POS: `ReferenceError: receiptHeader is not defined` when PaymentModal
rendered. A255 added `receiptHeader`/`receiptFooter` to `usePOSData` and USED them in
`CashierScreen` (PaymentModal props + the Print Bill call) but never added them to the
`usePOSData()` destructure. FIX: destructure them.

Why it reached prod: the dashboard build is esbuild-only (no type-check), so an undeclared
identifier that `tsc` would catch (TS2304) transpiles fine and only throws at runtime — my
esbuild transpile-checks share that blind spot. Noted for future dashboard edits.

## A264 — cart parity (unchanged from -aa)
Order-type selector (Dine in/Takeaway/Delivery) + Send to Kitchen · Hold in both modes;
web-only extras (Print Bill/Transfer/Split/Room) below Charge.

## Files
| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | A264 cart parity + A265 destructure `receiptHeader`/`receiptFooter` |
| `tests/pos-cart-parity.test.mjs` | guards (5) incl. the destructure guard |
| `docs/AUDIT-REGISTER.md` | A264 + A265 entries |
| `docs/MANIFEST-2026-09-07-aa.md`, `docs/MANIFEST-2026-09-07-ab.md` | delivery records |

## What ran (rule 7)
```
tests/pos-cart-parity.test.mjs -> 5/5 ; esbuild transpile CashierScreen -> clean ; gates green
grep sweep: no other JSX-prop identifier used-but-undeclared (resetPrinterSettings is declared)
```
NOT verified here (rule 16): a live Charge / Split on the till.

## Apply
Extract over repo root; `node --test tests/pos-cart-parity.test.mjs` -> 5 green; gates; deploy
dashboard. Charge now opens PaymentModal without crashing; Split/Room/Transfer open too.
