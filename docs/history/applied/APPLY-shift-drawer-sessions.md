# Fix: shifts become drawer sessions bound to a terminal (findings #13 + the two-terminal scenario)

The system keyed shifts on the cashier, but asked a human to count a drawer.
Those never reconciled. This realigns to the POS-industry-standard fixed-till
model, and adds the missing close authorisation.

## The scenario this fixes

Cashier A opens a drawer on terminal T1. Cashier B opens on T2. A logs into T2
and rings a 500 cash sale.

  BEFORE: /shifts/current on T2 found A's shift BY CASHIER and returned the T1
  shift; the sale was stamped with A's T1 shift_id while the 500 sat in the T2
  drawer. At close, T1 read 500 short and T2 read 500 over — a phantom variance
  split across two rooms. And ANY user could close ANY drawer with any count.

  AFTER: the sale attaches to T2's session (the terminal it was rung on). The
  money and the sale are both on the T2 drawer, which is what someone physically
  counts. A is still recorded on the order for per-cashier reporting.

## The model (Microsoft Commerce "fixed till", and every major POS)

A shift is a DRAWER SESSION bound to a register, not carried by a cashier:
  * one open session per terminal (not per cashier);
  * a cashier on two terminals is in two sessions;
  * several cashiers on one terminal SHARE its session; a login does not open a
    new one, and a new session opens only after an explicit close;
  * the drawer is what reconciles; the cashier is a tag on each sale and on the
    session (opened_by / closed_by) for reporting and accountability.

Migration 41 already added device_id/terminal_code/opened_by/closed_by to shifts,
clearly intending this model. Migration 42 then contradicted it with a
per-cashier constraint. The DESKTOP till already queried open shifts by device_id
(it was operating this model locally all along). Only the SERVER and WEB POS keyed
by cashier. This aligns them.

## Files in this bundle

    migrations/63_shift_drawer_sessions.sql        swap the constraint, backfill
    apps/server/src/lib/terminalKey.ts             resolve a request's terminal
    apps/server/src/routes/shifts.ts               open/current/close by terminal
    apps/server/src/routes/orders.ts               sale resolves shift by terminal
    tests/shift-drawer-sessions.test.mjs           the scenario, proven

shifts.ts and orders.ts are whole files. orders.ts also carries the earlier
numeric-stock and atomic-order fixes (cumulative), so it supersedes those two
bundles' orders.ts.

## What changed

- migration 63: replaces `shifts_one_open_per_cashier` with
  `shifts_one_open_per_terminal`, using a `shift_terminal_key(device_id,
  terminal_code, branch_id)` SQL function = COALESCE(device_id, terminal_code,
  'web:'||branch_id). Backfills a terminal key onto legacy open shifts and
  demotes any duplicate open sessions that already shared a terminal to
  closed_unreconciled (a manager counts each).
- terminalKey.ts: the same COALESCE in TypeScript, so app and index agree.
- /shifts/current: resolves the terminal's open session (was: the cashier's).
- /shifts/open: one open session per terminal; records device_id, terminal_code,
  opened_by.
- /shifts/:id/close: AUTHORISATION (finding #13). A drawer may be closed by the
  opener, a cashier on the same terminal, or a manager (shifts.manage / owner).
  Records closed_by and close_method='counted'.
- orders.ts: the sale attaches to the terminal's session.

## The web POS

The web dashboard sends no device_id, so its terminal key is 'web:<branchId>' —
all web sales in a branch share ONE logical drawer session. That is correct: a
browser has no dedicated hardware drawer, so a branch's web POS reconciles as one
drawer. No web change is required for this to hold.

## The desktop

The desktop already keys open shifts by device_id locally, so it needs little or
no change. Its sales sync with device_id set, which the server now uses to resolve
the session. Verify after deploy that a desktop sale lands on that device's open
session (it should, unchanged).

## Apply order

1. Run migration 63 FIRST. It is transactional and backfills before swapping the
   constraint. Read the NOTICE it emits — any "demoted duplicate open session"
   line is a drawer that was open twice and now needs counting.
2. Deploy terminalKey.ts, shifts.ts, orders.ts together.

## Test

    node tests/shift-drawer-sessions.test.mjs     (needs better-sqlite3; apps/desktop has it)

14 checks running your exact scenario: A opens T1, B opens T2, A sells on T2 →
the sale lands on T2's session; the drawers reconcile with NO phantom variance;
one-open-per-terminal is enforced; several cashiers share a terminal's session;
and the close-authorisation matrix (opener / same-terminal / manager allowed,
stranger blocked). Expected: 14 PASS.

## Do you need to build the desktop app?

No. Server + migration. The desktop's local model already matches; no desktop
rebuild is required for this change. Verify behaviour after deploy rather than
rebuilding.
