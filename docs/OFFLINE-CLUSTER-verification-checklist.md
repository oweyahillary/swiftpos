# SwiftPOS — Offline/Node Cluster: Two-Till Verification

**What this closes:** A19, A24, A20, A160, A161, A162, A163 (P1) + A168, A129. All are
**built and bench-green** (peer-relay 28/0, node-reference-bundle 25/0, node-reference-unpack
19/0, roster-snapshot 16/0, node-token-refresh/device-token 2/2) and were gated behind A101 —
which passed. This is the hardware pass that turns them from FIX BUILT into CLOSED (rule 16).

**You need:** the same **two tills + node** from the A101 run, one printer optional, the web
dashboard, and a way to cut one till's internet (unplug LAN/Wi-Fi or block the cloud) while the
node stays on the LAN.

> Nothing here needs new code. If a test FAILS, stop and tell me the peer log line — that's a
> real bug, not a checklist gap.

---

## Setup — do this first
1. **Build the current dev flavour on both tills** (it now contains the whole cluster):
   `cd apps/desktop && npm run pack:dev` — install on both.
2. Enrol one as the **node** (role `node`); enrol the other as a **peer** with the node's URL +
   branch secret.
3. With **both online**, let them **sync once** — the node pulls the roster **and** the
   reference snapshot (catalogue/prices) it will serve. (Not optional: the node serves what it
   last pulled.)
4. Open the **peer's log** (Technician → View log) to watch the `node …` lines.

---

## Test 1 — Peer sale reaches the cloud via the node  → closes **A19 / A162**
- Cut the **peer's** internet. Keep the node on the LAN.
- Ring a normal sale on the peer (include an item **with a paid modifier** — that's the case the
  relay is designed to protect).
- Bring the peer's internet back **off** but let the **node** stay online (node relays it).
- On the **web dashboard**, find that order.
- **Expect:** it appears **exactly once**, with the **peer's original order number**, and the
  **total includes the modifier** (not short). No duplicate row. → **Pass / Fail**

## Test 2 — Reference data flows down through the node  → closes **A24 / A161**
- On the dashboard, **change a product's price**. Let the **node** sync once (node online).
- **Cut the peer's cloud**, keep the node on the LAN. Trigger a sync on the peer.
- **Expect:** the peer shows the **new price**, pulled **from the node** (log shows a node
  reference pull), and both tills sell that item at the **same** price. → **Pass / Fail**
- **Fallback check:** now make the **node unreachable** too and sync the peer. **Expect:** the
  peer falls back to the **cloud** path unchanged (no crash, no wiped catalogue). → **Pass / Fail**

## Test 3 — Roster replicates for failover  → closes **A20 / A163**
- With the node online and the peer's cloud **cut**, sign in on the peer with a PIN.
- **Expect:** signs in — the peer authenticates against the **node-replicated roster**. → **Pass / Fail**
- On the dashboard, **deactivate a cashier**. Let the node sync, then sync the peer (cloud still
  cut). Try that cashier on the peer. **Expect:** **refused** (revocation reached the peer via the
  node). → **Pass / Fail**
- **Promote the peer to node** (Technician → promote). **Expect:** it can **immediately** sign staff
  in — it pulled a fresh roster before flipping. → **Pass / Fail**

## Test 4 — Session refresh brokered by the node  → closes **A160**
- On the peer, **cut the cloud**, keep the node online. Let the peer's **access token lapse**
  (wait it out, or leave it idle past 15 min).
- Keep using the peer (ring a sale).
- **Expect:** it keeps working — the session **refreshed through the node**, no login prompt.
  → **Pass / Fail**
- **Revocation-is-final:** revoke that device/session on the cloud, restore the peer's cloud, sync.
  **Expect:** the session **ends** (a clean 401 is never brokered around). → **Pass / Fail**

## Test 5 — Delivery sale reaches the cloud  → closes **A129**
- Ring a **delivery** order on either till (online).
- **Expect:** it appears on the cloud dashboard (no silent park). → **Pass / Fail**

## Test 6 (optional) — Offline-shift order attribution  → closes **A168**
- Open a shift on the peer while **offline**, ring a sale, then reconnect and let it push.
- **Expect:** the order syncs and is attributed to the **cashier who rang it** (not the owner).
  → **Pass / Fail**

---

## Regression sanity — the important negatives
- A till with **no node** configured still reads catalogue/roster **from the cloud** exactly as
  before, and normal **online** sign-in on both tills is unchanged. → **Pass / Fail**
- No till ever sells an item at a stale price while its node has the current one. → **Pass / Fail**

---

## Copy this back to close them
```
SwiftPOS offline/node cluster — two-till results (build: v_____)
Test 1 (A19/A162)  peer sale → cloud, orig id, modifier intact : PASS / FAIL  ____
Test 2 (A24/A161)  reference down via node + cloud fallback     : PASS / FAIL  ____
Test 3 (A20/A163)  roster replicate + revoke + promote          : PASS / FAIL  ____
Test 4 (A160)      refresh via node + revocation final          : PASS / FAIL  ____
Test 5 (A129)      delivery sale reaches cloud                  : PASS / FAIL  ____
Test 6 (A168)      offline-shift attribution (optional)         : PASS / FAIL  ____
Regression         no-node till + online unchanged              : PASS / FAIL  ____
Notes / any red log line:
```

**Still NOT covered by this pass (separate work, not blocked):** A164 desktop cutover (till
using the device-token instead of the owner token — server half built, desktop half unbuilt),
A22 (promotion split-brain check — unbuilt), A23 (distribution-lag/RPO measurement — unbuilt),
A18 (nodeServer.ts header doc reconcile).
