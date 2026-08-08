# SwiftPOS — Audit Register

**Living document.** The single tracker for audit findings: what is open, what is
closed, and what was checked and found correct. Update in place; do not fork.

| | |
|---|---|
| Opened | 2026-08-07 |
| Last updated | **2026-08-08, desktop audit + Beryl sync investigation** |
| Tree | `dev` @ `5ad57f7`, tag **v0.5.25**, desktop **v0.5.25**, `LOCAL_SCHEMA_VERSION` 51 |
| Open | **A: 1 P0 · 4 P1 · 3 P2 · 5 P3 — D: 2 P0 · 2 P1 · 5 P2 · 2 P3** |
| Closed this session | **31 (printing) + 1 (migration 46)** |

**Header corrections, 08-08.** The previous header said `415e044 + this session's
work`; the work is committed at `a80c224` (59 files, not 58). It said the counts
were 5 P2 where section A lists 3. **C6, E1-E4, F, G1-G2 and H1-H2 appear in the
changelog as opened and have no entry anywhere in this file** — lost in the 08-08
restructure. They are neither open nor closed; they are missing. Recover from
`git show 415e044:docs/AUDIT-REGISTER.md` before the next session re-audits them.

`HANDOFF-2026-08-08.md` stated desktop v0.5.24 while `apps/desktop/package.json`
said 0.5.23. Bumped to 0.5.24 — then `release:patch` bumped again during the
build, so **the shipped artifact is `SwiftPOS-0.5.25-x64.exe` and the tag is
`v0.5.25`**. `v0.5.24` was deleted: no installer exists for it, and a tag
pointing at a version you cannot produce is worse than no tag.

**Rule learned: the tag follows the build, never precedes it.** `release:patch`
runs `npm version patch`, so the version is decided BY the build. With no
auto-update the tag is the only record of which source produced the `.exe` on a
given till.

**Working rules** live in `HANDOFF-2026-08-08-evening.md` §0 — standing, not
per-session. Rule 14 is the one this file depends on: nothing ships without an ID
and an entry here, in the same change as the code.

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

**Pattern worth copying (08-08):** `test/heldOrders.test.mjs` selects
`better-sqlite3` when it resolves and falls back to `node:sqlite` only where the
native module cannot be built — then prints which driver ran. On any machine
that can run the app the real driver is used, so the green *is* hardware-
equivalent, and where it is not the output says so instead of implying otherwise.
**Confirmed on the target machine 08-08:** plain `node` cannot load the app's
`better-sqlite3` at all — `ERR_DLOPEN_FAILED`, built for `NODE_MODULE_VERSION`
133 (Electron 35) against the 115 that Node 20 requires. That is not a broken
checkout; `postinstall` runs `electron-builder install-app-deps`, which is
supposed to build for Electron's ABI. And `node:sqlite` needs Node >= 22.5 while
the tills run Node 20, so a suite that hard-imports it cannot run where it
matters either. **The only runtime that tests the real driver is Electron
itself:** `npm run test:held:electron` (see `test/run-under-electron.mjs`).
Verified green there: 21/21 on better-sqlite3 under Electron 35.7.5, Windows.

---

## D. OPEN — desktop app audit, 2026-08-08

Every item below was verified against source at `a80c224`, not against docs.

### D1 · P0 · Owner login is a dead end when they own two businesses
`auth.ts:603` — `/desktop-login` returns 409 `MULTIPLE_BUSINESSES` with *"Choose
which one to open."* `ipcHandlers.ts:83` throws `data.error` and drops `code`.
There is no picker anywhere in `apps/desktop`. The owner reads an instruction
the app gives no way to follow.
**Not firing for Beryl** — that owner has exactly one business (verified 08-08).
Closed by the D4 enrolment work, which removes owner login from the till.

### D2 · P0 · CLOSED 08-08 · Open tables lived in localStorage
See §E. Held orders now sit in SQLite, one row per tab. D9 (cross-till recall)
remains open — that needs server state, not local storage.

