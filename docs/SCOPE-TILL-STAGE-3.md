# SCOPE — Till Stage 3: the Android tablet as a branch-server peer

**Register:** Till stage 3 (per `docs/ANDROID-APP-DESIGN.md` §5, lines 496–506). Android launch = v2.0.0 (see version plan).
**Status of this doc:** **APPROVED by owner 2026-11-12** — ship slices A–D as Stage 3 v1; shared tables = **Stage 3b**, decided and built on its own; A410 treated as a *preference* (keep the tablet's cloud fallback), not a lock-in. Build not yet started.
**One-line summary:** the branch server and its whole `/node/*` protocol are **already built and in production on the desktop**. Stage 3 is **not** "build a branch server" — it is **wiring the Android tablet to consume the server the desktop already talks to**, so a mixed branch (desktop tills + tablets) runs a busy evening on one internet connection, shares tables, and keeps selling if the cloud drops.

---

## 1. The headline finding (why this is smaller than it sounds)

A three-part code survey (branch-server machinery, the Android client seam, the server-side shared-state model) found that **almost everything Stage 3 lists already exists** — just not consumed by the tablet:

- The **branch server** lives in `apps/desktop` (Electron in role `node`/`office`), not the cloud. It is a mature `/node/*` HTTP+TLS server (~27 routes, `apps/desktop/src/main/nodeServer.ts`), battle-hardened across dozens of register items with a large test suite.
- The **desktop peer client** is a complete, proven reference implementation of consuming that server (`nodeClient.ts`, `nodeIngest.ts`, `cloudGateway.ts`, `nodeHealth.ts`).
- The **Android tablet already does two of the `/node/*` jobs** — it **joins** through the server (`apps/android/src/shop/branchServer.ts`) and **prints** through it (`/node/print`, shipped in Stage 1).

What is **not** present is the tablet consuming the rest of `/node/*`: selling/sync, PIN verify, session refresh, and the cloud gateway. And **one capability is genuinely unbuilt everywhere** — cross-device shared tables / held orders (its core library exists but is unwired; see §5).

So Stage 3 ≈ **make the tablet a first-class branch peer, the way the desktop already is.** The server and the reference client are proven; the risk is concentrated in the tablet wiring and one new feature.

---

## 2. What already exists — do NOT re-scope

| Capability | Branch server (desktop `node`) | Desktop peer client | Android tablet |
|---|---|---|---|
| `/node/*` HTTP+TLS server, UDP discovery beacon (4199), join/Allow pairing (A427) | **BUILT** `nodeServer.ts`, `serverBeacon.ts`, `serverJoin.ts` | n/a | n/a |
| Join through the server | BUILT | BUILT `ipc/join.ts` | **BUILT** `branchServer.ts` (Stage 1) |
| Print through the server `/node/print` (own stations + SQLite spool) | BUILT `nodePrintRelay.ts`, `print/printWorker.ts` | BUILT | **BUILT** (Stage 1, "server-first else direct") |
| Cloud gateway `/node/cloud/api/*` — server is the sole uplink (A410) | BUILT `nodeGateway.ts` | BUILT `cloudGateway.ts` | **NOT PRESENT** |
| Sell/sync through server `/node/sync` + `/node/since` distribution | BUILT | BUILT `nodeIngest.ts` | **NOT PRESENT** |
| PIN verify `/node/verify-pin` vs branch roster (A426) | BUILT `branchStaff.ts` | BUILT | **NOT PRESENT** (tablet does cloud `/auth/verify-pin` + Stage-2 offline bcrypt) |
| Session refresh via server `/node/refresh` (A160) | BUILT | BUILT | **NOT PRESENT** |
| `/node/*` protocol version negotiation (integer, not header) | BUILT `nodeHealth.ts` | BUILT | **NOT PRESENT** |
| Reference snapshot (catalogue, prices, **tables**, pumps, print routing) `/node/reference` | BUILT | BUILT | **NOT PRESENT** |
| Cross-device **shared open tables / held orders** | core **BUILT but UNWIRED** `nodeTabs.ts` (atomic claim, 90s lease, unit-tested); **no `/node/tabs` route; no caller** | — | **NOT PRESENT** |

Server-side foundations already proven (shared by any peer, tablet included):
- Idempotent offline push (`apps/server/src/routes/sync.ts` `POST /api/sync/push`) + bulk backfill (`backfill.ts`), with per-row conflict parking.
- Per-device order numbers `terminal_code--<n>` from a **local** counter, cloud only validates uniqueness per (business, branch, device) — **no central dispenser** (`apps/desktop/src/main/billNumber.ts`, migration 94). A181/A183.
- Device registry + roles `till | node | office`, **one-server-per-branch** enforced (`deviceRegistry.ts`, `deviceRole.ts`, `confirmServingRole`).
- Session refresh handshake (A477 SYN/SYN-ACK/ACK) + machine binding (`auth.ts`, `refreshHandshake.ts`).
- WebSocket "changed" doorbell held by the branch server, peers take changes over LAN (`liveHub.ts`, A531).

---

## 3. What Stage 3 actually is — the tablet work

Everything funnels through **one base host** on the tablet: `apps/android/src/config.ts:12` `API_URL`, used by the native client (`cloud/client.ts`), the web POS (`lib/api.ts` `api`), and the web POS `posApi`. The file's own header already earmarks Stage 3: *"adds the branch server as a second authority target beside it."*

The whole offline machinery already sits behind **one `window.fetch` wrap** (`apps/android/src/shop/offlineWrites.ts:88,111`) whose decision today is binary: **online → cloud; offline → buffer-or-refuse.** Stage 3 turns that into a three-way: **branch server (if joined & reachable) → cloud → buffer.** This is the exact shape printing already uses ("server-first, else direct" — `printing.ts:46`, `printRouted.ts:108`), so there is a proven in-repo pattern to copy.

**One real wrinkle the survey flagged:** the `window.fetch` seam covers the web-POS calls (`api` + `posApi`) but **native calls bypass it** — till-token refresh, PIN verify and join go through `cloud/client.ts` (CapacitorHttp), not `window.fetch`. So "route to the branch server" is **not** a single interception point; it is the fetch seam **plus** `tillSession.ts` / `pinSignIn.ts` / `replay.ts`. The credential for all of it already exists: the `ServerLink` ({url, cert, securityCode, nodeSecret, deviceToken}) saved to Keystore at join (`branchServer.ts:26`), today used only for printing.

---

## 4. Recommended build — slices, each device-testable, in order

**Governing principle: the branch transport engages only when a `ServerLink` is saved.** A tablet joined by cloud enrolment code (no branch server on the LAN) keeps Stage 1/2 behaviour **byte-for-byte unchanged** — Stage 3 is additive and keeps its blast radius off the common single-tablet case.

### Slice A — Branch transport + health/protocol handshake  *(large — the foundation)*
Add one helper that, when a `ServerLink` is present, directs `/api/*` traffic to the server's `/node/cloud/api/*` gateway (A410), with a `/node/health` protocol check (`nodeHealth` integer compare — refuse to talk to an incompatible server, fall back to cloud) and transport-failure fallback to cloud-direct. Wire it into **both** interception points: the `offlineWrites` fetch seam (web POS) and `cloud/client.ts` (native). Mirrors desktop `cloudGateway.ts` + `nodeClient.ts`.
*Done when:* a joined tablet's ordinary traffic provably flows through the server's gateway, and pulling the server's plug silently falls back to the cloud.

### Slice B — Sell & sync through the server  *(medium–large)* — **BUILT (push) 2026-11-12, see `docs/BUILD-TILL-STAGE-3B.md`; `/node/since` pull deferred by design**
Point the online write path and the Stage-2 replay sender at the server: sales ingest via `/node/sync` (the server relays to cloud, A19) and the tablet pulls peers' rows via `/node/since`. The offline buffer still backs a total outage. Touches `offlineWrites.ts:111`, `replay.ts:17,85` (`cloudUrl`/`cloudSender`).
*Done when:* a tablet sells with the branch online but its **own** internet off; sales reach the cloud via the server; two devices' completed orders aggregate at the branch.

### Slice C — PIN verify through the server  *(small–medium)*
When a `ServerLink` is present and reachable, verify the cashier PIN against the branch roster via `/node/verify-pin` (503 → fall back to cloud, then to the Stage-2 offline bcrypt cache). Reuses the roster the server already keeps (`branchStaff.ts`, A426). Touches `pinSignIn.ts`.
*Done when:* a cashier signs in on the tablet with the cloud unreachable but the branch server up.

### Slice D — Session refresh through the server (A160)  *(medium)*
Broker the till token refresh through `/node/refresh` when a server is present, so a tablet past its refresh window recovers from the branch instead of needing a technician + cloud. Touches `tillSession.ts` (`renew`/`signBackIn`). This realises the A160 vision (`docs/SCOPE-node-authority-A160.md`) for the tablet.
*Done when:* a tablet offline-from-the-cloud past its token window keeps working via the server with no re-enrolment.

### Slice E — Shared tables / held orders across devices  *(large — the one genuinely new build; needs an owner decision)*
See §5. Recommend treating this as **Stage 3b**, decided and built on its own, not folded into A–D.

**Recommended cut for "Stage 3 done":** A + B + C + D deliver the core promise — *one internet uplink for the branch, the tablet a true peer.* E (shared tables) is the headline waiter-experience feature but carries a concurrency decision and a two-till test rig, so it earns its own slice.

---

## 5. Shared tables / held orders — the one real new build

Today **no two devices see each other's open tabs** — not via the cloud (held orders are deliberately local-only, out of the sync queue — `apps/desktop/src/renderer/lib/heldOrders.ts`), not via the branch server (the routes aren't wired). The floor `tables` table is **config only** (name/shape/zone), it carries no occupancy.

