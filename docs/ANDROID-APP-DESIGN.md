# SwiftPOS — Android Tablet App Design

Status: **design proposal, pre-approval.** No code yet. Companion to
`DESKTOP_DESIGN.md`, `BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` and
`PHASE5-NODE-AUTHORITY.md`. Covers an Android POS on consumer tablets (Samsung
class, **not** all-in-one POS terminals), the two deployment setups, printing,
offline behaviour, reconciliation, data retention and manager reporting.

Terminology is deliberately the same as the desktop docs: **node**, **peer**,
**till**, **office**, `node_queue`/`sync_queue`, `idempotency_key`,
enrolment (D4), node-brokered auth (A160). Where a desktop mechanism already
exists, this document reuses it by name rather than inventing a parallel.

---

## 1. The one rule everything hangs off

**The tablet is a leaf peer. It is never a node, never an authority, and never
holds data on behalf of another device.**

- It **sells** (`canSell() === true`, role `till` — never `office`, never `node`).
- It **always syncs up** to a server — a node on the LAN, or the cloud.
- It is **never a promotion target.** It does not serve peers, does not hold the
  branch roster for anyone else, and is excluded from `REPLICATED_TABLES`
  distribution as a *source*. A branch's failover story (PHASE5 §10) does not
  involve tablets.

Everything below follows from that one rule. Its local database is only ever two
things: an **outbound buffer** (sales not yet acked by a server) and a **read
cache** (catalogue + its own recent sales for display). Once a server acks a
sale, the tablet's copy is *cache* — and that single fact decides retention (§8).

This is the same principle PHASE5 §2 states for a desktop peer, applied without
the "can be promoted" clause:

> **A till asks the nearest authority that can answer, and is only bounded when
> it can reach none of them.**

For a tablet the order of authority is **node (LAN) → cloud → local cache**, and
unlike a desktop peer it can never *become* one of those authorities.

---

## 2. The two setups

### Setup 1 — with a node (recommended)

The tablet is another peer on the existing node protocol. The node handles
authority, the central print spool, and the sole cloud uplink. Cloud is optional
but recommended (backup + cross-branch).

```
                         ┌──────────────┐
                         │    CLOUD      │  optional — backup, cross-branch,
                         │ Supabase+API  │  remote reports
                         └──────▲───────┘
                                │  node is the SOLE uplink (PHASE5 §3)
   ═════════════════ BRANCH LAN (cabled backbone) ═══════════════════
                                │
                         ┌──────┴───────┐
                         │  NODE / OFFICE│  always-on · cabled · UPS
                         │  authority    │  tables, bill ranges, staff roster,
                         │  central SPOOL│  central print spool, sync_queue
                         └──┬────┬───┬───┘
     render→POST bytes  ────┘    │   └──── TCP 9100 ──┬─ Kitchen printer (cabled)
     over /node/print (HTTP)     │ /node/since        ├─ Dispatch printer (cabled)
        ┌───────────────┐        │ (state push)       └─ Receipt printer (cabled)
        │  Tablet (peer)│  ...   │
        │  node_queue   │────────┘
        └───────────────┘   speaks the SAME /node/* protocol a desktop peer does
```

### Setup 2 — no node, cloud required

There is no on-prem authority, so **the cloud is the authority when reachable.**
We do not support "no node **and** no cloud" as a steady state — that is only the
temporary degraded window of Setup 2, covered by the local buffer (§6).

```
                    ┌──────────────┐
                    │    CLOUD      │  ← AUTHORITY when online
                    │ Supabase+API  │    bill ranges, table locks, staff,
                    └──────▲───────┘    stock, consolidated reports
    internet (may blip)    │
   ════════════════════════╪═══════ BRANCH LAN ═══════════════════
                           │
     ┌──────────┬──────────┴───────┬──────────┐
 ┌───┴────┐ ┌───┴────┐        ┌────┴───┐  ┌────┴───────┐
 │Tablet 1│ │Tablet 2│  ...   │Tablet N│  │  Network    │
 │ buffer │ │ buffer │        │ buffer │  │  printer    │
 └───┬────┘ └───┬────┘        └───┬────┘  │  (cabled)   │
     └──────────┴─────────────────┴───────┴──▲──────────┘
        each tablet: render + local spool + DIRECT TCP 9100
        collision-free bill ranges · reconcile to cloud on reconnect
```

