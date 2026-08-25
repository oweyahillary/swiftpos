# MANIFEST — 2026-08-25 batch -d — A162 (A19 node→cloud relay, peer-side carry)

**Base commit:** `189e597` (dev tip). **Supersedes MANIFEST-2026-08-25-c.md** (cumulative, rule 3
— this zip carries the whole day: the A24 channel from -a/-b AND both A19 slices from -c/-d).
**Register:** A162 · P1 · OPEN. A19 stays OPEN until closed on target.
**Version:** no desktop bump in this delivery (rule 22); one is DUE at the stop-double-push slice (rule 15).

The A19 relay is now end-to-end on the bench: the till carries its original cloud payload to the
node (this slice), and the node forwards it to the cloud (slice -c). A peer's offline sales now
reach the cloud.

## What this slice adds

The till stores its exact cloud payload at sale time (`receipt_payloads`, since A94) — the only copy
that holds each line's variant/modifier selections, which the replicated `order_items` do NOT. This
slice carries that payload to the node so the node forwards it verbatim, and the cloud re-prices the
order identically to a direct push (no modifier under-total).

## Files this batch (-d edits 3, extends 1 test)

| File | Change |
|------|--------|
| `apps/desktop/src/main/peerRelay.ts` | NEW shared `buildCloudOrderPayload(orderPayload, ctx)` — the single source for the cloud /api/orders payload, used by BOTH the till's direct push and the node's forward so the two payloads for one order are identical. |
| `apps/desktop/src/main/syncEngine.ts` | `createLocalOrder` now builds its `sync_queue` payload through the shared builder (output-identical refactor of the former inline object). |
| `apps/desktop/src/main/nodeIngest.ts` | `fillNodeOutbox` attaches `row._relayPayload` for orders — rebuilt via the shared builder from `receipt_payloads` (faithful items) + the row's envelope (device_id/shift_id/created_at). Rides to the node in the existing node_queue row; slice -c's `buildPeerRelay` accepts it. |
| `apps/desktop/test/peer-relay.test.mjs` | Extended 18 → 28 (mutation-checked): shared-builder guards + a round-trip proving a modifier price survives build → forward. |

Also in this cumulative zip (unchanged from -c): the A24 channel files and slice -c's `peerRelay`
node-side + `nodeIngest` forward, plus MANIFEST -a/-b/-c.
Not shipped: `apps/desktop/package-lock.json` (bench artifact, no dependency changed — rule 22).

## The deliberate money-path decision: the peer STILL double-pushes

Register change-point #1 (stop the peer enqueuing to its own cloud `sync_queue` when it has a
`node_url`) is **intentionally NOT in this slice.** The peer keeps double-pushing, and that is safe:
idempotency dedupes on the cloud (peer id), so a sale is never counted twice, and **correctness
never depends on the relay working** — the relay is a pure additive accelerator. If a payload is
ever missing (e.g. `receipt_payloads` pruned) or imperfect, the order still reaches the cloud by the
till's own push. This is the safest way to land a money path: prove the new route works alongside
the proven one, then remove the redundancy in a later slice (with the 404 fallback + a cached
node-capability flag). The only cost meanwhile is a cosmetic pending-backlog on an offline peer.

## Verified on the bench (Linux, Node 22 — WEAKER than the Windows/Node 20/Electron target, rule 9)

```
apps/desktop $ npx tsc -b tsconfig.main.json --force   → exit 0 (clean)
apps/desktop $ npm run test:peerrelay                  → 28 passed, 0 failed
  mutation-checks: don't mark legs completed → 1 named FAIL; don't drop kot_sent → 1 named FAIL
                   (slice -c guards still bite: empty items → 2; idempotency mismatch → 1)
$ node scripts/check-test-registration.mjs             → OK
$ node scripts/check-register-consistency.mjs          → OK
```

## NOT verified here — target-only (rule 16)

`fillNodeOutbox`'s `receipt_payloads` read and the `applyPeerRows` enqueue under real SQLite/
Electron; a real till→node→cloud round trip; and the close condition — a live node + peer + cloud
proving a peer sale reaches the cloud exactly ONCE, attributed to the peer's device, with a modifier
order's cloud total matching the receipt.

## Rollback (this batch's edits)

```
git checkout 189e597 -- apps/desktop/src/main/syncEngine.ts apps/desktop/src/main/nodeIngest.ts
# peerRelay.ts + peer-relay.test.mjs are new in -c; to drop just -d's additions to them,
# revert buildCloudOrderPayload / the extended test asserts, or roll the whole day back:
#   git checkout 189e597 -- apps/desktop/... ; rm the new files + docs/MANIFEST-2026-08-25-*.md
```
Rolling the whole day back to `189e597` removes A24 and A19 together; the per-file rollback lines in
MANIFEST -b and -c cover the narrower reverts.