### D3 · P1 · No auto-update
No `electron-updater`, no `autoUpdater`. Every release is a hand-installed `.exe`
per till; `localDb.ts` says so itself. Root cause of A1 — no release pipeline is
why `pos.zip` gets hand-built from a working folder. Also the tax on every other
fix in this list.

### D4 · P1 · Owner portal credential used to provision the till
No device-scoped enrolment. Couples portal and till blast radius.
**Agreed design:** business ID identifies, a single-use enrolment code authorises.
Portal issues it; server burns it, writes the `user_devices` row and returns a
device-scoped token. Copy `routes/tech.ts` — that flow is already this shape.

### D5 · P1 · CLOSED 08-08 · Owner and staff tokens stored plaintext in SQLite
See §E. Wrapped at rest via `main/tokenStore.ts`; plaintext columns retained as
a fallback and never cleared until the wrapped value has been read back in the
same write.

### D6 · P2 · Local schema 46-51 undocumented
`localDb.ts` explains 43/44/45 in detail, then goes silent through 51. Six
generations with no record, on the mechanism deciding whether a field till works.

### D7 · P2 · 126 IPC channels, no shared payload validation
`check-ipc-parity` proves a channel exists, not that its two sides agree. This is
the gap §L already names, and what P-09 and P-11 were.

### D8 · P2 · Dispatch ticket can print nowhere
`POSPage.tsx:455` early-returns on `canPrint('kitchen')`, but the HTML path it
skips prints kitchen **and** dispatch. `escposBridge.ts:409` filters targets to
bound stations. Kitchen bound + dispatch unbound = the dispatch slip prints on
neither system, silently. Dormant while thermal is off.

### D9 · P3 · Held orders are not visible across tills
### D10 · P3 · `ipcHandlers.ts` at 1,639 lines
### D11 · P1 · `/api/pos/init` fails closed and kills the catalogue pull
`pos.ts:62-67` does `.single()` on `branches WHERE is_main` — zero rows errors,
and `one_main_branch_per_business` permits zero. `pos.ts:87` returns 403 on
`desktop_licensed`, which defaults false — **and resolves it from the `is_main`
branch, not the branch the till is bound to.** A till bound to branch B is
licensed by branch A's flag.
**Not the Beryl fault** — verified 08-08: one branch, `is_main` true,
`desktop_licensed` true. The licence-resolution bug stands regardless.

### D12 · P1 · CLOSED 08-08 · Inbound sync failures were entirely silent
See §E.

### D13 · P0 · PARTLY CLOSED 08-08 · Refresh rotation
Client side done — single-flight guard and stale-token retry, see §E.
**The crash window remains open** and cannot be closed from the client: the
server revokes the consumed token before the response is even sent, so any
interruption between there and the till's `UPDATE session` strands a dead token.
Only a server-side grace period fixes it — a briefly-superseded token returning
the current pair instead of a 401. That is the outstanding part of D13.

### D13 (original finding) · Refresh rotation with a non-atomic persist and no guard
`auth.ts:50-51` — access 15m, refresh 30d, **rotating**; `auth.ts:736` revokes
the consumed token before the desktop persists the new one at
`syncEngine.ts:117`. Killed between those points — crash, power cut, dropped
response — the till holds a revoked token and can never refresh. **The owner must
sign in again.** The window opens every ~15 minutes of trading.
Second path: `refreshAccessToken()` has no single-flight guard and is called from
the sync loop, IPC handlers and the PIN screen; concurrent callers present the
same token and the loser gets a 401.
**Fix:** single-flight mutex; on 401 re-read the token from SQLite once before
giving up; server-side, a short grace window returning the current pair.

### D14 · P2 · The till is not registered
`user_devices` has **no row for Beryl at all**. `sync.ts:71` is an `UPDATE`, not
an upsert, so telemetry writes nothing; `checkDeviceBranch` returns `ok:true` for
unknown devices, so migration 52's binding is inert. Consequence: no remote
visibility of `app_version` or `schema_version` — every diagnosis needs someone
physically at the machine.