The tablet is built **once** against two abstract seams — an *authority target*
and a *print target*. Setup 1 points both at the node; Setup 2 points them at the
cloud and the printer directly. Adding a node to a Setup-2 branch later is a
re-point, not a rewrite (§12, pinch point 11).

---

## 3. Authority & discovery

The "which setup am I in" decision is **automatic discovery, not a switch a user
flips.** On boot the tablet walks the chain:

```
boot → node configured/discovered (mDNS or node_url) and reachable?
        ├─ yes → route authority + print through the node          (Setup 1)
        ├─ no, but cloud reachable? → route to cloud + direct print (Setup 2)
        └─ neither → local buffer; reconcile when an authority returns (rare blip)
```

### Auth chain (reuses PHASE5 §4d verbatim in shape)

```
node_url set?    → POST /node/verify-pin
                    answered (ok OR refused) → honour it
                    transport failure        → fall through
cloud reachable? → POST /api/auth/verify-pin
                    answered → honour it; on success, cache verifier
                    transport failure → fall through
local cache      → verifyPinOffline
```

The 08-08 rule holds across both authorities: **fall back only when an authority
could not be *reached*, never when one *answered no*.** A 401 is final wherever
it comes from — otherwise a sacked cashier signs in by turning off Wi-Fi.

### Credential storage — the Android parallel to DPAPI/`safeStorage`

The desktop wraps cached PIN verifiers and tokens with Electron `safeStorage`
(DPAPI). The tablet's equivalent is **Android Keystore-backed
EncryptedSharedPreferences** (or a Keystore-wrapped blob). The honest limit is
identical to PHASE5 §5 and must be stated to a client, not glossed:

> Keystore defeats a copied database, a stolen backup and a pulled flash chip. It
> does **not** defeat code running as the app on an unlocked, rooted device. A
> lost tablet with cached verifiers is a reason to **rotate PINs**, and that is a
> runbook step, not an assumption.

`PIN_CACHE_TTL_DAYS` means, as on desktop, **days since ANY authority was
reached** — refreshed on a node verify or a cloud verify. A tablet that reaches
its node daily never expires; a tablet that has left the building is bounded.

---

## 4. Bill numbering — pre-allocated ranges

A single sequential counter cannot survive multiple tablets going offline. The
mechanism, used in **both** setups because both have an offline window:

- On enrolment/sync, the authority (node or cloud) hands each tablet a **range**
  it owns exclusively — e.g. tablet 3 → `3000–3999`. Topped up on sync at a low
  watermark (say 20% remaining).
- Offline, the tablet issues from its own range. **Two tablets can never
  collide**, online or off.
- **Numbering must never block a sale.** If a range is exhausted while offline,
  the tablet issues a *provisional* uuid receipt and the real number is assigned
  on sync. Size ranges to the promised offline window (200 sales/day × a 5-day
  buffer = a 1000-number range) so exhaustion is a designed-for edge, not a daily
  event.

This is the offline-safety primitive the rest of reconciliation leans on: order
identity is a uuid, the human-facing bill number comes from a private range, and
neither can conflict across devices.

---

## 5. Printing

### 5.1 One renderer, two last hops

The `shared/printing` renderer is **pure and reused verbatim** — it already runs
in a browser for the settings preview. Only `escpos.ts` changes (`Buffer` →
`Uint8Array`). What differs between setups is only the **last hop**:

```
            order ──▶ shared/printing renderer ──▶ ESC/POS bytes
                                                       │
                        ┌──────────────────────────────┴───────────────┐
        Setup 1: POST bytes to node  /node/print   Setup 2: native plugin
        (node's central spool sends over TCP)       sends direct (TCP or BT)
```

