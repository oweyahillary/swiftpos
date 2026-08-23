# MANIFEST — 2026-08-23-t

**Batch:** A19 source-analysis pass — status confirmed + concrete fix map. **Docs-only — no zip** (rule 18).
**Cumulative:** follows -a…-s. Apply after -s.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-s.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | Appended a `STATUS + FIX MAP 2026-08-23` note to A19. Stays **OPEN P1**; counts unchanged. | Rule 14 / 7 — turn the agreed design into a verified current-state + a precise, actionable change map. |
| `docs/MANIFEST-2026-08-23-t.md` | New (this file). | Rule 2. |

## Headline

Unlike A17 (which turned out already built), **A19's §3 fix is genuinely unbuilt.** The node is a replica, not a relay — an offline peer's sales never reach the cloud. This note records the confirmed current state and the exact two change points, so it's ready to implement (money path, ship last).

## Confirmed current state (source, rule 7)

- `syncEngine.ts:1780` — every till enqueues its own sale to the cloud `sync_queue` (`idempotency_key = orderId`).
- `nodeIngest.applyPeerRows` stamps ingested peer rows `sync_status = 'peer'` (`PEER_SYNC_STATUS`) to keep them **out** of the node's cloud push; `nodeServer.ts:14-30` documents "the node does not forward peer rows to the cloud." The node outbox (`nodeIngest.ts:410+`) is peer→node only.
- Result: an offline peer's `sync_queue` never drains and nothing forwards it → cloud never sees peer sales. A19 confirmed.

## Concrete §3 fix (not implemented here)

1. **Peer stops double-pushing** (`syncEngine.ts:1780`): with a `node_url`, skip `sync_queue` and push node-only; fall back to `sync_queue` only if the node 404s the new forward-capable ingest (mixed-version safety).
2. **Node forwards** (`applyPeerRows`): for peer ORDER rows, also enqueue into the NODE's own `sync_queue`, preserving the peer's original id + `idempotency_key`, so the node's existing cloud push relays them. Two-queue separation stays.

**Hardest part:** the node must produce the cloud `/api/orders` payload for a forwarded peer sale — `applyPeerRows` doesn't retain the peer's push payload, so forwarding must stash it at ingest or reconstruct it faithfully. Idempotency makes the mixed-version window safe (cloud dedupes on `idempotency_key`).

## Dependencies / sequencing

- PHASE5 §8 puts §3 **last** (moves money paths); ideally after D3 auto-update.
- Companion to A17's rollout: A17 (built) lets a remote peer keep **selling** offline; A19 is what makes those sales **reach cloud** (web dashboard, eTIMS, cloud loyalty, backup).
- **Target-only:** closing needs a live node + peer + cloud — verify a peer sale reaches cloud once, with the peer's original id and no duplicate. Not buildable/verifiable on the bench (rule 16/20).

## Verification

- `node scripts/check-register-consistency.mjs` → green (A19 still OPEN P1; counts unchanged).
- No code changed; nothing to build.

## Rollback

```
git apply -R A19-source-analysis.patch
```