**But the hard part is already written:** `apps/desktop/src/main/nodeTabs.ts` implements the full node-authoritative core — `node_tabs` schema, `registerTab`, `listOpenTabs`, atomic `claimTab` (90-second lease, 409 on double-claim), steal/clear audit — and it is **unit-tested**. It just has **no `/node/tabs` route and no caller**. The design (`docs/HELD-ORDERS-CROSS-TILL-D9.md`, rated P3) says "nothing built," which is now stale: the primitive exists.

So Stage 3b ≈ expose `nodeTabs` as `/node/tabs` + `/node/tabs/:id/claim` on the server, and consume it from **both** the desktop renderer and the Android POS. **Owner decisions needed first** (D9 doc): the concurrency rule (lease length, what a "steal" shows the other waiter), and a two-till + two-tablet rig to verify no tab is ever sold twice.

---

## 6. Open decisions for the owner

1. ~~**Scope of "Stage 3 v1":** ship A–D first, shared tables as a separate **Stage 3b**.~~ **DECIDED 2026-11-12: yes — A–D first, 3b on its own.**
2. **Shared tables concurrency model** (only when 3b starts): lease length and the "someone else grabbed this tab" UX. Blocks E, nothing else. *(Open — deferred to 3b.)*
3. ~~**Sole uplink vs cloud fallback.**~~ **DECIDED 2026-11-12: A410 as a preference — the tablet keeps a cloud-direct fallback on transport failure, like the desktop peer and printing already do.**
4. **Test rig (OPEN — needed before Slice B device-test):** Stage 3 cannot be verified on one device. It needs a desktop in `node` role + at least one tablet (ideally two tablets + a desktop till) on a LAN. Slices build + headless-test without it; device verification does not. Confirm the hardware exists.