Setup 1's `/node/print` is **the existing `apps/print-server` contract**
(`{ target, data(base64) }`) moved onto the node, feeding the SQLite spool with
retry/backoff already built in `printWorker.ts`. The node becomes the single
print authority for the branch.

### 5.2 Why network printing should go through the node (Setup 1)

This is what makes "one printer, several tablets" reliable — which is the whole
reason for cabled network printers:

- **One queue per printer.** Port 9100 is single-connection; a central spool
  serialises. Direct-from-tablet races (pinch point 3).
- **Catch-up survives the creating tablet leaving.** A waiter fires a KOT, the
  kitchen printer is jammed, the waiter walks off — the node still delivers it.
  A per-tablet spool dies when the tablet sleeps (pinch point 4).
- **Branch-wide "printer down" visibility.**

### 5.3 Direct print (Setup 2) and Bluetooth fallback

- **Setup 2, network printer:** tablet renders and prints **direct to the printer
  IP** via a native TCP plugin, backed by its own **persistent local spool**
  (Capacitor SQLite, same retry logic). Accept the two losses in 5.2 — they are
  the honest cost of no node.
- **Bluetooth fallback (no network at all):** tablet → its **own paired** printer
  via the native BT plugin. BT is point-to-point, so it is inherently
  one-printer-per-tablet and has no shared spool. Fine as a fallback; do not
  pretend it shares.

### 5.4 Break-glass

Build the native TCP plugin **even in Setup 1**. If the node is ever down, a
tablet can print direct to the printer IP as an emergency path (pinch point 5).
The node route is the optimisation; direct is the floor.

### 5.5 The rule that must not be broken

**Never fall back to Android's `PrintManager` / `WebView.print()`.** That
rasterises to a bitmap — exactly the GDI-style slow, mangled-column path
`transport.ts` was written to escape. Raw ESC/POS bytes, end to end, always.

---

## 6. Offline tier — store-and-forward, not a full offline till

Name the tier precisely, because it is a 3× cost fork:

| Tier | Works offline | Cost |
|---|---|---|
| 0 — online-only | nothing; blip = can't sell | cheapest |
| **1 — store-and-forward** ✅ | keep taking orders, queue, print, reconcile | moderate |
| 2 — full offline till | everything incl. shared state offline | expensive — this is what a **node** gives the branch; do not rebuild it per tablet |

Setup-2 tablets are **Tier 1**. The local DB is a **buffer, not a mirror**:
`sales`, `order_lines`, `payments`, `bill_range_cursor`, `sync_queue`, plus a
cached `catalogue` for reads. It does **not** carry the reports engine, other
tablets' sales, or branch-wide aggregates — those need a convergence point (§9,
§11). "Build offline just in case" means Tier 1, and only Tier 1.

---

## 7. Reconciliation — when the buffer flushes

Most of it is trivially safe **because** of §4: append-only orders with uuids and
private bill ranges cannot conflict. Only optimistically-touched shared state
needs rules.

### Reconnect handshake

1. **Auth refresh** (node/cloud — A160 node-brokered).
2. **Pull:** server version/clock, updated catalogue, **bill-range top-up**,
   current table + held-order state.
3. **Push:** replay `sync_queue` **in creation order**, idempotent upserts keyed
   by order uuid / `idempotency_key`.
4. **Resolve:** auto where possible; prompt the human only where a sale's
   *linkage* is contested.
5. **Mark acked rows `synced`** → now prunable (§8).

### Conflict matrix

| What the tablet did offline | Conflicts? | Resolution |
|---|---|---|
| Completed / paid sale | No | Idempotent upsert by uuid. **Sale never lost.** ~90% of volume. |
| Bill range low / exhausted | No | Top up on reconnect; provisional uuid receipt if it ran out (§4). Never blocks a sale. |
| Stock decrement | Soft | Replay as **deltas, not absolutes**, so they compose across devices. Oversell is reported as variance, never un-sold. |
| **Seated an open dine-in table** | **Yes** (the only real one) | Server wins the *table*; tablet **keeps the order**. Re-parent: "Order #3012 was on Table 5, now occupied — reassign?" Only linkage renegotiated. |
| Held order created offline | No | uuid is device-unique; nobody else could edit it. Surfaces late, upserts cleanly. |
| Void / refund | No | Append-only event referencing a uuid. Ordered replay; server tolerates in-batch dependency (void arriving with its order). |

