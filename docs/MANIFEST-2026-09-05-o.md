# MANIFEST 2026-09-05-o — A227 manager stock history (cumulative: A225 + A226 + A227)

**Base:** `origin/dev` @ `7a6defc`. **CUMULATIVE** — carries A225 (reprint), A226 (doc styling) and A227
(history), none of which are pushed yet. One zip delivers all three. If you've pushed any, tell me and I'll rebase.

## What A227 does
A new **History** tab in the manager portal (Inventory group): a read-only record of **deliveries
received** (GRNs at the branch) and **transfers** (in + out, all statuses, scoped to the branch), each
re-printable via the shared engine. Endpoints are ones managers already reach.

## Files (A227 delta)
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/pages/manager/ManagerHistoryTab.tsx` | NEW — the history view | delete file |
| `apps/dashboard/src/pages/manager/ManagerDashboard.tsx` | History nav item + tab case | restore from `7a6defc` |
| `tests/manager-history.test.mjs` | NEW — source guards (5/5, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A227 entry; counts P3 10→11 | restore from `7a6defc` |
| `docs/MANIFEST-2026-09-05-o.md` | NEW — this manifest | delete file |

Also in this cumulative zip: the A225 (reprint) + A226 (styling) files and their manifests (m, n).

## What ran + output (rule 7)
```
tests/manager-history.test.mjs    5/5  (mutations: drop branch scope → red · drop tab case → red)
tests/document-styling.test.mjs   8/8  [A226]
tests/reprint-history.test.mjs    5/5  [A225]
apps/dashboard  npx tsc --noEmit  exit 0
register · doc-refs · parity · catalogue   exit 0
```
Could NOT verify here: rendered history + reprints (browser).

## Apply
1. Extract over root; run gates. 2. `git add` the A225+A226+A227 files (see manifests m/n/o); commit; push. 3. Deploy dashboard.
