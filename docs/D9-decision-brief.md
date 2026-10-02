# D9 decision brief — cross-till held orders (the lock/lease model)

Written 2026-09-10 after the owner chose the concurrency model. This turns that
choice into a buildable spec and surfaces the edge cases before any code. Read
alongside `HELD-ORDERS-CROSS-TILL-D9.md` (the original design) and the register
D9 entry.

## The owner's decision (the model to build)

> "Once a held order is claimed by a till it **locks** on the other till until
> **release / held again / cleared**. When till 2 is editing, till 1 should show
> **locked**. If there's a miscommunication and the order is **cleared**, the
> **manager gets a notification** — who opened it, what changed, who cleared it —
> for audit."

This is a **soft-lock / lease** model — close to option (b) in the design doc but
with two additions the doc didn't have: an explicit **lock indicator on the other
till while editing**, and an **audit trail with a manager notification on clear**.
It is neither a permanent handoff (a) nor view-only (c): any till can *see* every
open tab; a till *claims a lock* to edit/charge; the lock *releases* so another
till can take over; and a *clear* is an audited, notified event.

## How it behaves (the workflow, precisely)

1. **Open.** A tab is created on the till that opens it (writes locally first, as
   today — never lose a tab to a network hiccup), then registered with the branch
   node so other tills can see it. Owner-of-record = the opening till/staff.
2. **See.** Every till shows: its own local tabs ∪ the node's open tabs. Each tab
   shows its state — **Open** (claimable), or **Locked by <till/staff>** (someone
   is editing/charging it).
3. **Claim to edit/charge.** A till taps a tab → `claim`. The node atomically
   grants the lock (returns the tab) or refuses with **409 "locked at <till>"**.
   Only the lock-holder can edit lines or charge.
4. **On the other till, live.** A claimed tab shows **Locked** — greyed, not
   tappable to edit — with who holds it. It updates on the next poll (a few
   seconds), so a second cashier sees the lock before trying.
5. **Release.** The lock ends when the holder: charges it (tab → order, tab
   deleted everywhere), holds it again (saves changes, releases the lock — back to
   **Open**), or explicitly releases (no change, back to **Open**). A lock also
   **auto-expires** after a timeout (see edge cases) so a crashed till can't
   freeze a tab forever.
6. **Clear (discard).** Discarding a tab without charging is the dangerous path.
   It requires the lock, and it emits an **audit event** → manager notification:
   `{ tab, opened_by, opened_at, last_changed_by, changes_summary, cleared_by,
   cleared_at }`. This is the "who opened / what changed / who cleared" record.

## What must be built (node-authoritative, per the design doc)

The branch node is the single source of truth for open tabs — no peer-to-peer
mutable-state race to reconcile. New node routes (mirroring the D4 atomic-claim
shape):

| Route | Purpose | Concurrency |
|---|---|---|
| `POST /node/tabs` | register an opened tab | idempotent on tab id |
| `GET  /node/tabs` | list branch-open tabs (for the ∪ view) | read |
| `POST /node/tabs/:id/claim` | acquire the edit/charge lock | **atomic**: conditional update `SET locked_by=? WHERE locked_by IS NULL OR locked_by=? OR lock_expires < now()` → row or 409 |
| `POST /node/tabs/:id/release` | drop the lock (hold-again / explicit) | must be the holder |
| `PATCH /node/tabs/:id` | save edited lines (holder only) | must hold the lock |
| `DELETE /node/tabs/:id` | charged or cleared; on clear, write the audit event | must hold the lock; clear emits audit |

Node tab state: the existing `held_orders` columns **plus** `locked_by TEXT`,
`lock_expires TEXT`, `opened_by TEXT`, `last_changed_by TEXT`. The audit event
rides the existing `events` replication (write-once, already replicated) — so the
manager notification is just a new event type consumed by the existing
notification path, not new plumbing.

## Edge cases the model must answer (flagged for the owner)

1. **Till crashes while holding the lock.** Without a timeout, the tab is frozen
   forever. → `lock_expires` (a lease, e.g. 3 min, renewed on each edit). After it
   lapses another till can claim. **Owner input: how long?** Too short = the lock
   steals mid-edit; too long = a crashed till blocks the table. 2–5 min typical.
2. **Two tills claim in the same instant.** The atomic conditional update means
   exactly one wins; the other gets 409. Benchable. ✓
3. **Offline peer.** A till that can't reach the node still sees/works **its own**
   local tabs (never lost) but can't see or claim others' — correct, and matches
   today's isolation. When it reconnects, its tabs register.
4. **Charged-but-still-shown.** Between charge on till 1 and the poll on till 2,
   till 2 may still show the tab. Claiming it → 409 (already gone/charged), so the
   worst case is a harmless "that tab was just charged" message, **not** a double
   charge. This is the safety property that makes the model acceptable.
5. **Clear vs. charge audit.** Only **clear** (discard) needs the who/what/who
   notification — a charge is already a recorded sale. Confirm that's the intent.

## Benchable vs. not (rule 16) — unchanged from the design doc

- **Benchable now:** the node route handlers, the atomic claim/lock (409 on
  double-claim, lease expiry), the audit-event emit on clear, and the ∪ view
  logic — under PGlite / node:sqlite.
- **NOT benchable — needs two real tills + a node:** the live lock indicator
  updating across tills, a till dropping offline mid-charge, the poll-lag window
  in edge case 4. This is the whole point of the feature and only a two-till rig
  proves it.

## Recommended build order

1. **Owner confirms two things:** the lease timeout (edge case 1), and that only
   *clear* is audited/notified (edge case 5).
2. Build the node tab table + the 6 routes + the atomic claim, with a bench test
   for the claim/lock/expiry/audit-emit (the D4 conditional-update pattern).
3. Wire the desktop: `held:*` IPC gains claim/release/lock-state; the tab list
   shows Open vs Locked-by; clear emits the audit event.
4. **Two-till session** to verify the live behaviour before it goes near a real
   floor. Do NOT ship on the client rollout until that passes.

## Two questions back to the owner before code

1. **Lease timeout** — how long may a till hold a tab's lock with no activity
   before another till can take it? (2–5 min suggested.)
2. **Audit scope** — audit + notify the manager on **clear/discard** only, or also
   on other actions (e.g. a forced lock-steal after timeout)? A forced steal is
   arguably worth notifying too.