### Governing principles

- Orders are facts — replay idempotently, **never drop a sale.**
- **Deltas, not absolutes** for stock.
- Server wins contested state, but the **sale is always preserved** and the human
  is asked.
- Replay in creation order; server absorbs in-batch dependencies.
- Acked = cache = prunable.
- **Never trust the tablet's wall clock** for newest-wins. Anchor to
  server time on sync, the same monotonic approach the desktop "tech clock-floor"
  uses (pinch point 12).

---

## 8. Data retention — two clocks

Direct answer: **not forever.**

- **Unsynced data → kept forever, until acked.** Sacred. Nothing in `sync_queue`
  is auto-deleted on age; only a server ack releases it. This is unacknowledged
  money.
- **Synced data → rolling window, default ~30 days, configurable.** Once the
  server has it, the tablet only needs a local copy for **reprints** and
  **on-device display** (§9). Prune synced rows older than the window; they live
  on the server, fetchable when online.

The two conditions are **independent**: prune *synced AND older than N days* —
never an unsynced row regardless of age.

Why bounded: consumer tablets have limited storage and SQLite degrades with an
ever-growing sales+lines+payments table; and it is pointless, the server is the
truth. Why not tiny: reprints and shift/day-close need a few days of runway and
"refetch from cloud" is unreliable on flaky internet. **Size the window to the
offline independence promised.** Honest limit: **offline you cannot reprint a
receipt older than the local window.** Reprint is local-first, server-fallback.

---

## 9. Manager on the tablet — two features, not one

Yes, a manager can log in and view sales — but split it, or a single till's
numbers get mistaken for the branch:

| View | Scope | Offline? | Source |
|---|---|---|---|
| **"This device"** | what *this tablet* rang up (today/shift) | ✅ always | local DB (within retention window) |
| **"Branch (live)"** | consolidated across all tablets | ❌ needs connection | convergence point (node/cloud) |

- **Device report** is a pure local read — device X/Z, cash-up, "how's this till
  doing." This respects §1: the tablet only ever reports *itself* locally.
  Offline branch reporting is **not offered**, for the same reason consolidated
  reporting needs a convergence point (§11) — a tablet aggregating peers would be
  a node, which it must never be.
- **Branch report** pulls from node/cloud. Offline, show "needs connection — last
  synced 14:32," never a partial number dressed as a total.

Auth reuses the cached-verifier path (§3), gated by a permission key (the
existing A59 till-permission-keys / `permission-model.md`), with auto-lock on
timeout because this exposes financials on a shared-floor device. The device
view can only reach as far as the **retention window** (§8) — set the window ≥ the
longest period a manager reviews on-device.

---

## 10. Payment & the Daraja seam

Payment is the customer's responsibility for v1; we leave room for Daraja.
Concretely: a **payment record with `method` + `status`**, where
`method ∈ {cash, card, mpesa_manual, other}` now and `mpesa_stk` later.

Honest caveat to bank now: **M-Pesa STK is inherently online-only, even after
Daraja lands** — the STK push and its `MPESA_CALLBACK_URL` both need internet and
a server. So offline, M-Pesa always degrades to `mpesa_manual` (customer pays on
their phone, cashier marks it paid). Design the payment UI so that fallback is a
first-class path, not a bolt-on (pinch point 10).

---

## 11. Consolidated reporting — the value ladder (client honesty)

Consolidated reporting needs a **convergence point** where all tablets' sales
meet. This is the table to show a client, and it doubles as a sales ladder:

