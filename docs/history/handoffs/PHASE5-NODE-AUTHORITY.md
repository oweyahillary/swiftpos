# PHASE 5 — The node is the branch's authority

**Status: FOR APPROVAL BEFORE CODE.**
Opened 2026-08-09. Owner's design statement, recorded verbatim:

> One server, all tills sync their sales there — makes it easy for the manager to
> view sales reports and close the day. This server till is the only source of
> truth, and the only link to the cloud (for clients who have web access; sync
> also serves as data backup). The node can stay offline forever — assume a
> client in a remote place with minimal internet; no need to lock them out. Yes,
> the node should be able to authorise. We are creating a resilient system for
> offline clients: they should work efficiently without disruption.

Closes register **A17** (P0), **A18** (P1), **A19** (P1).
Reverses one decision from the 08-08 evening handoff — see §6.

---

## 1. What the code does today, and why it does not match

Three facts, each read from source at `f9d29a8`:

1. **Authentication is cloud-only.** `ipcHandlers.ts auth:verifyPin` → `ownerFetch`
   → `getServerUrl()` → `device_config.server_url`, which is **the cloud**.
   `node_url` is a different field (`nodeClient.ts:21`). The node's entire API is
   `/node/{health,sync,since,report,cursors,instructions,time,tech-session}`.
   **There is no auth route on the node.**
2. **The offline door expires at 14 days.** `staff_pin_cache.cached_at` is
   written from exactly one place — `cacheStaffCredential`, called only after a
   **successful cloud** verify-pin (`ipcHandlers.ts:443`). LAN contact with the
   node cannot refresh it. Day 15 with no internet, the shop cannot open.
3. **The node is a replica, not an uplink.** `INSERT INTO sync_queue` appears
   once, at `syncEngine.ts:1566`, on the till that made the sale. Nothing
   forwards peer rows, so a permanently-offline peer's sales never reach the
   cloud.

