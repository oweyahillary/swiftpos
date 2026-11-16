# Phase 2 & 3 — implementation design, 3 August 2026

> **⚠ STATUS CORRECTION, 2026-08-10 (register A5).**
> **This document still said "For approval before code" a week after the code
> shipped.** Phase 2a landed in `5ef0f08` (branch distribution, replicated star,
> local schema v47) and Phase 2b+2c in `fee91cc` (mutation events, bounded
> replicas, nightly snapshots, v49). Phase 4's central day close landed in
> `40f53ac` (v46).
>
> **Read this as a record of what was decided and built, not as a proposal.**
> Where the shipped behaviour and this document disagree, the code is the
> authority and the disagreement is a finding worth filing.
>
> Known drift already recorded elsewhere: the node is a **replica, not a relay**
> (A19), reference data does not flow downstream to an offline peer (A24), and
> the node cannot authorise anybody (A17). None of those limits are stated below,
> because they were discovered by running it.

For approval before code. One amendment to BRANCH-SERVER-PLAN.md, three open
decisions resolved, mitigations for the consequences Phase 2 raises.

---

## The amendment: replicated star, not true mesh

The plan's Phase 2 says "any till can serve any other." Implementing that
literally means **every till runs an HTTP listener** — a firewall rule per
machine, a bigger attack surface per machine, and it abandons the rule that has
held since Phase 1: peers are outbound-only.

