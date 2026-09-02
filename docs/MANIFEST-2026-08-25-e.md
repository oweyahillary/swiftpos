# MANIFEST — 2026-08-25 batch -e — A163 (A20 staff-roster replication to peers)

**Base commit:** `189e597` (dev tip). **Supersedes MANIFEST-2026-08-25-d.md** (cumulative, rule 3
— this zip carries the whole day: A24 reference channel + A19 relay + this A20 roster channel).
**Register:** A163 · P1 · OPEN. A20 stays OPEN until closed on the failover target.
**Version:** no desktop bump in this delivery (rule 22); one is DUE at the next build (rule 15).

The branch node now replicates its staff roster to peers, so a promoted till can authenticate
cashiers and OPEN THE SHOP on failover — the moment A20 exists to prevent. A special case of the
A24 snapshot channel, on a SEPARATE endpoint because it carries PIN hashes.

## Owner decision + mitigation

The owner accepted replicating the branch's bcrypt PIN hashes to every peer (not just the node) —
"a branch is one trust domain" (PHASE5 §10.1). Mitigation to add to ops docs: **rotate PINs when a
terminal goes missing** (the PIN-rotation-on-missing-terminal runbook).

## Why raw bcrypt crosses the LAN

`branch_staff.pin_hash_enc` is bcrypt wrapped with `safeStorage`, which is bound to the machine/OS
account that wrapped it — a peer can't decrypt the node's wrapped form. So the node unwraps to raw
bcrypt to serve, and each peer re-wraps with its own `safeStorage` via the existing
`storeBranchStaff`. Same shape as how the node sources the roster from the cloud (raw in, wrapped
locally). The raw bcrypt (not a plaintext PIN) crosses the X-Node-Secret-authed, branch-scoped LAN
channel — the exposure the owner already accepted.

## Files this batch (-e adds 2, edits 4)

| File | Change |
|------|--------|
| `apps/desktop/src/main/rosterSnapshot.ts` | **NEW pure.** `buildRosterSnapshot` (node reshape + content version, keeps only bcrypt staff) and `unpackRosterSnapshot` (peer apply-decision). Holds THE LOCKOUT GUARD: refuse an empty/pinless snapshot so a wholesale replace can never leave a peer that authenticates no one. |
| `apps/desktop/src/main/branchStaff.ts` | `readBranchStaffForServe` — unwraps `pin_hash_enc`/`override_pin_hash_enc` to raw bcrypt for the node to serve. |
| `apps/desktop/src/main/nodeServer.ts` | New `POST /node/roster` (branch-gated + X-Node-Secret). |
| `apps/desktop/src/main/nodeClient.ts` | `fetchRosterFromNode` (peers only; null on any node problem). |
| `apps/desktop/src/main/syncEngine.ts` | `pullCatalogue` tail: a PEER pulls `/node/roster` and replaces its roster when the guard permits and the version changed (in-memory version-skip). Nodes unchanged. |
| `apps/desktop/src/main/ipcHandlers.ts` | `tech:promoteToNode` pulls a fresh roster from the current node BEFORE the role flip, so a freshly promoted peer authenticates at once. |
| `apps/desktop/test/roster-snapshot.test.mjs` | **NEW.** 16 asserts, mutation-checked. |
| `apps/desktop/package.json` / `.github/workflows/ci.yml` | `test:roster` script + CI step. No version change. |
| `docs/AUDIT-REGISTER.md` | A163 entry; header Open A-P1 15→16; A163 in Counts. |

Also in this cumulative zip (unchanged from -d): the A24 channel + both A19 slices, plus
MANIFEST -a…-d. Not shipped: `apps/desktop/package-lock.json` (rule 22).

## The guard that matters (lockout prevention)

`storeBranchStaff` replaces wholesale (DELETE+INSERT). Applying an empty or all-pinless snapshot
would leave a peer able to authenticate NO ONE — locking the shop out on failover. A branch always
has staff, so such a snapshot is ALWAYS a failed pull, never legitimate. `unpackRosterSnapshot`
refuses it (`apply:false`) and the peer keeps its good roster. Mutation-checked: removing the guard
turns the "empty/pinless → do not apply" asserts red.

## Verified on the bench (Linux, Node 22 — WEAKER than the Windows/Node 20/Electron target, rule 9)

```
apps/desktop $ npx tsc -b tsconfig.main.json --force   → exit 0 (clean)
apps/desktop $ npm run test:roster                     → 16 passed, 0 failed
  mutation-checks: apply empty/pinless roster → 2 named FAILs; keep non-bcrypt PIN → 1 named FAIL
$ node scripts/check-test-registration.mjs             → OK
$ node scripts/check-register-consistency.mjs          → OK
```

## NOT verified here — target-only (rule 16)

The safeStorage unwrap/rewrap, the `/node/roster` endpoint, the peer pull + `storeBranchStaff`, and
the promote backstop under real Electron/SQLite; and the close condition — two tills + a node: the
roster reaches a peer; that peer, cut from the cloud, signs a cashier in by PIN; a deactivated staff
member disappears after the next pull; and `tech:promoteToNode` yields a node that can immediately
authenticate staff.

## Rollback (this batch's additions)

```
rm apps/desktop/src/main/rosterSnapshot.ts apps/desktop/test/roster-snapshot.test.mjs docs/MANIFEST-2026-08-25-e.md
git checkout 189e597 -- apps/desktop/src/main/branchStaff.ts apps/desktop/src/main/nodeServer.ts \
                        apps/desktop/src/main/nodeClient.ts apps/desktop/src/main/ipcHandlers.ts
# syncEngine.ts, package.json, ci.yml and the register are shared with -a…-d — revert only the
# A163 lines, or roll the whole day back to 189e597.
```
