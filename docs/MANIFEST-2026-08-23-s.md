# MANIFEST — 2026-08-23-s

**Batch:** A17 source-analysis pass — the P0 fix is already built; register corrected. **Docs-only — no zip** (rule 18).
**Cumulative:** follows -a…-r. Apply after -r.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-r.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | Appended an `IMPLEMENTATION FOUND 2026-08-23` note to A17. Stays **OPEN P0**; counts unchanged. | Rule 14 / 7 — the entry described an "unstarted design gap"; PHASE5 §4 was in fact built and never recorded. |
| `docs/MANIFEST-2026-08-23-s.md` | New (this file). | Rule 2. |

## Headline

**A17 (the P0 "peer till locks out on day 15") is fixed in code** — PHASE5 §4 was implemented after the design was agreed, but the register still tracked it as unstarted ("do not patch"). No code was written in this batch; this corrects the record.

## What was verified in source (rule 7)

- **Node auth route** — `POST /node/verify-pin` at `nodeServer.ts:160`; handler `verifyPinAtNode` in `branchStaff.ts`; `X-Node-Secret`-guarded.
- **Node roster** — `branch_staff` table + `branchStaff.ts`, pulled from `GET /api/pos/branch-staff` (`pos.ts:21`) with the full four-condition guard (desktop surface, own business, `isNodeRole(device_role)`, device's own branch). bcrypt hashes only.
- **Peer authority chain** — `ipcHandlers.ts:487-534`: node (LAN) → cloud → last resort; fall back only on transport failure; a rejection is final; a node uses its own (never-expiring) roster, a peer uses the cache.
- **Expiry** — `pinCache.ts:148`: a node-configured peer's cache is exempt from the 14-day cutoff → no day-15 lockout for a node-attached till.
- **Prerequisites** — D14 (registration) CLOSED; D4 (enrolment) implemented-pending-verify; `isNodeRole` built server-side (`deviceRole.ts`/`deviceRegistry.ts`).

## Why it stays OPEN P0

1. **Not yet on the tills** — no desktop auto-update (D3 open) and `main` lags `dev`, so running terminals likely predate this fix; the P0 is live in production until installed.
2. **No live proof (rule 16)** — needs a real node + peer over 15+ offline days.
3. **A19 not closed by this** — the node still does not forward peer sales to cloud (`nodeServer.ts:10-23`); a peer can now SELL offline indefinitely (A17) but its sales still don't BACK UP to cloud (A19, separate P1).

## Caveats to weigh (not necessarily bugs)

- §4e is implemented as "has a `node_url` → never expires," broader than the spec's "days since any authority reached" — a node-configured peer that hasn't reached its node in weeks still never expires.
- The node-verify path doesn't call `cacheStaffCredential`, so the last-resort cache is populated only by cloud verifies (fine while the node is the daily authority; an edge case for a cashier who has only ever signed in via node when both node and cloud are down).

## To close A17

Ship the current build to the tills, then a live two-till offline test: a peer with a `node_url` keeps selling past day 15 with no internet, reaching only its node.

## Verification

- `node scripts/check-register-consistency.mjs` → green (A17 still OPEN P0; counts unchanged).
- No code changed; nothing to build.

## Rollback

```
git apply -R A17-source-analysis.patch
```
