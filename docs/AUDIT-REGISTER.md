# SwiftPOS — Audit Register

**Living document.** The single tracker for audit findings: what is open, what is
closed, and what was checked and found correct. Update in place; do not fork.

| | |
|---|---|
| Opened | 2026-08-07 |
| Last updated | **2026-08-08, end of printing session** |
| Tree | `dev` @ `415e044` + this session's work, desktop v0.5.23, `LOCAL_SCHEMA_VERSION` 51 |
| Open | **1 P0 · 4 P1 · 5 P2 · 5 P3** |
| Closed this session | **31** |

**How to use this.** IDs are stable and never reused. Closed items keep their
entry — half the value of this file is stopping the next session re-auditing
ground already covered. New findings append with the next free number.

**Method.** Every item verified by reading or running source, not by reading docs.

**Severity.** **P0** money/data loss or a false-confidence trap · **P1** wrong
numbers or silent divergence · **P2** correctness residue · **P3** hygiene.

---

## Status at close of session

```
server tsc  OK   dashboard  OK   desktop main  OK   desktop renderer  OK

check-schema-drift    OK   check-ipc-parity      OK   (126/126)
check-supabase-catch  OK   check-shared-sync     OK
check-rls-coverage    OK   check-table-usage     OK   ← new, proves B6
check-sql-binds       OK   check-client-parity   OK   ← new, proves B5
check-own-rows        OK   check-row-attribution OK

offline suites        17/17
print resilience      51/51
printing package      spooler 18 + tickets 30, all passing
sample output         byte-identical to SAMPLE-OUTPUT.txt
```

58 files changed across the session.

---

## TOMORROW — before shipping

Agreed plan, in order:

1. **Run a full service on 0.5.23** with thermal on. Nothing below matters more
   than one real trading period.
2. **Final code review** — business logic, error reporting, UI logic.
3. **Remove HTML printing.** Only after 1 and 2. See P-06 for exactly what goes.
4. **Then** the register's remaining P0/P1 items.

---
## A. OPEN — carried into tomorrow

### A1 · P0 · OPEN · Secrets leak on every zip
`.env` files ride along because `pos.zip` is built from the working folder.
Rotated once this session; **the packaging is still unfixed**, so it will recur.

**Fix:** `git archive --format=zip HEAD -o pos.zip`. It honours the index, so
ignored files physically cannot get in. Two minutes, and it is the fourth time.

### A2 · P1 · OPEN · BUG-17 — mpesa `.single()`
`routes/mpesa.ts:224, 372`. Untouched this session.

### A3 · P1 · OPEN · BUG-21 — KDS realtime / RLS
Never re-verified. Still unknown, not known-good.

### A4 · P1 · OPEN · Migration 68 exists only in production
Applied to the live database, never committed to any branch. Confirmed absent
from git history. The repo cannot reproduce production.
**Blocked on:** `select version, applied_at from public.schema_migrations order by version;`

### A5 · P1 · OPEN · Docs understate the system by two phases
`ROADMAP.md` last touched 2026-07-10; no mention of Phase 2, Phase 4, Close
Branch, `/node/since`, events or the office role — all of which pass tests.
`PHASE2-3-DESIGN.md` still reads *"For approval before code."*

### A6 · P2 · OPEN · The 3-Aug handoff was never filed
Recoverable: `git show 0f85155:HANDOFF.md`. Commit `a4aee05` overwrote the path
with a different document. Nothing in `docs/` records the tech DB console or the
wipe gates.

### A7 · P2 · OPEN · `ParkingPOS` / `PetrolPOS` unrouted, no ROADMAP line
### A8 · P2 · OPEN · `SplitBillModal` unrouted while `PATCH /:id/split` is live
### A9 · P3 · OPEN · Empty `apps/desktop/src/renderer/{lib,pages,components}/`
### A10 · P3 · OPEN · `PrinterSetupScreen` docstring claims a supersession that has not happened
### A11 · P3 · OPEN · `ManagerPage.tsx:1061-65` comment contradicts itself
### A12 · P3 · INVESTIGATE · `ingredients.current_stock` vs `ingredient_stock_levels.current_stock`
Same duplicate-table shape as B6. Find who reads it before it becomes B6's sequel.

