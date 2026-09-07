# MANIFEST 2026-09-07-d — A246: Print Bill → 3 silent station receipts in the shared format

**Base:** `origin/dev` @ c9698bb (+ pending A244/reconcile from delivery -c). **Ship after -c.**
**Delivery:** zip, extract over repo root. Dashboard-only. **No bridge/exe rebuild. No migration.**

## Why
Restaurant "Print Bill" opened a **browser print dialog**, printed **once**, and used an
**ad-hoc format** ("This is not a receipt / pay at the counter") unlike the desktop. It never
used the shared renderer or the bridge.

## What changed
- **3 station renderers vendored** into `escposRenderer.js` from `shared/printing` —
  `renderReceiptEscPos` / `renderKitchenEscPos` / `renderDispatchEscPos` (receipt/kitchen/dispatch
  presets; kitchen `includeUnits:'all'`). Byte-reproducible via `scripts/build-escpos-renderer.mjs`.
- **`printBill.ts`** fans an order to every enabled Full-order printer — receipt → Customer
  Receipt, kot → Master KOT, expeditor → Dispatcher — rendered in the shared format and sent to
  the Windows spooler via the bridge, **silently**. Alerts (not silently) if nothing is configured
  or the bridge is down, so a bill is never believed-printed.
- **`buildReceiptOrder`** now emits `units[]` from variants/modifiers (sub-items on all three
  tickets), and **`buildReceiptBusinessConfig` sets `currencyCode`** — fixes `PAY: undefined`
  (which also affected the live post-charge receipt).
- **`CashierScreen`** — `printGuestCheck` rewritten to call `printBillToStations`; the
  iframe/`window.print` dialog deleted.

## Files
| File | Change | ID |
|---|---|---|
| `scripts/escpos-renderer/entry.ts` | expose 3 station renderers | A246 |
| `apps/dashboard/src/lib/escposRenderer.js` | regenerated (3 renderers) — reproducible | A246 |
| `apps/dashboard/src/lib/escposRenderer.d.ts` | 3 renderer types | A246 |
| `apps/dashboard/src/lib/printBill.ts` | **new** — fan-out to the 3 stations via the bridge | A246 |
| `apps/dashboard/src/lib/buildReceiptOrder.ts` | emit units; set currencyCode | A246 |
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | Print Bill → silent fan-out; delete iframe | A246 |
| `tests/tiny-bridge-printing.test.mjs` | 18 → 22 guards | A246 |
| `docs/AUDIT-REGISTER.md` | A246 entry; A-P2 26→27 | A246 |
| `docs/MANIFEST-2026-09-07-d.md` | this manifest | — |

## What ran + output (rule 7)
```
shared sample generator            -> reproduces SAMPLE-OUTPUT.txt (golden), all money PASS
web-shaped order → bundle          -> KITCHEN + RECEIPT render correctly (names, sub-items,
                                      money block, PAY: KES 3,580.00, footer)
escposRenderer.js                  -> byte-reproducible via scripts/build-escpos-renderer.mjs
tests/tiny-bridge-printing.test.mjs-> 22/22 green
esbuild transpile (printBill, buildReceiptOrder, CashierScreen) -> clean
register-consistency · doc-refs · root-clean -> green
```
**NOT verified here (rule 16):** the physical print on the XP-80.

## Honest constraints
- The flat web `CartItem` has no combo base/upgrade split or per-unit station routing, so
  sub-items print as **names** (no per-upgrade price) and **kitchen + dispatch both print all
  items** — matching the web's own "Full order printers = all items" model. Per-component routing
  is a desktop-only combo feature.
- **"3 printouts" needs all three Full-order printers configured** (Customer Receipt + Master KOT
  + Dispatcher). Today only Customer Receipt (XP-80) is set up.

## Rollback (rule 2)
Code-only, no schema. `git revert <this commit>` and redeploy the dashboard.

## Apply
1. Extract over repo root.
2. `node --test tests/tiny-bridge-printing.test.mjs` + register/doc/root gates.
3. Redeploy the dashboard (no exe rebuild). To get 3 printouts, configure Master KOT + Dispatcher
   under Settings → Printers (each with its Windows printer name).
