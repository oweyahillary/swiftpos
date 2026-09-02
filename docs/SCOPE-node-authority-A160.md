# SCOPE — Node-authority tills: one node online, the peers rely on it (A160)

**Proposed register ID:** A160 (P1) — not yet filed; this is the scope for your approval.
**Vision (your original design):** at a branch, **one till is the node/server and needs
internet; every other till relies on the node** for authentication, tokens, reference
data, and getting its sales to the cloud. A peer with no internet keeps working entirely
through the node — it never needs a human login, an enrolment code, or the cloud.
**Verified in the tree, and it *was* the plan:** `nodeServer.ts` still carries the comment
*"this header used to state that the node was the SOLE uplink to the cloud"* — the design
existed and was walked back to per-till uplink. This scope restores it, deliberately.

---

## Current state (verified at source)

**Built (the foundation is real):**
- The node **already authenticates peers over the LAN** with a shared `node_secret`
  (`X-Node-Secret` header on every `/node/*` call — `nodeServer.ts:82`). Peers already
  send `device_id` + `node_secret` on every node call.
- Devices have a stable identity: `device_id` (generated once), a role (`till`/`node`/
  `office`), `terminal_code`, and `node_secret` — the credential basis for a grant.
- Cashier **PIN** auth already works through the node (`/node/verify-pin`) or the offline
  cache (A17). So daily cashier sign-in already doesn't need the cloud.

