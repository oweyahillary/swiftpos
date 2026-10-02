# MANIFEST 2026-09-10-D9-core — held-orders cross-till: the benchable core

**Base:** `origin/dev` @ `aa8011d`. **This delivery also carries the still-unpushed D18**
(see below) — they share `docs/AUDIT-REGISTER.md`, so they commit together.

## D9 (core only) — node-authoritative held-order claim/lease/audit
Owner chose a soft-lock/lease model (full spec in `docs/D9-decision-brief.md`): any till sees
every open tab; a till claims an atomic LOCK to edit/charge/clear; the lock is a 90s LEASE
renewed on every edit; CLEAR and a forced lock-STEAL are audited + manager-notified; a routine
claim→edit→charge is not.

**Built (benchable core):** `apps/desktop/src/main/nodeTabs.ts` — the node tab store (schema +
`registerTab`, `listOpenTabs`, `claimTab`, `updateTab`, `releaseTab`, `deleteTab`, `stealAudit`).
The claim is one conditional `UPDATE … WHERE (unlocked OR mine OR lease-expired)` whose `.changes`
is 1 for exactly one caller — the D4 enrolment-burn shape, so two tills can't both hold it.
**Proven:** `apps/desktop/test/node-tabs-claim.test.mjs` (17 checks — claim/409/idempotent-reclaim/
edit-renews-lease/423-non-holder/expired-lease-steal-flagged/release/clear-audited/charge-not-
audited/non-holder-can't-clear). Desktop main tsc 0. Wired into `test:desktop` (via `test:tabs`).

**NOT built — deliberately (rule 12/16), the risky + unverifiable-here half:**
1. Wiring `nodeTabs` into `nodeServer.ts` routes + `nodeClient.ts` + the desktop `held:*` IPC/UI
   (the Open-vs-Locked-by indicator, claim-on-recall).
2. The audit→manager-notification hop — the clear/steal audit must ride local→cloud sync into the
   server `notifications` table. A multi-hop integration.
3. The LIVE cross-till behaviour — poll lag, a till dropping offline mid-charge, two real tills
   racing a claim. Only a two-till rig proves it, and it IS the point of the feature.

**Do not ship to a real floor until (3) passes** — held orders are the app's most dangerous data;
a double-charged table is worse than the current gap. Owner confirmations still useful: poll
interval 3–5s (assumed) wants a node-load check.

## D18 (carried in this commit) — tech token paste guard
`tests/tech-token-paste.test.mjs` (6 checks, mutation-checked) locks the existing `PinPage`
onPaste fix that routes an `st2.` token past the truncating reveal field. D18 → FIX BUILT; needs
an on-screen paste confirm on the amber build. (Manifest `docs/MANIFEST-2026-09-10-D18.md`.)

## Files
| File | Change | ID |
|---|---|---|
| `apps/desktop/src/main/nodeTabs.ts` | NEW — node tab store + atomic claim/lease/audit | D9 |
| `apps/desktop/test/node-tabs-claim.test.mjs` | NEW — 17-check core test | D9 |
| `apps/desktop/package.json` | +`test:tabs`, chained into `test:desktop` | D9 |
| `docs/D9-decision-brief.md` | NEW — the owner-decision spec | D9 |
| `tests/tech-token-paste.test.mjs` | NEW — D18 paste guard | D18 |
| `docs/MANIFEST-2026-09-10-D18.md` | D18 record | — |
| `docs/AUDIT-REGISTER.md` | D9 → FIX BUILT (core); D18 → FIX BUILT; changelog | — |
| `docs/MANIFEST-2026-09-10-D9-core.md` | this record | — |

## What ran (rule 7)
```
apps/desktop/test/node-tabs-claim.test.mjs   17/17
tests/tech-token-paste.test.mjs              6/6
desktop main tsc -p tsconfig.main.json       0 errors (excl. @swiftpos/printing resolution)
offline suites  tests/*.test.mjs             97/97
gates  register-consistency / doc-refs / root-clean / test-registration   OK
```

## NOT verified here (rule 16)
- D9: everything in "NOT built" above — especially the two-till live behaviour.
- D18: the on-screen paste on the amber build.

## Apply (covers D9-core AND the pending D18)
```
git pull origin dev
# extract this zip over the repo root, then:
node apps/desktop/test/node-tabs-claim.test.mjs      # 17/17
node tests/tech-token-paste.test.mjs                 # 6/6
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs && node scripts/check-test-registration.mjs
git add apps/desktop/src/main/nodeTabs.ts apps/desktop/test/node-tabs-claim.test.mjs apps/desktop/package.json docs/D9-decision-brief.md tests/tech-token-paste.test.mjs docs/MANIFEST-2026-09-10-D18.md docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-10-D9-core.md
git commit -m "D9 core: node-authoritative held-order claim/lease/audit (benchable half); D18 paste guard"
git push origin dev
```
Rollback: revert this commit — new module + tests + register; nothing wired into a runtime path yet.