### D15 · P3 · Two different tables named `sync_queue`
`public.sync_queue` in Postgres (`retry_count`, `table_name`) is **dead** —
no hit for `from('sync_queue')` anywhere in `apps/server` or `apps/dashboard`.
The live one is the till's SQLite table (`attempts`, `last_error`). Same name,
different columns, one of them a decoy. Drop or rename it.

---

## M. Migration ledger — reconciled against production, 2026-08-08

Source: `select version, applied_at from public.schema_migrations`, cross-checked
against the live schema dump. **`schema_migrations` under-reports** — several
migrations are demonstrably applied but have no row, so the log cannot be used to
decide what to run. That is worse than a known gap and is why 46 sat unapplied.

- **31 and 32** are recorded `SKIPPED`, "number never used". Resolved, not lost.
  **64 never existed.** The earlier concern about four missing numbers is one gap.
- **68 is real and prod-only.** `p_delta` → `p_points` on the loyalty RPC, applied
  2026-08-06 21:13. `CREATE OR REPLACE` cannot rename a parameter, so it needed a
  DROP. **Extract the live definition and commit it** — see §E.
- **66 is applied in production but filed under `archive/superseded`.** It is the
  live `create_order_atomic`, superseded only by 69's hotfix. 69 is a full
  redefinition, so the repo *can* rebuild the function.
- **71 is recorded as version `71`**; the file inserts `71_adjust_fuel_tank_level`.
  Re-running it creates a duplicate row.
- **Applied but unrecorded:** 57 (`onboarding_progress.owner_pin_set` exists),
  60 (`component_slots`, `order_item_units` etc. exist), and almost certainly
  53 and 61 (functions). 55/56/58 are recorded under legacy names.
- **Genuinely unapplied until 08-08: 46.** See §E.

---

## E. CLOSED 2026-08-08

