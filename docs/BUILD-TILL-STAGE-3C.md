# Till stage 3 — Slice C: verify a PIN at the branch server

Scope: `docs/SCOPE-TILL-STAGE-3.md`. Slice A (gateway) = `docs/BUILD-TILL-STAGE-3A.md`; Slice B (sell/sync) =
`docs/BUILD-TILL-STAGE-3B.md`. This slice routes the **staff PIN sign-in** at a Shop POS through the branch server it
joined, so the branch's roster — the LAN authority — answers first.

## Why

A joined branch server already keeps the branch's staff roster (`apps/desktop/src/main/branchStaff.ts`): it is refreshed
on every catalogue pull and by relayed staff changes, and it holds each person's bcrypt `pin_hash`. That roster is fresher
than this tablet's own Stage-2 cache and it is reachable **over the LAN with no internet at either end**. So a PIN sign-in
should ask the server first; only if the server cannot give a verdict does the POS fall back to the cloud, and then to its
own offline check.

Hook 2 of Slice A (wrapping the native `cloud/client.ts`) was deferred here precisely because verify-pin wants its **own**
LAN-authoritative route (`/node/verify-pin`), not the generic `/node/cloud` gateway.

## The server contract (already built)

`POST /node/verify-pin` — `apps/desktop/src/main/nodeServer.ts` (~L452), verdict from `branchStaff.verifyPinAtNodeAsync`:

- Request: body `{ branch_id, pin }`, over the server's pinned TLS, with the branch access code (`X-Node-Secret`) and this
  POS's device proof (`x-device-id`, `x-device-token`) — as every `/node/*` call.
- `200 { ok: true, staff: { staffId, name, roleName, permissions } }` — verified. **No JWT is minted:** the person's
  writes go under this POS's **own till token** (already routed through the server by Slice A/B), carrying their
  `cashier_id`, exactly as the online path does.
- `401 { ok: false, reason, error }` — a bad or **ambiguous** (shared) PIN. **FINAL** — the server's own rule (F7) is that
  the peer must not fall back to another authority on a 'no'.
- `429 { reason: 'rate_limited' }` — ≥10 attempts/min from this till or address.
- `503 { reason: 'unavailable' | 'no_roster' }` — the node cannot prove which POS is asking, or cannot read its roster.
  The server returns 503 (not 401) on purpose, so the till treats it as **unreachable** and checks elsewhere.

## The decision (tablet side)

| From the server | Tablet does |
|---|---|
| `200` + a usable `staff` | **Sign in** as that person — a tokenless, *confirmed* cashier session (the till token carries the writes). |
| `401` | **Refuse, final.** Show the server's words; never ask the cloud. |
| `503` · `429` · `404` (old build, no route) · `403` · no answer at all | **Fall back:** cloud `/auth/verify-pin` (if online), then the Stage-2 offline bcrypt check. |

The returned session is tokenless like the Stage-2 offline session, but it is **not provisional** — the LAN authority
already said yes, so there is no held PIN and no reconnect upgrade to wait for (`refreshToken` is empty, not
`OFFLINE_PENDING`).

## Files

- **New:** `apps/android/src/shop/branchPin.ts` — `readPinVerdict` (PURE: classify the node's answer → `session` /
  `refused` / `fallback`) and `verifyPinAtServer` (injectable `link` / `request` / `device` deps). Builds the cashier
  session with the shared `cashierSessionFrom` (rules.ts), mapping the node's `{ staffId, name, roleName, permissions }`
  to `{ staff: { id, name, role }, permissions }`. Posts through `branchServer.nodeRequest` (pinned TLS); **does not
  import `cloud/client`** (that would close the import cycle the Slice A sheet warns of — `cloud/client → branchGateway →
  branchServer → tillSession → cloud/client`).
- **Wire:** `apps/android/src/screens/shop/PinScreen.tsx` — `signIn()` tries `verifyPinAtServer` **before** the online
  branch; a `session` is used as-is, a `refused` throws `PinRefused` (final), anything else falls through to the existing
  cloud / offline paths unchanged. A new `hasLink` state lets a POS that **joined a server but has no cached roster yet**
  reach the PIN pad while offline (the server verifies it), instead of the "no staff saved" wall.
- **Tests:** `tests/android-till-stage3c.test.mjs` (hermetic — esbuild bundle, Capacitor stubbed, injected deps).
- **CI:** a named step after Slice B in `.github/workflows/ci.yml`.
- **Native:** none. Slice A already made `BranchServer.request` return headers; verify-pin needs only `{ status, body }`.
- **Version:** `apps/android/package.json` 0.4.1 → **0.4.2** (`versionCode` auto-derived by build.gradle → 4002);
  `docs/ANDROID-CHANGELOG.md`.

## Tests (headless — no rig)

`readPinVerdict` (pure): no answer → fallback; `200` + staff → a session (staffId/name/role/permissions carried, token
empty, branch from the till); a `200` with no usable staff, `ok:false`, or an unreadable body → fallback; `401` → refused
with the node's words (and a default when bodyless); `503` / `429` / `404` → fallback. `verifyPinAtServer` (injected): no
link → fallback **without a call**; `200` → session with `{ branch_id, pin }` and the device proof sent; `401` → refused;
a null answer → fallback. Source checks: posts `/node/verify-pin`, reuses `nodeRequest`, does not import `cloud/client`;
PinScreen tries the server first and treats a refusal as final.

**Mutations confirmed to bite:** a 503 read as refused; a 401 read as fallback; verifyPinAtServer calling with no link;
branchPin importing cloud/client.

## Device / rig test (owner — LAN behaviour, not headless)

Two tills + a branch server (extra laptop = node role, this laptop = desktop till peer, a phone = Shop POS):

1. **Server verifies:** phone joined to the server, tablet **and** server both offline from the internet → a valid PIN
   signs in (proves it went via `/node/verify-pin`, not the cloud and not the tablet's own cache).
2. **Wrong PIN is final:** a bad PIN is refused immediately with the server's words — it is **not** re-tried against the
   cloud (watch the network / server log: one `/node/verify-pin`, no `/auth/verify-pin` after a 401).
3. **Server down → cloud:** stop the branch server, keep the tablet online → a PIN still signs in via the cloud.
4. **Both down → offline:** server down **and** tablet offline → a PIN signs in via the Stage-2 offline check (a held PIN,
   upgraded on reconnect), for a person already cached.
5. **Fresh join, offline:** a POS joined to the server but never yet online → it reaches the PIN pad offline and signs in
   via the server (no "no staff saved" wall).

Lands on `dev` (app pinned to dev-api); nothing deploys. **Next:** Slice D — session refresh through `/node/refresh`
(A160); then Stage 3b, shared tables across devices.
