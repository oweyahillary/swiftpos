# MANIFEST 2026-09-07-c — A244 test-print spooler fix + offline/node cluster reconcile

**Base:** `origin/dev` @ c9698bb (A17 close in). **Delivery:** zip, extract over repo root.
Dashboard-only code change + docs. **No bridge/exe rebuild. No migration.**

## Why
"Send test receipt" and the per-station test buttons failed with
`connect XP-80:9100: dial tcp: lookup XP-80: no such host` on a correctly-installed
Windows XP-80. Cause: `testPrint` posted the printer **name as a bare `target`**, so the
bridge routed it to the **network** branch instead of the Windows spooler. Real receipt/KOT
printing was never affected (those paths already send `printer:`-prefixed targets).

## Files
| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/lib/localPrintServer.ts` | `testPrint` sends `target: 'printer:' + printerName` (spooler), not a bare name | A244 |
| `tests/tiny-bridge-printing.test.mjs` | guard: testPrint target is `printer:`-prefixed (mutation-checked); 17→18 | A244 |
| `docs/AUDIT-REGISTER.md` | A244 entry; A-P2 25→26; offline/node cluster retag OPEN→FIX BUILT (still open in counts, rule 16) | A244 + reconcile |
| `docs/OFFLINE-CLUSTER-verification-checklist.md` | new — two-till checklist that closes A19/A20/A24/A160/A161/A162/A163 (+A168/A129) | reconcile |
| `docs/MANIFEST-2026-09-07-c.md` | this manifest | — |

## What ran + output (rule 7)
```
tests/tiny-bridge-printing.test.mjs            -> 18/18 green
  mutation-checked: revert testPrint to a bare target -> the new guard reddens
esbuild transpile-syntax (localPrintServer.ts) -> clean
register-consistency · doc-refs · root-clean   -> green
```
Cluster reconcile evidence (docs-only, no code): the offline/node pure-logic suites were run
green on current dev — peer-relay 28/0, node-reference-bundle 25/0, node-reference-unpack 19/0,
roster-snapshot 16/0, node-token-refresh + device-token 2/2 — and every `/node/*` endpoint +
peer-read wire was traced by hand (see the A244/cluster changelog).

**NOT verified here (rule 16):** the physical test print on the XP-80 (spooler RAW), and the
two-till offline/node pass (that's what the new checklist is for).

## Rollback (rule 2)
Code-only, no schema. `git revert <this commit>` and redeploy the dashboard. Bridge unchanged,
so no exe to roll back.

## Apply
1. Extract over repo root.
2. `node --test tests/tiny-bridge-printing.test.mjs` + register/doc-refs/root gates.
3. Redeploy the dashboard (no exe rebuild). Hard-refresh the Printers page.
4. "Send test receipt" → the XP-80 spooler; confirm paper.
