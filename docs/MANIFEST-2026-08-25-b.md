# MANIFEST — 2026-08-25 batch -b — A161 (A24 downstream reference channel, COMPLETE)

**Base commit:** `189e597` (dev tip). **Supersedes MANIFEST-2026-08-25-a.md** (cumulative, rule 3).
**Register:** A161 · P1 · OPEN. Closes A24 on the two-till target. A20 (roster) rides this
same channel in a later slice.
**Version:** no desktop bump in this delivery (rule 22); one is DUE at the next build (rule 15).

The full A24 reference channel: the branch node now SERVES its reference data (batch -a) and an
offline peer now READS it from the node instead of going stale on the cloud (batch -b). End-to-
end on the bench; closes on the target.

## Files (9 — lockfile excluded)

| File | Change |
|------|--------|
| `apps/desktop/src/main/referenceBundle.ts` | **NEW.** Node PACK (`buildReferenceBundle`/pure `mapReferenceBundle`) + peer UNPACK (pure `unpackNodeBundle` + `AcquiredReference` + `numOrNull`). Owns the channel's shape contract both directions. |
| `apps/desktop/src/main/nodeServer.ts` | `POST /node/reference` (branch-scoped, `X-Node-Secret`), serves the snapshot from the node's local tables. |
| `apps/desktop/src/main/nodeClient.ts` | `fetchReferenceFromNode()` — null on unreachable/refused/malformed so the peer falls back to cloud. |
| `apps/desktop/src/main/syncEngine.ts` | `pullCatalogue` refactored **node-first**: node bundle → same write transaction, skip the 7+N cloud calls; else cloud path **unchanged**. Config persistence hoisted to shared `applyReferenceConfig`. **Write transaction + roster pull byte-identical.** |
| `apps/desktop/test/node-reference-bundle.test.mjs` | **NEW.** 25 asserts, node reshape, mutation-checked (tri-state). |
| `apps/desktop/test/node-reference-unpack.test.mjs` | **NEW.** 19 asserts, peer unpack don't-wipe guards, mutation-checked. |
| `apps/desktop/package.json` | `test:refbundle` + `test:refunpack` scripts, wired into `test:desktop`. No version change. |
| `.github/workflows/ci.yml` | Two CI steps run the reference tests (plain node). |
| `docs/AUDIT-REGISTER.md` | A161 entry (batches -a and -b); header Open A-P1 13→14; A161 in Counts. |

Not shipped: `apps/desktop/package-lock.json` — bench `npm install` artifact, no dependency
changed (rule 22).

## The additive-by-construction argument (why the money path is safe)

`fetchReferenceFromNode()` returns null for: a node device, a till with no `node_url`, or any
node problem (unreachable/refused/malformed). Only when it returns a real bundle does the peer
take the node path. So **every device except a peer with a live, answering node is byte-for-byte
unchanged** — the cloud acquisition and the entire write transaction are the same code they were
at `189e597`. The peer path feeds that same write transaction. The don't-wipe guards
(`tablesFetched`/`pumpsFetched`/nullable `stations`/`paymentMethods`) mean a partial or old-build
node bundle can never clear good local data — it reads as "not supplied", exactly as a failed
cloud fetch does today.

## Verified on the bench (Linux, Node 22 — WEAKER than Windows/Node 20/Electron, rule 9)

```
apps/desktop $ npx tsc -b tsconfig.main.json --force   → exit 0 (clean)
apps/desktop $ npm run test:refbundle                  → 25 passed, 0 failed
apps/desktop $ npm run test:refunpack                  → 19 passed, 0 failed
  mutation-checks: break the tri-state → 3 named FAILs; break the tables don't-wipe → 1 named FAIL
$ node scripts/check-test-registration.mjs             → OK
$ node scripts/check-register-consistency.mjs          → OK (header agrees with body)
```

## NOT verified here — target-only (rule 16)

- The SQL reads in `buildReferenceBundle` (needs `better-sqlite3` under Electron).
- The real node↔peer HTTP exchange; a peer actually re-pointing its catalogue to the node.
- The full CI gate suite (server/dashboard installs absent in this sandbox).

## To close A24 (target)

Two tills + a node. (1) Edit a product price on the dashboard; let the node sync; **cut the
peer's cloud** (leave the node online); confirm the peer picks up the new price FROM the node,
and that two tills at one branch never show one item at two prices. (2) With the node ALSO
unreachable, confirm the peer falls back to the cloud (or keeps its last-known-good), never
wiping its catalogue/tables/pumps.

## Rollback

```
rm apps/desktop/src/main/referenceBundle.ts \
   apps/desktop/test/node-reference-bundle.test.mjs \
   apps/desktop/test/node-reference-unpack.test.mjs \
   docs/MANIFEST-2026-08-25-a.md docs/MANIFEST-2026-08-25-b.md
git checkout 189e597 -- apps/desktop/src/main/syncEngine.ts \
                        apps/desktop/src/main/nodeServer.ts \
                        apps/desktop/src/main/nodeClient.ts \
                        apps/desktop/package.json \
                        .github/workflows/ci.yml \
                        docs/AUDIT-REGISTER.md
```
Deletes the four new source/test files and the two manifests; restores the six edited files to
`189e597`. Returns the tree exactly to base.