| ID | What it was | Closed by |
|---|---|---|
| 46 | `payments_method_check` admitted only cash/mpesa/card/credit while `PaymentModal.tsx:49-57` offers Glovo on every till, unconditionally. The migration file predicted the symptom verbatim: *"the order fails to sync and sits in the queue with a constraint violation nobody can read from the till."* | Applied to production 08-08. Verified: `glovo` present in the constraint. **Was not the Beryl fault** — those payloads are cash. |
| D12 | Inbound sync failures were silent. `syncEngine.ts:328` was a bare `if (!res.ok) return false` — status and body discarded — on the **one** call that matters, while tables/pumps/stations all log properly. Compounding it, the desktop had **no durable logging at all**: every `console.warn` goes to a console that does not exist on a packaged build. | New `main/logFile.ts` (rolling, bounded, never throws). Catalogue pull and both token refreshes now record status + body. `getSyncStatus()` gains `pullError`, `pullErrorSince` and `logPath`, alongside the existing `failedReason`. |
| D2 | Held orders — restaurant tabs, with pre-assigned bill number and per-line kotSent flags — were one JSON blob in renderer `localStorage`, read through a catch that returned an empty list. A truncated write reported **zero open tables**, silently, with the KOTs already on the pass. | New `held_orders` table (one row per tab, so a bad row costs one table not all of them). Five IPC channels; the renderer API keeps its shape but is now async — 9 call sites and 5 functions in `POSPage.tsx`. **No `LOCAL_SCHEMA_VERSION` bump**: `CREATE TABLE IF NOT EXISTS` runs ungated on every open. A corrupt cart now returns the tab with an empty cart and a `corrupt` flag so it can be rebuilt from the KOT, rather than disappearing. One-time idempotent import of the legacy blob, and the old key is cleared only after the main process confirms it. Not cleared by `clearCatalogue()`. |
| D13 (client half) | Refresh tokens rotate and `auth.ts:736` revokes the consumed one, but `refreshAccessToken()` had no single-flight guard across three call sites (`ownerFetch`/PIN pad, the sync loop, the order push) and `refreshStaffToken()` none across four. Two concurrent refreshes present the same token; the loser gets a 401 for a token that was valid when it read it, and the owner is signed out. Offline that is unrecoverable — there is no way to sign back in. | Single-flight promise on both paths, so overlapping callers await one request. Plus a one-shot retry when a 401 arrives and the persisted token differs from the one sent — a stale in-memory copy is bookkeeping, not a revoked session. A genuinely revoked token is **not** retried. 10 new tests; mutation-checked by removing the guard and confirming they fail. |
| D16 (offline sign-in) | Everything on a till worked offline except the DOOR: `auth:verifyPin` called the server and threw, and the local `users` table carried no hash to check against, so a line fault stopped the floor starting a shift. | New `staff_pin_cache` table + `main/pinCache.ts`. Cached **only** for staff who signed in on this terminal while online, **only** bcrypt hashes (legacy upgrades on next online sign-in), **never** `override_pin_hash` — elevated actions stay online. Wrapped with safeStorage/DPAPI; nothing cached at all if the platform cannot wrap it. Expires after 14 days without server contact; cleared on logout. Offline verification scans all cached entries and refuses on two matches, same as the server. `bcryptjs` (pure JS) not `bcrypt` — a native module would hit the same ABI wall as better-sqlite3. Server returns the hash from `/api/auth/verify-pin` for `surface === 'desktop'` only. **The fallback fires on transport failure only, never on a 401/409** — otherwise a sacked cashier signs in by unplugging the cable. 16 tests. |
| D5 | `session.token` / `refresh_token` and the staff equivalents were plaintext in `swiftpos.db`. The refresh token is the durable one — 30 days, self-renewing — so anyone with a copy of the file held working owner-scoped access long after taking it. | New `main/tokenStore.ts`: values wrapped with safeStorage (DPAPI) into `*_enc` columns, 8 read sites and 3 write sites routed through it, `migratePlaintextTokens()` at startup so an upgraded till stops holding a clear credential within seconds. **The plaintext is cleared only after the wrapped value round-trips in the same write** — the naive version of this change is itself a lockout, and offline the owner cannot sign in again to replace what it destroyed. No safeStorage means plaintext, not a broken session. 14 tests, mutation-checked by removing the round-trip verification. Honest limit, same as PHASE2-3-DESIGN §2d: defeats a copied `.db`, a stolen backup and a pulled disk; not code running as the app user. |
| A1 (packaging) | `pos.zip` hand-built from the working folder, so `.env` rode along. Written as prose in five handoffs and committed as a script zero times — which is why it recurred. | `npm run package` → `git archive --format=zip HEAD -o pos.zip`, plus `npm run package:check` which fails if `.env` or `node_modules` appear. |

### Still open from the Beryl investigation

Eight orders failed on 2026-08-07 between 21:09 and 22:53 UTC, all `attempts=5`,
all `Failed to create order (ref: …)`. Ruled out by evidence, not by reasoning:

- **Not Glovo** — both sampled payloads are `"method":"cash"`.
- **Not the shift FK** — shift `79c4881f-…` exists, open, terminal `T1`.
- **Not the payment reconciliation guard** — 600 = 600 and 6040 = 6040 exactly;
  that path is 23514 and returns a readable 400 anyway.
- **Not an order-number collision** — 23505, handled as a 409 at `orders.ts:669`.

Only `throw createErr` at `orders.ts:681` produces the generic message, so it is
an unhandled Postgres error **or something throwing after the RPC committed**
(stock deduction and the rest run inside the same `try`). Two ways to settle it:
grep the server log for `error 341849fb`, or check whether those idempotency keys
already exist in `public.orders` — if they do, the money is recorded and the till
is lying.

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
| 2026-08-08 | Desktop audit (D1-D15) and Beryl sync investigation. Migration ledger reconciled against production (§M). Migration 46 applied. D12 and A1 packaging closed. Header counts and commit corrected. |
| 2026-08-08 (eve) | D2, D12, D13 (client half), D16 offline sign-in, A1 packaging closed. Migration 46 applied. 78 desktop tests added, green on Windows/Node 20 with SQLite suites on the real Electron ABI. Working rules moved into the handoff §0. |
