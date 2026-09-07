# PLAN — bring web POS printing to desktop parity

Study of the desktop print path (the gold standard) and a phased plan to match it
on the web. Written after reading `apps/desktop/src/main/escposBridge.ts`
(`printSale`, `toUnits`, `stationsForCategory`), `print/printWorker.ts` (the
spool), and `shared/printing` (the renderers behind `SAMPLE-OUTPUT.txt`).

## How the desktop does it (the model to match)
1. **Main-process orchestration.** On order creation the main process calls
   `printSale(sale, business, stations, kinds)` — the renderer never fans out.
2. **Timing split.** `kinds` decides what queues *now*: **kitchen + dispatch at
   SEND**, **receipt at PAY**. "The entire point of a kitchen ticket is that it
   goes first" — food must not wait for payment. A counter sale (no send step)
   passes all three at once.
3. **Category routing.** Each line routes via `stationsForCategory(category_id)`
   → reads `category_stations`, falls back to `categories.is_kitchen`, keeps only
   station ids that exist on this terminal. Real station uuids, not hardcoded.
4. **Combo-aware units.** `toUnits` expands `line.comboComponents`, each routed on
   its **own** `category_id`; variants attach as **attributes** to the first
   component ("3PC Chicken / all spicy"); modifiers route to **dispatch only**
   ("a sauce is packed, not cooked"); a text `describeFromText` fallback exists.
5. **Kitchen exclusions.** `kitchenExclusions()` strips owner-named items (e.g.
   drinks) from kitchen tickets.
6. **A real spool.** `queueTickets` → `printWorker` → a SQLite-backed spool with
   retry classification (transient vs permanent), stuck-job recovery across
   restart. A ticket is never silently lost.
7. **Rendering.** Each station renders via `shared/printing` `renderTicket` with
   its preset (receipt/kitchen/dispatch) — the same code the web already vendors.

## Where the web stands
- **Shared** with desktop: `shared/printing` renderers (web vendors them as
  `renderReceiptEscPos` / `renderKitchenEscPos` / `renderDispatchEscPos`, A246).
- **Has:** `Product.category_id`; a bridge that forwards ESC/POS to the spooler;
  full-order fan-out to Customer Receipt / Master KOT / Dispatcher (A246), now in
  kitchen → customer → dispatcher order (A247).
- **Missing vs desktop:**
  - `CartItem` has **no `comboComponents`** and no per-component category → no
    combo-aware or category-routed kitchen/dispatch tickets.
  - No `category_stations` / `is_kitchen` routing applied on the web.
  - No kitchen exclusions.
  - No timing split — the web fires from Print Bill / Charge, not send-vs-pay.
  - No persistent retry spool (browser + one-shot bridge forward).

## Plan (phased; each phase ships + is verified on the till)

**Phase 0 — DONE (A246 + A247).** Silent, shared-format fan-out to the three
full-order printers, in kitchen → customer → dispatcher order. All-items copies
(no routing). This is the shippable baseline.

**Phase 1 — Enrich the web cart (foundation).** Products API returns combo items
with `category_id`; `CartItem` gains `comboComponents`. Nothing prints
differently yet — this is the data the rest needs. *Gate: cart carries components;
existing flows unchanged.*

**Phase 2 — Port the routing logic to `shared/`.** Lift `toUnits` +
`stationsForCategory` out of `escposBridge.ts` into a shared, DB-free module that
takes routing tables as input, so web and desktop run the **same** logic (no
second, weaker copy). Desktop keeps its SQLite adapters; web feeds the same
functions data loaded from the API. *Gate: desktop still green against
`SAMPLE-OUTPUT.txt`; web produces the same units for the same input.*

**Phase 3 — Web routing + exclusions.** Load `category_stations` + kitchen
exclusions on the web; route each line/component to the right station; strip
excluded items from kitchen tickets. Kitchen/dispatch stop being all-items copies.
*Gate: two-category order prints correctly on the till.*

**Phase 4 — Timing split.** Kitchen + dispatch fire on **Send to Kitchen**;
receipt fires on **Charge**. Print Bill becomes a customer proforma only. Matches
the desktop's send-vs-pay model. *Gate: food ticket prints at send, receipt at
pay.*

**Phase 5 — Reliability (optional parity).** Give the bridge a small persistent
retry queue so a transient printer error retries instead of dropping — spool
parity without a browser-side daemon.

## Notes
- Reuse, don't reinvent: Phases 2–4 are about running the desktop's proven logic
  on web data, not writing a parallel implementation.
- Each phase is independently shippable and independently verifiable on the till.
- Estimated risk is highest at Phase 1 (touches the products API + cart) and
  Phase 4 (changes when things print) — both want their own register IDs +
  two-till checks.
