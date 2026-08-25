# MANIFEST — 2026-08-25 batch -c — A162 (A19 node→cloud relay, node-side half)

**Base commit:** `189e597` (dev tip). **Supersedes MANIFEST-2026-08-25-b.md** (cumulative, rule 3
— this zip carries the whole day: the A24 channel from -a/-b AND this A19 slice).
**Register:** A162 · P1 · OPEN. Builds A19 §3 (money path). A19 stays OPEN until closed on target.
**Version:** no desktop bump in this delivery (rule 22); one is DUE at the peer-side build (rule 15).

The node now FORWARDS a peer's sales to the cloud. Slice 1 is the node-side decision + enqueue,
built as a pure, testable module. The peer-side half (attach the payload + stop double-pushing)
is the next slice — see "Still to build".

## Why stash, not reconstruct (the finding that shaped this)

The cloud's `/api/orders` ALWAYS re-prices an order from its `items` and stores that as the
authoritative total (`apps/server/src/routes/orders.ts:467`, "Finding #19") — it never trusts a
client total. Re-pricing needs each line's variant/modifier selections, but the node's replicated
order lines carry none (they don't cross the LAN). So a payload REBUILT from the node's tables
would be re-priced without the paid modifiers and stored short by every modifier charge, silently.
The only faithful forward is the peer's ORIGINAL payload, carried verbatim. This slice puts the
node-side machinery in place to relay that payload; the peer starts sending it in the next slice.

## Files this batch (-c adds 3, edits 3)

| File | Change |
|------|--------|
| `apps/desktop/src/main/peerRelay.ts` | **NEW.** Pure `buildPeerRelay(orderRow)` — decides if a peer order can be forwarded faithfully; refuses (safely, order still lands for branch reports) anything the cloud would 400 forever or that could misattribute money. |
| `apps/desktop/src/main/nodeIngest.ts` | `enqueuePeerRelay` (writes the payload into the node's own `sync_queue`, `INSERT OR IGNORE` on the UNIQUE `order_id`); wired into `applyPeerRows` in the SAME transaction as the order insert, new-order branch only. `IngestResult.relayed` counter. |
| `apps/desktop/test/peer-relay.test.mjs` | **NEW.** 18 asserts, forward guards, mutation-checked. |
| `apps/desktop/package.json` | `test:peerrelay` script, wired into `test:desktop`. No version change. |
| `.github/workflows/ci.yml` | CI step runs the peer-relay test. |
| `docs/AUDIT-REGISTER.md` | A162 entry; header Open A-P1 14→15; A162 in Counts. |

Also in this cumulative zip (unchanged from -b, the A24 channel): `referenceBundle.ts`,
`nodeServer.ts`, `nodeClient.ts`, `syncEngine.ts`, `node-reference-bundle.test.mjs`,
`node-reference-unpack.test.mjs`, and MANIFEST-2026-08-25-a.md + MANIFEST-2026-08-25-b.md.
Not shipped: `apps/desktop/package-lock.json` (bench artifact, no dependency changed — rule 22).

## Idempotency — three independent guards against double-counting a sale

`sync_queue.order_id` is UNIQUE and the enqueue is `INSERT OR IGNORE` (a re-offered order never
enqueues twice); the node's push carries the peer's stable id as `X-Idempotency-Key`; and the cloud
short-circuits duplicates on `(business, idempotency_key)`. A peer on the old build pushing straight
to cloud AND this node forwarding the same order converge on ONE cloud row — the mixed-version
window is safe.

## Verified on the bench (Linux, Node 22 — WEAKER than the Windows/Node 20/Electron target, rule 9)

```
apps/desktop $ npx tsc -b tsconfig.main.json --force   → exit 0 (clean)
apps/desktop $ npm run test:peerrelay                  → 18 passed, 0 failed
  mutation-checks: accept empty items → 2 named FAILs; drop idempotency-mismatch guard → 1 named FAIL
$ node scripts/check-test-registration.mjs             → OK
$ node scripts/check-register-consistency.mjs          → OK
```

## Still to build — peer-side half (next slice, money path)

1. `fillNodeOutbox` attaches the peer's original cloud payload to the order row as `_relayPayload`
   (faithful source: `receipt_payloads`, which holds the full items incl. variants/modifiers).
2. The peer stops double-pushing to its own cloud `sync_queue` when it has a `node_url`, with the
   register's 404 fallback: an old node that doesn't accept the forward → the peer keeps enqueuing
   `sync_queue`, so a sale is never parked.

## NOT verified here — target-only (rule 16)

The enqueue and `applyPeerRows` wiring under real SQLite/Electron; a real node→cloud POST; and the
close condition itself — a live node + peer + cloud proving a peer sale reaches the cloud exactly
ONCE, attributed to the peer's device, with a modifier order's cloud total matching the receipt.

## Rollback (this batch only)

```
rm apps/desktop/src/main/peerRelay.ts apps/desktop/test/peer-relay.test.mjs docs/MANIFEST-2026-08-25-c.md
git checkout 189e597 -- apps/desktop/src/main/nodeIngest.ts
# then re-apply the -b state of the shared files, or roll the whole day back:
#   git checkout 189e597 -- apps/desktop/package.json .github/workflows/ci.yml docs/AUDIT-REGISTER.md
```
Because `package.json`, `ci.yml` and the register are shared with -a/-b, rolling back A19 alone
means reverting only the A162 lines in them; rolling back the whole day restores them to `189e597`.
