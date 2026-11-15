# BUILD SHEET — Till Stage 3, Slice A: branch transport + protocol handshake

Parent scope: `docs/SCOPE-TILL-STAGE-3.md` (owner-approved 2026-11-12). This sheet is the concrete design for **Slice A only** — the foundation the other slices sit on.

**STATUS 2026-11-12 — BUILT (core), verified headless, on branch `android-till-3`.** Native header return, the `branchGateway` module, and the web-POS seam wiring are done; Android `tsc` + `vite build` clean; `android-till-stage3` 40/40, `android-till-stage2` unchanged 69/69, `android-till-stage1` 59/59, `pos-wording-a586` 12/12. **Still open:** the APK (Java) build runs in CI; **Hook 2 (native client) is folded into Slices C/D** (see note below); the This-device status line is optional polish (the branch server's own log already shows a forward for the rig test); **device-test on the rig.**

## Goal

When a tablet has **joined a branch server** (a `ServerLink` is saved, `apps/android/src/shop/branchServer.ts:26`), route its cloud traffic **through the server's `/node/cloud` gateway** (A410) instead of straight to the cloud — exactly as the desktop peer already does (`apps/desktop/src/main/cloudGateway.ts`). Falls back to the tablet's own cloud on any server problem (A410 as a **preference**, per the approved decision). A tablet with **no** `ServerLink` is byte-for-byte unchanged.

**Done when:** on the rig (laptop in `node` role + a phone joined to it), the phone's ordinary cloud calls provably arrive via the server's gateway (server log shows the forward); killing the server's internet keeps the phone selling by falling back to its own; killing the server on the network falls back to the cloud; an incompatible server protocol is refused with one clear line.

## Design principles

1. **`ServerLink`-gated.** No link → the existing Stage 1/2 path runs untouched. The whole slice is additive.
2. **Preference, not lock-in (approved).** Server unreachable, server-uplink-down, or an old/ refusing server → fall back to the tablet's own cloud if it has internet, else buffer (Stage 2). The desktop treats server-unreachable as "offline"; we deliberately keep the cloud fallback.
3. **Mirror the proven desktop semantics**, don't reinvent: gateway prefix `/node/cloud`, header `X-Node-Secret: <nodeSecret>`, the `X-Node-Gateway` mark that distinguishes a real forward from an old server's 404, and `X-Node-Uplink: down` for the server's own internet being down (`cloudGateway.ts:29-33`).
4. **One shared helper, two JS call sites.** The web POS funnels through `window.fetch` (the `offlineWrites.ts` seam); native calls funnel through `cloud/client.ts`. Both delegate to one `branchGateway` module so the routing logic lives in exactly one place and is unit-tested once.

## The native gap to close first (small Java change)

The pinned-TLS transport the tablet uses for every `/node/*` call is the native `BranchServer.request` (`apps/android/src/native/plugins.ts:48-55`). It currently returns **only** `{ status, body }`. The gateway decision needs the **response headers** (`X-Node-Gateway`, `X-Node-Uplink`). So:

- Extend `BranchServerPlugin.request` to return `{ status, body, headers: Record<string,string> }` — read the response headers in `BranchServerPlugin.java` / `PinnedTls.java` and pass them back. Keep it backward compatible (printing ignores headers).
- Update the TS interface in `plugins.ts` and the `pinned()` helper in `branchServer.ts:51-57` to carry headers through.

This is the only native change in Slice A. Everything else is TypeScript.

## The shared helper — `apps/android/src/shop/branchGateway.ts` (new)

Mirrors `cloudGateway.ts` but the hop goes over pinned TLS via the native plugin, not `fetch`.

```
gatewayFetch(path, method, body, token, extraHeaders) → GatewayOutcome
  link = readServerLink()                       // cached in memory, invalidated on join/forget
  if (!link) return { via: 'none' }             // caller does its normal cloud call
  r = await BranchServer.request({
        url: `${link.url}/node/cloud/api${path}`,   // GATEWAY_PREFIX + /api + path
        method, cert: link.cert,
        headers: { 'X-Node-Secret': link.nodeSecret,
                   ...(token ? { Authorization: `Bearer ${token}` } : {}),
                   'x-device-id': await deviceId(), ...extraHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined })
   .catch(UNREACHABLE / IDENTITY_CHANGED → return { via: 'server-unreachable' })
  if (r.headers['x-node-uplink'] === 'down')  return { via: 'uplink-down' }
  if (!r.headers['x-node-gateway'])           return r.status === 404
                                                 ? { via: 'old-server' }        // no gateway on this build
                                                 : { via: 'server-refused', status: r.status }   // wrong code / device key
  return { via: 'gateway', status: r.status, body: r.body }   // the cloud's own answer, forwarded
```

**Caller decision table** (encodes the approved preference-with-fallback):

| `via` | Meaning | Tablet does |
|---|---|---|
| `none` | no server joined | normal cloud call (unchanged) |
| `gateway` | server forwarded the cloud's answer | use it — this IS the cloud's response |
| `server-unreachable` | server off / wrong cert | **fall back to own cloud** if online, else Stage-2 buffer; note the channel |
| `uplink-down` | server up, its internet down | **fall back to own cloud** if online, else buffer |
| `old-server` | server on a pre-gateway build | fall back to own cloud; remember 10 min (don't re-pay the round trip — `cloudGateway.ts:127-129`) |
| `server-refused` | wrong branch access code / device key | fall back to own cloud; surface a "re-join this POS" notice (do **not** treat as a 401 sign-out) |

A tablet-side health record (last-ok / last-error per channel), a trimmed version of `nodeHealth.ts`, feeds the This-device page so a technician can see the gateway is live.

## Hook point 1 — the web-POS fetch seam (`apps/android/src/shop/offlineWrites.ts`)

The seam already sees every web-POS cloud call (`isCloud`, line 88). Insert the gateway **before** the existing online branches, only when a link is present:

- Reads (currently line 96-108): when online and a link is present, try `gatewayFetch(GET)`; on `gateway` build a `Response` from `{status, body}`; on any fallback `via`, run the existing `original()` cloud GET (and the cold-start cache still works as today). Offline is unchanged.
- Writes (currently line 111): when online and a link is present, try `gatewayFetch(method, body, token)`; on `gateway` return the forwarded `Response`; on a fallback `via` with internet, `original()`; with no internet, the existing buffer path (line 112+). The provisional-response machinery is untouched.

The seam needs the caller's bearer token to forward it; today the web POS sets `Authorization` on the request, so `gatewayFetch` reads it from `init.headers` rather than being passed one.

## Hook point 2 — the native cloud client (`apps/android/src/cloud/client.ts`)

`request()` (line 18-33) is the native path (join, device refresh, PIN, version). Wrap its single `CapacitorHttp.request` call: first `gatewayFetch(method, path, body, token)`; on `gateway`, return the parsed body with the same status handling; on a fallback `via`, the existing `CapacitorHttp` call. Join itself (`/auth/enrol/redeem`) is exempt — you can't route through a server you haven't joined yet.

`replay.ts` (`cloudSender`, line 85) gets the same treatment in Slice B when buffered sales learn to drain to `/node/sync`; in Slice A it still drains cloud-direct.

**Scope refinement (2026-11-12):** Hook 2 is **deferred and folded into Slices C/D.** Reason: the web-POS seam (Hook 1) already routes *all* selling traffic (`posApi` + `api` both go through `window.fetch`). The only native cloud calls are join (can't route — no server yet), `/api/version` + app-update (fine cloud-direct), and the two that matter — **verify-pin and token refresh — which get their own LAN-authoritative `/node/*` routes in Slice C (`/node/verify-pin`) and Slice D (`/node/refresh`)**, not the generic `/node/cloud` gateway. Wrapping `cloud/client.ts` now also risks an import cycle (`cloud/client → branchGateway → branchServer → tillSession → cloud/client`); C/D will introduce it behind a setter instead. So Slice A ships the seam routing (the real value) and the handshake.

## The protocol handshake

On POS open with a `ServerLink` present (and on reconnect), `GET <link.url>/node/health` over pinned TLS; parse `{ protocol, min_till_protocol, capabilities }` (server side already serves this — `nodeServer.ts` `/node/health`, constants in `nodeHealth.ts:68-73`). Define `TILL_PROTOCOL` on the tablet. If `min_till_protocol > TILL_PROTOCOL` → show "update this POS" and **do not** route through the gateway (stay cloud-direct). If `protocol < TILL_PROTOCOL` → route, but the This-device page notes "update the branch server." Matches the desktop's `noteServerInfo` / `protocolVerdict`.

## Tests (headless — no rig needed to go green)

- A **mock `/node/*` server** in the test harness (a tiny HTTP server, or a stub of `BranchServer.request`) that returns, per case: a gateway-marked forward, `X-Node-Uplink: down`, a bare 404 (old server), a 401 refusal, and a `/node/health` with each protocol combination.
- Assert `gatewayFetch` returns the right `via` for each, and that each caller takes the right branch (use server / fall back to cloud / buffer).
- Assert the no-`ServerLink` path is unchanged (existing Stage 2 suite must stay green — `tests/android-till-stage2.test.mjs`).
- `apps/android` tsc + vite build; run the full local CI sweep before the commit (per the run-all-CI-steps rule).

## Files touched (Slice A)

- **New:** `apps/android/src/shop/branchGateway.ts` (+ its tests).
- **Native:** `apps/android/android/app/src/main/java/com/zaptill/app/BranchServerPlugin.java`, `PinnedTls.java` (return headers); `apps/android/src/native/plugins.ts` + `shop/branchServer.ts` `pinned()` (carry headers).
- **Wire:** `apps/android/src/shop/offlineWrites.ts`, `apps/android/src/cloud/client.ts`.
- **Status surface:** a trimmed tablet `nodeHealth`-style record + the This-device page.
- **Tests:** new gateway suite; `tests/android-till-stage2.test.mjs` unchanged must stay green.

## What Slice A deliberately does NOT do

- No `/node/sync` push or `/node/since` pull — the branch holding rows through a **total** outage and the tablet seeing **other devices'** orders is **Slice B**. Slice A only changes the *route* of a cloud call; it does not add branch-held buffering or cross-device state.
- No `/node/verify-pin` (Slice C) or `/node/refresh` (Slice D).
- No shared tables (Stage 3b).
- Nothing deploys — lands on `dev`, app on dev-api.