| Config | Consolidated branch report | Cross-branch / remote | Needs online licence? |
|---|---|---|---|
| Tablets only, no node | ❌ per-tablet only | ❌ | — |
| Tablets → **cloud** | ✅ | ✅ | **Yes** |
| Tablets → **node** | ✅ (on-prem) | ❌ (until cloud added) | **No** |
| Tablets → node → cloud | ✅ | ✅ | Yes |

The row that sells the node: **it gives consolidated branch reports with zero
online licence**, because it runs the same server schema and is the convergence
point on-prem. Even a Setup-2 branch with no live licence gets consolidated
reports *with a lag* if tablets occasionally reach the internet — so "online
licence" is the honest gate for **real-time** consolidation, not for its
existence. **Be upfront: several tablets with no node and no licence get only
per-device reports.**

---

## 12. Pinch points

The places this bites, stated plainly so nobody discovers them on a counter.

1. **Table double-seating offline.** The one unsolvable shared-state conflict
   without a live authority. Server wins the table, the sale is preserved, the
   human is prompted (§7). A node eliminates it; Setup 2 offline cannot.
2. **Bill-range exhaustion offline.** Mitigated by provisional numbering (§4) —
   but if ranges are sized too small for the real offline window, provisional
   receipts become common and confusing. Size them generously.
3. **Port 9100 is single-connection.** Several tablets printing to one network
   printer contend; the loser's connection is refused. Central node spool
   serialises (Setup 1); direct print (Setup 2) needs **jittered connect-retry**
   (50–500 ms). Tolerable because jobs are sub-KB and sub-second.
4. **A queued job dies with the tablet.** Setup 2's per-tablet spool loses a job
   if that tablet sleeps/OOM-dies before the printer recovers. Only a **node
   spool** owns the job independently of the creator. This is a real Setup-2
   reliability gap, not a bug.
5. **Node is a SPOF for printing in Setup 1.** Mitigated by the §5.4 break-glass
   direct path — but that path loses the shared queue until the node returns.
6. **Android background execution / Doze.** The app process gets killed and
   background sockets throttled. A spool that must retry after the cashier
   switches apps needs a **foreground service** (with its own notification and a
   Play Store justification). Without it, queued tickets silently stall.
7. **Bluetooth is two protocols and a chunking trap.** SPP (RFCOMM) vs BLE are
   different APIs; BLE needs the receipt **chunked and paced** to MTU or the
   printer prints a garbled half. Permissions differ by OS version
   (`BLUETOOTH_CONNECT`/`SCAN` on 12+, location on older). Budget real
   per-device testing.
8. **Consumer-tablet storage growth.** Why retention is bounded (§8). An
   unbounded sales table degrades SQLite over months on a device you can't expand.
9. **Keystore's honest limit.** Like DPAPI, it defeats a copied DB but not code
   running as the app on a rooted device (§3). A lost tablet ⇒ **rotate PINs**.
10. **Offline M-Pesa is impossible.** STK needs internet + a server callback;
    always degrades to manual (§10). Do not promise offline M-Pesa.
11. **The seam abstraction is load-bearing.** "Node ↔ cloud toggle for free"
    only holds if the tablet talks to an *authority target* and a *print target*,
    never a hardcoded cloud URL or printer IP. Hardcode either and the node
    upgrade becomes a rewrite. This is a discipline, enforced in review.
12. **Clock trust.** A tablet's wall clock can be wrong or hostile. Any
    newest-wins or "who seated first" decision must use **server-anchored** time,
    never the device clock — the same rule the desktop applies to price sync.
13. **Enrolment & seat counting (D4).** A tablet must **enrol** and **report its
    role** before a server can hand it the roster or a bill range, or count its
    activation seat. PHASE5 §12.2 records that a till does not report its role
    yet — the Android peer must, and it consumes a `role='till'` seat
    (`canSell() === true`). This is a prerequisite, not a nicety.
14. **Mixed-fleet schema skew.** An Android peer and desktop peers at one branch
    must speak the same `/node/*` protocol and `X-Schema-Version`. A tablet on a
    newer schema than its node is the same class of problem as a mixed-version
    desktop branch (PHASE5 §9) — handle it with the same idempotent, version-aware
    handshake.