The till's local `users` table (`localDb.ts:360`) carries `id, name, role_name,
status, synced_at` — **no hash, no permissions, no branch.** There is nothing on
a peer to authenticate against even if we wanted there to be.

### The tension this design has to resolve honestly

`syncEngine.ts:1138-1151` records a *deliberate* move away from node-as-uplink:

> It made the node a single point of failure for every peer's sales, which is the
> opposite of the reason a branch server exists — and it forced `node_ack`, a
> third state in a column that can only hold one destination's opinion.

**That change was engineering-correct and product-wrong.** The two-queue
separation (`node_queue` vs `sync_queue`) was the right fix and **is kept**. What
is restored is only the *routing*: the node forwards. The single-point-of-failure
objection is answered in §3 — a node outage delays cloud backup, it does not lose
sales, because the peer holds its rows until acked.

---

## 2. Principle

> **A till asks the nearest authority that can answer, and is only bounded when
> it can reach none of them.**

Order of authority for a peer till: **node (LAN) → cloud → local cache.**
For the node itself: **cloud → its own roster** (which never expires).

Today the order is cloud → local cache, with the node absent from the chain
entirely. That single omission is A17, A19 and half of D16's awkwardness.

---

## 3. Sales routing (closes A19)

**A till with a `node_url` pushes to the node only. The node forwards to cloud.**

- Peer enqueues to `node_queue` as now. It does **not** enqueue to `sync_queue`.
- On ingest, the node enqueues the peer row into **its own** `sync_queue`,
  preserving the **original `id` and `idempotency_key`** — never re-minted.
- `node_queue` and `sync_queue` stay separate. One status column still cannot
  hold two destinations' opinions; that bug is not being reintroduced.

**Why a node outage is not lost sales.** The peer keeps unacked rows in
`node_queue` indefinitely and retries. A node that is off for a week means the
manager's combined view is stale for a week and cloud backup is a week behind —
both inherent to "the node is the source of truth" — but every sale is still on
the peer, and still on paper.

**Rollout is safe because of idempotency.** During a mixed-version window a peer
on the old build pushes straight to cloud while the node also forwards the same
row. Both carry the same `idempotency_key`, and `orders.ts:360` short-circuits
to `200 duplicate`. So this can roll out one till at a time. **A peer that gets a
404 from the node's new routes falls back to its current behaviour** rather than
parking sales.

---

## 4. The node as auth authority (closes A17)

### 4a. New table, node only — `branch_staff`

```
staff_id, name, role_name, branch_id, permissions,
pin_hash_enc, override_pin_hash_enc, status, updated_at, source_synced_at
```

Both hashes wrapped with `safeStorage` via the existing `tokenStore` helpers.
bcrypt only, exactly as `pinCache` already insists. `CREATE TABLE IF NOT EXISTS`,
ungated — per D2's finding, all local tables run on every open, so **no
`LOCAL_SCHEMA_VERSION` bump.**

### 4b. New server endpoint — `GET /api/pos/branch-staff`

Returns the branch's active staff with bcrypt hashes. Guarded by: `surface ===
'desktop'`, the caller's own business, the caller's bound branch, and
`isNodeRole(device_role)` — **node OR office**, see §12. The server pulls it on
every successful catalogue sync.

This is the one genuinely new exposure and it is stated plainly: **an endpoint
that hands a machine the branch's PIN hashes.** It is why the guard is four
conditions and not one, and why D4 enrolment stops being deferrable (§7).

### 4c. New node route — `POST /node/verify-pin`

Guarded by the existing `X-Node-Secret` and branch scope, like every other
`/node/*` route. Same semantics the server already has and `pinCache` already
mirrors: scan all candidates, **refuse on two matches** rather than guess. A
shared PIN books one cashier's sales to another, and the node has no more right
to guess than the server does.

Returns the staff identity and permissions. **No JWT is minted** — the existing
decision stands: orders push under the owner token and `cashier_id` comes from
`staff_session`.

### 4d. `auth:verifyPin` on a peer becomes

```
node_url set?  → POST node/verify-pin
                   answered (ok or refused) → that is the answer, honour it
                   transport failure        → fall through
cloud reachable? → POST /api/auth/verify-pin   (as today)
                   answered → honour it; on success, cache
                   transport failure → fall through
local cache      → verifyPinOffline
```

**The 08-08 rule is preserved and extended:** fall back only when an authority
could not be *reached*, never when one *answered no*. A 401 from the node is as
final as a 401 from the cloud. Otherwise a sacked cashier signs in by unplugging
a cable — now with two cables to choose from.

### 4e. Expiry, restated

`PIN_CACHE_TTL_DAYS` stops meaning "days since cloud contact" and starts meaning
**days since ANY authority was reached.** `cached_at` is refreshed on a
successful node verify as well as a cloud one.

- A peer that reaches its node daily: **never expires.** Correct — it is in the
  shop, doing its job.
- A peer that reaches neither for 14 days: still bounded. Also correct — that
  terminal has left the building.
- **The node itself never expires.** Its `branch_staff` roster is authoritative
  until replaced. This is the remote-client case and it is the point of the
  whole document.

---

## 5. Override PIN, offline (reverses a D16 decision)

D16 recorded: *"`override_pin_hash` is never cached. A thief already has the
till; the only credential worth stealing is the one that authorises voids,
discounts past the floor and refunds. Elevated actions stay online."*

**That is reversed, deliberately, on the owner's call** — a remote site cannot
have voids and refunds unavailable indefinitely.

The reversal keeps most of what the original decision bought:

- **Override hashes live on the NODE only.** They are never written to a peer's
  `staff_pin_cache`.
- A peer asks the node **per authorisation**; it caches no override credential.
- So a stolen *peer* still gains nothing — which was D16's actual threat model.
- A stolen *node* is a genuinely worse outcome than before. That is the cost, it
  is real, and it is accepted knowingly.

**Honest limit, same as PHASE2-3-DESIGN §2d and D5:** `safeStorage`/DPAPI defeats
a copied `.db`, a stolen backup and a pulled disk. It does not defeat code
running as the app user. A node that auto-logs-in gives an attacker who powers it
on exactly what the app has. **The node should require a typed Windows password.**

---

## 6. Decisions recorded (do not relitigate)

- **Node is the branch's source of truth and its sole cloud uplink.** Peers with
  a `node_url` do not push to cloud.
- **The two-queue separation stays.** `node_queue` ≠ `sync_queue`. The 08-08
  reasoning was right; only the routing changes.
- **No JWT is minted offline**, by node or cache. Unchanged from 08-08.
- **Refuse on two PIN matches**, at every layer. Unchanged.
- **bcrypt only.** Legacy hashes upgrade on the next online sign-in. Unchanged.
- **A node never expires.** A peer expires only when it can reach no authority.
- **Override authorisation moves to the node**, and is never cached on a peer.
- **Fall back on transport failure only, never on a rejection.** Unchanged, now
  across two authorities.

---

## 7. What this makes urgent

**D4 (device enrolment) stops being deferrable.** §4b hands a machine the
branch's PIN hashes on the strength of `isNodeRole(device_role)` — a value the
till currently sets about itself. Enrolling a device against its node is the same
mechanism, and building the auth path twice would be waste. **D4 should land in
the same piece of work, not after it.**

**D14 (the till is not registered) becomes a prerequisite,** not a nice-to-have:
`user_devices` has no row for Beryl at all, so there is nothing to check
`device_role` against server-side.

---

## 8. Sequencing

Nothing here ships before **0.5.25 has traded a full service**. This changes how
a till authenticates; with no auto-update (D3) a bad build is a site visit.

1. Approve this document.
2. D4 + D14 — enrolment and registration (prerequisite, §7).
3. §4a/§4b — `branch_staff` and the server endpoint. **Additive**: a new table
   and a new route, nothing existing changes behaviour.
4. §4c/§4d/§4e — node verify-pin and the peer's authority chain.
5. §3 — sales routing. Last, because it is the one that moves money paths, and
   idempotency makes it safe to roll out one till at a time.
6. §5 — override via node.

## 9. What must be tested on the target, not on a bench

- A peer signing in with the internet cable out and the node up — repeatedly,
  past 14 days, by clock manipulation.
- A peer with **both** node and cloud unreachable: must fall to cache, then
  expire, with a message naming which authorities it tried.
- A node cold-started after a month offline: must open the shop.
- A sacked cashier: must be refused by the node, and **must not** then succeed
  from cache.
- A mixed-version branch (one till 0.5.25, one newer) selling simultaneously:
  no duplicates, no parked sales.
- **Failover, end to end** — see §10.6.

---

## 10. Failover — promotion (added 2026-08-09, second clarification)

Owner's addition:

> Data on the server is replicated across all nodes. If the server dies, a node
> can be upgraded to a server and syncing continues — so yes, a single point of
> failure, but with a fast recovery plan and no loss of data.

**Most of this already exists and is better than the register credits.**
`tech:promoteToNode` (`ipcHandlers.ts:1746`) is session-gated, audited
(`role.promote` with from/to), clears `node_url`, starts the listener and returns
the branch secret. `tech:setNodeUrl` probes **before** saving — a wrong address
written blind is a till that silently stops replicating — and doubles as the
demotion path. Distribution (`collectDistribution`, `nodeIngest.ts:605`) fans
every origin's rows to every other peer, and orders carry `_items` and
`_payments` as children (`:641-648`), so a promoted till holds **complete**
orders, not just headers.

So the claim holds. Two gaps stop it holding *completely*, and both are in scope
for this phase because PHASE5 makes the node load-bearing for authentication as
well as for sales.

### 10.1 · A20 · P1 · `branch_staff` must replicate, or failover cannot open the shop

§4a specifies `branch_staff` as **node only**. Under failover that is wrong: a
promoted till would hold every sale in the branch and **no way to authenticate
anyone**. The shop stays shut at exactly the moment the design exists to protect.

`branch_staff` must therefore join `REPLICATED_TABLES`, distributed like any
other row and re-wrapped with each machine's own `safeStorage` on arrival —
DPAPI is machine-bound, so blobs cannot be copied verbatim between tills.

**This forces the §5 security question into the open, and it is the owner's
call.** If every till holds the branch roster, then:

| | Node-only (§5 as written) | Replicated (failover works) |
|---|---|---|
| Stolen peer yields cashier PINs | No | **Yes** |
| Stolen peer yields override PINs | No | **Yes**, unless split (below) |
| Node dies at a remote site | **Shop shut** | Promote and carry on |

**Recommendation — split the roster.** Replicate `pin_hash_enc` to every till,
because sell-side continuity is the whole point. Keep `override_pin_hash_enc`
replicated too, but flagged, so a business that wants the tighter posture can
turn it off and accept that a failover at a fully offline site loses voids and
refunds until internet returns. Default **on**, matching the owner's stated
priority — resilience over hardening — with the trade recorded rather than
discovered later.

The honest framing: **a branch is one trust domain.** Every till already holds
every sale, every customer and every price for the whole branch. Withholding the
roster buys less than it appears to, and the stronger controls are the ones
already there — DPAPI, the branch secret, a typed Windows password — plus one
that is not: **rotate PINs when a terminal goes missing.** That should be a
documented runbook step, not an assumption.

### 10.2 · A21 · P1 · `outbox_cursors` is not keyed by node — rows are stranded on repoint

```
CREATE TABLE IF NOT EXISTS outbox_cursors (
  table_name  TEXT PRIMARY KEY,     -- ← table only. No node identity.
  last_seq    INTEGER NOT NULL DEFAULT 0,
  ...
)
```

A peer records how far it has offered its own rows **as a single number per
table**, with no record of *which node* it offered them to. `peer_cursors` on the
node side is correctly keyed `(device_id, table_name)`; the peer side is not.

Consequence, and it is precisely the failover case:

1. Peer C has offered `orders` up to seq 500 to the old node.
2. The old node distributed only up to seq 430 to the till that is about to be
   promoted, then died.
3. Peer C is repointed at the new node. Its cursor still says 500.
4. **Peer C never re-offers 431–500.** Those sales are on peer C and on a dead
   machine's disk. The new node — the branch's source of truth *and* its sole
   cloud uplink under §3 — never receives them.

Not lost, but absent from the day close, the manager's totals and the cloud
backup, with nothing reporting a gap.

**Fix, in order of preference:**

1. **Reset the outbox cursors in `tech:setNodeUrl` when the node URL actually
   changes.** The peer re-offers everything; ingest is `INSERT OR IGNORE` and
   upsert-by-id, so duplicates are absorbed. Two lines, no schema change, and it
   uses the same property that makes §3's rollout safe.
2. Key the table `(node_id, table_name)`. Cleaner, but a schema change on the
   mechanism that decides whether a field till works — and D6 already notes
   local schema 46–51 went undocumented. Not during a deploy window.

**Prefer 1 now, 2 later if a branch ever runs two nodes.**

### 10.3 · The promoted till's cloud queue

`sync_status` is **deliberately** not replicated (`nodeIngest.ts:47-50`): it
describes one device's relationship with the cloud and means nothing on another
machine. Correct — and it means a promoted till **cannot know which orders
already reached the cloud.**

It does not need to. On promotion, re-enqueue the branch's orders into the new
node's `sync_queue`; `orders.ts:360` short-circuits an already-delivered order to
`200 duplicate` on its `idempotency_key`. Re-pushing is cheap and safe;
under-pushing is a silent shortfall in the backup.

Bound it to orders since the last closed business day rather than all history, so
a long-lived branch does not re-push a year of trade on a role change.

### 10.4 · What promotion does NOT recover

Stated so nobody assumes otherwise:

- Rows the dead node originated but never distributed. Its own sales live only on
  its disk. **Distribution lag is the true RPO** and it is not currently measured
  — worth a "last distributed" age on the tech screen.
- The dead node's `swiftpos.db` remains the only copy of those rows, so **do not
  wipe or re-image a failed node** until it has been read. That belongs in the
  runbook.

### 10.5 · Split brain

`promoteToNode` clears `node_url` and starts serving immediately, with no check
that the old node is actually gone. If the old one is merely unplugged from the
network rather than dead, reconnecting it gives the branch **two nodes**, and
peers pointed at either. Nothing detects this today.

Not urgent while promotion is a tech-session action with a human deciding, but it
should at minimum **warn**: on start, a node that can reach another node on the
same branch should say so loudly.

### 10.6 · Failover test, on real hardware

1. Three tills, one node. Sell on all three.
2. Pull the node's network cable, then power it off mid-service.
3. Promote a peer. Repoint the remaining tills.
4. **Assert every pre-failure sale from every till is present on the new node**
   — this is what A21 breaks.
5. Sign in a cashier on the new node with no internet at all — this is what A20
   breaks.
6. Authorise a void — this is §5.
7. Restore internet. Assert the cloud has each order exactly once.
8. Power the old node back on, still cabled. Observe what happens (§10.5).

---

## 11. REVISION, 2026-08-09 — most of this is already built

Owner's push-back: *"most of the architecture had been built if you read my code
keenly, a good percentage is there."* **Correct, and §§3-5 above over-specify as
a result.** This section is the corrected reading. Where it disagrees with §§3-5,
this section wins.

### 11.1 What already exists

Verified by reading source, not docs:

| Capability | Where | State |
|---|---|---|
| Peer → node replication | `node_queue`, `/node/sync`, `applyPeerRows` | Built, with per-row failure reporting |
| Node → peer distribution | `collectDistribution`, `/node/since`, `peer_cursors` | Built, fans every origin to every peer |
| Orders replicate **complete** | `_items` / `_payments` children, `nodeIngest.ts:641-648` | Built |
| LAN authentication | `X-Node-Secret`, branch scoping on every `/node/*` | Built |
| Promotion / demotion | `tech:promoteToNode`, `tech:setNodeUrl` | Built — session-gated, audited, **probes before saving** |
| Mutation propagation | `emitEvent` + `EVENT_WHITELIST` | Built, with the whitelist as an explicit security boundary |
| Central day close | `branchClose.ts`, `node_instructions`, acks, peer state | Built (Phase 4) |
| Staff sync pipe | `syncEngine:581` pulls `/api/staff` → local `users` | Built |
| `can_authorize` per staff | `shapeStaff`, `staff.ts:85-90` | Built |
| Authorizer list | `GET /api/staff/authorizers` | Built |
| Offline PIN cache, wrapped | `pinCache.ts` | Built 08-08 |
| Credentials wrapped at rest | `tokenStore.ts` | Built 08-08 |
| Order idempotency end to end | `X-Idempotency-Key` → `orders.ts:360` | Built |
| Tech console, snapshots, maintenance | `techService`, `takeSnapshot`, `maintenance_state` | Built |

The hard parts — cursors, ordering, the whitelist boundary, promotion safety,
duplicate suppression — are done, and several are better than the register
credits them.

### 11.2 The gap is ONE thing, in one direction

`REPLICATED_TABLES` is `orders, shifts, float_transactions, expenses,
business_days, events` — **all sales-side.** Everything a till *reads* still
comes from the cloud: `syncEngine:476` pulls the catalogue from
`/api/pos/init`, `:581` pulls staff from `/api/staff`, both against
`_serverUrl`, which is the cloud. `nodeClient` pulls only `/node/since`.

> **The node replicates sales upward and sideways. Nothing flows downward
> through it.**

A17 (auth), A20 (roster for failover) and A24 (catalogue, below) are not four
findings. They are three symptoms of that one sentence. So is the reason a peer
locks out at 14 days: not that the cache is wrong, but that the node is absent
from the read chain entirely.

### 11.3 · A24 · P1 · Reference data goes permanently stale on an offline peer

An offline-forever peer keeps whatever catalogue, prices, settings and staff
roster it held when it last saw the cloud. The node cannot supply any of it.

So at a remote site: a price change reaches the node when *it* has internet and
**never reaches the tills**; a new cashier hired at HQ can never sign in on a
peer; kitchen exclusions and receipt text never update. Two tills at one branch
can quietly sell the same item at different prices, which is exactly the class
`branch_prices` and `local_price_edits` were built to control.

### 11.4 The corrected delta — smaller than §§3-5 implied

**Drop `branch_staff` entirely.** The `users` table already exists locally and is
already synced. The work is columns on it, not a new table:

1. **Add `pin_hash_enc`, `override_pin_hash_enc`, `permissions`, `branch_id`
   to the local `users` table.** `CREATE TABLE IF NOT EXISTS` runs ungated on
   every open (D2's finding), so **no `LOCAL_SCHEMA_VERSION` bump.**
2. **A node-scoped variant of `/api/staff` that does not strip the hashes.**
   `shapeStaff` (`staff.ts:85-90`) already does the stripping in one place, so
   this is a flag on one function, not a new endpoint shape. Guarded as §4b.
3. **`POST /node/verify-pin`** — one more route in a file where seven already
   follow the same `X-Node-Secret` + branch-scope pattern.
4. **Add `users` (and the catalogue tables) to the downstream distribution.**
   This is the real work, and it is an extension of `collectDistribution` rather
   than a new mechanism. It closes A17, A20 and A24 together.
5. **Authority chain in `auth:verifyPin`** — node → cloud → cache (§4d).
6. **Refresh `cached_at` on node contact** (§4e). One line.
7. **Reset outbox cursors in `tech:setNodeUrl`** (A21, §10.2). Two lines.
8. **Node enqueues ingested peer rows into its own `sync_queue`** (§3, A19).
9. **Peer skips the cloud push when `node_url` is set** (§3).

Items 6, 7 and 9 are a handful of lines each. Item 4 is the substantial one, and
it is an extension, not an invention.

### 11.5 What this changes about the security question in §10.1

It sharpens it rather than settling it. Under 11.4, peers hold hashes **only so
they can be promoted** — normal operation asks the node live (§4c). So the
question is exactly: *is instant failover worth every till holding the branch
roster?* The recommendation in §10.1 stands, and so does the runbook item that
does not yet exist: **rotate PINs when a terminal goes missing.**


---

## 12. CORRECTION, 2026-08-10 — the office role

Owner: *"does this involve the view-only node?"* It does, and §4b was wrong.

`deviceConfig.ts:26` — the role is `'till' | 'node' | 'office'`. Office is a
branch server that **cannot sell**: no drawer, no shift, no cash, safe
unattended, and it is not meant to consume an activation seat. The file provides
two helpers precisely so nobody tests the literal:

```ts
export function isNodeRole(role) { return role === 'node' || role === 'office'; }
export function canSell(role)    { return role !== 'office'; }
```

with the warning: *"Comparing against the literal `'node'` anywhere else is how
office machines fall through cracks."* **§4b did exactly that** and would have
refused an office machine the branch roster.

That is backwards. An office box is the *better* holder of the roster: it is the
machine that is safe unattended, which is the entire security argument of §10.1.
A till doubling as a node sits on a counter all day; an office server sits in a
locked back room.

### 12.1 Corrected rules

- Every server-side gate uses **`isNodeRole()`**, never `=== 'node'`.
- **`canSell()` is a separate question.** An office machine authenticates staff
  (§4c) and serves the branch (§3) but must never open a shift or take a
  payment. Do not conflate "may authorise" with "may sell".
- Failover (§10): an office machine is a **promotion target like any other
  peer**, and the preferred one. `branch_staff` replication (A20) must reach it.
- Sales routing (§3): an office node forwards peer sales to the cloud exactly as
  a till-node does. It originates none of its own, which is a simplification —
  its `sync_queue` carries only forwarded rows.

### 12.2 What the server does not know yet

`user_devices` has **no role column** — confirmed against the live dump — and
the till **never reports its role**: the sync headers are `X-Schema-Version`,
`X-Device-Id` and app version, and `device_role` appears in none of them.

So D4 has a first step this document did not identify: **the till must report
its role before the server can store, verify or count one.** Until then, every
registered machine looks identical, and the seat-counting note in
`deviceConfig.ts` (*"the server counts only role='till'"*) cannot be
implemented — it describes an intent, and `grep -rni activation apps/server/src/`
finds no counting anywhere.
