# Till stage 3 — Slice D: session refresh through the branch server

Route the Shop POS's **session renewal** (A477) through the joined branch server instead of straight to the cloud, the way
Slice A routes selling traffic and Slice C routes the PIN. Scope: `docs/SCOPE-TILL-STAGE-3.md`. Slices A/B/C landed first.

## Why
A joined POS already sells (Slice A/B) and verifies PINs (Slice C) through the branch server. Renewal was the last native
cloud call still going direct. Routing it through the server means a POS whose own path to the internet is flaky keeps its
session alive as long as the **server** has internet — and it is the natural home for the native call Slice A deferred
("Hook 2") to avoid an import cycle.

## The server contract (already built — `apps/desktop/src/main/nodeServer.ts`)
`POST /node/refresh` and `POST /node/refresh/ack` (pinned TLS, `X-Node-Secret`, this POS's device proof). The server
proxies to the cloud's `/api/auth/refresh[/ack]` with the peer's `X-Device-*` headers **except `X-Device-Token`** (F7 —
that is the key for THIS server, not the cloud's). It forwards the cloud's status + body, and answers **503** when it has
no cloud URL or cannot reach the cloud (`AbortSignal.timeout(10s)`).

## Decision table (tablet — `readRefreshResult`)
| From the server | `via` | tillSession does |
|---|---|---|
| 200 + new tokens | `answer` (200) | keep the new access/refresh token, save, ack via `/node/refresh/ack` |
| 401 (the cloud refused) | `answer` (401) | thrown as a `CloudError(401)` → `renew`'s existing `signBackIn` (device secret, A407) |
| any other forwarded status | `answer` | thrown as `CloudError(status)` — handled like the direct path |
| no answer (null) / 404 (old build) / 503 (node can't reach cloud) | `fallback` | renew **cloud-direct** (`cloudPost('/auth/refresh')`), unchanged |
| no `ServerLink` joined | `fallback` | renew cloud-direct — a lone cloud POS is byte-for-byte unchanged |

A forwarded **401 is the cloud's own**, so the device-secret sign-back-in still fires exactly as before — the branch server
never turns a cloud refusal into a false "keep trying".

## The import-cycle avoidance (a setter, not an import)
Wrapping the native client directly would close `cloud/client → branchGateway → branchServer → tillSession → cloud/client`.
Instead:
- `branchRefresh.ts` imports **only** `branchServer` (never `cloud/client` or `tillSession`).
- `tillSession.ts` exposes `setServerRefresh(fn)` and calls the injected `fn` from a new `refreshCall` helper. It does **not**
  import `branchRefresh`.
- `ShopPos.tsx` calls `setServerRefresh(refreshViaServer)` once on mount (clears on unmount). Unset → renewal is cloud-direct.

## Files
- **New** `apps/android/src/shop/branchRefresh.ts` — `readRefreshResult` (pure) + `refreshViaServer` (injectable deps); sends `x-device-id` only, never `x-device-token`.
- **Mod** `apps/android/src/shop/tillSession.ts` — `setServerRefresh` + `refreshCall`; `renew()` routes both the refresh and the ack through it.
- **Mod** `apps/android/src/screens/shop/ShopPos.tsx` — installs the router on mount.
- **New** `tests/android-till-stage3d.test.mjs` — hermetic (esbuild, Capacitor stubbed).
- **Mod** `.github/workflows/ci.yml` — Slice D step after Slice C.
- **Mod** `apps/android/package.json` — 0.4.2 → **0.4.3** (versionCode auto-derives to 4003).
- **Mod** `docs/ANDROID-CHANGELOG.md` — 0.4.3 entry.

## Tests (headless — no rig)
`readRefreshResult` null/404/503→fallback, every other status→the cloud's forwarded answer. `refreshViaServer`: no link→
fallback (not called), a 200/401 forwarded, the `/ack` path routes, `x-device-id` sent and **`x-device-token` never**, 503
and a thrown request→fallback. Source checks: no `cloud/client`/`tillSession` import in `branchRefresh`, no `x-device-token`,
`tillSession` routes through `refreshCall` + exports the setter, `ShopPos` installs the router.

## Device / rig test (LAN — can't be headless)
1. **Renews via the server:** phone joined; let the access token near expiry → it renews over the LAN through `/node/refresh`
   (tablet's own internet off, server's on → still renews).
2. **Server down → cloud-direct:** stop the server, tablet online → renewal still happens straight from the cloud.
3. **A real cloud refusal still signs back in:** force a cloud 401 (revoke the refresh token) while routed via the server →
   the POS signs back in with its device secret (A407), not a stuck session.
4. **The ack goes via `/node/refresh/ack`** (the old token is revoked only after the new one is kept).
5. **No branch server:** a lone cloud POS renews exactly as before.

Lands on `dev` (app on dev-api), nothing deploys; owner commits.