**NOT built (why "only the node online" isn't the case today):**
- **Session tokens refresh against the CLOUD.** `syncEngine.ts` refreshes at
  `${_serverUrl}/api/auth/refresh`; the node has **no** token endpoint. Access tokens
  live **15 min**, refresh tokens **30 days** — so a peer offline past its refresh window
  (or whose refresh is lost/revoked) falls to a full re-auth, which under A158 is a fresh
  enrolment code (cloud + a human). **This is the wart you're pointing at.**
- **Peers reach the cloud directly** for their own sales (`POST /api/orders`) and pull
  reference data (`/api/pos/init`, `/api/staff`, …) from the cloud. The node is only a
  *branch-local replica* they *also* push to — not their uplink.

So today every till needs internet for its own token lifecycle and sync. The node is a
replica + PIN authority, not the peers' backend.

---

## The four axes the node must own (dependency map)

For a peer to *never* need the internet, the node must be its whole backend:

| Axis | Register item | State |
|------|---------------|-------|
| **Tokens** — node issues/renews a peer's session token | **A160 (this)** | new; foundation (node_secret auth) exists |
| **Reference down** — node serves catalogue/prices/staff/settings to peers | **A24** | mapped (source pass done) |
| **Sales up** — node forwards a peer's sales to the cloud | **A19** | mapped (source pass done) |
| **Roster/devices** — node knows its registered devices to authenticate + serve them | **A20** | mapped (source pass done) |

A160 is the auth leg. The pure vision is A160 **+ A19 + A24 + A20**.

---

## The design fork (this decides the size — pick per phase)

**(a) Cloud device-grant — smallest; half-solves the wart today.**
The till proves its device identity (`device_id` + a device secret) to the CLOUD and gets
a fresh session token — no owner login, no enrolment code, no human. Any till *with
internet* self-heals on expiry. Needs neither the node nor A19/A20/A24. A159 already makes
the granted token safe (it carries `surface:'desktop'`; the write-guard blocks dashboard
writes).

**(b) Node brokers the grant — the offline answer.**
A peer with no internet asks its node; the node (which has internet) runs the (a) grant on
the peer's behalf and hands the cloud-signed token down. Peers stay cloud-signed and keep
their direct uplink as a fallback. Needs A20 (node knows its devices); not A19.

**(c) Node mints its own tokens — the pure vision.**
The node issues LAN-scoped tokens peers use for everything; peers never touch the cloud.
**Requires A19** (node is the uplink) — a node-minted token can't sync a peer's sales up
unless the node forwards them. This is "only the node online," fully realised.

---

## Token design (applies to all three)

- **Grant credential:** `device_id` + a per-device secret. Reuse/registerable via the
  existing device registry; issued at enrolment alongside `node_secret`. Never the owner
  password.
- **Claims:** `surface: 'desktop'`, `isOwner: false` (device-scoped, **not** owner) →
  A159's guard already forbids dashboard writes. `branchId` bound; `deviceId`/`terminalCode`
  carried for attribution and revocation.
- **Lifetimes:** short access (~15 min, unchanged); the *grant* replaces the 30-day refresh
  ceiling for peers — a peer re-grants from its node/cloud on demand, so "offline > 30 days"
  stops being a lockout.
- **Revocation (must-have):** a stolen/decommissioned peer must be killable — revoke by
  `device_id` at the node (drops it from the registered set) and at the cloud (device
  status = revoked). Grant checks device status every issue.

---

## Phased build plan (each phase shippable + useful alone)

**Phase 1 — (a) cloud device-grant.** New `POST /api/auth/device-token` (device_id +
device secret → session token, device-scoped). Desktop: on refresh failure / expiry, try
the device-grant before dropping to the enrol screen. Closes the re-login wart for online
tills. *Smallest, highest immediate value.*
  - Server: new endpoint + device-secret verification + revocation check.
  - Desktop: `syncEngine` refresh path + `App.tsx` fallback ordering.
  - Depends on: nothing new (device registry exists). Pairs with A159 (already shipped).

**Phase 2 — (b) node brokers for offline peers.** New `POST /node/token`: node authenticates
the peer (`X-Node-Secret` + device_id, already the pattern), runs the Phase-1 grant upstream,
returns the token. Desktop: peer prefers node-broker when the cloud is unreachable.
  - Server: none (reuses Phase 1). Node: new endpoint + broker logic.
  - Depends on: **A20** (node's device list to authenticate peers).

**Phase 3 — (c) node-sole ("only the node online").** Node mints LAN-scoped tokens; peers
read reference from the node (**A24**) and the node forwards their sales up (**A19**); peers'
direct cloud paths become fallback-only or are disabled.
  - Depends on: **A19 + A24 + A20** — this is the node-cluster completion.

---

## Security model

- **node_secret is branch-shared** — good enough to authenticate a peer to *its* node on the
  LAN, but it means any peer holding it can request a token. Pair issuance with a per-device
  secret + device-status check so a revoked device is refused even with a valid `node_secret`.
- **A159 is the safety net** — every granted/minted token is `surface:'desktop'`, so the
  write-guard already stops it from touching the dashboard. Turn on `TERMINAL_WRITE_ENFORCE`
  before Phase 1 ships widely, so a device token can never mutate dashboard data.
- **Revocation path is mandatory before (c)** — once peers depend on the node for tokens, a
  lost peer must be revocable at the node without a cloud round-trip.
- **The node becomes a high-value target** — it holds the roster (A20) and issues tokens.
  Its disk (SQLite) and `node_secret` must be protected; a compromised node = branch
  compromise. Document it as a single trust domain (PHASE5 §10.1 already frames this).

## Risks / edge cases
- **Two nodes / node failover:** if a peer is promoted to node (A20), token issuance must
  move with it; two nodes issuing tokens for one branch must not diverge.
- **Clock skew:** node-minted tokens (c) need the node's clock trusted; `/node/time` exists
  but token `exp` validation across peers must tolerate skew.
- **Grant replay / secret theft:** a captured device secret must be revocable; log every
  grant (device_id, time) for audit.
- **Backwards compatibility:** old builds still refresh against the cloud — Phase 1 is
  additive (a new endpoint), so no rollout ordering issue until (c) disables direct paths.

## What can be verified on the bench vs target
- **Bench:** grant logic, token claims/scope, allowlist/guard interaction, revocation
  decision — all unit-testable (mutation-checked), like A159.
- **Target only (rule 16):** the real node↔peer flow — a peer re-granting from its node
  with the cloud cut, failover moving issuance, revocation killing a live peer.

---

## Recommendation

Build **Phase 1 (a)** next — it's small, closes the "session expired → login" wart for every
online till, and A159 already de-risks the token. Then Phase 2 (b) gives offline peers the
same via the node. Phase 3 (c) — the pure "only the node online" — is the payoff once A19 +
A24 + A20 land, and those are already mapped. You reach the original design incrementally,
each step shippable, without a big-bang rewrite.