---

## 13. What reuses existing code

| Reused nearly as-is | Genuinely new |
|---|---|
| `shared/printing` renderer (`Buffer`→`Uint8Array` only) | Capacitor Android shell around the React POS UI |
| `/node/*` peer protocol, `node_queue`, idempotency, `/node/verify-pin` | **Native transport plugin: TCP + Bluetooth** (the only new printing code) |
| `apps/print-server` `{target,data}` contract → the node's `/node/print` | Bill-range allocator (server-side) + tablet range cursor |
| SQLite print spool + retry classification (`printWorker.ts`, `transport.ts`) | Foreground service for the tablet spool (Doze) |
| Auth chain node→cloud→cache, PIN cache TTL semantics (PHASE5 §4) | Keystore/EncryptedSharedPreferences (replaces `safeStorage`) |
| Enrolment D4, node-brokered token refresh A160 | Tablet Tier-1 buffer + reconciliation client |
| Manager report shapes, permission keys (A59) | "This device" vs "Branch" report split in the app |

The renderer surviving intact is the win: we re-solve **transport**, which is
bounded, not **layout**, where the subtle bugs live.

---

## 14. What must be tested on real hardware, not a bench

- Two tablets printing to **one** network printer at the same instant — no lost
  job, no garble (pinch 3).
- A tablet that queues a KOT, then is **backgrounded / screen-locked** for
  minutes — the job must still print when foregrounded (pinch 6).
- A Bluetooth receipt on a **BLE** printer — full, not truncated (pinch 7).
- A tablet offline past a shift, then reconnecting — every sale lands exactly
  once; a contested table prompts, never silently drops (pinch 1, §7).
- Bill-range **exhaustion** offline — a sale still completes on a provisional
  number, reconciles to a real one (pinch 2).
- Node down mid-service in Setup 1 — tablets fall to **break-glass direct print**
  and keep selling (pinch 5).
- A **lost tablet** — cached verifiers do not open the shop after a PIN rotation
  (pinch 9).
- Manager "This device" vs "Branch" — the branch view refuses cleanly offline,
  the device view works (§9).

---

## 15. Decisions recorded (do not relitigate)

- **The tablet is a leaf peer.** Never a node, never promoted, never holds data
  for another device. Its DB is buffer + cache only.
- **Two setups, one build.** Node (Setup 1, recommended) or cloud (Setup 2,
  cloud required). No "node-less and cloud-less" steady state.
- **Discovery is automatic:** node → cloud → local buffer. Not a manual switch.
- **Bill numbers come from pre-allocated ranges.** Numbering never blocks a sale.
- **Setup-2 offline is Tier 1** (store-and-forward), not a full offline till.
- **Printing:** one renderer; node central spool in Setup 1, direct + local spool
  in Setup 2, BT as fallback, direct as break-glass. **Never** Android
  `PrintManager`.
- **Retention:** unsynced forever, synced ~30-day rolling window, independent
  conditions.
- **Manager view:** device-scoped offline, branch-scoped online.
- **Payment:** record with `method`+`status`; M-Pesa STK is online-only, always.
- **Fall back on transport failure only, never on a rejection.** (Unchanged from
  PHASE5, now across node and cloud from a tablet.)
- **Server-anchored time** for any conflict resolution. Never the device clock.

---

## Open questions (need a call before build)

1. **Node = existing desktop, or a dedicated office box?** Support both, or pick
   one per branch shape? (Affects whether Setup 1 needs new hardware.)
2. **How bad is the venue internet, really?** Solid → Setup 2 is cheap (thin
   cloud client). Flaky → the Tier-1 buffer is load-bearing and worth its cost.
   The whole complexity curve rides on this.
3. **Range size policy.** Fixed block per tablet, or scaled to observed daily
   volume? Watermark for top-up?
4. **Retention window default** — 30 days proposed. Does any client review more
   than a month on-device?
5. **Foreground-service posture** — always-on spool service (reliable, battery +
   Play scrutiny) vs on-app-open only (simpler, loses deep-background retry)?
