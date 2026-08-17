# Phase-5 downstream read-path — implementation plan (A17, A19, A20, A24; A18 doc)

This operationalises the design already agreed in `PHASE5-NODE-AUTHORITY.md`
(especially §11.4) into a sequenced, testable delivery. It designs nothing new;
it turns the agreed delta into concrete work, files, decisions, and tests. Read
`PHASE5-NODE-AUTHORITY.md` first — this is the "how we ship it", not the "why".

## The problem in one sentence

**The node replicates sales upward and sideways; nothing flows downward through
it.** `REPLICATED_TABLES` (`nodeIngest.ts:32`) is `orders, shifts,
float_transactions, expenses, business_days, events` — all sales-side. Everything
a till *reads* — catalogue (`syncEngine:476` → `/api/pos/init`), staff
(`syncEngine:581` → `/api/staff`) — still comes from the **cloud**. A peer with no
internet keeps whatever it last held.

A17 (auth locks out at day 15), A20 (failover can't open the shop), and A24
(prices/catalogue/settings go stale) are **not three problems**. They are three
symptoms of that one sentence. A19 is the matching upward half: an offline peer's
sales never reach the cloud because the node doesn't forward them.

## The core move

Extend the **existing** downstream mechanism — `collectDistribution` /
`/node/since` / `peer_cursors`, which already fans sales rows to peers — to also
carry the read-side tables (`users`, catalogue, prices, settings). It is an
extension of a proven mechanism, not a new one. The node becomes the peer's
source of truth for reads, exactly as it already is for writes.

One honest caveat up front (see "Risks"): sales rows are partitioned by
`device_id` + `seq`, and read-side rows are **not** — they're branch-global,
authored at HQ. So the read-path needs its **own cursor model** (per-table
version / `updated_at`, single upstream origin), not a literal reuse of the
sales cursor. This is the one genuinely substantial item; everything else is
small.

---

## Work breakdown (from §11.4, made concrete)

Grouped by the sequencing in §8. Sizes are relative.

### Group A — additive schema + read endpoints (nothing changes behaviour yet)

1. **Local `users` columns** (small). Add `pin_hash_enc`, `override_pin_hash_enc`,
   `permissions`, `branch_id` to the local `users` table. `CREATE TABLE IF NOT
   EXISTS` runs ungated on every open (D2), so **no `LOCAL_SCHEMA_VERSION` bump**.
   Drop the `branch_staff` idea entirely — `users` already exists and syncs.
2. **`business_settings.branch_id`** (small, but a real gap A24 found). Today it
   has none, so a two-branch business editing exclusions for one branch changes
   both. Add it before settings can distribute per-branch. Also reconcile the
   **two** exclusion mechanisms A24 found (cloud-backed vs per-till `localStorage`)
   into one source, or the distributed copy will fight the local one.
3. **Node-scoped `/api/staff` variant** (small). `shapeStaff` (`staff.ts:85-90`)
   strips the hashes in one place — add a flag so a node-authenticated pull keeps
   `pin_hash_enc` / `override_pin_hash_enc`. Guarded exactly as §4b. Not a new
   endpoint shape, a flag on one function.

### Group B — the node as read authority

4. **Downstream distribution of read tables** (substantial — the real work).
   Extend `collectDistribution` to also serve `users` and the catalogue set
   (`products`, `categories`, `branch_prices`/effective prices, `business_settings`,
   receipt/exclusion settings). Because these are branch-global, this needs a
   read-side cursor (per-table `updated_at`/version, one upstream origin = the
   node) rather than the `device_id`+`seq` sales cursor. On arrival at a peer,
   credential blobs are **re-wrapped with that machine's own `safeStorage`** —
   DPAPI is machine-bound, so a blob can't be copied verbatim between tills. This
   single item closes the read half of A17, A20, and A24.
5. **`POST /node/verify-pin`** (small). One more route in `nodeServer.ts`, where
   seven already follow the `X-Node-Secret` + branch-scope pattern (§4c).
6. **Peer authority chain in `auth:verifyPin`** (small). Try **node → cloud →
   cache**, in that order, with a message that names which authorities were
   tried (§4d). Today it's cloud-only via `ownerFetch`/`getServerUrl()`.
7. **Expiry, restated** (one line). Redefine the 14-day bound as "days since **any**
   authority was reached", and **refresh `cached_at` on node contact** (§4e). A
   peer that sees its node daily never expires; a node never expires. This is what
   actually turns off the day-15 lockout — not raising the TTL, which would only
   widen the stolen-till window.
8. **Override PIN offline** (small). Cache/replicate `override_pin_hash_enc` so
   voids, discounts past the floor, and refunds work through the offline period
   (§5 — reverses a D16 decision, deliberately).

### Group C — sales routing (moves money paths; ships last, one till at a time)

9. **Node forwards peer sales to the cloud** (small, A19). When the node ingests a
   peer row, it enqueues it into its **own** `sync_queue`, preserving the original
   id and idempotency key, so the cloud eventually sees every branch sale. A node
   outage then delays cloud *backup*, not branch *operation*.
10. **Peer skips the cloud push when `node_url` is set** (small, §3). The peer
    pushes to the node only; the two-queue mechanism (`syncEngine:1138-1151`) was
    right, the routing was wrong.
11. **Reset outbox cursors in `tech:setNodeUrl`** (two lines, A21 — already closed,
    keep in the checklist so a repoint doesn't strand rows).

---

## The one decision only the owner can make

**Does the staff roster replicate to every till?** (§10.1, A20.) Failover needs
it — a promoted till with no roster can't authenticate anyone, so the shop stays
shut at the exact moment failover exists to prevent. But every till holding the
roster means a **stolen peer yields the branch's PIN hashes**.

| | Node-only | Replicated (failover works) |
|---|---|---|
| Stolen peer yields cashier PINs | No | **Yes** |
| Stolen peer yields override PINs | No | **Yes** (unless split) |
| Node dies at a remote site | **Shop shut** | Promote and carry on |

**Recommendation (from §10.1): split the roster.** Replicate `pin_hash_enc` to
every till (sell-side continuity is the point); keep `override_pin_hash_enc`
replicated too but **flagged**, default on, so a tighter-posture business can turn
it off and accept that a failover at a fully offline site loses voids/refunds
until internet returns. The honest framing: **a branch is one trust domain** —
every till already holds every sale, customer, and price for the branch;
withholding the roster buys less than it looks like. This needs a yes/no before
Group B item 4 is built, and it comes with a **new runbook item: rotate PINs when
a terminal goes missing.**

---

## Sequencing (§8) — and why this order

Nothing ships before a build has **traded a full service**, because this changes
how a till authenticates and there's no auto-update (D3) — a bad build is a site
visit.

1. Approve this plan + the roster decision above.
2. Group A (schema + endpoints) — additive, nothing changes behaviour.
3. Group B items 5–8 (node verify-pin, auth chain, expiry, override) — behind the
   new endpoints from A.
4. Group B item 4 (read distribution) — the substantial piece, once A/B scaffolding
   is in.
5. Group C (sales routing) — **last**, because it moves money paths; idempotency
   makes it safe to enable one till at a time.

The dependency worth stating: **Group C is safe only because order idempotency
(`X-Idempotency-Key` → `orders.ts:360`) already works end to end.** That's why a
mixed-version branch during rollout produces no duplicates.

## Prerequisites already met

D4 (enrolment) is live-verified as of this session, and D14 (registration) is
built — §7's prerequisites are satisfied, so this is unblocked to start once the
roster decision is made.

---

## Test plan — target only, not the bench (§9)

The bench (Linux, no Electron ABI, no LAN) can type-check and unit-test the
routing logic, but **none of the following can be proven off-target**:

- A peer signing in with the internet cable out and the node up — repeatedly,
  **past 14 days by clock manipulation** (the day-15 test).
- A peer with **both** node and cloud unreachable: must fall to cache, then
  expire, naming which authorities it tried.
- A node **cold-started after a month offline**: must open the shop.
- A **sacked cashier**: refused by the node, and **must not** then succeed from
  cache (the dangerous path — a stale cache must never override a live "no").
- A **mixed-version branch** (one till on the old build, one new) selling
  simultaneously: no duplicates, no parked sales.
- **Failover end to end** (§10.6): kill the node, promote a peer, confirm it can
  authenticate and open the shop, then demote cleanly.

## What closes each ID

- **A17** — items 4 (roster reaches the peer via the node), 5–7 (node verify-pin,
  auth chain, expiry-on-node-contact). Day-15 lockout gone.
- **A19** — items 9–10 (node forwards, peer skips cloud). Cloud sees every sale.
- **A20** — item 4 with the roster decision (roster replicates → failover can
  authenticate).
- **A24** — item 4 for catalogue/prices/settings + item 2 (branch_id + exclusion
  unification). Reads stop going stale.
- **A18** — doc fix: `nodeServer.ts`'s header describes an architecture that no
  longer exists; correct it as part of touching that file (cheap, do it in Group B).

## Risks / watch-items

- **Read-side cursoring is the trap.** Don't force read tables into the sales
  `device_id`+`seq` model. They need per-table version/`updated_at` and a single
  upstream origin. Getting this wrong means either missed updates or full-table
  re-sends. This is where the design attention should go.
- **Price consistency** — `branch_prices` and `local_price_edits` exist precisely
  to stop two tills at one branch selling the same item at different prices;
  distribution must carry the *effective* price, not just base.
- **The two exclusion sources** (A24) must be unified first, or distribution and
  `localStorage` will disagree on the same till.
- **Credential re-wrap on arrival** must be verified per machine — a blob wrapped
  on the node and stored verbatim on a peer is useless (DPAPI machine-bound), and
  silently so.
- **D3 (no auto-update)** is the multiplier on all of the above: every one of the
  target tests is a site visit until auto-update ships. Worth weighing whether a
  minimal D3 lands first.

## Estimate shape

Groups A + B items 5–8 + Group C are each small (a handful of files, mostly
additive, each a day or so of careful work + a target test). **Item 4 (read
distribution + its cursor model) is the bulk** — design it first, in isolation,
against the two hardest cases (a price change at HQ reaching a fully offline peer;
a new cashier signing in on a peer that has never seen them). Everything else
hangs off it.
