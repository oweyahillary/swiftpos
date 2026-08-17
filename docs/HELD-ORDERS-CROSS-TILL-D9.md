# Held orders across tills (register D9)

**Status: design only. Nothing built.** Held orders are the most dangerous data
in the app — open restaurant tables with food already cooking and no bill yet;
`heldOrders.ts` says *"losing one silently is the worst failure this app has."*
Making them cross-till is a real feature with a concurrency decision at its
centre, and it must not be implemented blind (no multi-till rig on the bench).
This document is the design and the decision to make before any code.

## Today

Tabs are **local to one till**: one row per tab in that till's SQLite
(`held_orders`), `held:list/hold/recall/delete` IPC, deliberately out of the sync
queue. `heldOrders.ts`: *"Cross-till recall is register D9 and needs server
state — not this."* So a tab opened on till 1 is invisible on till 2, and a
waiter who opens on the floor terminal cannot charge at the counter.

## Why it is not "add held_orders to REPLICATED_TABLES"

The node replication (`nodeIngest.ts`) is **seq-append, origin-scoped**: each
device writes rows with a monotonic `seq`, peers pull `seq > cursor` per origin.
That fits write-once records — `orders, shifts, float_transactions, expenses,
business_days, events`. Held orders break it two ways:

1. **They are deleted.** A tab ends by being charged (becomes an order) or
   discarded. The seq-append model has no delete — a peer that pulled the tab
   keeps showing it after it is gone. A cashier charging an already-charged tab is
   a double sale on the app's worst data path. Handling this means tombstones
   (delete markers that also replicate) — real added complexity and a new failure
   mode (a lost tombstone = a ghost tab).
2. **They are mutated concurrently.** Two tills editing the same tab, or both
   recalling it to charge, is a race the append model cannot arbitrate.

## The decision (owner) — the concurrency model

When till 2 wants a tab that is open on till 1, what happens?

- **(a) Hard claim / handoff.** Recalling on till 2 takes ownership; till 1's copy
  becomes read-only or disappears. Matches "one person works a table at a time."
  Needs an atomic claim so two tills cannot both win.
- **(b) Soft view, charge-locks.** Any till can *see* every open tab; the first to
  **charge** locks it, and a second charge attempt is refused with "already being
  paid at till 1." Lightest for staff, but the lock must be atomic and survive a
  till dropping offline mid-charge.
- **(c) View-only.** Tills can see other tabs but only the owning till can act.
  Safest, least useful — barely more than a shared board.

This is a workflow choice about how the client's floor actually runs, not a
technical one. It decides everything below it.

## Recommended shape (pending that decision): node-authoritative

Given the danger, make the **branch node the single source of truth for open
tabs**, rather than replicating mutable state peer-to-peer:

- Tabs still write locally first (never lose one to a network hiccup), then
  register with the node: `POST /node/tabs` (open), `/node/tabs/:id` (update),
  `DELETE /node/tabs/:id` (charged/discarded).
- A till shows **its own local tabs ∪ the node's open tabs**. Cross-till
  visibility needs node contact; an offline peer still sees and works its own —
  which is correct (its tabs are never lost, they just are not shared until it
  reaches the node).
- **Recall/charge is a single atomic node operation** — `POST /node/tabs/:id/claim`
  returning the tab and marking it claimed, or 409 if already claimed. The node
  being the one arbiter removes the eventual-consistency race entirely; there is
  no "two peers both think they own it" state to reconcile. This is why
  node-authoritative beats replicate-with-tombstones for THIS data.

Delete propagates for free: it is a node state change other tills see on their
next poll, not a tombstone that can be lost.

## What is benchable vs what is not

- **Benchable** (if/when the model is chosen): the node route handlers and the
  atomic claim (the 409-on-double-claim is exactly the shape proven for D4's
  enrolment burn — a conditional update that returns the row or nothing), tested
  under PGlite/node:sqlite.
- **NOT benchable, and where the real risk is:** the multi-till behaviour — two
  tills racing a claim, a till dropping offline mid-charge, a tab charged on one
  and still shown on another until the poll. That needs two real tills and a node,
  and it is the whole point of the feature.

## Recommendation

D9 is **P3**, sits on the worst-failure data path, needs an owner decision on the
concurrency model, and needs a multi-till rig to verify. It should **not** ride
the client rollout. Make the decision above, then build node-authoritative behind
that decision with the claim proven on the bench and the multi-till behaviour
smoke-tested — not before. Until then this is deliberately unbuilt: a ghost tab
or a double-charged table is worse than the feature's absence.
