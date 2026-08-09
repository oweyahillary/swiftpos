# Fix: wire the relocated-till branch check (finding #16)

Migration 52 built a device→branch binding and `lib/deviceBinding.ts` implemented
the check — but it had ZERO call sites, so it never ran. A till physically moved
to another branch kept booking its takings to the old one. This wires the check
into order creation.

## Files in this bundle

    apps/server/src/routes/orders.ts              calls checkDeviceBranch on POST /orders
    tests/device-branch-binding.test.mjs          proof, standalone

orders.ts is the WHOLE file and is CUMULATIVE — it also contains the
numeric-stock, atomic-order and shift-drawer-session fixes from earlier bundles.
If you are applying the consolidated set, this is the newest orders.ts and
supersedes the earlier copies.

`lib/deviceBinding.ts` is NOT included — it already exists in your tree and is
unchanged. This bundle only adds the call site.

## What was wrong

The branch on an order payload is the TILL's claim about itself — it lives in the
machine's local config and travels with the machine. Nothing checked it. Move a
till from Branch A to Branch B and it keeps reporting Branch A: A's books carry
revenue that never happened there, B's stock walks out unrecorded, and neither
branch's cash count reveals it because each is internally consistent. It surfaces
only in a stock take weeks later — or not at all. Migration 52 recorded the
binding server-side precisely so the claim could be checked; the check was just
never called.

## The fix

`POST /api/orders` now calls `checkDeviceBranch(businessId, deviceId, branch_id)`
right after the existing branch-access check, before creating the order. The
function (unchanged, from migration 52's design):

  * FAILS OPEN for an unbound or unknown device — every existing till binds
    itself on first sight and keeps trading, so nothing breaks on deploy;
  * allows the bound branch;
  * REFUSES a move (409, code branch_mismatch) — the order stays on the till to
    re-push once the branch is corrected, so no sale is lost;
  * honours a manager's rebind window for one authorised relocation, recording
    the previous branch for audit.

Offline orders re-push through POST /orders (with idempotency), so they are
covered by the same guard.

## Scope note — what this does NOT wire

The shift push in sync.ts also carries a device_id and branch_id, so a moved
till's SHIFT could bind to the wrong branch. I did not wire the check there: that
path is a batched upsert with a different structure, the money-attribution risk
lives on the ORDER path (now covered), and adding it to the batch loop is more
invasive than the finding warrants. It is a clean, low-risk follow-up if you want
belt-and-braces — call checkDeviceBranch per shift row before the upsert.

## Test

    node tests/device-branch-binding.test.mjs

15 checks: no-device/no-branch pass through, unknown device fails open, first
sighting binds, the bound branch is allowed, a MOVE is refused without changing
the binding, a manager's rebind window lets one authorised move through and
records the previous branch, and a subsequent move is refused again. Expected:
15 PASS.

## Do you need to build the desktop app?

No. Server-only, no migration (52 already exists), no desktop build. After
deploying, a till reporting its normal branch is unaffected; a till whose local
branch_id is changed to another branch will get a 409 on its next sale until a
manager authorises the move.
