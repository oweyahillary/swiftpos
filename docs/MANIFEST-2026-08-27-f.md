# MANIFEST 2026-08-27-f — A169: credit offline sales to the cashier (Option A)

**Base:** applies on top of `d7b20a5` + `-d` + `-e`. Cross-stack (server + desktop).
**Artifact:** `swiftpos-2026-08-27-f.patch`.

## What ships

**A169 (P1, still OPEN — FIX BUILT, bench).** Offline sales were credited to the
owner because the server writes `cashier_id = req.userId` and an offline shift
pushes under the owner token. Option A (owner-approved): the till sends the real
cashier in the payload; the server trusts it only under an owner/device token and
only when it validates against the branch roster like verify-pin. Staff-PIN
tokens stay authoritative (online sales can't be reattributed).

## Files

| File | Change |
|------|--------|
| `apps/server/src/lib/cashier.ts` | NEW. Pure `pickCashier` / `claimNeedsValidation` — the resolution decision, unit-tested directly. Documents the accepted residual risk and the A164 interaction. |
| `apps/server/src/routes/orders.ts` | Import the resolver; validate a claimed `cashier_id` against `users`+`user_branches` (verify-pin's rule); credit `resolvedCashierId` in the create payload (was `req.userId`) and in the completed-order webhook. |
| `apps/desktop/src/main/peerRelay.ts` | `CloudOrderCtx` gains `cashierId`; the shared builder emits `cashier_id`. Single source of truth for both push paths. |
| `apps/desktop/src/main/syncEngine.ts` | Peer direct push passes the local `cashierId`. |
| `apps/desktop/src/main/nodeIngest.ts` | Node A19 relay passes the peer row's own `cashier_id` (same value → byte-identical payload). |
| `tests/cashier-attribution.test.mjs` | NEW. Runs the real `pickCashier`/`claimNeedsValidation` (11/11, 2 mutation guards). |
| `tests/cloud-payload-cashier.test.mjs` | NEW. Real `buildCloudOrderPayload` carries `cashier_id`; peer/relay byte-identical (5/5). |
| `docs/AUDIT-REGISTER.md` | A169 → FIX BUILT; changelog; next free ID → A174. Open counts unchanged (A169 stays open P1 pending verification). |
| `docs/MANIFEST-2026-08-27-f.md` | This file. |

## The trust model (why this is safe)

- Staff-PIN token (online): `isOwner:false`, `userId` = the cashier → authoritative, claim ignored. No new spoofing surface online.
- Owner/enrol token (offline today): `isOwner:true`, `userId` = owner → a VALIDATED payload cashier is credited; an unvalidated one falls back to the owner and is logged.
- Validation mirrors verify-pin exactly: active user, in `req.businessId`, with `branch_id` in `user_branches` (empty = all branches).

## Accepted residual risk (Option A)

An owner-token push can attribute a sale to any branch-authorised cashier, not
provably the one who rang it. Attribution, not money movement; strictly better
than "all offline → owner." Owner approved this trade-off. Option B (device-grant
per-cashier identity) supersedes it later.

## A164 interaction — READ BEFORE THE DEVICE-GRANT CUTOVER

The resolver gates on `isOwner`. The A164 device-scoped token is `isOwner:false`
with `userId = owner` and is currently INERT. When that cutover ships, offline
pushes would route down the "staff token" branch and mis-credit the owner again.
The cutover MUST revisit `pickCashier` (give the device token a distinguishing
claim and gate on that). Flagged in `lib/cashier.ts`.

## Verification (rule 7) and what is NOT verified (rule 16)

- Unit: `pickCashier`/`claimNeedsValidation` 11/11 (incl. mutations); `buildCloudOrderPayload` 5/5. Bench, plain node.
- `apps/server` and `apps/desktop` `tsc --noEmit` clean.
- All gates green.
- NOT verified here (needs live server + Postgres + a real till): the route resolving a claim end-to-end, the DB validation query against real `user_branches`, and an actual offline sale crediting the cashier on the cloud. These keep A169 OPEN P1 until a till+cloud run confirms them.

## Rule 15

Desktop code changed (peerRelay/syncEngine/nodeIngest) → bump the desktop version
and tag after the build; the bump is not in this patch (rule 22). The server
deploys on its own cadence.

## Rollback

```
git apply -R swiftpos-2026-08-27-f.patch
```
