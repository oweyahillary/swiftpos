# Shift & day parity — web POS ← desktop till (decision brief)

**Opened 2026-09-13.** Owner-agreed design for closing the shift/day gaps between
the web POS and the desktop till. Findings: **A273** (web register identity),
**A274** (web shift hard-gate — BUILT), **A275** (remote day close). This brief is
the standing design; the register entries are the tracker.

## The operating model (owner, 2026-09-13)
- **The desktop till is the main register. The web POS is the backup** — used when
  a till is down or unavailable.
- Therefore the web must **fold into the desktop's cash model**, not run a parallel
  one. A physical selling spot should reconcile as **one** register, one drawer,
  one trading day — regardless of whether a given sale was rung on the till or the
  browser standing in for it.

## What exists today (read from source, not memory — rule 5/17)
- A shift is a **drawer session bound to a terminal, not a cashier**. The cloud
  keys it `terminalKey = device_id || terminal_code || web:<branchId>`
  (`apps/server/src/lib/terminalKey.ts`, mirroring migration 63's one-open-drawer
  unique index). Whoever signs in on a terminal sells **into its open drawer**;
  per-sale attribution stays on `orders.cashier_id`.
- The **desktop** carries the full two-level cash model: `business_days` (per till,
  opens implicitly, closes only on a manager cash count, **never auto-closes, never
  writes a count nobody made**) + `shifts`. Central close is node-orchestrated
  (`branchClose.ts`): the manager queues a `close_day` instruction, the till
  **executes it locally** (computes its own expected cash + variance) and acks.
  The till is the cash authority; the node never does cash arithmetic on replicas.
- `business_days` **syncs to the cloud push-only** (till → cloud). Closes flow UP,
  never DOWN — so a day cannot be closed by writing the cloud copy; the till would
  never learn and would keep selling.
- The **web** has no `device_id`/`terminal_code`, so every web sale in a branch
  collapses to one shared `web:<branchId>` drawer; it has **no `business_days`
  concept at all** (no day open/close, no day-level count/variance, no next-day
  lock). End-of-day on web today is the shift + a Z-report modal.

## Invariants any change must preserve
1. **The till is the cash authority.** Expected cash + variance are computed where
   the drawer lives, never on a replica.
2. **Never fabricate a reconciliation.** No close on estimated cash with no count
   (`dayService.ts`: "a fabricated reconciliation is worse than none").
3. **One open drawer per terminal** (migration 63). Do not let the web open a
   second drawer against a terminal that already has one.
4. **Additive, revertable.** Cash-custody code ships behind clear seams; each
   change restorable by one file (rule 13, 20).

---

## Decisions (owner delegated to lead dev, 2026-09-13)

### #3 register identity → **Option B: the web stands in for a chosen till**
When a cashier opens the web POS as a backup, they **pick which till they are
covering**. The web then adopts that till's identity (sends its `terminal_code`,
and its `device_id` where we have it) so its sales land in **that till's drawer and
trading day**. One register per physical spot; nothing to reconcile twice; and it
means there is **no separate "web day"** for #2 to close.

- Rejected — Option A (web is its own register): splits one physical spot's cash
  into two books, which contradicts "web is the backup for a till."
- Consequence to honour: if the covered till is itself online with an open drawer,
  the web sells **into that same open shift** (the existing any-cashier-into-open
  model, extended across devices). If the till is down, the web carries the drawer
  until the till returns and re-syncs. Both are legal under one-drawer-per-terminal.

### #2 remote day close → **Option (i): remote FINALISE of a count the till made**
The off-site manager cannot conjure a physical count. So: the **cashier at the till
enters the drawer count**, and the manager **reviews and finalises remotely**. The
close is carried as a **cloud-relayed `close_day` instruction** — the exact
`branchClose.ts` pattern, but the queue lives in the cloud so an off-site manager
can post it; the till (or node) pulls it on its normal cloud sync and **executes it
locally**, then acks. This keeps invariants 1 and 2 intact.

- Rejected — Option (ii) (manager closes on expected cash, no count): this is the
  fabricated reconciliation the model explicitly refuses.
- Not a cloud-side write to `business_days`: closes flow up only, so a cloud write
  would never reach the till.

---

## Phased plan (each phase additive + independently shippable)

**Phase 1 — A274 · web shift hard-gate (BUILT 2026-09-13, bench).**
The web now blocks every selling boundary (Charge, Send to Kitchen, Room charge)
when no drawer session is open, and no longer swallows a failed `/api/shifts/current`
check — an unknown shift state prompts to open, never falls through to a
`shift_id:null` sale. Forward-compatible with A273 (the gate reads `currentShift`
regardless of how it was scoped). Guard: `tests/web-shift-gate.test.mjs` (5,
mutation-checked). Target confirm (rule 16): on screen, Charge disabled with no
shift; opening a shift enables it; a sale carries the shift id.

**Phase 2 — A273 · web register identity (Option B). BUILT 2026-09-13 (bench), delivery -b.**
Web POS gains a "which till am I covering?" picker at shift open (`GET /api/shifts/terminals`
lists the branch's enrolled tills), adopts the chosen till's `device_id` as `x-device-id`
on every request, and on a one-open-per-terminal 409 folds into the till's existing drawer.
No migration (the cloud already keys on the header). **Behaviour change:** a web shift now
requires covering an enrolled till. Target confirm (rule 16): till + web-as-that-till share
one drawer; a web sale carries the till's device_id; the offline→return re-sync path; tsc.

**Phase 3 — A275 · remote day close (Option i). BUILT 2026-09-13 (bench), delivery -c.**
Migration 102 (`day_close_instructions`, cloud mirror of `node_instructions`); `/api/day-close`
(manager instruct/overview, till pending/ack); the till's `syncAll` pulls and runs
`executeCloseDay` verbatim then acks (idempotent, best-effort); manager "Remote day close" panel
in ManagerShiftTab. Count entered remotely (i-A) — the cashier's count relayed by the manager;
the till computes expected+variance. Never writes a business_days close on the cloud. Target
confirm (rule 16): the full live loop, date-mismatch refusal, idempotent re-run, tsc, PGlite
migration test on CI.

### Follow-up decisions surfaced during the build
- **A273 gate interaction:** a web shift now requires covering an enrolled till (Option B).
  Confirm on the floor, or ask for a generic-web-register fallback.
- **A275 count entry (i-A vs i-B):** built i-A (manager enters the relayed count). If you'd rather
  the cashier physically enters the count at the till on an incoming instruction (i-B), that's a
  follow-up — the relay + ack shapes already support carrying the count either way.

## Verification posture
Phases 2–3 touch cash custody and the desktop till, so nothing is CLOSED on bench
evidence (rule 16): each needs the live till (and, for the drawer-sharing, a
till + web-as-that-till pair). Bench proves the wiring; the floor proves the money.
The step-by-step floor checklist with PASS criteria is `docs/VERIFY-SHIFT-DAY-PARITY.md`.