The amendment: **distribution flows through the node, but every till holds the
full branch picture.**

    T2 ──push──▶ NODE ◀──push── T3
    T2 ◀──pull── NODE ──pull──▶ T3      (each till pulls the OTHERS' rows)

- Tills push their own rows to the node (exists today).
- On the same poll they already make every 15s, tills **pull every other
  device's rows** from the node: `GET /node/since` with per-peer cursors —
  the cursor machinery (seq, device_seq, peer_cursors) already exists from
  Phase 1 and is reused unchanged.
- Origin `device_id` preserved end to end; own-row scoping already keeps
  replicas out of every push path and the sell gate (Phase 1's whole point).

**What this keeps from true mesh:** three copies of every sale on the LAN
within seconds; failover = promote any till by flipping its role flag (it
already has the data AND the server code — the listener just isn't running);
the office PC stays optional.

**What it gives up:** resilience only in the case where the node AND a second
till die in the same window before the survivor pulled. Judged acceptable —
that window is ≤15 seconds of one till's sales.

**Promotion when the node dies mid-day:** any till can be promoted from its
Tech screen (role flag + start listener). Peers repoint `node_url` (60 seconds
each, tech-guided). The promoted node serves what it holds and — decision 3
below — says so.

---

## Phase 2 scope, in build order

### 2a. Distribution (`/node/since`) — ~2 days
- `GET /node/since` (node): body of per-table, per-device cursors → batches of
  other devices' rows, `_items`/`_payments` riding inside orders as today.
- Peer applies via the existing `applyPeerRows` — same refusals, same
  idempotency, same `'peer'` stamping. New code is the pull loop and cursor
  bookkeeping, not a second ingest path.

### 2b. Mutations as events — ~2 days
The append-only design's known gap: a closed shift/day/voided order never
updates on replicas. Fixed the way the plan prescribes — **events, not
UPDATEs**:
- New replicated table `events`: `id, seq, device_id, kind, target_id, payload,
  created_at`. Kinds at launch: `shift_closed`, `day_closed`, `order_voided`.
- Only the ORIGIN device may emit an event about its own row (enforced at
  ingest, same rule as row attribution).
- Appliers are idempotent UPDATE-by-id, applied in seq order on every replica.
- This also upgrades the Close Branch screen: peer day/drawer state stops
  being poll-only and becomes replica-accurate.

### 2c. Bounded replicas + archive tier — ~2 days
Replicas are **rolling caches, not archives**: each till keeps its OWN full
history but prunes *other devices'* rows older than **90 days** — and only
rows **confirmed held by the archive tier**. Who the archive is depends on
deployment:
- **Online client:** archive = cloud. Prune condition: cloud-synced.
- **Fully offline client:** archive = the NODE, which never prunes anything —
  it is the system of record. Peers prune on node-acked (Phase 1 machinery).
A row no archive has confirmed is never pruned by anyone: a broken archive
means disks grow, not data dies. Growth is the safe failure.

**Offline clients get a backup job** (ships inside 2c): nightly encrypted
snapshot from the node to a second location (USB / second disk / NAS),
N-snapshot retention, restore procedure in the RUNBOOK, and "last backup:
when, where" on the manager screen so a dead backup drive is seen, not
discovered during a disaster. Sales guidance: offline clients should run the
node on a physically secured office machine (Phase 3 role) — a till doubling
as the archive is a till someone can walk out with.
- Bounds what a stolen till exposes: one quarter, one branch — not the
  business's life.
- Bounds disk: non-issue at any realistic volume.
- The DPA answer becomes one sentence: "each terminal holds an encrypted,
  90-day operational replica; the system of record is the cloud."

### 2d. Phase 7 pulled forward — ~2.5 days
Encryption at rest ships **with** Phase 2, not five phases later. Every till
holding branch data is precisely when the open .db stops being acceptable.

**Cipher:** SQLCipher via better-sqlite3-multiple-ciphers (drop-in for the
driver). Existing plaintext DBs migrate in place on first boot
(sqlcipher_export → atomic swap → .bak kept until verified).

**Key design — one data key, wrapped twice.** The whole design is key
RECOVERY, because encryption that bricks your own backups is worse than none:
- Per-till random 256-bit DEK; the database only ever knows the DEK.
- Wrap 1: DPAPI / Electron safeStorage, machine+user bound → the till boots
  unattended. No PIN-to-start; a POS that needs a human to boot is not a POS.
- Wrap 2: a RECOVERY CODE (BitLocker-style), DEK wrapped under an
  scrypt-derived key, shown once at install for the owner's safe. Online
  clients additionally escrow the wrapped DEK to the cloud (owner-dashboard
  retrievable). The nightly snapshot carries the recovery-wrapped DEK blob
  beside the encrypted .db — machine dies → new hardware → restore → recovery
  code → trading. Works identically with zero internet.

**Honest limits, stated in client-facing material:** defeats the copied .db,
the stolen disk, the stolen till. Does NOT defeat code running as the app
user on that machine — nothing at this layer does; that is BitLocker +
Windows accounts (Phase 0). Key rotation deferred to Phase 6 (PRAGMA rekey
makes it cheap there).

**Phase 2 total: ~8.5 days including archive/backup and encryption.**

---

## Phase 3 — the `office` role — ~2-3 days

Same installer, third role at setup: `till | node | office`.

- **office = node that cannot sell.** Runs the listener, ingest, distribution,
  Close Branch, reports, menu/price/stock management. No POS screen, no
  drawer, no shift, no cash — safe unattended, and it does not consume an
  activation seat (the server counts only `role='till'` against the quota,
  which slots straight into the Model B licensing decision).
- Where a client has a proper desktop: office PC is the node. Where it's a
  laptop: T1 stays node, PC installs as `office` in view-only stance (no
  listener). Installer supports both; recommendation printed at setup.
- Replacing the node machine = repoint `node_url` on each till (documented,
  60s each). mDNS discovery is deliberately NOT in scope — magic discovery on
  shop LANs is a support burden dressed as a feature.

---

## The three open decisions — resolved

1. **Every till holds branch-wide data?** YES — made acceptable by 2c
   (90-day bound) + 2d (encrypted at rest) + Phase 0 BitLocker. Exposure of a
   stolen till: one encrypted quarter of one branch.
2. **Office PC vs T1 as node?** Per client, installer supports both (above).
3. **Promotion with missing data?** The promoted node serves what it holds and
   **names the gap**: any report spanning a period where a peer's cursor shows
   holes prints "consolidated from <date>; T3 last reported <time>" — the DSR
   staleness rule, generalised. Background repair pulls the missing rows from
   the cloud when internet returns. Visibly partial, never invisibly partial.

---

## Order of work

    Phase 2a  distribution        2 days
    Phase 2b  events              2 days
    Phase 2c  pruning             1 day
    Phase 2d  encryption          2 days   (Phase 7, pulled forward)
    Phase 3   office role         2-3 days
    ——— then ———
    Activation codes              1 day    (jumps queue if an install books)
    Phase 5   heartbeat + gate    3 days   (now safe: failover is real)
    Phase 6   secret rotation     3 days

Gate unchanged: Phase 2a does not start until the branch has traded a full day
and Phase 4 has closed it centrally once on real hardware.
