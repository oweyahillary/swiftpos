# MANIFEST — 2026-08-25 batch -a — A161 (A24 downstream reference channel, node-serve half)

**Base commit:** `189e597` (dev tip — "batch -i: A160 node-brokered token refresh").
**Register:** A161 · P1 · OPEN (opened this batch). Closes A24 when the channel is complete
and target-verified; A20 rides the same channel in a later slice.
**Version:** no desktop version bump in this delivery (rule 22). One is DUE at the next build
(rule 15), batched with batch -b — this batch alone changes no running till.

This is the FIRST half of Phase (c)'s reference leg: the node now *serves* its branch reference
data. The peer does not *read* it yet — that is batch -b — so nothing here is reachable at
runtime and no till behaviour changes. Delivered now, separately, because the node-serve half
is purely additive and bench-testable, while the peer read touches the money-adjacent catalogue
path and only closes on the two-till target.

## Files (7 — lockfile deliberately excluded)

| File | Change |
|------|--------|
| `apps/desktop/src/main/referenceBundle.ts` | **NEW.** `buildReferenceBundle(db,cfg)` reads the node's local reference tables; pure `mapReferenceBundle(rows)` reshapes them into the cloud shapes `pullCatalogue` consumes (tri-state `is_kitchen`, users→`roles:{name}`, stations→`category_ids[]`, combos→record). |
| `apps/desktop/src/main/nodeServer.ts` | Import `buildReferenceBundle`; new `POST /node/reference` handler after `/node/since` (branch-scoped, `X-Node-Secret`, full snapshot). |
| `apps/desktop/src/main/nodeClient.ts` | New `fetchReferenceFromNode()` (mirrors `pullNodeDistribution`; null on any failure → peer falls back to cloud). **Unused until -b.** |
| `apps/desktop/test/node-reference-bundle.test.mjs` | **NEW.** 25 assertions, drives the real compiled `mapReferenceBundle`; mutation-checked (breaking the tri-state → 3 named failures). |
| `apps/desktop/package.json` | Adds `test:refbundle` script; wires it into `test:desktop`. **No version change.** |
| `.github/workflows/ci.yml` | New CI step runs the reference-bundle test (plain node, after the sync-failure step). |
| `docs/AUDIT-REGISTER.md` | A161 entry added after A160; header Open A-P1 13→14; A161 added to Counts. |

Not shipped: `apps/desktop/package-lock.json` — modified only by the bench `npm install` used to
run `tsc`; it is the recipient's tooling's file and no dependency actually changed (rule 22).

## Verified on the bench (Linux, Node 22 — WEAKER than the Windows/Node 20/Electron target, rule 9)

```
apps/desktop $ npx tsc -b tsconfig.main.json --force     → exit 0 (clean)
apps/desktop $ npm run test:refbundle                    → 25 passed, 0 failed
  mutation-check: asTriBool → passthrough  → 3 named asserts FAIL, tsc still clean (rule 10/23)
$ node scripts/check-test-registration.mjs               → OK (53 files invoked)
$ node scripts/check-register-consistency.mjs            → OK (125/125, header agrees with body)
```

## NOT verified here — target-only (rule 16)

- The SQL reads in `buildReferenceBundle` (needs `better-sqlite3` under Electron — not loadable
  on this bench).
- The real node↔peer HTTP exchange over the LAN.
- The full CI gate suite (server/dashboard installs not present in this sandbox).

## To close A24 (target, AFTER batch -b lands the peer read)

On two tills + a node: edit a product price on the dashboard; let the node sync; cut the peer's
cloud (leave the node online); confirm the peer picks up the new price **from the node**, and
that two tills at one branch never show the same item at two prices.

## Rollback

```
# New files:
rm apps/desktop/src/main/referenceBundle.ts
rm apps/desktop/test/node-reference-bundle.test.mjs
rm docs/MANIFEST-2026-08-25-a.md
# Edited files — restore from the base commit:
git checkout 189e597 -- apps/desktop/src/main/nodeServer.ts \
                         apps/desktop/src/main/nodeClient.ts \
                         apps/desktop/package.json \
                         .github/workflows/ci.yml \
                         docs/AUDIT-REGISTER.md
```
Every edit is additive; restoring these six files and deleting the three new ones returns the
tree to `189e597` exactly.