### A13 · P3 · NOTE · Two suites run on `node:sqlite`, not the app's driver
`test-node-ingest`, `test-sync-rejection-routing`. They say so themselves. A
local green is not hardware-equivalent.

---

## B. CLOSED this session — audit findings

| ID | What it was | Closed by |
|---|---|---|
| A1 (rotation) | Live secrets in the archive | Rotated. **Packaging still open — see A1 above.** |
| B1 | `/pay` had no idempotency and no concurrency guard | Claim-before-write: `.eq('status','open').select()`. Loser returns the winner's payload; amount mismatch writes a `payment_exceptions` row. |
| B2 | Loyalty diverged 10× between counter and dine-in | `/pay` now uses `awardLoyaltyPoints` + earn rate + tier. Writes the ledger row, `total_spent` and `loyalty_points_used`. |
| B3 | ESC/POS built but `queueTickets()` never called | Wired into the sale path behind a per-terminal switch. |
| B4 | Two printer config stores | Stations from `print_stations`; printer bound per terminal. |
| B5 | `pump_id` end-to-end on desktop only | Added to `PaymentModal.buildOrderPayload`. `check-client-parity` proves it. |
| B6 | Low-stock alerts read `stock`, which nothing writes | Both jobs read `stock_levels`. `check-table-usage` proves it. |
| C1 | `fetchAllIds` paged without ORDER BY | `.order(idColumn)` + a `seen` set. |
| C2 | pageSize 1000 could silently truncate | 500, below every plausible row cap. |
| C3 | Racy read-then-write stock in 3 places | `adjust_product_stock` (existed, never called) + new `adjust_fuel_tank_level`. |
| C4 | Unescaped `ilike` pattern + `limit(20)` | `%`/`_`/`\` escaped, cap raised to 200. |
| C5 | BUG-18 owner lockout | **Three** sites, not two. Extracted to `lib/ownerBusiness.ts`; 409 + picker. |
| C7 | Numeric comparisons uncoerced | Fuel reorder, low-stock, discount floor. |
| C8 | `qty_pieces` fractional into an INTEGER column | Rounded in JS. |
| C9 | `dailySummary` `.lt()` — three bugs in one line | Removed; error destructured. |
| D1 | CI job named "Schema drift" did not run the drift gate | Added, plus both new gates. |
| D2 | `assert:built` warned instead of failing | Fails, and compares against newest `src/` mtime. |
| D3 | `build:all` did not clear `dist` | Cross-platform `clean` first. |
| BUG-16 | DB blip logged a cashier out | `try` narrowed to `jwt.verify`; 503 not 401. |
| BUG-19 | Till report overstated by every refunded bill | Nets off `refunded_amount`. |
| BUG-20 | Fuel deducted twice | Tank authoritative; `stock_levels` mirrors. |
| BUG-22 | `device_hint` stored a fleet-identical User-Agent | `device_id` first. Also fixes revocation. |
| — | `release:patch` built before bumping | Reordered. |
| — | `api.ts` stripped every error field but `code`/`status` | Preserved, so 409 payloads are usable. |

---

## P. CLOSED this session — printing

| ID | What it was |
|---|---|
| P-01 | Kitchen ticket empty: bridge used literal station ids that never matched real UUIDs. Now routes by **kind**. |
| P-02 | Combos opaque: components not sent. Now sent, routed by their own `category_id`. |
| P-03 | Plain products lost their variant entirely — `if (attrs.length && units.length)` dropped it when there were no components. |
| P-04 | Category never arrived: renderer sent `categories`, desktop products carry `category_id`. |
| P-05 | All three tickets fired at payment. Split: production on **send**, receipt on **pay**. |
| P-06 | Double printing when thermal was on — both systems fired. Old path now returns early. |
| P-07 | No receipt station possible on the till; receipt was never queued. "Till receipt" always offered. |
| P-08 | `Print receipt` said "sent" and printed nothing. Real reprint, marked **Duplicate Print**. |
| P-09 | Preview dead: handler expected a full `PrintContext`, screen sent `{stationId, paperWidthMm}`. |
| P-10 | Kitchen preview showed "0 items to cook" — sample routing ids didn't match the previewed station. |
| P-11 | Test print crashed on `station.kind` — same shape mismatch as P-09, missed once. |
| P-12 | **`-args` does not bind with `-Command`.** Root cause of three separate "printer" failures. Values now travel in the environment. |
| P-13 | Error classifier guessed from message text — `GetPrintQueue` was in the "not found" regex, so any fault in that call reported a wrong printer name. Now classifies on Win32 codes only, and says **"this is a fault in SwiftPOS"** when it is. |
| P-14 | USB needed manual sharing. Now Win32 `OpenPrinter`/`WritePrinter` RAW via P/Invoke — printer picked by name, no sharing, no native module. |
| P-15 | Receipt footer collapsed to one line — `wrap()` treats `\n` as a space. `wrapAuthored()` keeps author line breaks. |
| P-16 | **Every HTML print was truncated.** The measuring window had no width, so Electron defaulted it to 800px while printing at 302px. Shift report lost its entire cash reconciliation. |
| P-17 | Z-report was the last HTML document, via **two** routes (`printReceipt` and `window.open().print()`). Now ESC/POS through one helper. |
| P-18 | Drinks-only orders printed a kitchen slip reading **"0 items to cook"**. `hasPrintableContent()` — nothing routed, nothing printed. Receipts exempt. |
| P-19 | Both report screens set a failure message nothing displayed. Now shown. |

**New capability:** owner-stated kitchen exclusions (`business_settings.kitchen_exclusions`),
edited in Dashboard → Restaurant, cached on each till, applied to every source of
units. Your design — explicit beats inferred.

---

## I. Verified correct — do not re-audit

- **Item 10 numeric sweep:** additive coercion is clean. This codebase coerces at
  the API boundary, which is the right place. BUG-12 was in a *job* — no boundary.
  **Comparisons were not clean** — see C7.
- **The refund model is right.** `orders.status` stays `completed` on refund
  (migration 37), so the negative leg stays in shift-close scope. The bug was on
  the till only.
- **Constraints the code depends on all exist** — `stock_levels` and `users`
  composite uniques, and the `/orders` idempotency index. The schema dump does not
  render composite uniques; always cross-check `00_baseline.sql` before concluding
  one is missing.
- **`adjust_product_stock` already existed** (migration 61) and the sale path
  never called it. Same shape as `chunkIn`. Worth checking for more of these.
- **Ticket layouts match `SAMPLE-OUTPUT.txt` byte-for-byte**, both widths, and the
  sample is regenerated on every `npm test` in the printing package.

---

## L. The pattern

The 08-07 handoff ends: *"Every serious bug in this codebase came through the same
seam: two things that must agree, with nothing comparing them."*

This session was that, repeatedly — and now with gates on the two widest seams:

- `check-table-usage` — a table written under one name, read under another (B6)
- `check-client-parity` — a field the server reads that one client sends (B5)
- `check-ipc-parity` — caught P-17's handler landing in the wrong file **before** it shipped

The seam that kept biting and has **no** gate: **an IPC channel whose two sides
disagree about the payload shape** (P-09, P-11). `check-ipc-parity` proves a
channel exists, not that its arguments agree. That is the next gate worth building.

---

## Changelog

| Date | Change |
|---|---|
| 2026-08-07 | Opened. A1, B1-B5, C1-C6, D1-D3, E1-E4, F, G1-G2, H1-H2, I. |
| 2026-08-07 | Live schema dump reviewed. Added B6, C7-C9, §0 dump caveat. BUG-19 upgraded and sized. |
| 2026-08-08 | G1-G7 shipped. 31 items closed. Printing migrated to ESC/POS end to end (P-01…P-19). Two new gates. Register restructured: open items first, closed items retained as evidence. |