---

## 7. Test plan (hardware — from the design doc §5)

- A desktop server with two desktop tills and two tablets: tables, held orders and printing across all.
- Server off mid-service → tablets keep selling and catch up.
- Internet down → the whole branch keeps working.
- **Done when:** a mixed branch runs a busy evening on one server and the cloud's figures match afterwards.

## 8. Out of scope (later stages)

- Foreground print service, Bluetooth printers (classic + BLE), break-glass printing, kiosk mode — **Till stage 4**.
- Nothing here deploys to clients: Stage 3 lands on `dev`, app pinned to dev-api, until the owner calls it production-ready. No v2.0.0 Android tag until then.

---

## 9. Primary files to anchor the build

- **Server (already built):** `apps/desktop/src/main/` — `nodeServer.ts` (all routes), `nodeGateway.ts`, `nodePrintRelay.ts`, `nodeClient.ts`, `nodeHealth.ts`, `nodeIngest.ts`, `branchStaff.ts`, `nodeTabs.ts` (unwired), `serverBeacon.ts`, `serverJoin.ts`.
- **Android client seam (where Stage 3 is wired):** `apps/android/src/config.ts` (API_URL), `src/shop/offlineWrites.ts` + `offlineReads.ts` (the fetch seam), `src/cloud/client.ts` (native calls), `src/shop/branchServer.ts` (existing `/node/*` client + `ServerLink`), `tillSession.ts`, `pinSignIn.ts`, `replay.ts`.
- **Cloud (proven foundations):** `apps/server/src/routes/` — `sync.ts`, `backfill.ts`, `auth.ts`, `tables.ts`, `printers.ts`, `stations.ts`; `src/lib/deviceRegistry.ts`, `deviceRole.ts`, `refreshHandshake.ts`, `liveHub.ts`.
- **Docs:** `docs/ANDROID-APP-DESIGN.md` §4–5, §11; `docs/SCOPE-node-authority-A160.md`; `docs/HELD-ORDERS-CROSS-TILL-D9.md`.
