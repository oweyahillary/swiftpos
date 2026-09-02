# MANIFEST — 2026-08-24-d

**Base commit:** batch -c (`983f552`) on `audit/2026-08-23`. Applies **on top of -c**.
**Register ID:** **A152** (P0) — **FIX BUILT on the bench; entry stays OPEN** pending a
real-till test (rule 16) and a desktop version bump at build (rule 15).
**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.
**Apply:** `git apply MANIFEST-2026-08-24-d.patch` · **Rollback:** `git apply -R MANIFEST-2026-08-24-d.patch`

Fixes the 2026-08-23 outage class: a cloud/node that ANSWERS with a 5xx was treated
as a rejection, so offline PIN sign-in never fell through to the node/cache and tills
locked out even though the app is meant to keep trading offline.

---

## Files

| # | Change | File | What / why |
|---|--------|------|------------|
| 1 | **new** | `apps/desktop/src/main/authTransport.ts` | `isUnreachableStatus(status)` — the single rule: a 5xx means the authority answered but cannot serve ⇒ UNREACHABLE (fall through). A clean 4xx stays FINAL. |
| 2 | **edit** | `apps/desktop/src/main/nodeClient.ts` | `verifyPinAtNodeClient`: transport test widened from `=== 503` to `isUnreachableStatus` (all 5xx) — a node 500/502/504 was read as a final rejection (same class, LAN leg). |
| 3 | **edit** | `apps/desktop/src/main/ipcHandlers.ts` | `auth:verifyPin`: offline fallback extracted to `fallbackToLocalAuthority()`, now taken on a thrown error **and** a 5xx; `res.json()` guarded against a non-JSON gateway body. `auth:login` (owner): 5xx surfaces a clear "cloud unreachable, retry" message (no fallback possible for a first login) instead of "Login failed"/parse crash. |
| 4 | **new** | `tests/offline-auth-fallback.test.mjs` | 20 assertions modelling the authority decision + node leg (repo convention — coupled to Electron/SQLite, so the decision is modelled, cf. `node-verify-pin.test.mjs`). Auto-run by `run-all` and `check-test-registration`. |
| 5 | **edit** | `docs/AUDIT-REGISTER.md` | A152 annotated FIX BUILT (bench), kept OPEN P0; Last-updated. Open tally **unchanged** (still A-P0: 2). |
| 6 | **new** | `docs/MANIFEST-2026-08-24-d.md` | This manifest. |

**Not touched (rule 22):** no `package.json` version, no lockfile. **This is a desktop
change → the version must be bumped by the build** (`release:patch` runs `npm version
patch`; tag after the build, per rule 15). The bump is deliberately NOT in this patch.

## The three sites of the class (rule 6 — sweep, don't fix the one line that shouted)
1. **Cloud PIN verify** — the money bug. 5xx now ⇒ node/cache fallback.
2. **Node PIN verify** — was 503-only; a node 5xx now retries the cloud instead of rejecting.
3. **Owner desktop-login** — cloud-only by nature (no cached owner credential to fall
   back to), so the fix is error quality: a 5xx is named as a cloud outage, not a
   password failure, and a non-JSON page no longer throws.

No separate session-restore path needs it: `auth:getSession` is a local row read.

## Mutation check (rules 10, 23)
Narrowing `isUnreachableStatus` back to the pre-fix `status === 503` reddens exactly
the 502/500/504 assertions (cloud and node legs) by name — the outage bug. Verified:

```
node tests/offline-auth-fallback.test.mjs                    20 passed, 0 failed
  (mutated to === 503)                                        14 passed, 6 FAILED
```

## Evidence (rule 7 — what ran; rule 9 — where)
Bench: **Linux, Node v22.22.2** (static/type/build/logic only — no Electron/SQLite here).

```
desktop main tsc     only the 4 pre-existing implicit-any errors (escposBridge/printWorker,
                     untouched) — none introduced by this batch
desktop renderer tsc clean
run-all.mjs          full suite green incl. the new test + check-register-consistency
                     + check-test-registration
```

## Could NOT be verified here (rule 16) — the close conditions for this P0
1. **On a real till:** point it at a cloud URL returning 502/503 (or kill the Render
   service) and confirm a **previously-cached** cashier still signs in, a **wrong**
   PIN is still refused, and the owner-login screen shows the outage message.
2. **Node leg on hardware:** a peer whose node returns 5xx must fall to the cloud/cache.
3. **Delivery (D3):** confirm the affected tills actually run this build — with no
   auto-update, an old till keeps the bug regardless of this fix.
Until (1)–(3), A152 stays **OPEN P0**.
