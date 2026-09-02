# MANIFEST — 2026-08-24-i

**Base commit:** batch -h (A159) on `dev`. Applies **on top of -h**.
**Register ID:** **A160** (P1) — Phase a+b. Phase (a) already satisfied for online tills;
Phase (b) **FIX BUILT**, OPEN pending two-till verification.
**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.
**Apply:** `git apply MANIFEST-2026-08-24-i.patch` · **Rollback:** `git apply -R MANIFEST-2026-08-24-i.patch`

Your original design, token axis: an offline peer refreshes its session **through its
node** instead of falling to a login. No new credential, **no migration** — the refresh
token is the device credential.

---

## Files

| # | Change | File | What |
|---|--------|------|------|
| 1 | edit | `apps/desktop/src/main/nodeServer.ts` | New `POST /node/refresh` — X-Node-Secret authed; proxies the peer's refresh token to the cloud `/api/auth/refresh`; 503 if the node can't reach the cloud. |
| 2 | edit | `apps/desktop/src/main/nodeClient.ts` | `refreshViaNode(refreshToken)` — calls `/node/refresh`, returns the new pair or null. |
| 3 | edit | `apps/desktop/src/main/syncEngine.ts` | `doRefreshAccessToken` falls back to the node when the cloud is **unreachable (thrown) or 5xx** (A152 pattern); a clean **401 stays final**. |
| 4 | new | `tests/node-token-refresh.test.mjs` | 9 assertions (offline peer refreshes via node; revoked stays final; no-node/no-help ends session) + source wiring. Mutation-checked. |
| 5 | edit | `docs/AUDIT-REGISTER.md` | A160 entry; Open tally **A-P1 12→13**; Counts + Last-updated. |
| 6 | new | `docs/MANIFEST-2026-08-24-i.md` | This manifest. |

**Not touched (rule 22):** no version, no lockfile, **no migration**, no schema, no new IPC channel.

## Why no migration
The device already holds a server-issued, rotating, revocable credential — its **refresh
token** (`refresh_tokens` table). Phase (b) reuses it: the node proxies the existing
`/api/auth/refresh` on the peer's behalf. Nothing new to store server-side.

## Phase (a) — already done for online tills
Refresh-token rotation already re-auths an online till silently on expiry (no human). The
"login on expiry" only ever bit offline peers — which is what (b) fixes. So (a) needs no
build; (b) is the substance.

## The design, precisely
- **Auth:** `/node/refresh` reuses the branch `node_secret` (the node already authenticates
  every `/node/*` call this way).
- **Fallback trigger:** cloud thrown / 5xx → try the node (the A152 "unreachable ≠ rejected"
  rule). A **401 (revoked) is FINAL** — the node is not tried, so a killed session still ends.
- **Only the node needs internet:** the peer never contacts the cloud; the node does.

## Evidence (rule 7 / rule 9 — Linux, Node 22 bench)
```
desktop main tsc      clean (only the 4 pre-existing implicit-any)
desktop renderer tsc  clean
node-token-refresh    9/0 (mutation-checked)
refresh-grace / node-verify-pin / peer-auth-chain / offline-auth-fallback   all green
check-ipc-parity      OK      check-register-consistency  OK (A-P1 13)
```

## To CLOSE (owner) — the two-till drill (rule 16)
Two tills + a node, all trading. Cut the **peer's** cloud (leave the node online). Let the
peer's access token lapse (~15 min, or force it). Confirm the peer **refreshes via the node**
and keeps selling with no login prompt — and that a **revoked** token still ends the session.

## Phase (c) — the pure "only the node online" (future)
Node mints its own LAN tokens; peers never touch the cloud. Needs **A19** (node uplink) +
**A24** (reference down) + **A20** (roster). Scoped in `SCOPE-node-authority-A160.md`.
